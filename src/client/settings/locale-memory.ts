import type { Context } from '@deepseek-ai/cordis'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { localeMemoryKey } from '../../shared/i18n.js'

type LocaleForm = Pick<ConfigForm<{ preference?: string }>, 'getSnapshot' | 'subscribe'>

/** Remember only the native form's accepted value, including an explicit cleared preference. */
export function rememberLocale(form: LocaleForm): () => void {
  const sync = () => {
    try {
      const snapshot = form.getSnapshot()
      if (snapshot.status !== 'ready' || snapshot.value === undefined) return
      const preference = snapshot.value.preference
      if (preference === undefined) localStorage.removeItem(localeMemoryKey)
      else if (typeof preference === 'string') localStorage.setItem(localeMemoryKey, preference)
    } catch {
      // Storage and transient form failures must not interrupt authentication or settings.
    }
  }
  const stop = form.subscribe(sync)
  sync()
  return stop
}

export function installLocaleMemory(ctx: Context): void {
  ctx.inject(['configForms'], (scope) => {
    scope.effect(() => {
      try {
        return rememberLocale(scope.configForms.get<{ preference?: string }>('locale'))
      } catch {
        // An unavailable form leaves the previous memory intact.
        return () => {}
      }
    }, 'auth-remote: accepted locale memory')
  })
}
