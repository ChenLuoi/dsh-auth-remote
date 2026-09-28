import { randomBytes } from 'node:crypto'
import type { AuthState, AccountRecord, SessionRecord } from '../storage/state.js'
import { AuthStateStore } from '../storage/store.js'
import {
  DUMMY_PASSWORD_RECORD,
  hashPassword,
  validatePassword,
  verifyPassword,
} from './password.js'
import { issueSession, sessionFor, sessionHash } from './sessions.js'
import { backupCodeHash, generateBackupCodes, generateTotpSecret, matchedTotpStep } from './totp.js'

export interface AuthPolicy {
  requireTotp: boolean
  sessionHours: number
}

export type AuthErrorCode =
  | 'invalid_input'
  | 'uninitialized'
  | 'already_initialized'
  | 'invalid_credentials'
  | 'invalid_factor'
  | 'invalid_challenge'
  | 'challenge_expired'
  | 'unauthorized'
  | 'rate_limited'
  | 'busy'
  | 'conflict'
  | 'totp_required'

export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    readonly retryAfter?: number,
  ) {
    super(`auth-remote: ${code}`)
  }
}

interface BaseChallenge {
  id: string
  accountId: string
  securityVersion: number
  expiresAt: number
  failures: number
  busy: boolean
}

interface MfaChallenge extends BaseChallenge {
  kind: 'mfa'
}

interface BindingChallenge extends BaseChallenge {
  kind: 'binding'
  secret: string
  originSessionHash: string | null
}

type Challenge = MfaChallenge | BindingChallenge

export type LoginResult =
  | { kind: 'session'; token: string; expiresAt: number }
  | { kind: 'mfa'; challenge: string; expiresAt: number }
  | { kind: 'binding'; challenge: string; secret: string; expiresAt: number }

export interface AuthServiceOptions {
  now?: () => number
}

const LOGIN_CHALLENGE_MS = 5 * 60_000
const BINDING_CHALLENGE_MS = 10 * 60_000
const RATE_WINDOW_MS = 60_000
const MAX_ATTEMPTS = 10
const MAX_CHALLENGES = 32

function validatePolicy(policy: AuthPolicy, now: number): void {
  if (
    typeof policy.requireTotp !== 'boolean' ||
    !Number.isSafeInteger(policy.sessionHours) ||
    policy.sessionHours < 1 ||
    !Number.isSafeInteger(now + policy.sessionHours * 3_600_000)
  )
    throw new AuthError('invalid_input')
}

function validUsername(username: unknown): username is string {
  return (
    typeof username === 'string' &&
    username.length > 0 &&
    [...username].length <= 64 &&
    !/[\u0000-\u001f\u007f]/u.test(username)
  )
}

export class AuthService {
  private readonly now: () => number
  private readonly challenges = new Map<string, Challenge>()
  private readonly attempts: number[] = []
  private activeDerivations = 0
  private policyChanging = false
  private readonly unsubscribe: () => void

  constructor(
    private readonly store: AuthStateStore,
    private policy: AuthPolicy,
    options: AuthServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now
    validatePolicy(policy, this.now())
    this.unsubscribe = store.subscribe((previous, current) => {
      if (previous.account?.securityVersion !== current.account?.securityVersion) {
        this.challenges.clear()
        return
      }
      for (const [id, challenge] of this.challenges) {
        if (
          challenge.kind === 'binding' &&
          challenge.originSessionHash &&
          previous.sessions[challenge.originSessionHash] &&
          !current.sessions[challenge.originSessionHash]
        )
          this.challenges.delete(id)
      }
    })
  }

  dispose(): void {
    this.unsubscribe()
    this.challenges.clear()
  }

