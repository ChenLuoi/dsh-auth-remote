// Loaded only in the isolated alpha.2 feasibility profile.
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AuthService } from '../../../src/auth/service.ts'
import { totpCode, TOTP_PERIOD_MS } from '../../../src/auth/totp.ts'
import { AuthStateStore } from '../../../src/storage/store.ts'

export const inject = ['connection', 'connection.authentication', 'webServer', 'remoteConnection']

const original = Symbol.for('cordis.original')
const cookie = 'c1_session'
const dayMs = 86_400_000

function readSession(headers) {
  const value = headers instanceof Headers ? headers.get('cookie') : headers.cookie
  const pairs = value
    ?.split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(cookie + '='))
  return pairs?.length === 1 ? pairs[0].slice(cookie.length + 1) : undefined
}

function sessionCookie(token) {
  return `${cookie}=${token}; Path=/; HttpOnly; SameSite=Strict`
}

function send(res, status, value, extra) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    ...extra,
  })
  res.end(JSON.stringify(value))
}

export async function apply(ctx) {
  const authDir = join(process.env.DSH_HOME, 'c1-auth')
  await mkdir(authDir, { mode: 0o700 })
  const store = await AuthStateStore.open(authDir)
  const auth = new AuthService(store, { sessionHours: 12, requireTotp: false })
  const password = process.env.DSH_C1_PASSWORD
  if (!password) throw new Error('isolated proof password is required')
  await auth.initialize('owner', password)
  const unsigned = await auth.login('owner', password)
  const binding = await auth.startBinding(unsigned.token, password)
  const bound = await auth.confirmBinding(
    binding.challenge,
    totpCode(binding.secret, Math.floor(Date.now() / TOTP_PERIOD_MS)),
  )

  const sessions = new Map()
  const sessionByPeer = new Map()
  const staged = new Map()
  const approvals = new Map()
  const exchange = new AsyncLocalStorage()
  const undo = []
  let qr
  let loginDone = false
  const connection = ctx.connection
  const registry = ctx['connection.authentication'][original]
  const remote = ctx.remoteConnection[original]

  const patch = (object, key, arity, wrap) => {
    const method = object[key]
    if (typeof method !== 'function' || method.length !== arity)
      throw new Error(`unexpected alpha.2 hook ${key}`)
    const descriptor = Object.getOwnPropertyDescriptor(object, key)
    Object.defineProperty(object, key, { configurable: true, writable: true, value: wrap(method) })
    undo.push(() => {
      if (descriptor) Object.defineProperty(object, key, descriptor)
      else delete object[key]
      if (object[key] !== method) throw new Error(`alpha.2 hook restoration failed for ${key}`)
    })
  }

  const current = (session) =>
    Boolean(
      session &&
      !session.peer.signal.aborted &&
      session.expiresAt > Date.now() &&
      (session.role === 'B' || auth.session(session.token)),
    )
  const identify = (request) => {
    const session = sessions.get(readSession(request.headers))
    return current(session) ? session : undefined
  }
  const remember = (role, token, expiresAt) => {
    const peer = connection.createPeer({ principal: { kind: 'owner' } })
    const entry = { role, token, expiresAt, peer }
    sessions.set(token, entry)
    sessionByPeer.set(peer, entry)
    return entry
  }
  const issue = (grant) => {
    if (!grant.entry)
      grant.entry = remember(
        'B',
        randomBytes(32).toString('base64url'),
        Date.now() + grant.days * dayMs,
      )
    return grant.entry
  }

  const owner = (receiver) => {
    const invocation = receiver.ctx.invocation
    const session = sessionByPeer.get(invocation?.peer)
    if (session?.role !== 'A' || !current(session) || invocation.signal.aborted)
      throw new Error('owner session required')
    return session
  }
  const take = (receiver, action, id) => {
    const session = owner(receiver)
    const grant = staged.get(session.peer)
    if (!grant || grant.action !== action || grant.id !== id || grant.expiresAt <= Date.now())
      throw new Error('matching step-up required')
    staged.delete(session.peer)
    return grant
  }

  // Native registrations still belong to their own effects. Only the plugin's
  // independently verified Peer can pass the common network selector.
  const provider = {
    authenticate: (request) => identify(request)?.peer,
  }
  const removeProvider = ctx['connection.authentication'].register(provider)
  ctx.effect(
    () => async () => {
      undo.reverse().forEach((restore) => restore())
      await removeProvider()
      await Promise.all([...sessionByPeer.keys()].map((peer) => peer.dispose()))
      if ([...sessionByPeer.keys()].some((peer) => !peer.signal.aborted)) {
        throw new Error('alpha.2 proof left an active Peer during unload')
      }
      auth.dispose()
      await store.close()
      await writeFile(
        join(authDir, 'unloaded'),
        'hooks restored, provider withdrawn, peers disposed\n',
      )
    },
    'alpha.2 proof hooks',
  )

  patch(
    registry,
    'authenticate',
    1,
    (authenticate) =>
      function (request) {
        const session = identify(request)
        if (!session) return { rejection: 401 }
        const headers =
          request.headers instanceof Headers ? new Headers(request.headers) : { ...request.headers }
        const value = `${cookie}=${session.token}`
        if (headers instanceof Headers) headers.set('cookie', value)
        else headers.cookie = value
        const admission = authenticate.call(this, { ...request, headers })
        return admission.peer === session.peer ? admission : { rejection: 401 }
      },
  )

  // Gateway resolves each decorated method on the service view for the
  // invocation. Patch its original instance so the view retains invocation.
  patch(
    remote,
    'create',
    0,
    (create) =>
      function () {
        const grant = take(this, 'create', null)
        const ticket = create.call(this)
        qr = { ...grant, id: ticket.id }
        return ticket
      },
  )
  patch(
    remote,
    'decidePairing',
    3,
    (decide) =>
      function (id, decision, signal) {
        owner(this)
        const grant = decision === 'allow' ? take(this, 'approve', id) : undefined
        const result = decide.call(this, id, decision, signal)
        if (result === 'approved' && grant && !approvals.has(id)) approvals.set(id, grant)
        return result
      },
  )
  patch(
    remote,
    'cancel',
    1,
    (cancel) =>
      function (id) {
        owner(this)
        const result = cancel.call(this, id)
        if (result === 'cancelled' && qr?.id === id) qr = undefined
        return result
      },
  )
  for (const [name, arity] of [
    ['status', 1],
    ['pairingRequests', 1],
    ['loginUrl', 0],
  ]) {
    patch(
      remote,
      name,
      arity,
      (method) =>
        function (...args) {
          owner(this)
          return method.apply(this, args)
        },
    )
  }

  patch(
    remote.tickets,
    'consume',
    1,
    (consume) =>
      function (token) {
        const request = exchange.getStore()
        if (request?.kind !== 'qr' || !current(qr?.session) || !consume.call(this, token))
          return false
        if (this.state(qr.id) !== 'used') return false
        request.grant = qr
        qr = undefined
        return true
      },
  )
  patch(
    remote.pairing,
    'poll',
    5,
    (poll) =>
      function (id, secret, authority, cancel, nativeIssue) {
        const request = exchange.getStore()
        const grant = approvals.get(id)
        const result = poll.call(this, id, secret, authority, cancel, () =>
          request?.kind === 'pairing' && current(grant?.session) ? nativeIssue() : undefined,
        )
        if (result.status === 'completed' && request?.kind === 'pairing' && grant)
          request.grant = grant
        return result
      },
  )

  ctx.on(
    'webserver/request',
    async (req, res, next) => {
      const url = new URL(req.url, 'http://c1.invalid')
      const qrRequest = req.method === 'POST' && url.pathname === '/' && url.search === '?login=qr'
      const pairing = req.method === 'POST' && url.pathname === '/pairing/status'
      if (!qrRequest && !pairing) return next()
      const proof = { kind: qrRequest ? 'qr' : 'pairing', grant: undefined }
      const writeHead = res.writeHead
      res.writeHead = function (status, headers) {
        const nativeCookie = headers?.['set-cookie']
        if (status !== (qrRequest ? 204 : 200) || !nativeCookie)
          return writeHead.call(this, status, headers)
        if (
          !proof.grant ||
          typeof nativeCookie !== 'string' ||
          !nativeCookie.startsWith('dsh-remote-')
        ) {
          return writeHead.call(this, 503, { 'cache-control': 'no-store' })
        }
        const delegated = issue(proof.grant)
        // Retain the native credential only in this isolated proof so its
        // independent exclusion can be checked on the actual HTTP and mux paths.
        return writeHead.call(this, status, {
          ...headers,
          'set-cookie': [sessionCookie(delegated.token), nativeCookie],
        })
      }
      try {
        await exchange.run(proof, next)
      } finally {
        res.writeHead = writeHead
      }
    },
    true,
  )

  const route = (path, authPolicy, handler) =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/__c1/' + path,
      auth: authPolicy,
      handler: async (req, res, peer) => {
        try {
          await handler(req, res, sessionByPeer.get(peer))
        } catch {
          send(res, 403, { ok: false })
        }
      },
    })
  route('session', 'required', (_req, res, session) => {
    if (!session) return send(res, 403, { ok: false })
    send(res, 200, { role: session.role, expiresAt: session.expiresAt })
  })
  route('login', 'anonymous', async (req, res) => {
    if (req.method !== 'POST' || loginDone || req.headers.authorization !== `Proof ${password}`)
      return send(res, 403, { ok: false })
    loginDone = true
    const attempt = await auth.login('owner', password)
    const session = await auth.verifyMfa(attempt.challenge, bound.backupCodes[0])
    remember('A', session.token, session.expiresAt)
    send(
      res,
      200,
      { backupCodes: bound.backupCodes.slice(1) },
      { 'set-cookie': sessionCookie(session.token) },
    )
  })
  route('step', 'required', async (req, res, session) => {
    if (req.method !== 'POST' || session?.role !== 'A') return send(res, 403, { ok: false })
    const { action, id, days, code } = JSON.parse(await new Response(req).text())
    if (
      !['create', 'approve'].includes(action) ||
      (action === 'create' ? id !== null : typeof id !== 'string') ||
      ![1, 3, 7].includes(days)
    ) {
      return send(res, 400, { ok: false })
    }
    await store.transact((draft) => {
      if (!current(session) || !auth.verifyFactor(draft.account, code))
        throw new Error('invalid proof')
    })
    staged.set(session.peer, { action, id, days, session, expiresAt: Date.now() + 30_000 })
    send(res, 200, { ok: true })
  })
  route('ready', 'anonymous', (_req, res) => {
    const providers = [...registry.providers].map((entry) => entry.provider)
    if (providers.length !== 2) return send(res, 503, { ok: false })
    send(res, 200, { pluginProviderIndex: providers.indexOf(provider) })
  })
}
