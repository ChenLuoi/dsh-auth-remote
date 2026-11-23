import type { ConnectionTrustRequest } from '@deepseek-ai/dsh-client-connection'
import type { OriginProtocol } from '../../http/origin-policy.js'

interface NativeCookie {
  readonly pair: string
  readonly expiresAt: number
}

interface LegacyConnection {
  authenticatedUrl(baseUrl: string): string
  authorizeIndex(
    request: ConnectionTrustRequest & { method?: string; url?: string },
    response: {
      writeHead(status: number, headers?: Readonly<Record<string, string>>): unknown
      end(body?: string): unknown
    },
  ): boolean
  requestRejection(request: ConnectionTrustRequest): number | undefined
}

export function assertLegacyConnection(connection: object): asserts connection is LegacyConnection {
  for (const method of ['authenticatedUrl', 'authorizeIndex', 'requestRejection'] as const) {
    if (typeof Reflect.get(connection, method) !== 'function') {
      throw new Error(`auth-remote: Connection lacks ${method}`)
    }
  }
}

/** Host-only bridge to the public Connection token exchange. */
export class NativeBrowserAuth {
  private readonly cookies = new WeakMap<object, Map<string, NativeCookie>>()

  constructor(private readonly protocol: OriginProtocol = 'http:') {}

  cookieFor(connection: object, authority: string, origin: string, now = Date.now()): string {
    assertLegacyConnection(connection)
    let byAuthority = this.cookies.get(connection)
    if (byAuthority === undefined) {
      byAuthority = new Map()
      this.cookies.set(connection, byAuthority)
    }
    let cookie = byAuthority.get(authority)
    if (cookie === undefined || now >= cookie.expiresAt - 60_000) {
      cookie = exchange(connection, authority, this.protocol, now)
      byAuthority.set(authority, cookie)
    }
    const rejection = connection.requestRejection({
      headers: { host: authority, origin, cookie: cookie.pair },
    })
    if (rejection !== undefined) {
      byAuthority.delete(authority)
      throw new Error(
        `auth-remote: native Connection rejected ${authority} with ${String(rejection)}`,
      )
    }
    return cookie.pair
  }

  clear(connection: object): void {
    this.cookies.delete(connection)
  }
}

function exchange(
  connection: LegacyConnection,
  authority: string,
  protocol: OriginProtocol,
  now: number,
): NativeCookie {
  const baseUrl = new URL(`${protocol}//${authority}/`)
  const tokenUrl = new URL(connection.authenticatedUrl(baseUrl.href))
  const normalizedAuthority = baseUrl.host
  if (
    tokenUrl.protocol !== protocol ||
    tokenUrl.host !== normalizedAuthority ||
    tokenUrl.pathname !== '/' ||
    tokenUrl.searchParams.getAll('token').length !== 1
  ) {
    throw new Error('auth-remote: native Connection returned an invalid token URL')
  }
  let status: number | undefined
  let responseHeaders: Readonly<Record<string, string>> | undefined
  let ended = false
  const admitted = connection.authorizeIndex(
    { method: 'GET', url: tokenUrl.pathname + tokenUrl.search, headers: { host: authority } },
    {
      writeHead(code, headers) {
        status = code
        responseHeaders = headers
      },
      end() {
        ended = true
      },
    },
  )
  // The target version returns false after a successful 303 exchange.
  const setCookie = responseHeaders?.['set-cookie']
  if (
    admitted ||
    !ended ||
    status !== 303 ||
    setCookie === undefined ||
    responseHeaders?.location !== './'
  ) {
    throw new Error('auth-remote: native Connection token exchange failed')
  }
  const [pair, ...attributes] = setCookie.split(';').map((part) => part.trim())
  if (attributes.some((attribute) => /^secure$/iu.test(attribute)) !== (protocol === 'https:'))
    throw new Error('auth-remote: native Connection returned a Cookie for the wrong protocol')
  if (pair === undefined || !/^[^=;\s]+=([^;\s]*)$/u.test(pair)) {
    throw new Error('auth-remote: native Connection returned an invalid Cookie')
  }
  const maxAge = attributes
    .find((attribute) => /^max-age=/iu.test(attribute))
    ?.slice('max-age='.length)
  const seconds = maxAge === undefined ? NaN : Number(maxAge)
  const expiresAt = now + seconds * 1000
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || !Number.isSafeInteger(expiresAt)) {
    throw new Error('auth-remote: native Connection returned an invalid Cookie lifetime')
  }
  return { pair, expiresAt }
}
