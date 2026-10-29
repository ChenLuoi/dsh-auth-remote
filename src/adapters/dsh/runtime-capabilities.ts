import * as NativeWebServer from '@deepseek-ai/dsh-host-webserver'
import semver from 'semver'
import { SUPPORTED_DSH_RANGE } from './compatibility.js'
import type { OriginProtocol } from '../../http/origin-policy.js'
import { listenerPublicUrl } from './public-url.js'

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
export function assertRuntimeVersion(version: string): void {
  if (!semver.satisfies(version, SUPPORTED_DSH_RANGE, { includePrerelease: true }))
    throw new Error(
      `auth-remote: unsupported DSH version ${version}; minimum DSH 0.2.1-alpha.3. Upgrade to DSH 0.2.2-alpha.2; last supported plugin for older DSH: 0.2.0. See README.md and docs/support-history.md.`,
    )
}

/** Validate the native schema before opening resources. */
export function validateListenerConfig(
  config: NativeListenerConfig,
  native: NativeApi = NativeWebServer,
): NativeListenerConfig {
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535)
    throw new Error('auth-remote: invalid web listener port')
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

/** Missing or invalid native protocols fail closed. */
export function listenerProtocol(server: { readonly protocol?: string }): OriginProtocol {
  if (server.protocol !== 'http:' && server.protocol !== 'https:')
    throw new Error('auth-remote: DSH listener lacks a valid native protocol')
  return server.protocol
}

/** Match Connection's bind-authority URL rules, including mapped/scoped IPv6. */
export function listenerTransport(actual: {
  host: string
  port: number
  protocol: OriginProtocol
}): { authority: string; origin: string; loopback: boolean } {
  const loopback = NativeWebServer.isLoopbackHost(actual.host)
  const host = loopback
    ? NativeWebServer.normalizeBindAddress(actual.host)
    : // Connection compares the bind literal through WHATWG URL, retaining mapped IPv6.
      // A zone selects an interface and is excluded by its authority comparison.
      actual.host.split('%', 1)[0]!
  const url = new URL(listenerPublicUrl(host, actual.port, actual.protocol))
  return {
    authority: url.host,
    origin: url.origin,
    loopback,
  }
}
