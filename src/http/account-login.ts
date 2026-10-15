import { randomInt } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { AccountCallbackBridge } from '../adapters/dsh/account-callback.js'
import type { GuardedWebServer } from '../adapters/dsh/webserver.js'
import { AuthError, type AuthService } from '../auth/service.js'
import { sessionHash } from '../auth/sessions.js'
import {
  ACCOUNT_CALLBACK_PATH,
  ACCOUNT_LOGIN_BASE,
  isActiveAccountLogin,
  supportsManualAccountLogin,
  type AccountLoginState,
} from '../shared/account-login.js'
import type { AuthState, SessionRecord } from '../storage/state.js'
import type { AuthStateStore } from '../storage/store.js'
import {
  currentSessionToken,
  HttpFailure,
  readJsonBody,
  sendJson,
  sendHttpError,
  stringField,
} from './routes.js'

/** Only the public account service surface is used; no private provider state. */
export interface AccountProvider {
  getState(): Promise<Omit<AccountLoginState, 'supported'>>
  startSignIn(
    client: { version: string; locale: string; timezoneOffsetSeconds: number },
    callbackOrigin: string,
    source: 'web',
  ): Promise<Omit<AccountLoginState, 'supported'>>
  cancelSignIn(id: string): Promise<unknown>
}

interface OwnedAttempt {
  owner: string
  provider: AccountProvider
  callbackOrigin: string
  deadline: number
  id?: string
  cancelled: boolean
  submitting: boolean
  timer?: NodeJS.Timeout
  cancellation?: Promise<void>
}

/** Authenticated clipboard handoff into the native state/PKCE/credential lifecycle. */
export class ManualAccountLogin {
  private readonly bridge = new AccountCallbackBridge()
  private readonly unsubscribe: () => void
  private active: OwnedAttempt | undefined
  private starting = false
  private disposed = false
  private currentProvider: AccountProvider | undefined
  private disposal: Promise<void> | undefined

  constructor(
    ctx: Context,
    private readonly auth: AuthService,
    store: AuthStateStore,
    private readonly version: string,
  ) {
    this.unsubscribe = store.subscribe((_before, after) => this.reconcile(after))
    // Enable this temporary adapter only on the reviewed release. Other
    // compositions retain their native callback and dependency lifecycle.
    if (!supportsManualAccountLogin(version)) return
    // Cordis returns a fresh traceable proxy on every get(). Retain one
    // dependency generation, and cancel its attempt before it unloads.
    ctx.inject(['deepseekAccount'], (accountCtx) => {
      const provider = accountCtx.get('deepseekAccount') as AccountProvider
      accountCtx.effect(() => {
        this.currentProvider = provider
        return async () => {
          if (this.currentProvider === provider) this.currentProvider = undefined
          if (this.active?.provider === provider) await this.cancelAttempt(this.active)
        }
      }, 'auth-remote: account provider lifetime')
    })
  }

  install(server: GuardedWebServer): void {
    if (supportsManualAccountLogin(this.version)) server.installAccountCallbackBridge(this.bridge)
    for (const action of ['state', 'start', 'submit', 'cancel'])
      server.register({
        kind: 'exact',
        path: `${ACCOUNT_LOGIN_BASE}/${action}`,
        handler: (req, res) => this.handle(req, res, action),
      })
  }

  private provider(): AccountProvider | undefined {
    const provider = this.currentProvider
    return provider &&
      typeof provider.getState === 'function' &&
      typeof provider.startSignIn === 'function' &&
      typeof provider.cancelSignIn === 'function'
      ? provider
      : undefined
  }

  private session(token: string | null): { hash: string; session: SessionRecord } {
    const session = token && !this.disposed ? this.auth.session(token) : null
    if (!token || !session) throw new AuthError('unauthorized')
    return { hash: sessionHash(token), session }
  }

