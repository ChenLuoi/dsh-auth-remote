import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'
import { isIP } from 'node:net'
import { resolve } from 'node:path'
import { listenerPublicUrl, parsePublicUrl, type RootPublicUrl } from './adapters/dsh/public-url.js'
import {
  getRuntimeCapabilities,
  listenerTransport,
  validateListenerConfig,
  type RuntimeCapabilities,
  type NativeListenerConfig,
} from './adapters/dsh/runtime-capabilities.js'
import { createOriginPolicy, type OriginPolicy, type OriginProtocol } from './http/origin-policy.js'

export interface AuthConfig {
  publicUrl?: string
  host?: string
  port?: number
  tlsCert?: string
  tlsKey?: string
  allowedOrigins?: string[] | undefined
  requireTotp?: boolean
  manualAccountLogin?: boolean
  sessionHours?: number
  preserveOriginPaths?: string[]
}

export type ParsedAuthConfig = Omit<AuthConfig, 'manualAccountLogin'> & {
  manualAccountLogin: Volatile<boolean>
}

export interface ResolvedAuthConfig extends Omit<PendingAuthConfig, 'publicUrl'> {
  readonly publicUrl: string
  readonly listenerUrl: string
  readonly protocol: OriginProtocol
  readonly nativeAuthority: string
  readonly nativeOrigin: string
  readonly allowedOrigins: readonly string[]
  readonly originPolicy: OriginPolicy
}

export const DEFAULT_REQUIRE_TOTP = false
export const DEFAULT_SESSION_HOURS = 168
export const DEFAULT_WEB_HOST = '127.0.0.1'
export const DEFAULT_WEB_PORT = 3080
const AUTH_CONFIG_KEYS = new Set([
  'allowedOrigins',
  'requireTotp',
  'manualAccountLogin',
  'sessionHours',
  'preserveOriginPaths',
])

// The Loader resolves defaults before apply(). Programmatic activation is
// checked here as well because it need not pass through the Loader.
const StaticConfig: z<Omit<AuthConfig, 'manualAccountLogin'>> = z.object({
  publicUrl: z.string(),
  host: z.string(),
  port: z.number().step(1).min(0).max(65535),
  tlsCert: z.string(),
  tlsKey: z.string(),
  allowedOrigins: z.union([z.array(z.string()), z.const(undefined)]).default(undefined),
  requireTotp: z.boolean().default(DEFAULT_REQUIRE_TOTP),
  sessionHours: z.number().step(1).min(1).default(DEFAULT_SESSION_HOURS),
  preserveOriginPaths: z.array(z.string()).default([]),
})

const ManualAccountLoginConfig = z.boolean().default(true).volatile()
export const Config = z.object({
  ...StaticConfig.dict,
  manualAccountLogin: ManualAccountLoginConfig,
}) as z<AuthConfig, ParsedAuthConfig>

export interface WebStartupConfig {
  host?: string
  port?: number
  publicUrl?: string
  tls?: { certFile?: string; keyFile?: string }
}

export interface PendingAuthConfig extends NativeListenerConfig {
  readonly capabilities: RuntimeCapabilities
  readonly publicUrl: RootPublicUrl | undefined
  readonly publicUrlSource: 'cli' | 'file' | 'legacy' | 'derived'
  readonly tlsSource: 'cli' | 'file' | undefined
  readonly legacyWarning: boolean
  readonly requireTotp: boolean
  readonly manualAccountLogin: Volatile<boolean>
  readonly sessionHours: number
  readonly preserveOriginPaths: readonly string[]
}

