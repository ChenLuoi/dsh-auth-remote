export type OriginProtocol = 'http:' | 'https:'

export interface RegisteredOrigin {
  readonly origin: string
  readonly protocol: OriginProtocol
  readonly host: string
  readonly hostname: string
  readonly port: number
  readonly authorities: readonly string[]
}

export interface OriginPolicy {
  readonly registeredOrigins: readonly RegisteredOrigin[]
  matchAuthority(host: string): RegisteredOrigin | undefined
}

export interface RawRequestHead {
  readonly rawHeaders: readonly string[]
  readonly method: string | undefined
  readonly target: string | undefined
  readonly upgrade?: boolean
}

export interface RequestOriginContext {
  readonly origin: string
  readonly protocol: OriginProtocol
  readonly authority: string
  readonly downstreamAuthority: string
  readonly hostname: string
  readonly pathname: string
  readonly returnPath: string
  readonly registered: boolean
  readonly mayWriteCookie: boolean
}

interface Authority {
  readonly host: string
  readonly hostname: string
  readonly explicitPort: number | undefined
  readonly kind: 'ipv4' | 'ipv6' | 'name'
}

function defaultPort(protocol: OriginProtocol): number {
  return protocol === 'https:' ? 443 : 80
}

function parseAuthority(value: string): Authority | null {
  const ipv6 = /^(\[[0-9a-fA-F:.]+\])(?::([0-9]+))?$/u.exec(value)
  const plain = /^([A-Za-z0-9.-]+)(?::([0-9]+))?$/u.exec(value)
  const hostname = (ipv6?.[1] ?? plain?.[1])?.toLowerCase()
  const portText = ipv6?.[2] ?? plain?.[2]
  if (!hostname) return null
  if (portText !== undefined && (!/^[1-9][0-9]*$/u.test(portText) || Number(portText) > 65535))
    return null
  let parsed: URL
  try {
    parsed = new URL(`http://${hostname}`)
  } catch {
    return null
  }
  if (parsed.hostname !== hostname || parsed.username || parsed.password) return null
  let kind: Authority['kind']
  if (ipv6) {
    kind = 'ipv6'
  } else if (/^(?:[0-9]+\.){3}[0-9]+$/u.test(hostname)) {
    const octets = hostname.split('.')
    if (octets.some((octet) => Number(octet) > 255 || String(Number(octet)) !== octet)) return null
    kind = 'ipv4'
  } else {
    if (hostname.length > 253 || hostname.endsWith('.')) return null
    if (hostname.split('.').some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)))
      return null
    kind = 'name'
  }
  const explicitPort = portText === undefined ? undefined : Number(portText)
  return {
    host: `${hostname}${explicitPort === undefined ? '' : `:${explicitPort}`}`,
    hostname,
    explicitPort,
    kind,
  }
}