  private owned(token: string | null, id: string): OwnedAttempt {
    const { hash } = this.session(token)
    const active = this.active
    if (!active || active.owner !== hash || active.id !== id)
      throw new HttpFailure(409, 'account_attempt_mismatch')
    if (active.cancelled || active.deadline <= Date.now())
      throw new HttpFailure(410, 'account_attempt_expired')
    if (this.provider() !== active.provider) throw new HttpFailure(409, 'account_attempt_mismatch')
    return active
  }

  private schedule(attempt: OwnedAttempt): void {
    if (attempt.timer) clearTimeout(attempt.timer)
    attempt.timer = setTimeout(
      () => void this.cancelAttempt(attempt).catch(() => {}),
      Math.max(1, attempt.deadline - Date.now()),
    )
    attempt.timer.unref()
  }

  private async state(token: string | null): Promise<AccountLoginState> {
    const { hash } = this.session(token)
    const provider = this.provider()
    if (!provider) return { supported: false, status: 'signed-out', attempt: null }
    const view = await provider.getState()
    this.session(token)
    const active = this.active
    if (
      !active ||
      active.owner !== hash ||
      active.provider !== provider ||
      active.id !== view.attempt?.id
    )
      return { supported: true, status: view.status, attempt: null }
    const attempt = view.attempt
    if (attempt?.expiresAt !== undefined && attempt.expiresAt < active.deadline) {
      active.deadline = attempt.expiresAt
      this.schedule(active)
    }
    if (attempt && !isActiveAccountLogin(attempt.phase) && active.timer) clearTimeout(active.timer)
    return {
      supported: true,
      status: view.status,
      attempt: attempt && { ...attempt, expiresAt: active.deadline },
    }
  }

  private async start(
    token: string | null,
    body: Record<string, unknown>,
  ): Promise<AccountLoginState> {
    const owner = this.session(token)
    const locale = stringField(body, 'locale')
    const offset = body.timezoneOffsetSeconds
    if (
      locale.length > 64 ||
      !/^[a-z][a-z0-9_-]*$/iu.test(locale) ||
      !Number.isInteger(offset) ||
      Math.abs(offset as number) > 86_400
    )
      throw new HttpFailure(400, 'invalid_input')
    if (this.starting) throw new HttpFailure(409, 'account_busy')
    const provider = this.provider()
    if (!provider) throw new HttpFailure(503, 'account_unavailable')
    this.starting = true
    let entry: OwnedAttempt | undefined
    try {
      const previous = await provider.getState()
      if (previous.attempt && isActiveAccountLogin(previous.attempt.phase))
        throw new HttpFailure(409, 'account_busy')
      if (previous.status === 'credential-stored')
        return { ...previous, supported: true, attempt: null }
      if (this.active?.timer) clearTimeout(this.active.timer)
      entry = {
        owner: owner.hash,
        provider,
        callbackOrigin: `http://127.0.0.1:${randomInt(49152, 65536)}`,
        deadline: Math.min(Date.now() + 600_000, owner.session.expiresAt),
        cancelled: false,
        submitting: false,
      }
      this.active = entry
      this.schedule(entry)
      const view = await provider.startSignIn(
        { version: this.version, locale, timezoneOffsetSeconds: offset as number },
        entry.callbackOrigin,
        'web',
      )
      if (!view.attempt?.id) throw new HttpFailure(503, 'account_unavailable')
      entry.id = view.attempt.id
      // Revocation/unload may finish while the native service is awaiting sign-out.
      if (entry.cancelled || !token || !this.auth.session(token) || this.disposed) {
        await this.cancelAttempt(entry)
        throw new AuthError('unauthorized')
      }
      return await this.state(token)
    } catch (error) {
      if (entry) await this.cancelAttempt(entry)
      throw error
    } finally {
      this.starting = false
    }
  }