/** Resolve effective inputs without reading certificates or constructing a source policy. */
export function resolveStartupConfig(
  input: AuthConfig | ParsedAuthConfig,
  startup: WebStartupConfig,
  context: { version: string; profileDir: string; cwd: string },
): PendingAuthConfig {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new Error('auth-remote: config is required')
  const keys = new Set([...AUTH_CONFIG_KEYS, 'publicUrl', 'host', 'port', 'tlsCert', 'tlsKey'])
  for (const key of Object.keys(input))
    if (!keys.has(key)) throw new Error(`auth-remote: unknown config key ${JSON.stringify(key)}`)
  // Object schema keeps explicitly supplied keys even when null resolves to
  // undefined. Presence must survive that Loader normalization.
  const legacyWarning = Object.hasOwn(input, 'allowedOrigins')
  const explicitUrl = startup.publicUrl !== undefined || Object.hasOwn(input, 'publicUrl')
  if (legacyWarning && explicitUrl)
    throw new Error('auth-remote: publicUrl and allowedOrigins cannot be supplied together')
  // Loader owns parsed volatile references. Validate their current value without
  // reparsing or replacing the reference that it will update in place.
  const { manualAccountLogin: manual, ...ordinary } = input
  const config = StaticConfig(ordinary)
  let manualAccountLogin: Volatile<boolean>
  if (typeof manual === 'object' && manual !== null) {
    if (typeof manual.get !== 'function') throw new Error('auth-remote: invalid manualAccountLogin')
    z.boolean().required()(manual.get())
    manualAccountLogin = manual
  } else {
    manualAccountLogin = ManualAccountLoginConfig(manual)
  }
  const capabilities = getRuntimeCapabilities(context.version)
  let publicUrl: RootPublicUrl | undefined
  let publicUrlSource: PendingAuthConfig['publicUrlSource'] = 'derived'
  if (explicitUrl) {
    publicUrlSource = startup.publicUrl !== undefined ? 'cli' : 'file'
    publicUrl = parsePublicUrl(startup.publicUrl ?? config.publicUrl!)
  } else if (legacyWarning) {
    const origins = config.allowedOrigins!
    if (!Array.isArray(origins)) throw new Error('auth-remote: allowedOrigins must be an array')
    if (origins.length > 1)
      throw new Error('auth-remote: allowedOrigins must select one unique publicUrl')
    if (origins.length === 1) {
      publicUrlSource = 'legacy'
      publicUrl = parsePublicUrl(origins[0]!)
    }
  }
  let tls: NativeListenerConfig['tls']
  let tlsSource: PendingAuthConfig['tlsSource']
  if (startup.tls !== undefined) {
    const { certFile, keyFile } = startup.tls
    if (!certFile || !keyFile)
      throw new Error('auth-remote: --tls-cert and --tls-key must be supplied together')
    tlsSource = 'cli'
    tls = { certFile: resolve(context.cwd, certFile), keyFile: resolve(context.cwd, keyFile) }
  } else if (Object.hasOwn(input, 'tlsCert') || Object.hasOwn(input, 'tlsKey')) {
    if (!config.tlsCert || !config.tlsKey)
      throw new Error('auth-remote: TLS requires both tlsCert and tlsKey')
    tlsSource = 'file'
    tls = {
      certFile: resolve(context.profileDir, config.tlsCert),
      keyFile: resolve(context.profileDir, config.tlsKey),
    }
  }
  const listener = validateListenerConfig(capabilities, {
    host: startup.host ?? (Object.hasOwn(input, 'host') ? config.host! : DEFAULT_WEB_HOST),
    port: startup.port ?? (Object.hasOwn(input, 'port') ? config.port! : DEFAULT_WEB_PORT),
    ...(tls ? { tls } : {}),
    compression: 'none',
  })
  const sessionHours = config.sessionHours ?? DEFAULT_SESSION_HOURS
  if (
    !Number.isSafeInteger(sessionHours) ||
    !Number.isSafeInteger(Date.now() + sessionHours * 3_600_000)
  )
    throw new Error('auth-remote: sessionHours exceeds the safe timestamp range')
  const paths = config.preserveOriginPaths ?? []
  const seen = new Set<string>()
  for (const path of paths) {
    if (!isCanonicalPathPrefix(path))
      throw new Error(`auth-remote: invalid preserveOriginPaths entry ${JSON.stringify(path)}`)
    if (seen.has(path))
      throw new Error(`auth-remote: duplicate preserveOriginPaths entry ${JSON.stringify(path)}`)
    seen.add(path)
  }
  return {
    ...listener,
    capabilities,
    publicUrl,
    publicUrlSource,
    tlsSource,
    legacyWarning,
    requireTotp: config.requireTotp ?? DEFAULT_REQUIRE_TOTP,
    manualAccountLogin,
    sessionHours,
    preserveOriginPaths: Object.freeze([...paths]),
  }
}

/** Finalize exactly one source policy after the official listener reports its bound port. */
export function finalizeAuthConfig(
  pending: PendingAuthConfig,
  actual: { host: string; port: number; protocol: OriginProtocol },
): ResolvedAuthConfig {
  if (
    !Number.isInteger(actual.port) ||
    actual.port < 1 ||
    actual.port > 65535 ||
    isIP(actual.host) === 0
  )
    throw new Error('auth-remote: invalid actual listener host or port')
  const transport = listenerTransport(actual, pending.capabilities)
  let listenerUrl: string
  if (actual.host.includes('%')) {
    // A scoped bind is not a portable URL authority. Keep its listener display,
    // and require an explicit portable public root (loopback scope is redundant).
    if (transport.loopback) listenerUrl = `${transport.origin}/`
    else {
      if (!pending.publicUrl)
        throw new Error('auth-remote: scoped listener requires explicit publicUrl')
      listenerUrl = `${actual.protocol}//[${actual.host}]:${actual.port}/`
    }
  } else listenerUrl = listenerPublicUrl(actual.host, actual.port, actual.protocol)
  const publicUrl = pending.publicUrl ?? parsePublicUrl(listenerUrl)
  const originPolicy = createOriginPolicy([publicUrl.origin])
  return Object.freeze({
    ...pending,
    host: actual.host,
    port: actual.port,
    protocol: actual.protocol,
    nativeAuthority: transport.authority,
    nativeOrigin: transport.origin,
    publicUrl: publicUrl.url,
    listenerUrl,
    originPolicy,
    allowedOrigins: Object.freeze([publicUrl.origin]),
  })
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