function parseOrigin(value: string): RegisteredOrigin | null {
  const match = /^(https?):\/\/([^/?#]+)$/iu.exec(value)
  if (!match?.[1] || !match[2]) return null
  const authority = parseAuthority(match[2])
  if (!authority) return null
  const protocol = `${match[1].toLowerCase()}:` as OriginProtocol
  let url: URL
  try {
    url = new URL(`${protocol}//${authority.host}`)
  } catch {
    return null
  }
  if (url.hostname !== authority.hostname) return null
  const port = authority.explicitPort ?? defaultPort(protocol)
  const authorities = [url.host]
  if (url.port === '') authorities.push(`${url.hostname}:${defaultPort(protocol)}`)
  return Object.freeze({
    origin: url.origin,
    protocol,
    host: url.host,
    hostname: url.hostname,
    port,
    authorities: Object.freeze(authorities),
  })
}

/** Resolve an exact authority to a single configured protocol. No DNS or proxy headers are used. */
export function createOriginPolicy(origins: readonly string[]): OriginPolicy {
  if (!Array.isArray(origins)) throw new Error('auth-remote: allowedOrigins must be an array')
  const indexed = new Map<string, RegisteredOrigin>()
  const registeredOrigins: RegisteredOrigin[] = []
  const seen = new Set<string>()
  for (const value of origins) {
    const entry = typeof value === 'string' ? parseOrigin(value) : null
    if (!entry) {
      throw new Error(`auth-remote: invalid allowedOrigins entry ${JSON.stringify(value)}`)
    }
    if (seen.has(entry.origin)) {
      throw new Error(`auth-remote: duplicate allowedOrigins entry ${JSON.stringify(value)}`)
    }
    seen.add(entry.origin)
    for (const alias of entry.authorities) {
      const previous = indexed.get(alias)
      if (previous) {
        throw new Error(
          `auth-remote: ambiguous allowedOrigins authority ${alias} (${previous.protocol} and ${entry.protocol})`,
        )
      }
      indexed.set(alias, entry)
    }
    registeredOrigins.push(entry)
  }
  return Object.freeze({
    registeredOrigins: Object.freeze(registeredOrigins),
    matchAuthority(host: string) {
      const authority = parseAuthority(host)
      return authority ? indexed.get(authority.host) : undefined
    },
  })
}

function headerValues(rawHeaders: readonly string[], name: string): string[] | null {
  if (rawHeaders.length % 2 !== 0) return null
  const values: string[] = []
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const key = rawHeaders[i]
    const value = rawHeaders[i + 1]
    if (typeof key !== 'string' || typeof value !== 'string') return null
    if (key.toLowerCase() === name) values.push(value)
  }
  return values
}

function parseTarget(target: string): { pathname: string; returnPath: string } | null {
  if (
    !target.startsWith('/') ||
    target.startsWith('//') ||
    /[\\\u0000-\u001f\u007f\s#]/u.test(target) ||
    /%(?![0-9a-fA-F]{2})/u.test(target)
  )
    return null
  const rawPath = target.split('?', 1)[0]!
  for (const segment of rawPath.split('/')) {
    let decoded: string
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      return null
    }
    if (decoded === '.' || decoded === '..' || /[/\\\u0000-\u001f\u007f]/u.test(decoded))
      return null
  }
  let parsed: URL
  try {
    parsed = new URL(target, 'http://auth-remote.invalid')
  } catch {
    return null
  }
  if (parsed.origin !== 'http://auth-remote.invalid') return null
  if (parsed.pathname === '/') parsed.searchParams.delete('token')
  return { pathname: parsed.pathname, returnPath: parsed.pathname + parsed.search }
}

function isImplicitLoopback(authority: Authority): boolean {
  if (authority.hostname === 'localhost' || authority.hostname === '[::1]') return true
  if (authority.kind !== 'ipv4') return false
  return authority.hostname.startsWith('127.')
}

/** Validate the original request head before any Host, Origin or Cookie rewrite. */
export function evaluateRequestOrigin(
  policy: OriginPolicy,
  request: RawRequestHead,
): RequestOriginContext | null {
  const hosts = headerValues(request.rawHeaders, 'host')
  const origins = headerValues(request.rawHeaders, 'origin')
  const fetchSites = headerValues(request.rawHeaders, 'sec-fetch-site')
  if (
    !hosts ||
    !origins ||
    !fetchSites ||
    hosts.length !== 1 ||
    origins.length > 1 ||
    fetchSites.length > 1
  )
    return null
  const authority = parseAuthority(hosts[0]!)
  const target = request.target ? parseTarget(request.target) : null
  const method = request.method
  if (!authority || !target || !method || !/^[A-Z!#$%&'*+.^_`|~-]+$/u.test(method)) return null
  const needsOrigin = request.upgrade === true || method !== 'GET'
  if (needsOrigin && origins.length !== 1) return null
  const site = fetchSites[0]?.toLowerCase()
  if (
    site !== undefined &&
    (needsOrigin ? site !== 'same-origin' : !['same-origin', 'none'].includes(site))
  )
    return null
  const suppliedOrigin = origins.length === 1 ? parseOrigin(origins[0]!) : null
  if (origins.length === 1 && !suppliedOrigin) return null
  const registered = policy.matchAuthority(authority.host)
  let origin: string
  let protocol: OriginProtocol
  if (registered) {
    if (suppliedOrigin && suppliedOrigin.origin !== registered.origin) return null
    origin = registered.origin
    protocol = registered.protocol
  } else {
    if (!isImplicitLoopback(authority)) return null
    protocol = suppliedOrigin?.protocol ?? 'http:'
    const hostPort = authority.explicitPort ?? defaultPort(protocol)
    if (
      suppliedOrigin &&
      (suppliedOrigin.hostname !== authority.hostname || suppliedOrigin.port !== hostPort)
    )
      return null
    origin = suppliedOrigin?.origin ?? new URL(`${protocol}//${authority.host}`).origin
  }
  return Object.freeze({
    origin,
    protocol,
    authority: authority.host,
    downstreamAuthority: new URL(origin).host,
    hostname: authority.hostname,
    pathname: target.pathname,
    returnPath: target.returnPath,
    registered: registered !== undefined,
    mayWriteCookie: registered !== undefined || suppliedOrigin !== null,
  })
}
