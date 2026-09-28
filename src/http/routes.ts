import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import type { GuardedWebServer } from '../adapters/dsh/webserver.js'
import { PasswordValidationError } from '../auth/password.js'
import { AuthError, AuthService } from '../auth/service.js'
import { requireRequestContext } from './request-context.js'
import {
  AUTH_BASE,
  AUTH_COOKIE,
  type AuthErrorResponse,
  type LoginResponse,
  type MeResponse,
  type PublicStateResponse,
} from '../shared/auth-contract.js'

export type RoutePermission = 'public' | 'session' | 'logout' | null

const policies: Readonly<Record<string, RoutePermission>> = {
  [`GET ${AUTH_BASE}/state`]: 'public',
  [`GET ${AUTH_BASE}/login`]: 'public',
  [`GET ${AUTH_BASE}/login.js`]: 'public',
  [`GET ${AUTH_BASE}/login.css`]: 'public',
  [`POST ${AUTH_BASE}/login`]: 'public',
  [`POST ${AUTH_BASE}/mfa/verify`]: 'public',
  [`POST ${AUTH_BASE}/totp/start`]: 'public',
  [`POST ${AUTH_BASE}/totp/confirm`]: 'public',
  [`GET ${AUTH_BASE}/me`]: 'session',
  [`POST ${AUTH_BASE}/password`]: 'session',
  [`POST ${AUTH_BASE}/totp/disable`]: 'session',
  [`POST ${AUTH_BASE}/revoke-sessions`]: 'session',
  [`POST ${AUTH_BASE}/logout`]: 'logout',
}

export function routePermission(method: string | undefined, pathname: string): RoutePermission {
  return policies[`${method ?? ''} ${pathname}`] ?? null
}

class HttpFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code)
  }
}

function stringField(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string') throw new HttpFailure(400, 'invalid_input')
  return value
}

function optionalStringField(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new HttpFailure(400, 'invalid_input')
  return value
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > 16 * 1024)
    throw new HttpFailure(413, 'body_too_large')
  if (!/^application\/json(?:\s*;|$)/iu.test(String(req.headers['content-type'] ?? '')))
    throw new HttpFailure(415, 'unsupported_media_type')
  return new Promise((resolve, reject) => {
    let done = false
    let bytes = 0
    const chunks: Buffer[] = []
    const cleanup = () => {
      clearTimeout(timer)
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
      req.off('aborted', onAbort)
    }
    const fail = (error: Error) => {
      if (done) return
      done = true
      req.pause()
      cleanup()
      reject(error)
    }
    const onData = (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > 16 * 1024) fail(new HttpFailure(413, 'body_too_large'))
      else chunks.push(chunk)
    }
    const onEnd = () => {
      if (done) return
      done = true
      cleanup()
      try {
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (typeof body !== 'object' || body === null || Array.isArray(body))
          throw new HttpFailure(400, 'invalid_input')
        resolve(body as Record<string, unknown>)
      } catch {
        reject(new HttpFailure(400, 'invalid_json'))
      }
    }
    const onError = (error: Error) => fail(error)
    const onAbort = () => fail(new HttpFailure(408, 'request_aborted'))
    const timer = setTimeout(() => fail(new HttpFailure(408, 'request_timeout')), 10_000)
    req.on('data', onData)
    req.once('end', onEnd)
    req.once('error', onError)
    req.once('aborted', onAbort)
  })
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    ...headers,
  })
  res.end(JSON.stringify(body))
}

