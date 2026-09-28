import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { DshReadiness } from '../adapters/dsh/readiness.js'
import type { WebGate } from '../adapters/dsh/webserver.js'
import { AuthService } from '../auth/service.js'
import { sessionHash } from '../auth/sessions.js'
import type { ResolvedAuthConfig } from '../config.js'
import { AUTH_BASE, AUTH_COOKIE } from '../shared/auth-contract.js'
import { AuthStateStore } from '../storage/store.js'
import { AuthConnections } from './connections.js'
import { preservePublicOrigin, stripRootToken } from './origin.js'
import { evaluateRequestOrigin, type RequestOriginContext } from './origin-policy.js'
import { setRequestContext } from './request-context.js'
import { currentSessionToken, routePermission } from './routes.js'

function rejectHttp(res: ServerResponse, status: number, code: string): void {
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  res.end(JSON.stringify({ error: code }))
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`)
}

function downstreamCookie(original: string | undefined, native: string): string {
  const name = native.slice(0, native.indexOf('='))
  const unrelated = (original ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => {
      if (!part) return false
      const split = part.indexOf('=')
      const key = (split < 0 ? part : part.slice(0, split)).trim()
      return key !== name && key !== AUTH_COOKIE
    })
  return [...unrelated, native].join('; ')
}

/** Validates the public request before rewriting only the admitted business carrier. */
export class AuthGate implements WebGate {
  constructor(
    private readonly serverPort: () => number,
    private readonly config: ResolvedAuthConfig,
    private readonly store: AuthStateStore,
    private readonly auth: AuthService,
    private readonly readiness: DshReadiness,
    private readonly connections: AuthConnections,
  ) {}

  ready(): boolean {
    return this.store.healthy() && this.readiness.ready()
  }

  async http(req: IncomingMessage, res: ServerResponse, next: () => Promise<void>): Promise<void> {
    const raw = evaluateRequestOrigin(this.config.originPolicy, {
      rawHeaders: req.rawHeaders,
      method: req.method,
      target: req.url,
    })
    if (!raw) return rejectHttp(res, 403, 'invalid_origin')
    if (!this.ready()) return rejectHttp(res, 503, 'service_unavailable')
    setRequestContext(req, raw)
    const permission = routePermission(req.method, raw.pathname)
    if (permission === 'public' || permission === 'logout') return next()
    const token = currentSessionToken(req)
    const session = token ? this.auth.session(token) : null
    if (!session) {
      const accept = String(req.headers.accept ?? '')
      const navigation =
        req.method === 'GET' &&
        !raw.pathname.startsWith('/api') &&
        !raw.pathname.startsWith(AUTH_BASE) &&
        (accept.includes('text/html') || req.headers['sec-fetch-mode'] === 'navigate')
      if (navigation) {
        const location = new URL(`${AUTH_BASE}/login`, raw.origin)
        location.searchParams.set('return', raw.returnPath)
        res.writeHead(302, {
          'cache-control': 'no-store',
          location: location.pathname + location.search,
        })
        res.end()
        return
      }
      return rejectHttp(res, 401, 'unauthorized')
    }
    if (permission === 'session') return next()
    try {
      this.bridge(req, raw)
    } catch {
      this.readiness.detach()
      return rejectHttp(res, 503, 'service_unavailable')
    }
    stripRootToken(req)
    this.connections.trackResponse(
      // The token has already been checked by AuthService.
      this.hash(token!),
      session,
      res,
    )
    await next()
  }

  async upgrade(
    req: IncomingMessage,
    socket: Duplex,
    _head: Buffer,
    next: () => Promise<void>,
  ): Promise<void> {
    const raw = evaluateRequestOrigin(this.config.originPolicy, {
      rawHeaders: req.rawHeaders,
      method: req.method,
      target: req.url,
      upgrade: true,
    })
    if (!raw) return rejectUpgrade(socket, 403, 'Forbidden')
    if (!this.ready()) return rejectUpgrade(socket, 503, 'Service Unavailable')
    setRequestContext(req, raw)
    const token = currentSessionToken(req)
    const session = token ? this.auth.session(token) : null
    if (!session) return rejectUpgrade(socket, 401, 'Unauthorized')
    try {
      this.bridge(req, raw)
    } catch {
      this.readiness.detach()
      return rejectUpgrade(socket, 503, 'Service Unavailable')
    }
    this.connections.trackSocket(this.hash(token!), session, socket)
    await next()
  }

  private hash(token: string): string {
    // Kept in one place so a raw bearer token is never retained by connection tracking.
    return sessionHash(token)
  }

  private bridge(req: IncomingMessage, context: RequestOriginContext): void {
    const preserve = preservePublicOrigin(context.pathname, this.config.preserveOriginPaths)
    const authority = preserve
      ? context.downstreamAuthority
      : `127.0.0.1:${String(this.serverPort())}`
    const origin = preserve ? context.origin : `http://${authority}`
    const native = this.readiness.nativeCookie(authority, origin)
    req.headers.cookie = downstreamCookie(req.headers.cookie, native)
    req.headers.host = authority
    if (req.headers.origin !== undefined) req.headers.origin = origin
  }
}