  private callback(value: string, active: OwnedAttempt): URLSearchParams {
    if (value.length > 8192 || /[\u0000-\u0020\u007f]/u.test(value.trim()))
      throw new HttpFailure(400, 'account_invalid_callback')
    let url: URL
    try {
      url = new URL(value.trim())
    } catch {
      throw new HttpFailure(400, 'account_invalid_callback')
    }
    if (
      url.origin !== active.callbackOrigin ||
      url.pathname !== ACCOUNT_CALLBACK_PATH ||
      url.username ||
      url.password ||
      url.hash ||
      url.searchParams.getAll('code').length !== 1 ||
      !url.searchParams.get('code') ||
      url.searchParams.getAll('state').length !== 1 ||
      !url.searchParams.get('state') ||
      [...url.searchParams.keys()].some((key) => key !== 'code' && key !== 'state')
    )
      throw new HttpFailure(400, 'account_invalid_callback')
    return url.searchParams
  }

  private async submit(
    token: string | null,
    body: Record<string, unknown>,
  ): Promise<AccountLoginState> {
    const active = this.owned(token, stringField(body, 'id'))
    const query = this.callback(stringField(body, 'callbackUrl'), active)
    if (active.submitting) throw new HttpFailure(409, 'account_busy')
    active.submitting = true
    try {
      const before = await active.provider.getState()
      if (
        !before.attempt ||
        before.attempt.id !== active.id ||
        before.attempt.phase !== 'waiting-browser'
      )
        throw new HttpFailure(409, 'account_attempt_mismatch')
      // Recheck after asynchronous state reads and immediately before handing off.
      this.owned(token, active.id!)
      const status = await this.bridge.submit(query)
      if (status === 400) throw new HttpFailure(400, 'account_invalid_callback')
      const state = await this.state(token)
      if (state.status !== 'credential-stored' || state.attempt?.phase !== 'succeeded')
        throw new HttpFailure(
          status === 410 ? 410 : 409,
          state.attempt?.phase === 'expired'
            ? 'account_attempt_expired'
            : 'account_exchange_failed',
        )
      return state
    } finally {
      active.submitting = false
    }
  }

  private async cancelAttempt(attempt: OwnedAttempt): Promise<void> {
    attempt.cancelled = true
    if (attempt.timer) clearTimeout(attempt.timer)
    if (attempt.id) {
      attempt.cancellation ??= Promise.resolve().then(async () => {
        await attempt.provider.cancelSignIn(attempt.id!)
      })
      await attempt.cancellation
    }
  }

  private async reconcile(state: AuthState): Promise<void> {
    const active = this.active
    if (!active || active.cancelled) return
    const session = state.sessions[active.owner]
    const account = state.account
    if (
      !session ||
      !account ||
      session.accountId !== account.id ||
      session.securityVersion !== account.securityVersion ||
      session.expiresAt <= Date.now() ||
      (this.auth.policySnapshot().requireTotp && !account.totp)
    ) {
      await this.cancelAttempt(active)
    } else {
      active.deadline = Math.min(active.deadline, session.expiresAt)
      this.schedule(active)
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse, action: string): Promise<void> {
    try {
      const token = currentSessionToken(req)
      this.session(token)
      const expected = action === 'state' ? 'GET' : 'POST'
      if (req.method !== expected) throw new HttpFailure(405, 'method_not_allowed')
      if (action === 'state') {
        sendJson(res, 200, await this.state(token))
        return
      }
      const body = await readJsonBody(req)
      switch (action) {
        case 'start':
          sendJson(res, 200, await this.start(token, body))
          break
        case 'submit':
          sendJson(res, 200, await this.submit(token, body))
          break
        case 'cancel': {
          const active = this.owned(token, stringField(body, 'id'))
          await this.cancelAttempt(active)
          sendJson(res, 200, await this.state(token))
          break
        }
      }
    } catch (error) {
      sendHttpError(req, res, error)
    }
  }

  dispose(): Promise<void> {
    return (this.disposal ??= this.disposeAttempt())
  }

  private async disposeAttempt(): Promise<void> {
    this.disposed = true
    this.unsubscribe()
    if (this.active) await this.cancelAttempt(this.active)
  }
}
