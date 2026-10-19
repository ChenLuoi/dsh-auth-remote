import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import type { BindingResponse } from '../../shared/auth-contract.js'
import { authRequest, goToLogin, holdLoginRedirect, type AccountStatus } from './api.js'
import {
  SecurityDialog,
  CredentialFields,
  CancelButton,
  OperationError,
  useSecurityOperation,
  type SecurityTranslate,
} from './dialog.js'

type Binding = { challenge: string; secret: string }

function SecretQr({ uri, t }: { uri: string; t: SecurityTranslate }): JSX.Element {
  const [data, setData] = useState('')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let live = true
    setData('')
    setFailed(false)
    void QRCode.toDataURL(uri, { width: 220, margin: 2, errorCorrectionLevel: 'M' }).then(
      (value) => {
        if (live) setData(value)
      },
      () => {
        if (live) setFailed(true)
      },
    )
    return () => {
      live = false
    }
  }, [uri])
  return data ? (
    <img src={data} alt={t('settingsQrAlt')} width={220} height={220} />
  ) : (
    <p>{t(failed ? 'settingsQrUnavailable' : 'settingsQrLoading')}</p>
  )
}

export function TotpDialog({
  me,
  t,
  close,
}: {
  me: AccountStatus
  t: SecurityTranslate
  close: () => void
}): JSX.Element {
  const [binding, setBinding] = useState<Binding | null>(null)
  const [codes, setCodes] = useState<string[] | null>(null)
  const [copied, setCopied] = useState<'success' | 'failed' | null>(null)
  const releaseCodes = useRef<() => void>()
  const { busy, message, setMessage, run } = useSecurityOperation()
  useEffect(() => () => releaseCodes.current?.(), [])
  const issuer = 'DSH Auth Remote'
  const uri = binding
    ? `otpauth://totp/${encodeURIComponent(`${issuer}:${me.username}`)}?secret=${binding.secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`
    : ''
  const title = t(
    codes
      ? 'settingsBackupTitle'
      : binding
        ? 'settingsScanQr'
        : me.totpEnabled
          ? 'settingsRebindTotp'
          : 'settingsBindTotp',
  )
  return (
    <SecurityDialog title={title} t={t} close={close} busy={busy} locked={codes !== null}>
      {codes ? (
        <>
          <p>{t('settingsBackupDescription')}</p>
          {me.totpEnabled && <p>{t('settingsOldBackupInvalid')}</p>}
          <ol className="auth-remote-backup-codes">
            {codes.map((code) => (
              <li key={code}>{code}</li>
            ))}
          </ol>
          <p role="status">
            {copied &&
              t(copied === 'success' ? 'settingsBackupCopied' : 'settingsBackupCopyFailed')}
          </p>
          <div className="auth-remote-dialog-actions">
            <button
              className="auth-remote-button"
              onClick={() => {
                void (async () => {
                  try {
                    await navigator.clipboard.writeText(codes.join('\n'))
                    setCopied('success')
                  } catch {
                    setCopied('failed')
                  }
                })()
              }}
            >
              {t('settingsCopyAll')}
            </button>
            <button
              className="auth-remote-button auth-remote-primary"
              onClick={() => {
                goToLogin('updated')
                setCodes(null)
                setBinding(null)
                setCopied(null)
                releaseCodes.current?.()
                releaseCodes.current = undefined
              }}
            >
              {t('settingsBackupSaved')}
            </button>
          </div>
        </>
      ) : binding ? (
        <form
          key="confirm"
          onSubmit={(event) => {
            event.preventDefault()
            const data = new FormData(event.currentTarget)
            void run(
              () =>
                authRequest<BindingResponse>('/auth-remote/totp/confirm', {
                  challenge: binding.challenge,
                  code: data.get('code'),
                }),
              (result) => {
                releaseCodes.current ??= holdLoginRedirect()
                setCodes(result.backupCodes)
                setBinding(null)
                setCopied(null)
              },
            )
          }}
        >
          <SecretQr uri={uri} t={t} />
          <p>
            {t('settingsManualSecret')} <code>{binding.secret}</code>
          </p>
          <fieldset disabled={busy}>
            <label className="auth-remote-field">
              {t('settingsNewCode')}
              <input name="code" autoComplete="one-time-code" required />
            </label>
          </fieldset>
          <OperationError message={message} t={t} />
          <div className="auth-remote-dialog-actions">
            <CancelButton t={t} close={close} busy={busy} />
            <button
              type="button"
              className="auth-remote-button"
              disabled={busy}
              onClick={() => {
                setBinding(null)
                setMessage(null)
              }}
            >
              {t('settingsRestartBinding')}
            </button>
            <button
              className="auth-remote-button auth-remote-primary"
              type="submit"
              disabled={busy}
            >
              {t('settingsConfirmBinding')}
            </button>
          </div>
        </form>
      ) : (
        <form
          key="credentials"
          onSubmit={(event) => {
            event.preventDefault()
            const data = new FormData(event.currentTarget)
            void run(
              () =>
                authRequest<Binding>('/auth-remote/totp/start', {
                  password: data.get('password'),
                  ...(me.totpEnabled ? { currentCode: data.get('currentCode') } : {}),
                }),
              setBinding,
            )
          }}
        >
          <p>{t('settingsBindDescription')}</p>
          <fieldset disabled={busy}>
            <CredentialFields t={t} totpEnabled={me.totpEnabled} />
          </fieldset>
          <OperationError message={message} t={t} />
          <div className="auth-remote-dialog-actions">
            <CancelButton t={t} close={close} busy={busy} />
            <button
              className="auth-remote-button auth-remote-primary"
              type="submit"
              disabled={busy}
            >
              {t('settingsStartBinding')}
            </button>
          </div>
        </form>
      )}
    </SecurityDialog>
  )
}
