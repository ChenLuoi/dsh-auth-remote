import { useEffect, useRef, useState, type FormEvent } from 'react'
import QRCode from 'qrcode'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { BindingResponse } from '../../shared/auth-contract.js'
import {
  authRequest,
  goToLogin,
  isUnauthorized,
  settingsError,
  type AccountStatus,
  type SettingsMessage,
} from './api.js'

type Panel = 'password' | 'totp' | 'sessions' | null
type Binding = { challenge: string; secret: string; uri: string }
type SecurityDraft = {
  panel: Panel
  binding: Binding | null
  backupCodes: string[] | null
  message: SettingsMessage | null
  fields: Record<string, string>
}

/** The settings shell renders only the active section. Keep this page's draft while navigating to Language. */
let draft: SecurityDraft = {
  panel: null,
  binding: null,
  backupCodes: null,
  message: null,
  fields: {},
}

function resetDraft(): void {
  draft = { panel: null, binding: null, backupCodes: null, message: null, fields: {} }
}

function TextField(props: {
  label: string
  name: string
  type?: 'password' | 'text'
  required?: boolean
  autoComplete?: string
}): JSX.Element {
  return (
    <label className="auth-remote-field">
      {props.label}
      <input
        name={props.name}
        defaultValue={draft.fields[props.name] ?? ''}
        onChange={(event) => {
          draft.fields[props.name] = event.currentTarget.value
        }}
        type={props.type ?? 'text'}
        required={props.required ?? true}
        autoComplete={props.autoComplete}
      />
    </label>
  )
}

function SecretQr({ uri, t }: { uri: string; t: TranslateNS<'auth-remote'> }): JSX.Element {
  const [dataUrl, setDataUrl] = useState('')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let live = true
    setFailed(false)
    setDataUrl('')
    void QRCode.toDataURL(uri, { width: 220, margin: 2, errorCorrectionLevel: 'M' }).then(
      (value) => {
        if (live) setDataUrl(value)
      },
      () => {
        if (live) setFailed(true)
      },
    )
    return () => {
      live = false
    }
  }, [uri])
  return dataUrl ? (
    <img src={dataUrl} alt={t('settingsQrAlt')} width={220} height={220} />
  ) : (
    <p>{failed ? t('settingsQrUnavailable') : t('settingsQrLoading')}</p>
  )
}