function cookieToken(req: IncomingMessage): string | null {
  const header = req.headers.cookie
  if (typeof header !== 'string') return null
  const values = header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${AUTH_COOKIE}=`))
  if (values.length !== 1) return null
  return values[0]!.slice(AUTH_COOKIE.length + 1)
}

export function currentSessionToken(req: IncomingMessage): string | null {
  return cookieToken(req)
}

function cookieHeader(token: string, expiresAt: number, secure: boolean): string {
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
  return `${AUTH_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`
}

function clearCookieHeader(secure: boolean): string {
  return `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`
}

function cookieResponse(mayWriteCookie: boolean, value: string): Record<string, string> {
  if (!mayWriteCookie) throw new HttpFailure(403, 'invalid_origin')
  return { 'set-cookie': value }
}

function loginAsset(name: 'login.js' | 'login.css'): string {
  const source = import.meta.url.endsWith('/src/http/routes.ts')
  const base = new URL(source ? '../../dist/' : './', import.meta.url)
  return readFileSync(new URL(name, base), 'utf8')
}

function errorStatus(error: unknown): {
  status: number
  body: AuthErrorResponse
  retryAfter?: string
} {
  if (error instanceof HttpFailure) return { status: error.status, body: { error: error.code } }
  if (error instanceof PasswordValidationError)
    return { status: 400, body: { error: 'invalid_input' } }
  if (error instanceof AuthError) {
    const retryAfter = error.retryAfter ?? (error.code === 'busy' ? 1 : undefined)
    const status: Record<string, number> = {
      invalid_input: 400,
      uninitialized: 409,
      already_initialized: 409,
      invalid_credentials: 401,
      invalid_factor: 401,
      invalid_challenge: 400,
      challenge_expired: 410,
      unauthorized: 401,
      rate_limited: 429,
      busy: 429,
      conflict: 409,
      totp_required: 403,
    }
    return {
      status: status[error.code] ?? 500,
      body: { error: error.code, ...(retryAfter ? { retryAfter } : {}) },
      ...(retryAfter ? { retryAfter: String(retryAfter) } : {}),
    }
  }
  return { status: 503, body: { error: 'service_unavailable' } }
}

/** Explicit path/method registry; no prefix grants anonymous access. */
export class AuthRoutes {
  constructor(
    private readonly auth: AuthService,
    private readonly profileName: string,
  ) {}

  install(server: GuardedWebServer): void {
    const paths = new Set(Object.keys(policies).map((row) => row.slice(row.indexOf(' ') + 1)))
    for (const path of paths)
      server.register({
        kind: 'exact',
        path,
        handler: (req, res) => this.handle(req, res, path),
      })
  }

  private async handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const route = `${req.method ?? ''} ${path}`
    try {
      const context = requireRequestContext(req)
      const secure = context.protocol === 'https:'
      switch (route) {
        case `GET ${AUTH_BASE}/state`: {
          const status = this.auth.status()
          const body: PublicStateResponse = {
            initialized: status.initialized,
            requireTotp: this.auth.policySnapshot().requireTotp,
            profileName: this.profileName,
          }
          sendJson(res, 200, body)
          return
        }
        case `GET ${AUTH_BASE}/login`: {
          res.writeHead(200, {
            'cache-control': 'no-store',
            'content-type': 'text/html; charset=utf-8',
            'content-security-policy':
              "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
            'x-content-type-options': 'nosniff',
            'referrer-policy': 'no-referrer',
          })
          res.end(
            '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in to DSH</title><link rel="stylesheet" href="/auth-remote/login.css"><script defer src="/auth-remote/login.js"></script></head><body><main id="login-root" aria-live="polite">Checking sign-in status…</main></body></html>',
          )
          return
        }
        case `GET ${AUTH_BASE}/login.js`:
        case `GET ${AUTH_BASE}/login.css`: {
          const asset = loginAsset(route.endsWith('.css') ? 'login.css' : 'login.js')
          res.writeHead(200, {
            'cache-control': 'no-store',
            'content-type': route.endsWith('.css')
              ? 'text/css; charset=utf-8'
              : 'text/javascript; charset=utf-8',
            'x-content-type-options': 'nosniff',
          })
          res.end(asset)
          return
        }
        case `POST ${AUTH_BASE}/login`: {
          const body = await readJsonBody(req)
          const result = await this.auth.login(
            stringField(body, 'username'),
            stringField(body, 'password'),
          )
          if (result.kind === 'session') {
            const response: LoginResponse = { kind: 'session', expiresAt: result.expiresAt }
            sendJson(res, 200, response, {
              ...cookieResponse(
                context.mayWriteCookie,
                cookieHeader(result.token, result.expiresAt, secure),
              ),
            })
          } else if (result.kind === 'binding') {
            const response: LoginResponse = {
              kind: 'binding',
              challenge: result.challenge,
              expiresAt: result.expiresAt,
            }
            sendJson(res, 200, response)
          } else sendJson(res, 200, result satisfies LoginResponse)
          return
        }
        case `POST ${AUTH_BASE}/mfa/verify`: {
          const body = await readJsonBody(req)
          const result = await this.auth.verifyMfa(
            stringField(body, 'challenge'),
            stringField(body, 'code'),
          )
          sendJson(
            res,
            200,
            { kind: 'session', expiresAt: result.expiresAt } satisfies LoginResponse,
            {
              ...cookieResponse(
                context.mayWriteCookie,
                cookieHeader(result.token, result.expiresAt, secure),
              ),
            },
          )
          return
        }
        case `POST ${AUTH_BASE}/totp/start`: {
          const body = await readJsonBody(req)
          if (typeof body.challenge === 'string') {
            sendJson(res, 200, this.auth.bindingDetails(body.challenge))
          } else {
            const token = cookieToken(req)
            if (!token) throw new AuthError('unauthorized')
            const result = await this.auth.startBinding(
              token,
              stringField(body, 'password'),
              optionalStringField(body, 'currentCode'),
            )
            sendJson(res, 200, result)
          }
          return
        }
        case `POST ${AUTH_BASE}/totp/confirm`: {
          const body = await readJsonBody(req)
          sendJson(
            res,
            200,
            await this.auth.confirmBinding(
              stringField(body, 'challenge'),
              stringField(body, 'code'),
            ),
            cookieResponse(context.mayWriteCookie, clearCookieHeader(secure)),
          )
          return
        }
        case `GET ${AUTH_BASE}/me`: {
          const token = cookieToken(req)
          if (!token) throw new AuthError('unauthorized')
          const me = this.auth.me(token)
          const body: MeResponse = { ...me, requireTotp: this.auth.policySnapshot().requireTotp }
          sendJson(res, 200, body)
          return
        }
        case `POST ${AUTH_BASE}/password`: {
          const body = await readJsonBody(req)
          const token = cookieToken(req)
          if (!token) throw new AuthError('unauthorized')
          await this.auth.changePassword(
            token,
            stringField(body, 'currentPassword'),
            optionalStringField(body, 'currentCode'),
            stringField(body, 'newPassword'),
          )
          sendJson(
            res,
            200,
            { ok: true },
            cookieResponse(context.mayWriteCookie, clearCookieHeader(secure)),
          )
          return
        }
        case `POST ${AUTH_BASE}/totp/disable`: {
          const body = await readJsonBody(req)
          const token = cookieToken(req)
          if (!token) throw new AuthError('unauthorized')
          await this.auth.disableTotp(
            token,
            stringField(body, 'password'),
            stringField(body, 'currentCode'),
          )
          sendJson(
            res,
            200,
            { ok: true },
            cookieResponse(context.mayWriteCookie, clearCookieHeader(secure)),
          )
          return
        }
        case `POST ${AUTH_BASE}/revoke-sessions`: {
          const body = await readJsonBody(req)
          const token = cookieToken(req)
          if (!token) throw new AuthError('unauthorized')
          await this.auth.revokeWithCredentials(
            token,
            stringField(body, 'password'),
            optionalStringField(body, 'currentCode'),
          )
          sendJson(
            res,
            200,
            { ok: true },
            cookieResponse(context.mayWriteCookie, clearCookieHeader(secure)),
          )
          return
        }
        case `POST ${AUTH_BASE}/logout`:
          if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0) > 0)
            await readJsonBody(req)
          await this.auth.logout(cookieToken(req) ?? '')
          sendJson(
            res,
            200,
            { ok: true },
            cookieResponse(context.mayWriteCookie, clearCookieHeader(secure)),
          )
          return
        default:
          sendJson(res, 405, { error: 'method_not_allowed' })
      }
    } catch (error) {
      if (res.headersSent) {
        res.destroy()
        return
      }
      const failure = errorStatus(error)
      const terminateBody =
        failure.status === 413 || failure.status === 408 || failure.status === 415
      sendJson(res, failure.status, failure.body, {
        ...(failure.retryAfter ? { 'retry-after': failure.retryAfter } : {}),
        ...(terminateBody ? { connection: 'close' } : {}),
      })
      if (terminateBody)
        res.once('finish', () => {
          req.resume()
          req.socket.end()
        })
    }
  }
}
