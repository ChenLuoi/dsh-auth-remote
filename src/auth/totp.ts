import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
export const TOTP_PERIOD_MS = 30_000

function base32(bytes: Buffer): string {
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31]
  return output
}

function fromBase32(value: string): Buffer {
  let bits = 0
  let accum = 0
  const output: number[] = []
  for (const char of value) {
    const digit = alphabet.indexOf(char)
    if (digit < 0) throw new Error('auth-remote: invalid TOTP secret')
    accum = (accum << 5) | digit
    bits += 5
    if (bits >= 8) {
      output.push((accum >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(output)
}

export function generateTotpSecret(): string {
  return base32(randomBytes(20))
}

export function totpCode(secret: string, step: number): string {
  if (!Number.isSafeInteger(step) || step < 0) throw new Error('auth-remote: invalid TOTP step')
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const mac = createHmac('sha1', fromBase32(secret)).update(counter).digest()
  const offset = mac[mac.length - 1]! & 15
  const value = (mac.readUInt32BE(offset) & 0x7fff_ffff) % 1_000_000
  return String(value).padStart(6, '0')
}

export function matchedTotpStep(
  secret: string,
  code: string,
  timestamp: number,
  lastUsedStep: number | null,
): number | null {
  if (typeof code !== 'string' || !/^\d{6}$/u.test(code)) return null
  const current = Math.floor(timestamp / TOTP_PERIOD_MS)
  for (const step of [current - 1, current, current + 1]) {
    if (step < 0 || (lastUsedStep !== null && step <= lastUsedStep)) continue
    if (timingSafeEqual(Buffer.from(totpCode(secret, step)), Buffer.from(code))) return step
  }
  return null
}

export function backupCodeHash(code: string): string | null {
  if (typeof code !== 'string') return null
  const canonical = code.replaceAll('-', '').toUpperCase()
  if (!/^[A-Z2-7]{20}$/u.test(canonical)) return null
  return createHash('sha256').update(`auth-remote-backup:${canonical}`).digest('hex')
}

export function generateBackupCodes(): { codes: string[]; hashes: string[] } {
  const codes = Array.from({ length: 10 }, () =>
    base32(randomBytes(12))
      .match(/.{1,5}/gu)!
      .join('-'),
  )
  return { codes, hashes: codes.map((code) => backupCodeHash(code)!) }
}
