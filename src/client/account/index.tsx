import { createElement, useEffect, useRef, useSyncExternalStore, type ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { ManualSignInDialog } from './dialog.js'
import { ACCOUNT_LOGIN_CAPABILITY } from '../../shared/account-login.js'

type NativeProps = Record<string, unknown> & {
  complete?: () => void
  showLogin?: (visible: boolean) => void
}

interface NativeEntry {
  component: ComponentType<NativeProps>
  options: { priority?: number }
  locale?: string
  inject?: (...args: never[]) => object
}

/** Narrow adapter for alpha.3's public slot inspection and shadowing APIs. */
interface AccountSlots {
  entries(name: string): readonly NativeEntry[]
  subscribe(name: string, callback: () => void): () => void
  inject(name: string, callback: () => () => void): void
  register(
    options: {
      name: string
      id?: string
      priority?: number
      locale?: string
      inject?: NativeEntry['inject']
    },
    component: ComponentType<NativeProps>,
  ): () => void
}

export function installManualAccountLogin(ctx: Context): void {
  // The server derives this flag from the exact installed runtime version.
  if ((globalThis as Record<string, unknown>)[ACCOUNT_LOGIN_CAPABILITY] !== true) return
  const slots = ctx.get('slots') as AccountSlots
  if (typeof slots.entries !== 'function' || typeof slots.subscribe !== 'function') return
  const t = ctx.locale.bind('auth-remote')
  const locale = () => ctx.locale.getSnapshot().active
  let visible = false
  const listeners = new Set<() => void>()
  const completions = new Set<() => void>()
  const show = (complete?: () => void) => {
    if (complete) completions.add(complete)
    visible = true
    for (const listener of listeners) listener()
  }
  const close = () => {
    visible = false
    for (const complete of completions) complete()
    completions.clear()
    for (const listener of listeners) listener()
  }
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  function AccountOverlay(): JSX.Element | null {
    const open = useSyncExternalStore(subscribe, () => visible)
    return open ? (
      <ManualSignInDialog t={t as TranslateNS<'auth-remote'>} locale={locale} close={close} />
    ) : null
  }
  // The sidebar and onboarding can remount while initial workspace/settings
  // data settles. Keep the pending dialog in the stable frame overlay instead.
  slots.inject('shell.overlay', () =>
    slots.register(
      {
        name: 'shell.overlay',
        id: 'auth-remote.account-sign-in',
        locale: 'auth-remote',
      },
      AccountOverlay,
    ),
  )
  const wrappers = new WeakSet<object>()
  for (const name of ['settings.launcher', 'settings.models.sign-in']) {
    slots.inject(name, () => {
      let current: NativeEntry | undefined
      let unregister: (() => void) | undefined
      const update = () => {
        const native = slots
          .entries(name)
          .find(
            (entry) =>
              entry.locale === 'settings.account' &&
              entry.inject !== undefined &&
              !wrappers.has(entry.component),
          )
        if (native === current) return
        current = native
        unregister?.()
        unregister = undefined
        if (!native) return
        const Native = native.component
        function ManualAccountEntry(props: NativeProps): JSX.Element | null {
          const latest = useRef(props)
          latest.current = props
          useEffect(() => {
            if (name !== 'settings.launcher') {
              const complete = () => {
                latest.current.showLogin?.(false)
                latest.current.complete?.()
              }
              show(complete)
              return () => {
                completions.delete(complete)
              }
            }
          }, [])
          return name === 'settings.launcher'
            ? createElement(Native, {
                ...props,
                start: async () => {
                  show()
                },
              })
            : null
        }
        wrappers.add(ManualAccountEntry)
        unregister = slots.register(
          {
            name,
            priority: (native.options.priority ?? 0) - 100,
            // Framework still binds the native menu's translations and Hooks.
            ...(native.locale ? { locale: native.locale } : {}),
            inject: native.inject,
          },
          ManualAccountEntry,
        )
      }
      const stop = slots.subscribe(name, update)
      update()
      return () => {
        stop()
        unregister?.()
      }
    })
  }
}
