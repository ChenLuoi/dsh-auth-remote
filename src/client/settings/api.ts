import type { AuthErrorResponse, MeResponse } from '../../shared/auth-contract.js'
import type { MessageKey } from '../../shared/i18n.js'

export interface SettingsMessage {
  key: MessageKey
  params?: Record<string, string | number>
}

export class SettingsFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryAfter?: number,
  ) {
    super(code)
  }
}

export function loginLocation(reason = 'expired'): string {
  const current = new URL(location.href)
  current.searchParams.delete('token')
  const target = new URL('/auth-remote/login', location.origin)
  target.searchParams.set('return', current.pathname + current.search + current.hash)
  target.searchParams.set('reason', reason)
  return target.pathname + target.search
}

export function goToLogin(reason = 'expired'): void {
  location.assign(loginLocation(reason))
}

export async function authRequest<T>(path: string, body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    credentials: 'same-origin',
    cache: 'no-store',
  })
  const value: unknown = await response.json().catch(() => ({}))
  if (!response.ok) {
    const failure = value as AuthErrorResponse
    const seconds = Number(response.headers.get('retry-after'))
    throw new SettingsFailure(
      response.status,
      typeof failure.error === 'string' ? failure.error : 'service_unavailable',
      Number.isFinite(seconds) && seconds > 0 ? seconds : failure.retryAfter,
    )
  }
  return value as T
}

export function settingsError(error: unknown): SettingsMessage {
  if (!(error instanceof SettingsFailure)) return { key: 'errorNetwork' }
  switch (error.code) {
    case 'invalid_credentials':
      return { key: 'settingsErrorInvalidCredentials' }
    case 'invalid_factor':
      return { key: 'settingsErrorInvalidFactor' }
    case 'invalid_input':
      return { key: 'settingsErrorInvalidInput' }
    case 'rate_limited':
    case 'busy':
      return { key: 'errorRateLimited', params: { seconds: error.retryAfter ?? 1 } }
    case 'invalid_challenge':
    case 'challenge_expired':
    case 'conflict':
      return { key: 'settingsErrorChallenge' }
    case 'totp_required':
      return { key: 'settingsErrorTotpRequired' }
    case 'unauthorized':
      return { key: 'errorUnauthorized' }
    default:
      return { key: error.status === 503 ? 'errorServiceUnavailable' : 'errorGeneric' }
  }
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof SettingsFailure && error.status === 401 && error.code === 'unauthorized'
}

export type AccountStatus = MeResponse
