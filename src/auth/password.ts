import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import type { PasswordRecord } from '../storage/state.js'

export const PASSWORD_MIN_CHARACTERS = 12
export const PASSWORD_MAX_CHARACTERS = 256

export class PasswordValidationError extends Error {
  constructor() {
    super('auth-remote: password must contain 12–256 Unicode characters')
  }
}

export function validatePassword(password: unknown): asserts password is string {
  if (
    typeof password !== 'string' ||
    [...password].length < PASSWORD_MIN_CHARACTERS ||
    [...password].length > PASSWORD_MAX_CHARACTERS
  )
    throw new PasswordValidationError()
}

async function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    scryptCallback(
      password,
      Buffer.from(salt, 'hex'),
      64,
      { N: 16_384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    )
  })
}

export async function hashPassword(password: string): Promise<PasswordRecord> {
  validatePassword(password)
  const salt = randomBytes(32).toString('hex')
  return { salt, hash: (await derive(password, salt)).toString('hex') }
}

export async function verifyPassword(password: string, record: PasswordRecord): Promise<boolean> {
  const derived = await derive(password, record.salt)
  return timingSafeEqual(derived, Buffer.from(record.hash, 'hex'))
}

/** Wrong usernames still perform a comparable derivation. */
export const DUMMY_PASSWORD_RECORD: PasswordRecord = {
  salt: '0'.repeat(64),
  hash: '0'.repeat(128),
}
