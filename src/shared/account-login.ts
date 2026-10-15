/** The manual callback is transported in an authenticated POST, never fetched. */
export const ACCOUNT_LOGIN_BASE = '/auth-remote/account'
export const ACCOUNT_CALLBACK_PATH = '/oauth/callback'
export const ACCOUNT_LOGIN_CAPABILITY = '__DSH_AUTH_REMOTE_MANUAL_ACCOUNT_LOGIN__'

/** Temporary adapter: future releases must be reviewed before enabling it. */
export function supportsManualAccountLogin(version: string): boolean {
  return version === '0.2.1-alpha.3'
}

export type AccountLoginPhase =
  | 'initializing'
  | 'waiting-browser'
  | 'exchanging'
  | 'committing'
  | 'succeeded'
  | 'failed'
  | 'expired'
  | 'cancelled'

export interface AccountLoginAttempt {
  id: string
  phase: AccountLoginPhase
  authorizeUrl?: string
  expiresAt?: number
  errorCode?: string
}

export interface AccountLoginState {
  supported: boolean
  status: 'signed-out' | 'credential-stored'
  attempt: AccountLoginAttempt | null
}

export function isActiveAccountLogin(phase: AccountLoginPhase): boolean {
  return ['initializing', 'waiting-browser', 'exchanging', 'committing'].includes(phase)
}
