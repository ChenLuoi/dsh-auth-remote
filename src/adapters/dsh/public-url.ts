import { isIP } from 'node:net'
import { createOriginPolicy, type OriginProtocol } from '../../http/origin-policy.js'

export interface RootPublicUrl {
  readonly url: string
  readonly origin: string
}

/** Validate raw input before URL normalization can hide paths or authority aliases. */
export function parsePublicUrl(value: string): RootPublicUrl {
  if (
    typeof value !== 'string' ||
    !/^https?:\/\/[^/?#]+\/?$/iu.test(value) ||
    /[\\\s\u0000-\u001f\u007f]/u.test(value)
  )
    throw new Error('auth-remote: publicUrl must be an absolute HTTP(S) root URL')
  const originInput = value.endsWith('/') ? value.slice(0, -1) : value
  try {
    const policy = createOriginPolicy([originInput])
    const origin = policy.registeredOrigins[0]!.origin
    return Object.freeze({ url: new URL(origin).href, origin })
  } catch {
    throw new Error('auth-remote: invalid publicUrl authority')
  }
}

/** A configured zero port is never an advertised port: finalize after listening. */
export function listenerPublicUrl(host: string, port: number, protocol: OriginProtocol): string {
  if (isIP(host) === 0 || host.includes('%') || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('auth-remote: listener cannot form a root URL; configure explicit publicUrl')
  const authority = isIP(host) === 6 ? `[${host}]` : host
  const url = new URL(`${protocol}//${authority}:${port}/`)
  if (['0.0.0.0', '[::]', '[::ffff:0:0]'].includes(url.hostname))
    throw new Error('auth-remote: wildcard listener cannot form a publicUrl')
  return url.href
}
