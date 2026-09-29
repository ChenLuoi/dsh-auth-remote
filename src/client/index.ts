/** Browser entry: the Host installs its capability fact before DSH boot. */
import type { Context } from '@deepseek-ai/cordis'
import type { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { assertRemoteHostCapability } from './adapters/dsh.js'
import { SecuritySection } from './settings/section.js'
import { monitorSession } from './settings/monitor.js'
import { en, zh, type MessageKey } from '../shared/i18n.js'
import settingsStyles from './settings/style.css'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'auth-remote': MessageKey
  }
}

export const name = 'auth-remote'
export const inject = ['connection', 'slots', 'locale']

export function apply(ctx: Context): void {
  assertRemoteHostCapability(ctx)
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-auth-remote'
    tag.textContent = settingsStyles
    document.head.appendChild(tag)
    return () => tag.remove()
  }, 'auth-remote: settings styles')
  monitorSession(ctx)
  ctx.effect(() => ctx.locale.register('auth-remote', { en, zh }), 'auth-remote: dictionaries')
  const t = ctx.locale.bind('auth-remote')
  const slots = ctx.get('slots') as SlotCore & {
    inject(name: string, register: () => () => void): void
  }
  slots.inject('settings.section', () =>
    slots.register(
      {
        name: 'settings.section',
        id: 'security',
        order: 90,
        locale: 'auth-remote',
        label: () => t('settingsSectionLabel'),
      },
      SecuritySection,
    ),
  )
}
