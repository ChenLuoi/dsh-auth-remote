import type { Context } from '@deepseek-ai/cordis'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'

/**
 * A fully authenticated administrator may use the Host settings surface from
 * the public origin. Install the fact before the index boots Connection and
 * Remote; neither service can be repaired after its constructor caches it.
 */
export function installAuthenticatedHostCapability(ctx: Context): void {
  ctx.on('webserver/index-inject', (table: IndexInjection[]) => {
    table.push({ kind: 'global', name: '__DSH_TRANSPORT__', value: { ownsHost: true } })
  })
}
