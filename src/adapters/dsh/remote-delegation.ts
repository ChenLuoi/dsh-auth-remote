import { AsyncLocalStorage } from 'node:async_hooks'
import type { OutgoingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import { symbols, type Context } from '@deepseek-ai/cordis'
import { AuthError, type AuthService } from '../../auth/service.js'
import { sessionFor } from '../../auth/sessions.js'
import type { AuthConnections, SessionPeer } from '../../http/connections.js'
import { requireRequestContext } from '../../http/request-context.js'
import {
  cookieHeader,
  currentSessionToken,
  HttpFailure,
  readJsonBody,
  sendHttpError,
  sendJson,
} from '../../http/routes.js'
import {
  DELEGATION_PATH,
  DEFAULT_DELEGATED_SESSION_DAYS,
  isDelegatedSessionDays,
  type DelegatedSessionDays,
} from '../../shared/delegation.js'
import type { AuthStateStore } from '../../storage/store.js'
import type { AuthState } from '../../storage/state.js'
import type { GuardedWebServer } from './webserver.js'

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu

interface NativeTicket {
  id: string
  url: string
  lifetimeMs: number
}

interface RemoteReceiver {
  ctx: { invocation?: { peer: SessionPeer; signal: AbortSignal } }
}

interface PairingPoll {
  status: string
  cookie?: string
}

interface NativePairingRecord {
  expiresAt: number
  outcome: { status: string }
}

interface NativeRemote extends RemoteReceiver {
  create(this: RemoteReceiver): NativeTicket
  cancel(this: RemoteReceiver, id: string): string
  status(this: RemoteReceiver, id: string | null): { loginUrlAllowed: boolean }
  loginUrl(this: RemoteReceiver): string
  pairingRequests(this: RemoteReceiver, signal: AbortSignal): unknown
  decidePairing(
    this: RemoteReceiver,
    id: string,
    decision: 'allow' | 'deny',
    signal: AbortSignal,
  ): string
  tickets: {
    consume(token: string): boolean
    state(id: string): string
    cancel(id: string): void
  }
  pairing: {
    records: ReadonlyMap<string, NativePairingRecord>
    poll(
      id: string,
      secret: string,
      authority: string,
      cancel: boolean,
      issueCookie: () => string | undefined,
    ): PairingPoll
  }
}

interface Gateway {
  invoke(request: {
    namespace: 'remoteConnection'
    method: 'create' | 'decidePairing'
    args: Record<string, unknown>
    peer: SessionPeer
    signal: AbortSignal
  }): Promise<unknown>
}

type Command = {
  requestId: string
  pairingId: string | null
  days: DelegatedSessionDays
  code: string | undefined
}

interface Grant {
  id: string
  ownerHash: string
  securityVersion: number
  days: DelegatedSessionDays
  expiresAt: number
  delivery?: Promise<{ token: string; expiresAt: number }>
  delivered?: string
}

type Authorized = { grant: Grant; result: NativeTicket | 'approved' }

interface Operation {
  ownerHash: string
  action: string
  responseExpiresAt: number
  promise: Promise<Authorized> | undefined
}

function readCommand(body: Record<string, unknown>): Command {
  const { requestId, pairingId = null, days = DEFAULT_DELEGATED_SESSION_DAYS, code } = body
  if (
    Object.keys(body).some((key) => !['requestId', 'pairingId', 'days', 'code'].includes(key)) ||
    typeof requestId !== 'string' ||
    !uuid.test(requestId) ||
    (pairingId !== null && (typeof pairingId !== 'string' || !uuid.test(pairingId))) ||
    !isDelegatedSessionDays(days) ||
    (code !== undefined && (typeof code !== 'string' || code.length > 128))
  )
    throw new AuthError('invalid_input')
  return { requestId: requestId.toLowerCase(), pairingId, days, code }
}

export function isQrExchange(url: URL): boolean {
  const mode = url.searchParams.getAll('login')
  return (
    url.pathname === '/' && mode.length === 1 && mode[0] === 'qr' && !url.searchParams.has('token')
  )
}

export function isPairingPost(pathname: string): boolean {
  return (
    pathname === '/pairing/request' ||
    pathname === '/pairing/status' ||
    pathname === '/pairing/cancel'
  )
}

/** Hooks on the exact alpha.2 service instance. The Host still owns each ticket and its checks. */
export class RemoteDelegation {
  private readonly undo: Array<() => unknown> = []
  private readonly lifetime = new AbortController()
  private readonly commands = new AsyncLocalStorage<{
    peer: SessionPeer
    id: string | null
    used: boolean
  }>()
  private readonly exchanges = new AsyncLocalStorage<{ kind: 'qr' | 'pairing'; grant?: Grant }>()
  private readonly pairing = new Map<string, Grant>()
  private readonly approving = new Map<string, { cancelled: boolean }>()
  private readonly operations = new Map<string, Operation>()
  private invitation: Grant | undefined

  constructor(
    ctx: Context,
    server: GuardedWebServer,
    private readonly auth: AuthService,
    private readonly store: AuthStateStore,
    private readonly connections: AuthConnections,
  ) {
    const native = ctx.get('remoteConnection')
    const gateway = ctx.get('typertGateway')
    const remote: unknown = native && Reflect.get(native, symbols.original)
    if (!remote || typeof remote !== 'object' || !gateway || typeof gateway.invoke !== 'function')
      throw new Error('auth-remote: alpha.2 Remote services are unavailable')
    this.remote = remote as NativeRemote
    this.gateway = gateway as Gateway
    try {
      this.installHooks()
      this.undo.push(
        ctx.on('webserver/request', (req, res, next) => this.exchange(req, res, next), true),
      )
      this.undo.push(store.subscribe((_previous, current) => this.sweep(current)))
      this.undo.push(
        server.register({
          kind: 'exact',
          path: DELEGATION_PATH,
          handler: (req, res, peer?: SessionPeer) => this.handle(req, res, peer),
        }),
      )
      const timer = setInterval(() => {
        if (store.healthy() && (this.invitation || this.pairing.size || this.operations.size))
          this.sweep()
      }, 1000)
      timer.unref()
      this.undo.push(() => clearInterval(timer))
    } catch (error) {
      this.dispose()
      throw error
    }
  }

  private readonly remote: NativeRemote
  private readonly gateway: Gateway

  dispose(): void {
    this.lifetime.abort()
    if (this.invitation) this.remote.tickets.cancel(this.invitation.id)
    this.invitation = undefined
    this.pairing.clear()
    this.operations.clear()
    this.approving.clear()
    for (const restore of this.undo.splice(0).reverse()) restore()
  }

  private patch<T extends object, K extends keyof T>(
    target: T,
    key: K,
    arity: number,
    wrap: (original: T[K]) => T[K],
  ): void {
    const original = target?.[key]
    if (typeof original !== 'function' || original.length !== arity || Object.hasOwn(target, key))
      throw new Error(`auth-remote: incompatible alpha.2 Remote hook ${String(key)}`)
    Object.defineProperty(target, key, { configurable: true, value: wrap(original) })
    this.undo.push(() => Reflect.deleteProperty(target, key))
  }

  private owner(peer: SessionPeer | undefined): string {
    const hash = peer && this.connections.sessionHashForPeer(peer)
    if (this.lifetime.signal.aborted || !hash || !this.auth.passwordSession(hash))
      throw new AuthError('unauthorized')
    return hash
  }

  private permit(receiver: RemoteReceiver, id: string | null): void {
    const invocation = receiver.ctx.invocation
    const command = this.commands.getStore()
    this.owner(invocation?.peer)
    if (
      !invocation ||
      invocation.signal.aborted ||
      !command ||
      command.used ||
      command.id !== id ||
      command.peer !== invocation.peer
    )
      throw new AuthError('unauthorized')
    command.used = true
  }

  private pending(grant: Grant, state?: AuthState): boolean {
    return (
      !this.lifetime.signal.aborted &&
      grant.expiresAt > Date.now() &&
      this.auth.passwordSession(grant.ownerHash, state)?.securityVersion === grant.securityVersion
    )
  }

  private sweep(state = this.store.current()): void {
    const now = Date.now()
    const requireTotp = this.auth.policySnapshot().requireTotp
    if (this.invitation && !this.pending(this.invitation, state)) {
      this.remote.tickets.cancel(this.invitation.id)
      this.invitation = undefined
    }
    for (const [id, grant] of this.pairing) {
      if (
        grant.expiresAt <= now ||
        (grant.delivered
          ? !sessionFor(state, grant.delivered, now, requireTotp)
          : !grant.delivery && !this.pending(grant, state))
      )
        this.pairing.delete(id)
    }
    for (const [key, receipt] of this.operations) {
      if (!this.auth.passwordSession(receipt.ownerHash, state)) this.operations.delete(key)
      else if (receipt.responseExpiresAt <= now) receipt.promise = undefined
    }
  }

  private installHooks(): void {
    const adapter = this
    const remote = this.remote
    if (
      typeof remote.tickets?.state !== 'function' ||
      typeof remote.tickets.cancel !== 'function' ||
      !(remote.pairing?.records instanceof Map)
    )
      throw new Error('auth-remote: incompatible alpha.2 native ticket services')

    this.patch(
      remote,
      'create',
      0,
      (create) =>
        function () {
          adapter.permit(this, null)
          const ticket = create.call(this)
          adapter.invitation = undefined
          return ticket
        },
    )
    this.patch(
      remote,
      'decidePairing',
      3,
      (decide) =>
        function (id, decision, signal) {
          adapter.owner(this.ctx.invocation?.peer)
          if (decision === 'allow') adapter.permit(this, id)
          const result = decide.call(this, id, decision, signal)
          if (result === 'denied') adapter.pairing.delete(id)
          return result
        },
    )
    this.patch(
      remote,
      'cancel',
      1,
      (cancel) =>
        function (id) {
          adapter.owner(this.ctx.invocation?.peer)
          const result = cancel.call(this, id)
          if (result === 'cancelled' && adapter.invitation?.id === id)
            adapter.invitation = undefined
          return result
        },
    )
    const protect = <Args extends unknown[], Result>(
      method: (this: RemoteReceiver, ...args: Args) => Result,
    ) =>
      function (this: RemoteReceiver, ...args: Args): Result {
        adapter.owner(this.ctx.invocation?.peer)
        return method.apply(this, args)
      }
    this.patch(
      remote,
      'status',
      1,
      (status) =>
        function (id) {
          adapter.owner(this.ctx.invocation?.peer)
          return { ...status.call(this, id), loginUrlAllowed: false }
        },
    )
    this.patch(remote, 'pairingRequests', 1, protect)
    this.patch(remote, 'loginUrl', 0, () => () => {
      throw new AuthError('unauthorized')
    })

    this.patch(
      remote.tickets,
      'consume',
      1,
      (consume) =>
        function (this: NativeRemote['tickets'], token) {
          const exchange = adapter.exchanges.getStore()
          const grant = adapter.invitation
          if (
            exchange?.kind !== 'qr' ||
            !grant ||
            !adapter.pending(grant) ||
            remote.tickets.state(grant.id) !== 'pending' ||
            !consume.call(this, token) ||
            remote.tickets.state(grant.id) !== 'used'
          )
            return false
          adapter.invitation = undefined
          exchange.grant = grant
          return true
        },
    )
    this.patch(
      remote.pairing,
      'poll',
      5,
      (poll) =>
        function (this: NativeRemote['pairing'], id, secret, authority, cancel, issueCookie) {
          const exchange = adapter.exchanges.getStore()
          const grant = adapter.pairing.get(id)
          let withdrawn = false
          const result = poll.call(this, id, secret, authority, cancel, () => {
            if (exchange?.kind === 'pairing' && grant && adapter.pending(grant))
              return issueCookie()
            withdrawn = !adapter.approving.has(id)
            return undefined
          })
          if (result.status === 'cancelled') {
            adapter.pairing.delete(id)
            const processing = adapter.approving.get(id)
            if (processing) processing.cancelled = true
          }
          if (result.status === 'completed') {
            if (exchange?.kind !== 'pairing' || !grant) return { status: 'expired' }
            // The native poll marks completed before plugin persistence. A
            // cancellation can settle an existing delivery but cannot start one.
            if (cancel && !grant.delivery) {
              adapter.pairing.delete(id)
              return { status: 'cancelled' }
            }
            exchange.grant = grant
          }
          return withdrawn && result.status === 'unavailable' ? { status: 'expired' } : result
        },
    )
  }

  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
    peer: SessionPeer | undefined,
  ): Promise<void> {
    try {
      if (req.method === 'GET') {
        const token = currentSessionToken(req)
        const session = token && this.auth.session(token)
        if (!session) throw new AuthError('unauthorized')
        return sendJson(res, 200, {
          canAuthorize: session.source === 'password',
          totpEnabled: this.auth.status().totpEnabled,
        })
      }
      if (req.method !== 'POST') throw new HttpFailure(405, 'method_not_allowed')
      const ownerHash = this.owner(peer)
      const command = readCommand(await readJsonBody(req))
      const key = ownerHash + ':' + command.requestId
      const action = `${command.pairingId ?? 'qr'}:${command.days}`
      const known = this.operations.get(key)
      if (known) {
        if (known.action !== action) throw new AuthError('conflict')
        if (!known.promise || known.responseExpiresAt <= Date.now())
          throw new HttpFailure(410, 'expired')
        const authorized = await known.promise
        this.owner(peer)
        return this.sendAuthorization(res, authorized)
      }
      const receipt: Operation = {
        ownerHash,
        action,
        responseExpiresAt: Infinity,
        promise: undefined,
      }
      const promise = this.authorize(ownerHash, peer!, command)
      receipt.promise = promise
      this.operations.set(key, receipt)
      let authorized: Authorized
      try {
        authorized = await promise
      } catch (error) {
        this.operations.delete(key)
        throw error
      }
      receipt.responseExpiresAt = authorized.grant.expiresAt
      if (!res.destroyed) this.sendAuthorization(res, authorized)
    } catch (error) {
      if (res.destroyed) return
      sendHttpError(req, res, error)
    }
  }

  private sendAuthorization(res: ServerResponse, { result, grant }: Authorized): void {
    const lifetimeMs = grant.expiresAt - Date.now()
    if (
      lifetimeMs <= 0 ||
      (result !== 'approved' && this.remote.tickets.state(result.id) !== 'pending')
    )
      throw new HttpFailure(410, 'expired')
    sendJson(res, 200, { result: result === 'approved' ? result : { ...result, lifetimeMs } })
  }

  private async authorize(
    ownerHash: string,
    peer: SessionPeer,
    command: Command,
  ): Promise<Authorized> {
    this.sweep()
    const pairingId = command.pairingId
    const approving = { cancelled: false }
    let provisionalPairing: NativePairingRecord | undefined
    let provisional: NativeTicket | undefined
    let expiresAt = Infinity
    try {
      const authorized = await this.auth.authorizeRemote(
        ownerHash,
        command.code,
        async (owner) => {
          this.owner(peer)
          if (pairingId !== null) {
            const record = this.remote.pairing.records.get(pairingId)
            if (record?.outcome.status !== 'pending' || record.expiresAt <= Date.now())
              throw new HttpFailure(410, 'expired')
            provisionalPairing = record
            expiresAt = record.expiresAt
            this.approving.set(pairingId, approving)
          }
          const result = await this.commands.run({ peer, id: pairingId, used: false }, () =>
            this.gateway.invoke({
              namespace: 'remoteConnection',
              method: pairingId === null ? 'create' : 'decidePairing',
              args: pairingId === null ? {} : { id: pairingId, decision: 'allow' },
              peer,
              signal: this.lifetime.signal,
            }),
          )
          const grantBase = {
            ownerHash,
            days: command.days,
            securityVersion: owner.securityVersion,
          }
          if (pairingId !== null) {
            if (result !== 'approved' || approving.cancelled) throw new HttpFailure(410, 'expired')
            return {
              result,
              grant: { ...grantBase, id: pairingId, expiresAt },
            } satisfies Authorized
          }
          const ticket = result as NativeTicket
          if (
            !ticket ||
            typeof ticket.id !== 'string' ||
            typeof ticket.url !== 'string' ||
            !Number.isSafeInteger(ticket.lifetimeMs) ||
            ticket.lifetimeMs <= 0
          )
            throw new Error('auth-remote: malformed alpha.2 invitation result')
          provisional = ticket
          expiresAt = Date.now() + ticket.lifetimeMs
          return {
            result: ticket,
            grant: { ...grantBase, id: ticket.id, expiresAt },
          }
        },
        () =>
          !this.lifetime.signal.aborted &&
          !approving.cancelled &&
          expiresAt > Date.now() &&
          (!provisional || this.remote.tickets.state(provisional.id) === 'pending'),
      )
      if (!this.pending(authorized.grant) || approving.cancelled)
        throw new HttpFailure(410, 'expired')
      if (pairingId === null) this.invitation = authorized.grant
      else this.pairing.set(pairingId, authorized.grant)
      return authorized
    } catch (error) {
      if (provisional) this.remote.tickets.cancel(provisional.id)
      // Native approval happens before the factor commit. Restore only the same live request.
      if (
        pairingId !== null &&
        this.approving.get(pairingId) === approving &&
        provisionalPairing?.outcome.status === 'approved' &&
        provisionalPairing.expiresAt > Date.now() &&
        this.remote.pairing.records.get(pairingId) === provisionalPairing
      )
        provisionalPairing.outcome = { status: 'pending' }
      throw error
    } finally {
      if (pairingId !== null && this.approving.get(pairingId) === approving)
        this.approving.delete(pairingId)
    }
  }

  private async deliver(grant: Grant): Promise<{ token: string; expiresAt: number }> {
    if (!grant.delivery && !this.pending(grant)) throw new HttpFailure(410, 'expired')
    const issued = (grant.delivery ??= this.auth.claimRemote(
      grant.ownerHash,
      grant.securityVersion,
      grant.days,
      grant.expiresAt,
      this.lifetime.signal,
    ))
    try {
      const session = await issued
      if (this.lifetime.signal.aborted || !this.auth.session(session.token))
        throw new HttpFailure(410, 'expired')
      grant.delivered = session.token
      return session
    } catch (error) {
      if (!grant.delivered && grant.delivery === issued) delete grant.delivery
      throw error
    }
  }

  private async exchange(
    req: IncomingMessage,
    res: ServerResponse,
    next: () => Promise<void>,
  ): Promise<void> {
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://auth-remote.invalid')
    } catch {
      return next()
    }
    const qr = req.method === 'POST' && isQrExchange(url)
    if (
      !qr &&
      (req.method !== 'POST' ||
        (url.pathname !== '/pairing/status' && url.pathname !== '/pairing/cancel'))
    )
      return next()
    const exchange: { kind: 'qr' | 'pairing'; grant?: Grant } = { kind: qr ? 'qr' : 'pairing' }
    const { writeHead, end } = res
    let success: { status: number; headers: OutgoingHttpHeaders; body?: string } | undefined
    res.writeHead = new Proxy(writeHead, {
      apply(target, receiver, args) {
        const [status, headers] = args as [number, OutgoingHttpHeaders | undefined]
        if (
          status === (qr ? 204 : 200) &&
          typeof headers?.['set-cookie'] === 'string' &&
          headers['set-cookie'].startsWith('dsh-remote-')
        ) {
          success = { status, headers }
          return res
        }
        return Reflect.apply(target, receiver, args)
      },
    })
    res.end = new Proxy(end, {
      apply(target, receiver, args) {
        if (!success) return Reflect.apply(target, receiver, args)
        if (typeof args[0] === 'string') success.body = args[0]
        return res
      },
    })
    try {
      await this.exchanges.run(exchange, next)
    } finally {
      res.writeHead = writeHead
      res.end = end
    }
    if (!success || res.destroyed) return
    try {
      const context = requireRequestContext(req)
      const grant = exchange.grant
      if (
        !grant ||
        !context.mayWriteCookie ||
        (exchange.kind === 'pairing' && this.pairing.get(grant.id) !== grant)
      )
        throw new HttpFailure(410, 'expired')
      const session = await this.deliver(grant)
      if (res.destroyed) return
      writeHead.call(res, success.status, {
        ...success.headers,
        'set-cookie': cookieHeader(session.token, session.expiresAt, context.protocol === 'https:'),
      })
      res.end(success.body)
    } catch (error) {
      if (res.destroyed) return
      const expired =
        (error instanceof HttpFailure && error.status === 410) ||
        (error instanceof AuthError && error.code === 'unauthorized')
      if (qr) res.writeHead(expired ? 410 : 503, { 'cache-control': 'no-store' }).end()
      else sendJson(res, expired ? 200 : 503, { status: expired ? 'expired' : 'unavailable' })
    }
  }
}
