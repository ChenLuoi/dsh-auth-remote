import type { Context } from '@deepseek-ai/cordis'
import { authRequest, goToLogin, isUnauthorized, type AccountStatus } from './api.js'

/** Keep the official page from remaining open after this browser session expires or is revoked. */
export function monitorSession(ctx: Context): void {
  ctx.effect(() => {
    let active = true
    let checking = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const verify = () => {
      if (!active || checking) return
      checking = true
      void authRequest<AccountStatus>('/auth-remote/me')
        .then(
          (me) => {
            if (!active) return
            clearTimeout(timer)
            const remaining = me.expiresAt - Date.now()
            if (remaining <= 0) {
              goToLogin()
              return
            }
            timer = setTimeout(verify, Math.min(remaining + 20, 24 * 60 * 60 * 1000))
          },
          (error: unknown) => {
            if (active && isUnauthorized(error)) goToLogin()
          },
        )
        .finally(() => {
          checking = false
        })
    }
    verify()
    const poll = setInterval(verify, 5000)
    const off = ctx.on('connection/reset', verify)
    return () => {
      active = false
      clearTimeout(timer)
      clearInterval(poll)
      off()
    }
  }, 'auth-remote.session-monitor')
}
