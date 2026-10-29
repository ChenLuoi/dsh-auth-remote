import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'

/** The public native opening baseline is authoritative before any plugin effect. */
export function isAdministratorPage(): boolean {
  if (!Reflect.has(globalThis, '__DSH_REMOTE_ACCESS__')) return true
  const baseline: unknown = Reflect.get(globalThis, '__DSH_REMOTE_ACCESS__')
  return (
    typeof baseline === 'object' &&
    baseline !== null &&
    !Array.isArray(baseline) &&
    Reflect.get(baseline, 'type') === 'baseline' &&
    Reflect.get(baseline, 'owner') === true
  )
}

/** Confirm the Host's early index injection reached Connection construction. */
export function assertRemoteHostCapability(ctx: Context): void {
  if (typeof location === 'undefined') return
  const connection = ctx.get('connection') as ConnectionHandle | undefined
  if (connection === undefined) throw new Error('auth-remote: browser Connection is missing')
  const hostname = location.hostname.toLowerCase().replace(/^\[|\]$/gu, '')
  const loopback =
    hostname === 'localhost' ||
    hostname === '::1' ||
    /^127(?:\.[0-9]{1,3}){3}$/u.test(hostname) ||
    /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/u.test(hostname)
  if (!loopback && connection.isLoopback !== true) {
    throw new Error('auth-remote: Host settings capability was not installed before Connection')
  }
}
