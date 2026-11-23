import { AUTH_BASE } from './auth-contract.js'

export const DELEGATION_PATH = `${AUTH_BASE}/delegation`
export const DELEGATION_CAPABILITY = '__DSH_AUTH_REMOTE_DELEGATION__'
export const DELEGATED_SESSION_DAYS = [1, 3, 7] as const
export const DEFAULT_DELEGATED_SESSION_DAYS = 3
export const DAY_MS = 86_400_000

export type DelegatedSessionDays = (typeof DELEGATED_SESSION_DAYS)[number]

export function isDelegatedSessionDays(value: unknown): value is DelegatedSessionDays {
  return DELEGATED_SESSION_DAYS.some((days) => days === value)
}