export function SecuritySection({
  t,
}: SettingsSectionOwnerProps & { t: TranslateNS<'auth-remote'> }): JSX.Element {
  const sectionRef = useRef<HTMLElement>(null)
  const [me, setMe] = useState<AccountStatus | null>(null)
  const [panel, setPanel] = useState<Panel>(draft.panel)
  const [binding, setBinding] = useState<Binding | null>(draft.binding)
  const [backupCodes, setBackupCodes] = useState<string[] | null>(draft.backupCodes)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<SettingsMessage | null>(draft.message)

  useEffect(() => {
    draft.panel = panel
    draft.binding = binding
    draft.backupCodes = backupCodes
    draft.message = message
  }, [panel, binding, backupCodes, message])

  useEffect(() => {
    const dialog = sectionRef.current?.closest('[role="dialog"]')
    return () => {
      requestAnimationFrame(() => {
        if (!dialog?.isConnected || !dialog.getClientRects().length) resetDraft()
      })
    }
  }, [])

  useEffect(() => {
    let live = true
    void authRequest<AccountStatus>('/auth-remote/me').then(
      (value) => {
        if (live) setMe(value)
      },
      (error: unknown) => {
        if (isUnauthorized(error)) goToLogin()
        else if (live) setMessage(settingsError(error))
      },
    )
    return () => {
      live = false
    }
  }, [])

  async function submit<T>(operation: () => Promise<T>, done: (result: T) => void): Promise<void> {
    if (busy) return
    setBusy(true)
    setMessage(null)
    try {
      done(await operation())
    } catch (error) {
      if (isUnauthorized(error)) goToLogin()
      else setMessage(settingsError(error))
    } finally {
      setBusy(false)
    }
  }

  function values(event: FormEvent<HTMLFormElement>): FormData {
    event.preventDefault()
    return new FormData(event.currentTarget)
  }

  if (backupCodes) {
    return (
      <section
        ref={sectionRef}
        className="auth-remote-security"
        aria-label={t('settingsSectionAria')}
      >
        <h2>{t('settingsBackupTitle')}</h2>
        <p>{t('settingsBackupDescription')}</p>
        <ol className="auth-remote-backup-codes">
          {backupCodes.map((code) => (
            <li key={code}>{code}</li>
          ))}
        </ol>
        <button
          className="auth-remote-button"
          onClick={() => {
            resetDraft()
            goToLogin('updated')
          }}
        >
          {t('settingsBackupSaved')}
        </button>
      </section>
    )
  }

  return (
    <section
      ref={sectionRef}
      aria-label={t('settingsSectionAria')}
      className="auth-remote-security"
    >
      <h2>{t('settingsTitle')}</h2>
      <p>
        {me
          ? t('settingsAccountSummary', {
              username: me.username,
              totp: t(me.totpEnabled ? 'settingsTotpEnabled' : 'settingsTotpNotBound'),
            })
          : t('settingsLoading')}
      </p>
      <div className="auth-remote-actions">
        <button
          className="auth-remote-button"
          disabled={!me || busy}
          aria-pressed={panel === 'password'}
          onClick={() => {
            setPanel('password')
            setMessage(null)
          }}
        >
          {t('settingsChangePassword')}
        </button>
        <button
          className="auth-remote-button"
          disabled={!me || busy}
          aria-pressed={panel === 'totp'}
          onClick={() => {
            setPanel('totp')
            setBinding(null)
            setMessage(null)
          }}
        >
          {t(me?.totpEnabled ? 'settingsRebindTotp' : 'settingsBindTotp')}
        </button>
        <button
          className="auth-remote-button"
          disabled={!me || busy}
          aria-pressed={panel === 'sessions'}
          onClick={() => {
            setPanel('sessions')
            setMessage(null)
          }}
        >
          {t('settingsSessions')}
        </button>
      </div>
      {panel === 'password' && (
        <form
          onSubmit={(event) => {
            const data = values(event)
            const next = String(data.get('newPassword') ?? '')
            if (next !== data.get('confirmPassword')) {
              setMessage({ key: 'settingsPasswordMismatch' })
              return
            }
            void submit(
              () =>
                authRequest('/auth-remote/password', {
                  currentPassword: data.get('currentPassword'),
                  ...(me?.totpEnabled ? { currentCode: data.get('currentCode') } : {}),
                  newPassword: next,
                }),
              () => goToLogin('updated'),
            )
          }}
        >
          <h3>{t('settingsChangePassword')}</h3>
          <p>{t('settingsPasswordDescription')}</p>
          <TextField
            label={t('settingsCurrentPassword')}
            name="currentPassword"
            type="password"
            autoComplete="current-password"
          />
          {me?.totpEnabled && (
            <TextField
              label={t('settingsCurrentCode')}
              name="currentCode"
              autoComplete="one-time-code"
            />
          )}
          <TextField
            label={t('settingsNewPassword')}
            name="newPassword"
            type="password"
            autoComplete="new-password"
          />
          <TextField
            label={t('settingsConfirmPassword')}
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
          />
          <button className="auth-remote-button auth-remote-primary" disabled={busy} type="submit">
            {t('settingsSavePassword')}
          </button>
        </form>
      )}
      {panel === 'totp' && !binding && (
        <>
          <form
            onSubmit={(event) => {
              const data = values(event)
              void submit(
                () =>
                  authRequest<{ challenge: string; secret: string }>('/auth-remote/totp/start', {
                    password: data.get('password'),
                    ...(me?.totpEnabled ? { currentCode: data.get('currentCode') } : {}),
                  }),
                (result) => {
                  const issuer = 'DSH Auth Remote'
                  const label = `${issuer}:${me?.username ?? ''}`
                  setBinding({
                    ...result,
                    uri: `otpauth://totp/${encodeURIComponent(label)}?secret=${result.secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`,
                  })
                },
              )
            }}
          >
            <h3>{t(me?.totpEnabled ? 'settingsRebindTotp' : 'settingsBindTotp')}</h3>
            <p>{t('settingsBindDescription')}</p>
            <TextField
              label={t('settingsCurrentPassword')}
              name="password"
              type="password"
              autoComplete="current-password"
            />
            {me?.totpEnabled && (
              <TextField
                label={t('settingsCurrentCode')}
                name="currentCode"
                autoComplete="one-time-code"
              />
            )}
            <button
              className="auth-remote-button auth-remote-primary"
              disabled={busy}
              type="submit"
            >
              {t('settingsStartBinding')}
            </button>
          </form>
          {me?.totpEnabled && !me.requireTotp && (
            <form
              onSubmit={(event) => {
                const data = values(event)
                void submit(
                  () =>
                    authRequest('/auth-remote/totp/disable', {
                      password: data.get('disablePassword'),
                      currentCode: data.get('disableCode'),
                    }),
                  () => goToLogin('updated'),
                )
              }}
            >
              <h3>{t('settingsDisableTotp')}</h3>
              <p>{t('settingsDisableDescription')}</p>
              <TextField
                label={t('settingsCurrentPassword')}
                name="disablePassword"
                type="password"
                autoComplete="current-password"
              />
              <TextField
                label={t('settingsCurrentCode')}
                name="disableCode"
                autoComplete="one-time-code"
              />
              <button
                className="auth-remote-button auth-remote-primary"
                disabled={busy}
                type="submit"
              >
                {t('settingsDisableTotp')}
              </button>
            </form>
          )}
        </>
      )}
      {panel === 'totp' && binding && (
        <form
          onSubmit={(event) => {
            const data = values(event)
            void submit(
              () =>
                authRequest<BindingResponse>('/auth-remote/totp/confirm', {
                  challenge: binding.challenge,
                  code: data.get('code'),
                }),
              (result) => setBackupCodes(result.backupCodes),
            )
          }}
        >
          <h3>{t('settingsScanQr')}</h3>
          <SecretQr uri={binding.uri} t={t} />
          <p>
            {t('settingsManualSecret')} <code>{binding.secret}</code>
          </p>
          <TextField label={t('settingsNewCode')} name="code" autoComplete="one-time-code" />
          <button className="auth-remote-button auth-remote-primary" disabled={busy} type="submit">
            {t('settingsConfirmBinding')}
          </button>
          <button
            className="auth-remote-button auth-remote-restart"
            type="button"
            onClick={() => setBinding(null)}
          >
            {t('settingsRestartBinding')}
          </button>
        </form>
      )}
      {panel === 'sessions' && (
        <>
          <h3>{t('settingsSessions')}</h3>
          <button
            className="auth-remote-button"
            disabled={busy}
            onClick={() =>
              void submit(
                () => authRequest('/auth-remote/logout', {}),
                () => goToLogin('signed-out'),
              )
            }
          >
            {t('settingsSignOutCurrent')}
          </button>
          <form
            onSubmit={(event) => {
              const data = values(event)
              void submit(
                () =>
                  authRequest('/auth-remote/revoke-sessions', {
                    password: data.get('password'),
                    ...(me?.totpEnabled ? { currentCode: data.get('currentCode') } : {}),
                  }),
                () => goToLogin('updated'),
              )
            }}
          >
            <h3>{t('settingsSignOutAll')}</h3>
            <p>{t('settingsSignOutAllDescription')}</p>
            <TextField
              label={t('settingsCurrentPassword')}
              name="password"
              type="password"
              autoComplete="current-password"
            />
            {me?.totpEnabled && (
              <TextField
                label={t('settingsCurrentCode')}
                name="currentCode"
                autoComplete="one-time-code"
              />
            )}
            <button
              className="auth-remote-button auth-remote-primary"
              disabled={busy}
              type="submit"
            >
              {t('settingsSignOutAll')}
            </button>
          </form>
        </>
      )}
      <p className="auth-remote-error" role="alert" aria-live="assertive">
        {message && t(message.key, message.params)}
      </p>
    </section>
  )
}