  status(): { initialized: boolean; totpEnabled: boolean; activeSessions: number } {
    const state = this.store.current()
    return {
      initialized: state.account !== null,
      totpEnabled: state.account?.totp !== null && state.account?.totp !== undefined,
      activeSessions: Object.values(state.sessions).filter(
        (session) =>
          state.account &&
          session.accountId === state.account.id &&
          session.securityVersion === state.account.securityVersion &&
          session.expiresAt > this.now() &&
          (!this.policy.requireTotp || state.account.totp),
      ).length,
    }
  }

  session(token: string): SessionRecord | null {
    return sessionFor(this.store.current(), token, this.now(), this.policy.requireTotp)
  }

  policySnapshot(): AuthPolicy {
    return { ...this.policy }
  }

  me(token: string): { username: string; totpEnabled: boolean; expiresAt: number } {
    const state = this.store.current()
    const session = sessionFor(state, token, this.now(), this.policy.requireTotp)
    if (!session || !state.account) throw new AuthError('unauthorized')
    return {
      username: state.account.username,
      totpEnabled: state.account.totp !== null,
      expiresAt: session.expiresAt,
    }
  }

  bindingDetails(id: string): { secret: string; expiresAt: number } {
    const challenge = this.challenges.get(id)
    if (!challenge || challenge.kind !== 'binding') throw new AuthError('invalid_challenge')
    if (challenge.expiresAt <= this.now()) {
      this.challenges.delete(id)
      throw new AuthError('challenge_expired')
    }
    const state = this.store.current()
    this.sameAccount(state, challenge.accountId, challenge.securityVersion)
    if (challenge.originSessionHash) {
      const session = state.sessions[challenge.originSessionHash]
      if (!session || session.expiresAt <= this.now()) throw new AuthError('unauthorized')
    }
    return { secret: challenge.secret, expiresAt: challenge.expiresAt }
  }

  pendingChallenges(): number {
    this.expireChallenges()
    return this.challenges.size
  }

  private occupyAttempt(): void {
    const now = this.now()
    while (this.attempts.length > 0 && this.attempts[0]! <= now - RATE_WINDOW_MS)
      this.attempts.shift()
    if (this.attempts.length >= MAX_ATTEMPTS)
      throw new AuthError(
        'rate_limited',
        Math.ceil((this.attempts[0]! + RATE_WINDOW_MS - now) / 1000),
      )
    this.attempts.push(now)
  }

  private async derive<T>(run: () => Promise<T>): Promise<T> {
    if (this.activeDerivations >= 2) throw new AuthError('busy')
    this.activeDerivations++
    try {
      return await run()
    } finally {
      this.activeDerivations--
    }
  }

  private expireChallenges(): void {
    const now = this.now()
    for (const [id, challenge] of this.challenges)
      if (challenge.expiresAt <= now) this.challenges.delete(id)
  }

  private createChallenge(
    kind: 'mfa' | 'binding',
    account: AccountRecord,
    originSessionHash: string | null = null,
  ): LoginResult {
    this.expireChallenges()
    if (this.challenges.size >= MAX_CHALLENGES) throw new AuthError('busy')
    const id = randomBytes(32).toString('base64url')
    const expiresAt = this.now() + (kind === 'mfa' ? LOGIN_CHALLENGE_MS : BINDING_CHALLENGE_MS)
    const base = {
      id,
      accountId: account.id,
      securityVersion: account.securityVersion,
      expiresAt,
      failures: 0,
      busy: false,
    }
    if (kind === 'mfa') {
      this.challenges.set(id, { ...base, kind })
      return { kind, challenge: id, expiresAt }
    }
    const secret = generateTotpSecret()
    this.challenges.set(id, { ...base, kind, secret, originSessionHash })
    return { kind, challenge: id, secret, expiresAt }
  }

  private claim(id: string, kind: Challenge['kind']): Challenge {
    const challenge = this.challenges.get(id)
    if (!challenge || challenge.kind !== kind) throw new AuthError('invalid_challenge')
    if (challenge.expiresAt <= this.now()) {
      this.challenges.delete(id)
      throw new AuthError('challenge_expired')
    }
    if (challenge.busy || challenge.failures >= 5) throw new AuthError('invalid_challenge')
    challenge.busy = true
    return challenge
  }

