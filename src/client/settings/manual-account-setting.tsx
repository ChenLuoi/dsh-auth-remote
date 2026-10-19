import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { AccountLoginState } from '../../shared/account-login.js'
import {
  hasManualAccountRuntime,
  type ManualAccountBinding,
  type ManualAccountPreferences,
} from '../account/config.js'
import { authRequest } from './api.js'

const unavailable: ConfigFormSnapshot<ManualAccountPreferences> = {
  status: 'unavailable',
  value: undefined,
  base: undefined,
  user: undefined,
  revision: undefined,
  writable: false,
}

export function ManualAccountSetting({
  binding,
  t,
  clientAvailable,
}: {
  binding: ManualAccountBinding
  t: TranslateNS<'auth-remote'>
  clientAvailable: boolean
}): JSX.Element {
  const form = binding.form
  const snapshot = useSyncExternalStore(
    (listener) => form?.subscribe(listener) ?? (() => {}),
    () => form?.getSnapshot() ?? unavailable,
  )
  const mirrorError = useSyncExternalStore(
    (listener) => binding.mirror?.subscribe(listener) ?? (() => {}),
    () => binding.mirror?.getSnapshot().error ?? null,
  )
  const [supported, setSupported] = useState<boolean | undefined>(
    hasManualAccountRuntime() ? undefined : false,
  )
  const [pending, setPending] = useState<{ previous: boolean } | null>(null)
  const saving = useRef(false)
  const [failed, setFailed] = useState(false)
  const [known, setKnown] = useState(true)
  useEffect(() => {
    let live = true
    void authRequest<AccountLoginState>('/auth-remote/account/state').then(
      (value) => {
        if (live) setSupported(value.supported)
      },
      () => {
        if (live) setSupported(false)
      },
    )
    return () => {
      live = false
    }
  }, [])
  const ready =
    known && snapshot.status === 'ready' && typeof snapshot.value?.manualAccountLogin === 'boolean'
  const available = supported === true && clientAvailable
  async function save(value: boolean) {
    if (!form || !ready || saving.current) return
    saving.current = true
    setPending({ previous: snapshot.value!.manualAccountLogin })
    setFailed(false)
    try {
      if (!(await form.set('manualAccountLogin', value))) setFailed(true)
    } catch {
      setFailed(true)
      setKnown(false)
      try {
        setKnown(await binding.refresh())
      } catch {
        /* Retry can re-read the native configuration. */
      }
    } finally {
      saving.current = false
      setPending(null)
    }
  }
  return (
    <div className="auth-remote-manual-setting">
      <h3>{t('settingsLoginConfiguration')}</h3>
      <div className="auth-remote-manual-row">
        <div className="auth-remote-manual-copy">
          <span id="auth-remote-manual-label">{t('settingsManualAccountLogin')}</span>
          <p id="auth-remote-manual-description">{t('settingsManualDescription')}</p>
        </div>
        {ready && (
          <button
            type="button"
            role="switch"
            className="auth-remote-switch"
            aria-labelledby="auth-remote-manual-label"
            aria-describedby="auth-remote-manual-description"
            aria-checked={pending?.previous ?? snapshot.value!.manualAccountLogin}
            disabled={pending !== null || !snapshot.writable || !available}
            onClick={() => {
              void save(!snapshot.value!.manualAccountLogin)
            }}
          >
            <span aria-hidden="true" />
          </button>
        )}
      </div>
      {!ready && (
        <p role="status">
          {t(
            snapshot.status === 'loading' && !mirrorError
              ? 'settingsLoading'
              : 'settingsManualConfigUnavailable',
          )}
        </p>
      )}
      {(supported === false || !clientAvailable) && (
        <p role="status">{t('settingsManualUnavailable')}</p>
      )}
      {pending && <p role="status">{t('settingsSaving')}</p>}
      {failed && <p role="alert">{t('settingsManualSaveFailed')}</p>}
      {(!known || !ready) && (
        <button
          className="auth-remote-button"
          onClick={() => {
            void binding.refresh().then(
              (value) => {
                setKnown(value)
                setFailed(!value)
              },
              () => setFailed(true),
            )
          }}
        >
          {t('settingsRetry')}
        </button>
      )}
    </div>
  )
}
