import { authRequest, goToLogin, type AccountStatus } from './api.js'
import {
  SecurityDialog,
  CredentialFields,
  CancelButton,
  OperationError,
  useSecurityOperation,
  type SecurityTranslate,
} from './dialog.js'

/** Verification is never cached: every submit verifies and executes atomically. */
export function CredentialDialog({
  action,
  me,
  t,
  close,
}: {
  action: 'revoke' | 'disable'
  me: AccountStatus
  t: SecurityTranslate
  close: () => void
}): JSX.Element {
  const { busy, message, run } = useSecurityOperation()
  const label = t(action === 'revoke' ? 'settingsSignOutAll' : 'settingsDisableTotp')
  return (
    <SecurityDialog title={label} t={t} close={close} busy={busy}>
      <p>
        {t(action === 'revoke' ? 'settingsSignOutAllDescription' : 'settingsDisableDescription')}
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          const data = new FormData(event.currentTarget)
          void run(
            () =>
              authRequest(
                action === 'revoke' ? '/auth-remote/revoke-sessions' : '/auth-remote/totp/disable',
                {
                  password: data.get('password'),
                  ...(me.totpEnabled ? { currentCode: data.get('currentCode') } : {}),
                },
              ),
            () => goToLogin('updated'),
          )
        }}
      >
        <fieldset disabled={busy}>
          <CredentialFields t={t} totpEnabled={me.totpEnabled} />
        </fieldset>
        <OperationError message={message} t={t} />
        <div className="auth-remote-dialog-actions">
          <CancelButton t={t} close={close} busy={busy} />
          <button className="auth-remote-button auth-remote-primary" disabled={busy} type="submit">
            {label}
          </button>
        </div>
      </form>
    </SecurityDialog>
  )
}

export function CurrentSessionDialog({
  t,
  close,
}: {
  t: SecurityTranslate
  close: () => void
}): JSX.Element {
  const { busy, message, run } = useSecurityOperation()
  return (
    <SecurityDialog title={t('settingsSignOutCurrent')} t={t} close={close} busy={busy}>
      <p>{t('settingsSignOutCurrentDescription')}</p>
      <OperationError message={message} t={t} />
      <div className="auth-remote-dialog-actions">
        <CancelButton t={t} close={close} busy={busy} />
        <button
          className="auth-remote-button auth-remote-primary"
          data-autofocus
          disabled={busy}
          onClick={() => {
            void run(
              () => authRequest('/auth-remote/logout', {}),
              () => goToLogin('signed-out'),
            )
          }}
        >
          {t('settingsSignOutCurrent')}
        </button>
      </div>
    </SecurityDialog>
  )
}
