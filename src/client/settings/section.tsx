import { useEffect, useState, type ReactNode } from 'react'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import {
  accountOverview,
  goToLogin,
  isUnauthorized,
  settingsError,
  type AccountStatus,
  type SettingsMessage,
} from './api.js'
import { PasswordDialog } from './password-dialog.js'
import { CredentialDialog, CurrentSessionDialog } from './credential-dialog.js'
import { TotpDialog } from './totp-dialog.js'

export function SecuritySection({
  t,
  manualAccountSetting,
  locale,
}: SettingsSectionOwnerProps & {
  t: TranslateNS<'auth-remote'>
  manualAccountSetting?: ReactNode
  locale?: string
}): JSX.Element {
  const [operation, setOperation] = useState<
    'password' | 'current' | 'all' | 'totp' | 'disable' | null
  >(null)
  const [loading, setLoading] = useState(true)
  const [reload, setReload] = useState(0)
  const [me, setMe] = useState<AccountStatus | null>(null)
  const [message, setMessage] = useState<SettingsMessage | null>(null)
  useEffect(() => {
    let live = true
    setLoading(true)
    void accountOverview().then(
      (value) => {
        if (live) {
          setMe(value)
          setMessage(null)
          setLoading(false)
        }
      },
      (error) => {
        if (isUnauthorized(error)) goToLogin()
        else if (live) {
          setMe(null)
          setMessage(settingsError(error))
          setLoading(false)
        }
      },
    )
    return () => {
      live = false
    }
  }, [reload])
  const dismiss = () => {
    setOperation(null)
    setReload((value) => value + 1)
  }
  const placeholder = <span aria-hidden="true">—</span>
  return (
    <section aria-label={t('settingsSectionAria')} className="auth-remote-security">
      <h2>{t('settingsTitle')}</h2>
      <h3>{t('settingsOverview')}</h3>
      {loading && (
        <span className="auth-remote-loading-status" role="status">
          {t('settingsLoading')}
        </span>
      )}
      <dl className="auth-remote-overview" aria-busy={loading}>
        <div>
          <dt>{t('settingsUsername')}</dt>
          <dd>{me ? me.username : placeholder}</dd>
        </div>
        <div>
          <dt>TOTP</dt>
          <dd className="auth-remote-totp-status">
            {me ? t(me.totpEnabled ? 'settingsTotpEnabled' : 'settingsTotpNotBound') : placeholder}
            {me?.requireTotp && (
              <span
                className="auth-remote-policy-hint"
                role="img"
                tabIndex={0}
                aria-label={t('settingsTotpRequired')}
                title={t('settingsTotpRequired')}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <circle cx="8" cy="8" r="6" stroke="currentColor" />
                  <path d="M8 7v4M8 4.5v1" stroke="currentColor" strokeLinecap="round" />
                </svg>
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt>{t('settingsCreatedAt')}</dt>
          <dd>
            {me
              ? new Intl.DateTimeFormat(locale || navigator.language, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                }).format(me.createdAt)
              : placeholder}
          </dd>
        </div>
        <div>
          <dt>{t('settingsExpiresAt')}</dt>
          <dd>
            {me
              ? new Intl.DateTimeFormat(locale || navigator.language, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                }).format(me.expiresAt)
              : placeholder}
          </dd>
        </div>
        <div>
          <dt>{t('settingsActiveSessions')}</dt>
          <dd>{me ? me.activeSessions : placeholder}</dd>
        </div>
      </dl>
      {!loading && !me && (
        <button className="auth-remote-button" onClick={() => setReload((value) => value + 1)}>
          {t('settingsRetry')}
        </button>
      )}
      {manualAccountSetting}
      <div className="auth-remote-operation-row">
        <h3>{t('settingsPasswordTitle')}</h3>
        <button
          className="auth-remote-button"
          disabled={!me}
          onClick={() => setOperation('password')}
        >
          {t('settingsChangePassword')}
        </button>
      </div>
      <div className="auth-remote-operation-row">
        <h3>TOTP</h3>
        <div className="auth-remote-actions">
          <button
            className="auth-remote-button"
            disabled={!me}
            onClick={() => setOperation('totp')}
          >
            {t(me?.totpEnabled ? 'settingsRebindTotp' : 'settingsBindTotp')}
          </button>
          {me?.totpEnabled && !me.requireTotp && (
            <button
              className="auth-remote-button"
              disabled={!me}
              onClick={() => setOperation('disable')}
            >
              {t('settingsDisableTotp')}
            </button>
          )}
        </div>
      </div>
      <div className="auth-remote-operation-row">
        <h3>{t('settingsSessions')}</h3>
        <div className="auth-remote-actions">
          <button
            className="auth-remote-button"
            disabled={!me}
            onClick={() => setOperation('current')}
          >
            {t('settingsSignOutCurrent')}
          </button>
          <button className="auth-remote-button" disabled={!me} onClick={() => setOperation('all')}>
            {t('settingsSignOutAll')}
          </button>
        </div>
      </div>
      {operation === 'password' && me && <PasswordDialog me={me} t={t} close={dismiss} />}
      {operation === 'current' && <CurrentSessionDialog t={t} close={dismiss} />}
      {operation === 'all' && me && (
        <CredentialDialog action="revoke" me={me} t={t} close={dismiss} />
      )}
      {operation === 'totp' && me && <TotpDialog me={me} t={t} close={dismiss} />}
      {operation === 'disable' && me && (
        <CredentialDialog action="disable" me={me} t={t} close={dismiss} />
      )}
      <p className="auth-remote-error" role="alert">
        {message && t(message.key, message.params)}
      </p>
    </section>
  )
}
