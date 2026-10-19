import { createElement, useEffect, useRef, useSyncExternalStore, type ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { ManualSignInDialog } from './dialog.js'
import { hasManualAccountRuntime, manualAccountBinding } from './config.js'

type NativeProps = Record<string, unknown> & {
  complete?: () => void
  showLogin?: (visible: boolean) => void
  useApiKey?: () => void
  openOnboarding?: (id: string) => void
  start?: () => Promise<void>
}

interface DialogOwner {
  complete?: () => void
  useApiKey?: () => void
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

export function hasManualAccountClient(ctx: Context, requireEntry = true): boolean {
  const slots = ctx.get('slots') as AccountSlots | undefined
  return (
    hasManualAccountRuntime() &&
    !!slots &&
    ['entries', 'subscribe', 'inject', 'register'].every(
      (key) => typeof slots[key as keyof AccountSlots] === 'function',
    ) &&
    (!requireEntry ||
      slots
        .entries('settings.launcher')
        .some((entry) => entry.locale === 'settings.account' && typeof entry.inject === 'function'))
  )
}

export function installManualAccountLogin(ctx: Context): void {
  if (!hasManualAccountClient(ctx, false)) return
  const slots = ctx.get('slots') as AccountSlots
  const t = ctx.locale.bind('auth-remote')
  const locale = () => ctx.locale.getSnapshot().active
  let dialog: DialogOwner | undefined
  const listeners = new Set<() => void>()
  const completions = new Set<() => void>()
  const notify = () => {
    for (const listener of listeners) listener()
  }
  const show = (owner: DialogOwner = {}) => {
    if (owner.complete) completions.add(owner.complete)
    dialog = owner
    notify()
  }
  const close = () => {
    dialog = undefined
    const pending = [...completions]
    completions.clear()
    notify()
    for (const complete of pending) complete()
  }
  const useApiKey = () => {
    const action = dialog?.useApiKey
    if (!action) return
    dialog = undefined
    // Selecting credentials continues native onboarding; it must not complete it.
    completions.clear()
    notify()
    action()
  }
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  function AccountOverlay(): JSX.Element | null {
    const owner = useSyncExternalStore(subscribe, () => dialog)
    return owner ? (
      <ManualSignInDialog
        t={t as TranslateNS<'auth-remote'>}
        locale={locale}
        close={close}
        {...(owner.useApiKey ? { useApiKey } : {})}
      />
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
  ctx.inject(['configForms'], (configCtx) => {
    const { form: nativeForm, mirror } = manualAccountBinding(configCtx)
    const form = nativeForm!
    const subscribePreference = (listener: () => void) => {
      const stopForm = form.subscribe(listener)
      const stopMirror = mirror?.subscribe(listener)
      return () => {
        stopForm()
        stopMirror?.()
      }
    }
    const preference = () => {
      const snapshot = form.getSnapshot()
      return snapshot.status === 'ready'
        ? snapshot.value?.manualAccountLogin === true
        : snapshot.status === 'unavailable' || mirror?.getSnapshot().error
          ? false
          : undefined
    }
    const wrappers = new WeakSet<object>()
    for (const name of ['settings.launcher', 'settings.models.sign-in']) {
      const activeSlots = configCtx.get('slots') as AccountSlots
      activeSlots.inject(name, () => {
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
            const enabled = useSyncExternalStore(subscribePreference, preference)
            // Keep an already open native or manual onboarding task in its original mode.
            const initialMode = useRef<boolean>()
            if (initialMode.current === undefined && enabled !== undefined)
              initialMode.current = enabled
            const manualOnboarding = initialMode.current
            useEffect(() => {
              if (name !== 'settings.launcher' && manualOnboarding === true) {
                const complete = () => {
                  latest.current.showLogin?.(false)
                  latest.current.complete?.()
                }
                const owner: DialogOwner = {
                  complete,
                  ...(latest.current.useApiKey
                    ? {
                        useApiKey: () => {
                          latest.current.showLogin?.(false)
                          latest.current.useApiKey?.()
                        },
                      }
                    : {}),
                }
                show(owner)
                return () => {
                  completions.delete(complete)
                  if (dialog === owner && owner.useApiKey) {
                    dialog = {}
                    notify()
                  }
                }
              }
            }, [manualOnboarding])
            return name === 'settings.launcher'
              ? createElement(Native, {
                  ...props,
                  start: async () => {
                    // Loading is not an accepted false preference. Keep
                    // this click pending on the shared native read, then
                    // choose the route from the latest accepted value.
                    if (preference() === undefined) await mirror?.ensure()
                    const manual = preference()
                    if (manual === undefined) return
                    if (!manual) return latest.current.start?.()
                    show(
                      latest.current.openOnboarding
                        ? {
                            useApiKey: () => {
                              latest.current.showLogin?.(false)
                              latest.current.openOnboarding?.('deepseek-official')
                            },
                          }
                        : {},
                    )
                  },
                })
              : manualOnboarding === false
                ? createElement(Native, props)
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
  })
}
