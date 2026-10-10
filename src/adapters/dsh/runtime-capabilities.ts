import * as NativeWebServer from '@deepseek-ai/dsh-host-webserver'
import { isIP } from 'node:net'
import semver from 'semver'
import { SUPPORTED_DSH_RANGE } from './compatibility.js'
import type { OriginProtocol } from '../../http/origin-policy.js'
import { listenerPublicUrl } from './public-url.js'

export interface RuntimeCapabilities {
  readonly version: string
  readonly publicUrl: boolean
  readonly nativeTransport: boolean
}

export interface NativeListenerConfig {
  host: string
  port: number
  tls?: { certFile: string; keyFile: string }
  compression?: 'none' | 'gzip'
  compressionLevel?: number
  compressionThresholdBytes?: number
}

interface NativeApi {
  default: { Config?: (input: NativeListenerConfig) => unknown; prototype: object }
  isLoopbackHost?: (host: string) => boolean
  isWildcardHost?: (host: string) => boolean
  normalizeBindAddress?: (host: string) => string
}

/** Version admission and API verification remain separate checks. */
export function getRuntimeCapabilities(version: string): RuntimeCapabilities {
  if (!semver.satisfies(version, SUPPORTED_DSH_RANGE, { includePrerelease: true }))
    throw new Error(`auth-remote: unsupported DSH version ${version}`)
  return Object.freeze({
    version,
    publicUrl: semver.gte(version, '0.2.1-alpha.1'),
    nativeTransport: semver.gte(version, '0.2.1-alpha.2'),
  })
}

/** Old packages can load this module: new exports are only read on the native branch. */
export function validateListenerConfig(
  capabilities: RuntimeCapabilities,
  config: NativeListenerConfig,
  native: NativeApi = NativeWebServer,
): NativeListenerConfig {
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535)
    throw new Error('auth-remote: invalid web listener port')
  if (!capabilities.nativeTransport) {
    if (config.tls) throw new Error('auth-remote: this DSH version does not support TLS')
    if (isIP(config.host) !== 4)
      throw new Error('auth-remote: this DSH version supports only concrete IPv4, not IPv6')
    if (config.host === '0.0.0.0') throw new Error('auth-remote: wildcard binding is not supported')
    return { ...config, compression: config.compression ?? 'none' }
  }
  if (
    typeof native.default.Config !== 'function' ||
    typeof Object.getOwnPropertyDescriptor(native.default.prototype, 'protocol')?.get !==
      'function' ||
    typeof native.isLoopbackHost !== 'function' ||
    typeof native.isWildcardHost !== 'function' ||
    typeof native.normalizeBindAddress !== 'function'
  )
    throw new Error('auth-remote: DSH lacks native transport capabilities')
  // WebServer's constructor does not run its schema. Do so explicitly before resources open.
  return native.default.Config({
    ...config,
    compression: config.compression ?? 'none',
  }) as NativeListenerConfig
}

/** Older WebServer has no protocol getter; modern missing/invalid getters fail closed. */
export function listenerProtocol(
  server: { readonly protocol?: string },
  capabilities: RuntimeCapabilities,
): OriginProtocol {
  if (!capabilities.nativeTransport) return 'http:'
  if (server.protocol !== 'http:' && server.protocol !== 'https:')
    throw new Error('auth-remote: DSH listener lacks a valid native protocol')
  return server.protocol
}

/** Match Connection's bind-authority URL rules, including mapped/scoped IPv6. */
export function listenerTransport(
  actual: { host: string; port: number; protocol: OriginProtocol },
  capabilities: RuntimeCapabilities,
): { authority: string; origin: string; loopback: boolean } {
  const loopback = capabilities.nativeTransport
    ? NativeWebServer.isLoopbackHost(actual.host)
    : isIP(actual.host) === 4 && actual.host.startsWith('127.')
  const host = capabilities.nativeTransport
    ? loopback
      ? NativeWebServer.normalizeBindAddress(actual.host)
      : // Connection compares the bind literal through WHATWG URL, retaining mapped IPv6.
        // A zone selects an interface and is excluded by its authority comparison.
        actual.host.split('%', 1)[0]!
    : // Older Connection cannot recognize a concrete non-loopback bind authority.
      // Preserve its existing server-side loopback bridge without changing the listener.
      '127.0.0.1'
  const url = new URL(listenerPublicUrl(host, actual.port, actual.protocol))
  return {
    authority: url.host,
    origin: url.origin,
    loopback,
  }
}