  private failedChallenge(challenge: Challenge): void {
    challenge.failures++
    if (challenge.failures >= 5) this.challenges.delete(challenge.id)
  }

  private sameAccount(state: AuthState, accountId: string, securityVersion: number): AccountRecord {
    const account = state.account
    if (!account || account.id !== accountId || account.securityVersion !== securityVersion)
      throw new AuthError('conflict')
    return account
  }

  private requireSession(state: AuthState, token: string): AccountRecord {
    if (!sessionFor(state, token, this.now(), this.policy.requireTotp))
      throw new AuthError('unauthorized')
    return state.account!
  }

  private verifyFactor(account: AccountRecord, code: string | undefined): boolean {
    const factor = account.totp
    if (!factor) return true
    if (!code) return false
    const step = matchedTotpStep(factor.secret, code, this.now(), factor.lastUsedStep)
    if (step !== null) {
      factor.lastUsedStep = step
      return true
    }
    const hash = backupCodeHash(code)
    if (!hash) return false
    const index = factor.backupCodeHashes.indexOf(hash)
    if (index < 0) return false
    factor.backupCodeHashes.splice(index, 1)
    return true
  }

  async initialize(username: string, password: string): Promise<void> {
    if (!validUsername(username)) throw new AuthError('invalid_input')
    validatePassword(password)
    if (this.store.current().account) throw new AuthError('already_initialized')
    const record = await this.derive(() => hashPassword(password))
    await this.store.transact((draft) => {
      if (draft.account) throw new AuthError('already_initialized')
      draft.account = {
        id: randomBytes(16).toString('hex'),
        username,
        password: record,
        totp: null,
        securityVersion: 1,
      }
    })
  }

  async login(username: string, password: string): Promise<LoginResult> {
    this.occupyAttempt()
    if (!validUsername(username) || typeof password !== 'string' || password.length > 1024)
      throw new AuthError('invalid_credentials')
    const snapshot = this.store.current()
    const account = snapshot.account
    if (!account) throw new AuthError('uninitialized')
    const match = await this.derive(() =>
      verifyPassword(
        password,
        username === account.username ? account.password : DUMMY_PASSWORD_RECORD,
      ),
    )
    if (!match || username !== account.username) throw new AuthError('invalid_credentials')
    const current = this.store.current()
    const latest = this.sameAccount(current, account.id, account.securityVersion)
    if (latest.totp) return this.createChallenge('mfa', latest)
    if (this.policy.requireTotp) return this.createChallenge('binding', latest)
    const issued = await this.store.transact((draft) => {
      this.sameAccount(draft, account.id, account.securityVersion)
      if (draft.account!.totp || this.policy.requireTotp) throw new AuthError('conflict')
      return issueSession(draft, this.now(), this.policy.sessionHours)
    })
    return { kind: 'session', ...issued }
  }

  async verifyMfa(id: string, code: string): Promise<{ token: string; expiresAt: number }> {
    this.occupyAttempt()
    const challenge = this.claim(id, 'mfa') as MfaChallenge
    try {
      const issued = await this.store.transact((draft) => {
        if (challenge.expiresAt <= this.now()) throw new AuthError('challenge_expired')
        const account = this.sameAccount(draft, challenge.accountId, challenge.securityVersion)
        if (!account.totp || !this.verifyFactor(account, code))
          throw new AuthError('invalid_factor')
        return issueSession(draft, this.now(), this.policy.sessionHours)
      })
      this.challenges.delete(id)
      return issued
    } catch (error) {
      if (error instanceof AuthError && error.code === 'invalid_factor')
        this.failedChallenge(challenge)
      throw error
    } finally {
      challenge.busy = false
    }
  }

