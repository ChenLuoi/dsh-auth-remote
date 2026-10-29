import type { Context } from '@deepseek-ai/cordis'
import { requireRequestContext } from '../../http/request-context.js'

/** Preserve the public business origin only after native Connection admission. */
export function installLiveShareOrigin(ctx: Context): void {
  ctx.on('connection/request', async (req, _res, next) => {
    const path = req.url?.split('?', 1)[0]
    if (
      req.method !== 'POST' ||
      (path !== '/api/liveshare.ownerLoginStart' && path !== '/api/liveshare.ownerLoginRedeem')
    )
      return next()
    const trusted = requireRequestContext(req)
    const original = req.headers.origin
    if (original === undefined) return next()
    try {
      req.headers.origin = trusted.origin
      await next()
    } finally {
      req.headers.origin = original
    }
  })
}
