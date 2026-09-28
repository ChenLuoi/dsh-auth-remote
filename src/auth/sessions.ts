import { createHash, randomBytes } from 'node:crypto'
import type { AuthState, SessionRecord } from '../storage/state.js'

export function sessionHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function issueSession(
  draft: AuthState,
  now: number,
  sessionHours: number,
): { token: string; expiresAt: number } {
  const account = draft.account
  if (!account) throw new Error('auth-remote: cannot issue a session without an account')
  const expiresAt = now + sessionHours * 3_600_000
  if (!Number.isSafeInteger(expiresAt)) throw new Error('auth-remote: session expiry overflow')
  const token = randomBytes(32).toString('base64url')
  draft.sessions[sessionHash(token)] = {
    accountId: account.id,
    securityVersion: account.securityVersion,
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
): SessionRecord | null {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(token)) return null
  const session = state.sessions[sessionHash(token)]
  const account = state.account
  if (
    !session ||
    !account ||
    session.accountId !== account.id ||
    session.securityVersion !== account.securityVersion ||
    session.expiresAt <= now ||
    (requireTotp && !account.totp)
  )
    return null
  return session
}
