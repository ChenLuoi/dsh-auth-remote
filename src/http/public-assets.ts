const publicPwaPaths = new Set(['/manifest.webmanifest', '/favicon.svg', '/favicon-dark.svg'])

/** Only exact, read-only PWA resources bypass session authentication. */
export function isPublicPwaAsset(method: string | undefined, pathname: string): boolean {
  return (method === 'GET' || method === 'HEAD') && publicPwaPaths.has(pathname)
}
