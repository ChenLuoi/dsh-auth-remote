import type { Config as WebServerConfig } from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import { isIP } from 'node:net'
import { createOriginPolicy, type OriginPolicy } from './http/origin-policy.js'

export interface AuthConfig {
  allowedOrigins?: string[]
  requireTotp?: boolean
  sessionHours?: number
  preserveOriginPaths?: string[]
}

export interface ResolvedAuthConfig extends Omit<WebServerConfig, 'host'> {
  host: string
  allowedOrigins: readonly string[]
  originPolicy: OriginPolicy
  requireTotp: boolean
  sessionHours: number
  preserveOriginPaths: readonly string[]
}

export const DEFAULT_REQUIRE_TOTP = true
export const DEFAULT_SESSION_HOURS = 168
export const DEFAULT_WEB_HOST = '127.0.0.1'
export const DEFAULT_WEB_PORT = 3080
const AUTH_CONFIG_KEYS = new Set([
  'allowedOrigins',
  'requireTotp',
  'sessionHours',
  'preserveOriginPaths',
])

export interface WebListenerConfig extends Omit<WebServerConfig, 'host'> {
  host: string
}

// The Loader resolves defaults before apply(). Programmatic activation is
// checked here as well because it need not pass through the Loader.
export const Config: z<AuthConfig> = z.object({
  allowedOrigins: z.array(z.string()).default([]),
  requireTotp: z.boolean().default(DEFAULT_REQUIRE_TOTP),
  sessionHours: z.number().step(1).min(1).default(DEFAULT_SESSION_HOURS),
  preserveOriginPaths: z.array(z.string()).default([]),
})

export function resolveAuthConfig(
  input: AuthConfig,
  listener: WebListenerConfig,
): ResolvedAuthConfig {
  if (typeof input !== 'object' || input === null)
    throw new Error('auth-remote: config is required')
  for (const key of Object.keys(input))
    if (!AUTH_CONFIG_KEYS.has(key))
      throw new Error(`auth-remote: unknown config key ${JSON.stringify(key)}`)
  const config = Config(input)
  if (isIP(listener.host) !== 4) throw new Error('auth-remote: DSH web startup host must be IPv4')
  if (listener.host === '0.0.0.0')
    throw new Error('auth-remote: DSH does not support --host 0.0.0.0')
  if (!Number.isInteger(listener.port) || listener.port < 0 || listener.port > 65535)
    throw new Error('auth-remote: invalid DSH web startup port')
  const originPolicy = createOriginPolicy(config.allowedOrigins ?? [])
  const sessionHours = config.sessionHours ?? DEFAULT_SESSION_HOURS
  if (
    !Number.isSafeInteger(sessionHours) ||
    !Number.isSafeInteger(Date.now() + sessionHours * 3_600_000)
  ) {
    throw new Error('auth-remote: sessionHours exceeds the safe timestamp range')
  }
  const paths = config.preserveOriginPaths ?? []
  const seen = new Set<string>()
  for (const path of paths) {
    if (!isCanonicalPathPrefix(path)) {
      throw new Error(`auth-remote: invalid preserveOriginPaths entry ${JSON.stringify(path)}`)
    }
    if (seen.has(path))
      throw new Error(`auth-remote: duplicate preserveOriginPaths entry ${JSON.stringify(path)}`)
    seen.add(path)
  }
  return {
    host: listener.host,
    port: listener.port,
    compression: listener.compression ?? 'none',
    compressionLevel: listener.compressionLevel ?? 1,
    compressionThresholdBytes: listener.compressionThresholdBytes ?? 1024,
    allowedOrigins: Object.freeze(originPolicy.registeredOrigins.map((entry) => entry.origin)),
    originPolicy,
    requireTotp: config.requireTotp ?? DEFAULT_REQUIRE_TOTP,
    sessionHours,
    preserveOriginPaths: paths,
  }
}

function isCanonicalPathPrefix(path: string): boolean {
  if (!path.startsWith('/') || (path.length > 1 && path.endsWith('/'))) return false
  if (/[?#*\\]/u.test(path)) return false
  let url: URL
  try {
    url = new URL(path, 'http://auth-remote.invalid')
  } catch {
    return false
  }
  if (url.pathname !== path || url.search !== '' || url.hash !== '') return false
  for (const segment of path.slice(1).split('/')) {
    if (segment === '' && path !== '/') return false
    let decoded: string
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      return false
    }
    if (decoded === '.' || decoded === '..' || /[/\\\u0000-\u001f\u007f]/u.test(decoded))
      return false
  }
  return true
}
