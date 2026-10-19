import { AsyncLocalStorage } from 'node:async_hooks'
import type { Context } from '@deepseek-ai/cordis'

/**
 * DSH-HMR-001: listeners created by native HMR must not retain its transaction
 * marker in future socket callbacks. Native HMR uses the same exit boundary
 * for its own long-lived watchers, but exposes no public equivalent for IO.
 * Keep this capability-checked access limited to listener initialization; all
 * subsequent Settings writes still enter the unchanged native HMR queue.
 */
export function outsideHmrTransaction<T>(ctx: Context, initialize: () => T): T {
  const hmr = ctx.get('hmr') as { runExclusive?: unknown; executing?: unknown } | undefined
  const scope = hmr?.executing
  if (
    typeof hmr?.runExclusive === 'function' &&
    scope instanceof AsyncLocalStorage &&
    scope.getStore() === true
  ) {
    return scope.exit(initialize)
  }
  return initialize()
}
