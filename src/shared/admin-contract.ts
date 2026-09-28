export const ADMIN_PROTOCOL_VERSION = 1
export const ADMIN_MAX_BYTES = 16 * 1024

export type AdminRequest =
  | { version: 1; command: 'status' }
  | { version: 1; command: 'init'; username: string; password: string }
  | { version: 1; command: 'reset-password'; password: string }
  | { version: 1; command: 'reset-totp' }
  | { version: 1; command: 'revoke-sessions' }

export interface AdminStatus {
  initialized: boolean
  totpEnabled: boolean
  activeSessions: number
  online: boolean
  ready: boolean
}

export type AdminResponse =
  | { version: 1; ok: true; result: AdminStatus | { ok: true } }
  | { version: 1; ok: false; error: string }