  async startBinding(
    token: string,
    password: string,
    currentCode?: string,
  ): Promise<Extract<LoginResult, { kind: 'binding' }>> {
    this.occupyAttempt()
    const snapshot = this.store.current()
    const account = this.requireSession(snapshot, token)
    if (typeof password !== 'string' || password.length > 1024)
      throw new AuthError('invalid_credentials')
    const match = await this.derive(() => verifyPassword(password, account.password))
    if (!match) throw new AuthError('invalid_credentials')
    if (account.totp) {
      await this.store.transact((draft) => {
        this.requireSession(draft, token)
        this.sameAccount(draft, account.id, account.securityVersion)
        if (!this.verifyFactor(draft.account!, currentCode)) throw new AuthError('invalid_factor')
      })
    } else {
      const latest = this.store.current()
      this.requireSession(latest, token)
      this.sameAccount(latest, account.id, account.securityVersion)
    }
    return this.createChallenge('binding', account, sessionHash(token)) as Extract<
      LoginResult,
      { kind: 'binding' }
    >
  }

  async confirmBinding(id: string, code: string): Promise<{ backupCodes: string[] }> {
    this.occupyAttempt()
    const challenge = this.claim(id, 'binding') as BindingChallenge
    try {
      const step = matchedTotpStep(challenge.secret, code, this.now(), null)
      if (step === null) {
        this.failedChallenge(challenge)
        throw new AuthError('invalid_factor')
      }
      const backups = generateBackupCodes()
      await this.store.transact((draft) => {
        if (challenge.expiresAt <= this.now()) throw new AuthError('challenge_expired')
        const account = this.sameAccount(draft, challenge.accountId, challenge.securityVersion)
        const originSession = challenge.originSessionHash
          ? draft.sessions[challenge.originSessionHash]
          : null
        if (
          challenge.originSessionHash &&
          (!originSession || originSession.expiresAt <= this.now())
        )
          throw new AuthError('unauthorized')
        account.totp = {
          secret: challenge.secret,
          lastUsedStep: step,
          backupCodeHashes: backups.hashes,
        }
        account.securityVersion++
        draft.sessions = {}
      })
      this.challenges.clear()
      return { backupCodes: backups.codes }
    } finally {
      challenge.busy = false
    }
  }

  async changePassword(
    token: string,
    currentPassword: string,
    currentCode: string | undefined,
    newPassword: string,
  ): Promise<void> {
    this.occupyAttempt()
    validatePassword(newPassword)
    if (typeof currentPassword !== 'string' || currentPassword.length > 1024)
      throw new AuthError('invalid_credentials')
    const snapshot = this.store.current()
    const account = this.requireSession(snapshot, token)
    const match = await this.derive(() => verifyPassword(currentPassword, account.password))
    if (!match) throw new AuthError('invalid_credentials')
    const replacement = await this.derive(() => hashPassword(newPassword))
    await this.store.transact((draft) => {
      this.requireSession(draft, token)
      const current = this.sameAccount(draft, account.id, account.securityVersion)
      if (!this.verifyFactor(current, currentCode)) throw new AuthError('invalid_factor')
      current.password = replacement
      current.securityVersion++
      draft.sessions = {}
    })
  }

  async disableTotp(token: string, password: string, currentCode: string): Promise<void> {
    this.occupyAttempt()
    if (this.policy.requireTotp) throw new AuthError('totp_required')
    if (typeof password !== 'string' || password.length > 1024)
      throw new AuthError('invalid_credentials')
    const snapshot = this.store.current()
    const account = this.requireSession(snapshot, token)
    const match = await this.derive(() => verifyPassword(password, account.password))
    if (!match) throw new AuthError('invalid_credentials')
    await this.store.transact((draft) => {
      this.requireSession(draft, token)
      const current = this.sameAccount(draft, account.id, account.securityVersion)
      if (!current.totp || !this.verifyFactor(current, currentCode))
        throw new AuthError('invalid_factor')
      current.totp = null
      current.securityVersion++
      draft.sessions = {}
    })
  }

