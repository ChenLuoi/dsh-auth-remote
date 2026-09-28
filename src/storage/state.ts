/** The only persisted representation of account and full-session state. */
export const STATE_SCHEMA_VERSION = 1

export interface PasswordRecord {
  salt: string
  hash: string
}

export interface TotpRecord {
  secret: string
  lastUsedStep: number | null
  backupCodeHashes: string[]
}

export interface AccountRecord {
  id: string
  username: string
  password: PasswordRecord
  totp: TotpRecord | null
  securityVersion: number
}

export interface SessionRecord {
  accountId: string
  securityVersion: number
  createdAt: number
  expiresAt: number
}

export interface AuthState {
  schemaVersion: typeof STATE_SCHEMA_VERSION
  revision: number
  account: AccountRecord | null
  /** Keys are SHA-256 token hashes, never bearer tokens. */
  sessions: Record<string, SessionRecord>
}

export function emptyState(): AuthState {
  return { schemaVersion: STATE_SCHEMA_VERSION, revision: 0, account: null, sessions: {} }
}

function record(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`auth-remote: invalid ${label}`)
  const entries = Object.keys(value)
  if (entries.length !== keys.length || entries.some((key) => !keys.includes(key)))
    throw new Error(`auth-remote: invalid ${label} fields`)
  return value as Record<string, unknown>
}

function integer(value: unknown, label: string, min = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < min)
    throw new Error(`auth-remote: invalid ${label}`)
  return value as number
}

function nonempty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`auth-remote: invalid ${label}`)
  return value
}

function hex(value: unknown, bytes: number, label: string): string {
  if (typeof value !== 'string' || !new RegExp(`^[a-f0-9]{${bytes * 2}}$`, 'u').test(value))
    throw new Error(`auth-remote: invalid ${label}`)
  return value
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value))
    throw new Error(`auth-remote: invalid ${label}`)
  return value
}

export function validateState(value: unknown): AuthState {
  const state = record(value, ['schemaVersion', 'revision', 'account', 'sessions'], 'state')
  if (state.schemaVersion !== STATE_SCHEMA_VERSION)
    throw new Error(`auth-remote: unsupported state schema version ${String(state.schemaVersion)}`)
  const revision = integer(state.revision, 'revision')
  let account: AccountRecord | null = null
  if (state.account !== null) {
    const entry = record(
      state.account,
      ['id', 'username', 'password', 'totp', 'securityVersion'],
      'account',
    )
    const password = record(entry.password, ['salt', 'hash'], 'password record')
    let totp: TotpRecord | null = null
    if (entry.totp !== null) {
      const factor = record(
        entry.totp,
        ['secret', 'lastUsedStep', 'backupCodeHashes'],
        'TOTP record',
      )
      if (!Array.isArray(factor.backupCodeHashes) || factor.backupCodeHashes.length > 10)
        throw new Error('auth-remote: invalid backup code hashes')
      if (typeof factor.secret !== 'string' || !/^[A-Z2-7]{32}$/u.test(factor.secret))
        throw new Error('auth-remote: invalid TOTP secret')
      totp = {
        secret: factor.secret,
        lastUsedStep:
          factor.lastUsedStep === null ? null : integer(factor.lastUsedStep, 'TOTP step'),
        backupCodeHashes: factor.backupCodeHashes.map((hash) => digest(hash, 'backup code hash')),
      }
      if (new Set(totp.backupCodeHashes).size !== totp.backupCodeHashes.length)
        throw new Error('auth-remote: duplicate backup code hash')
    }
    const username = nonempty(entry.username, 'username')
    if ([...username].length > 64 || /[\u0000-\u001f\u007f]/u.test(username))
      throw new Error('auth-remote: invalid username')
    account = {
      id: hex(entry.id, 16, 'account id'),
      username,
      password: {
        salt: hex(password.salt, 32, 'password salt'),
        hash: hex(password.hash, 64, 'password hash'),
      },
      totp,
      securityVersion: integer(entry.securityVersion, 'security version', 1),
    }
  }
  const sessions = state.sessions
  if (typeof sessions !== 'object' || sessions === null || Array.isArray(sessions))
    throw new Error('auth-remote: invalid sessions')
  const validatedSessions: Record<string, SessionRecord> = Object.create(null)
  for (const [hash, value] of Object.entries(sessions)) {
    digest(hash, 'session token hash')
    const session = record(
      value,
      ['accountId', 'securityVersion', 'createdAt', 'expiresAt'],
      'session',
    )
    const createdAt = integer(session.createdAt, 'session creation')
    const expiresAt = integer(session.expiresAt, 'session expiry')
    if (!account || session.accountId !== account.id || expiresAt <= createdAt)
      throw new Error('auth-remote: invalid session account or lifetime')
    validatedSessions[hash] = {
      accountId: account.id,
      securityVersion: integer(session.securityVersion, 'session security version', 1),
      createdAt,
      expiresAt,
    }
  }
  return { schemaVersion: STATE_SCHEMA_VERSION, revision, account, sessions: validatedSessions }
}
