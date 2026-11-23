import { createHash, randomBytes } from 'node:crypto'
import type { AuthState, SessionRecord } from '../storage/state.js'
import {
  DAY_MS,
  DEFAULT_DELEGATED_SESSION_DAYS,
  isDelegatedSessionDays,
  type DelegatedSessionDays,
} from '../shared/delegation.js'

export function sessionHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function issueSession(
  draft: AuthState,
  now: number,
  sessionHours: number,
): { token: string; expiresAt: number } {
  return issue(draft, now, now + sessionHours * 3_600_000, 'password')
}

export function issueDelegatedSession(
  draft: AuthState,
  now: number,
  days: DelegatedSessionDays = DEFAULT_DELEGATED_SESSION_DAYS,
): { token: string; expiresAt: number } {
  if (!isDelegatedSessionDays(days)) throw new Error('auth-remote: invalid delegated session days')
  return issue(draft, now, now + days * DAY_MS, 'delegated')
}

function issue(
  draft: AuthState,
  now: number,
  expiresAt: number,
  source: SessionRecord['source'],
): { token: string; expiresAt: number } {
  const account = draft.account
  if (!account) throw new Error('auth-remote: cannot issue a session without an account')
  if (!Number.isSafeInteger(expiresAt)) throw new Error('auth-remote: session expiry overflow')
  const token = randomBytes(32).toString('base64url')
  draft.sessions[sessionHash(token)] = {
    accountId: account.id,
    securityVersion: account.securityVersion,
    source,
    createdAt: now,
    expiresAt,
  }
  return { token, expiresAt }
}

export function sessionFor(
  state: AuthState,
  token: string,
  now: number,
  requireTotp: boolean,
  allowDelegated = true,
): SessionRecord | null {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(token)) return null
  const session = state.sessions[sessionHash(token)]
  return session && isActiveSession(state, session, now, requireTotp, allowDelegated)
    ? session
    : null
}

/** Shared admission predicate for authentication and the account overview. */
export function isActiveSession(
  state: AuthState,
  session: SessionRecord,
  now: number,
  requireTotp: boolean,
  allowDelegated = true,
): boolean {
  const account = state.account
  return !!(
    account &&
    session.accountId === account.id &&
    session.securityVersion === account.securityVersion &&
    session.expiresAt > now &&
    (allowDelegated || session.source === 'password') &&
    (!requireTotp || account.totp)
  )
}