  async revokeWithCredentials(
    token: string,
    password: string,
    currentCode?: string,
  ): Promise<void> {
    this.occupyAttempt()
    if (typeof password !== 'string' || password.length > 1024)
      throw new AuthError('invalid_credentials')
    const snapshot = this.store.current()
    const account = this.requireSession(snapshot, token)
    const match = await this.derive(() => verifyPassword(password, account.password))
    if (!match) throw new AuthError('invalid_credentials')
    await this.store.transact((draft) => {
      this.requireSession(draft, token)
      const current = this.sameAccount(draft, account.id, account.securityVersion)
      if (!this.verifyFactor(current, currentCode)) throw new AuthError('invalid_factor')
      current.securityVersion++
      draft.sessions = {}
    })
  }

  async logout(token: string): Promise<void> {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(token)) return
    const hash = sessionHash(token)
    if (!this.store.current().sessions[hash]) return
    await this.store.transact((draft) => {
      delete draft.sessions[hash]
    })
  }

  async resetPassword(newPassword: string): Promise<void> {
    validatePassword(newPassword)
    const replacement = await this.derive(() => hashPassword(newPassword))
    await this.store.transact((draft) => {
      if (!draft.account) throw new AuthError('uninitialized')
      draft.account.password = replacement
      draft.account.securityVersion++
      draft.sessions = {}
    })
  }

  async resetTotp(): Promise<void> {
    await this.store.transact((draft) => {
      if (!draft.account) throw new AuthError('uninitialized')
      draft.account.totp = null
      draft.account.securityVersion++
      draft.sessions = {}
    })
  }

  async revokeAll(): Promise<void> {
    await this.store.transact((draft) => {
      if (!draft.account) throw new AuthError('uninitialized')
      draft.account.securityVersion++
      draft.sessions = {}
    })
  }

  async applyPolicy(next: AuthPolicy): Promise<void> {
    validatePolicy(next, this.now())
    if (this.policyChanging) throw new AuthError('busy')
    if (
      next.requireTotp === this.policy.requireTotp &&
      next.sessionHours === this.policy.sessionHours
    )
      return
    this.policyChanging = true
    const previous = this.policy
    this.policy = next // fail closed while the policy commit is pending
    try {
      await this.store.transact((draft) => {
        if (next.requireTotp && !previous.requireTotp && draft.account && !draft.account.totp) {
          draft.account.securityVersion++
          draft.sessions = {}
        }
        if (next.sessionHours < previous.sessionHours) {
          for (const session of Object.values(draft.sessions))
            session.expiresAt = Math.min(
              session.expiresAt,
              session.createdAt + next.sessionHours * 3_600_000,
            )
        }
      })
      this.challenges.clear()
    } catch (error) {
      if (this.store.healthy()) this.policy = previous
      throw error
    } finally {
      this.policyChanging = false
    }
  }

  /** Startup/re-activation must persist tightening before the guarded listener opens. */
  async enforceCurrentPolicy(): Promise<void> {
    const state = this.store.current()
    const revokeUnbound =
      this.policy.requireTotp && !state.account?.totp && Object.keys(state.sessions).length > 0
    const shorten = Object.values(state.sessions).some(
      (session) => session.expiresAt > session.createdAt + this.policy.sessionHours * 3_600_000,
    )
    if (!revokeUnbound && !shorten) return
    await this.store.transact((draft) => {
      if (this.policy.requireTotp && draft.account && !draft.account.totp) {
        draft.account.securityVersion++
        draft.sessions = {}
      }
      for (const session of Object.values(draft.sessions))
        session.expiresAt = Math.min(
          session.expiresAt,
          session.createdAt + this.policy.sessionHours * 3_600_000,
        )
    })
  }
}
