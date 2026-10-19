import type { Context } from '@deepseek-ai/cordis'
import type {
  ConfigForm,
  ConfigForms,
  SettingsDescribeView,
  SettingsDescribeFace,
} from '@deepseek-ai/dsh-client-ui-settings/client'
import { ACCOUNT_LOGIN_CAPABILITY } from '../../shared/account-login.js'

export interface ManualAccountPreferences {
  manualAccountLogin: boolean
}
export interface ManualAccountBinding {
  form?: ConfigForm<ManualAccountPreferences>
  mirror?: SettingsDescribeFace
  refresh(): Promise<boolean>
}

/** All accepted values remain in the native form mirror and its revision queue. */
export function manualAccountBinding(ctx: Context): ManualAccountBinding {
  const forms = ctx.get('configForms') as ConfigForms | undefined
  const form = forms?.get<ManualAccountPreferences>('auth-remote')
  const mirror = forms?.describe()
  return {
    ...(form ? { form } : {}),
    ...(mirror ? { mirror } : {}),
    async refresh() {
      if (!mirror || !form) return false
      // A namespace fold cannot publish a document before the first successful
      // read. Let the native mirror recover that read through its own transport.
      if (!mirror.getSnapshot().view) {
        await mirror.ensure()
        return form.getSnapshot().status === 'ready'
      }
      const remote = ctx.get('remote') as
        | {
            settings?: { describe(): Promise<{ ok: boolean; value?: SettingsDescribeView }> }
          }
        | undefined
      const result = await remote?.settings?.describe()
      const view = result?.ok && result.value?.namespaces.find((view) => view.ns === 'auth-remote')
      if (!view) return false
      mirror.acceptView(view)
      return true
    },
  }
}

export function hasManualAccountRuntime(): boolean {
  return (globalThis as Record<string, unknown>)[ACCOUNT_LOGIN_CAPABILITY] === true
}
