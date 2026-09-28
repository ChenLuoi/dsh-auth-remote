export const AUTH_BASE = '/auth-remote'
export const AUTH_COOKIE = 'dsh_auth_remote'

export interface PublicStateResponse {
  initialized: boolean
  requireTotp: boolean
  profileName: string
}

export interface MeResponse {
  username: string
  totpEnabled: boolean
  requireTotp: boolean
  expiresAt: number
}

export interface AuthErrorResponse {
  error: string
  retryAfter?: number
}

export type LoginResponse =
  | { kind: 'session'; expiresAt: number }
  | { kind: 'mfa'; challenge: string; expiresAt: number }
  | { kind: 'binding'; challenge: string; expiresAt: number }

export interface BindingResponse {
  backupCodes: string[]
}
