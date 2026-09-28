import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'

interface NativeCookie {
  readonly pair: string
  readonly expiresAt: number
}

/** Host-only bridge to the public Connection token exchange. */
export class NativeBrowserAuth {
  private readonly cookies = new WeakMap<HostConnectionHandle, Map<string, NativeCookie>>()

  cookieFor(
    connection: HostConnectionHandle,
    authority: string,
    origin: string,
    now = Date.now(),
  ): string {
    let byAuthority = this.cookies.get(connection)
    if (byAuthority === undefined) {
      byAuthority = new Map()
      this.cookies.set(connection, byAuthority)
    }
    let cookie = byAuthority.get(authority)
    if (cookie === undefined || now >= cookie.expiresAt - 60_000) {
      cookie = exchange(connection, authority, now)
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

  clear(connection: HostConnectionHandle): void {
    this.cookies.delete(connection)
  }
}

function exchange(connection: HostConnectionHandle, authority: string, now: number): NativeCookie {
  const tokenUrl = new URL(connection.authenticatedUrl(`http://${authority}/`))
  const normalizedAuthority = new URL(`http://${authority}/`).host
  if (
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
