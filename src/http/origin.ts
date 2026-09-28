import type { IncomingMessage } from 'node:http'

export function preservePublicOrigin(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some(
    (prefix) => prefix === '/' || pathname === prefix || pathname.startsWith(`${prefix}/`),
  )
}

/** Remove only the official launch token on the root index entry. */
export function stripRootToken(req: IncomingMessage): void {
  if (!req.url) return
  const url = new URL(req.url, 'http://auth-remote.invalid')
  if (url.pathname !== '/' || !url.searchParams.has('token')) return
  url.searchParams.delete('token')
  req.url = url.pathname + url.search + url.hash
}
