import type { AccountStatus } from './api.js'
import { authRequest, goToLogin } from './api.js'
import {
  SecurityDialog,
  CredentialFields,
  CancelButton,
  OperationError,
  useSecurityOperation,
  type SecurityTranslate,
} from './dialog.js'

export function PasswordDialog({
  me,
  t,
  close,
}: {
  me: AccountStatus
  t: SecurityTranslate
  close: () => void
}): JSX.Element {
  const { busy, message, setMessage, run } = useSecurityOperation()
  return (
    <SecurityDialog title={t('settingsChangePassword')} t={t} close={close} busy={busy}>
      <p>{t('settingsPasswordDescription')}</p>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          const data = new FormData(event.currentTarget)
          const next = String(data.get('newPassword') ?? '')
          if (next !== data.get('confirmPassword')) {
            setMessage({ key: 'settingsPasswordMismatch' })
            return
          }
          void run(
            () =>
              authRequest('/auth-remote/password', {
                currentPassword: data.get('currentPassword'),
                ...(me.totpEnabled ? { currentCode: data.get('currentCode') } : {}),
                newPassword: next,
              }),
            () => goToLogin('updated'),
          )
        }}
      >
        <fieldset disabled={busy}>
          <CredentialFields t={t} totpEnabled={me.totpEnabled} passwordName="currentPassword" />
          <label className="auth-remote-field">
            {t('settingsNewPassword')}
            <input name="newPassword" type="password" autoComplete="new-password" required />
          </label>
          <label className="auth-remote-field">
            {t('settingsConfirmPassword')}
            <input name="confirmPassword" type="password" autoComplete="new-password" required />
          </label>
        </fieldset>
        <OperationError message={message} t={t} />
        <div className="auth-remote-dialog-actions">
          <CancelButton t={t} close={close} busy={busy} />
          <button className="auth-remote-button auth-remote-primary" disabled={busy} type="submit">
            {t('settingsSavePassword')}
          </button>
        </div>
      </form>
    </SecurityDialog>
  )
}
