import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import {
  ACCOUNT_LOGIN_BASE,
  isActiveAccountLogin,
  type AccountLoginState,
} from '../../shared/account-login.js'
import type { MessageKey } from '../../shared/i18n.js'
import { authRequest, goToLogin, isUnauthorized, SettingsFailure } from '../settings/api.js'

function failureMessage(error: unknown): MessageKey {
  if (!(error instanceof SettingsFailure)) return 'errorNetwork'
  switch (error.code) {
    case 'account_invalid_callback':
      return 'accountLoginInvalidCallback'
    case 'account_attempt_expired':
      return 'accountLoginExpired'
    case 'account_attempt_mismatch':
      return 'accountLoginMismatch'
    case 'account_busy':
      return 'accountLoginBusy'
    case 'account_unavailable':
      return 'accountLoginUnavailable'
    case 'account_exchange_failed':
      return 'accountLoginFailed'
    default:
      return 'errorServiceUnavailable'
  }
}

export function ManualSignInDialog({
  t,
  locale,
  close,
  useApiKey,
}: {
  t: TranslateNS<'auth-remote'>
  locale: () => string
  close: () => void
  useApiKey?: () => void
}): JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null)
  const popup = useRef<Window | null>(null)
  const navigated = useRef<string>()
  const latest = useRef<AccountLoginState>()
  const live = useRef(true)
  const revision = useRef(0)
  const onClose = useRef(close)
  onClose.current = close
  const [state, setState] = useState<AccountLoginState>()
  const [callbackUrl, setCallbackUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<MessageKey>()
  const [blocked, setBlocked] = useState(false)

  const accept = (value: AccountLoginState) => {
    latest.current = value
    if (!live.current) return
    setState(value)
    if (value.status === 'credential-stored') {
      setCallbackUrl('')
      onClose.current()
      return
    }
    const attempt = value.attempt
    if (
      attempt?.authorizeUrl &&
      navigated.current !== attempt.id &&
      popup.current &&
      !popup.current.closed
    ) {
      const target = new URL(attempt.authorizeUrl)
      target.searchParams.set(
        'theme',
        document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light',
      )
      popup.current.location.replace(target.href)
      navigated.current = attempt.id
    }
  }

  useEffect(() => {
    live.current = true
    dialog.current?.showModal()
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      const generation = revision.current
      try {
        const value = await authRequest<AccountLoginState>(`${ACCOUNT_LOGIN_BASE}/state`)
        if (generation === revision.current) accept(value)
      } catch (error) {
        if (isUnauthorized(error)) goToLogin()
        else if (live.current) setMessage(failureMessage(error))
      }
      if (live.current) timer = setTimeout(() => void poll(), 1000)
    }
    void poll()
    return () => {
      live.current = false
      clearTimeout(timer)
      popup.current?.close()
      const attempt = latest.current?.attempt
      if (attempt && isActiveAccountLogin(attempt.phase))
        void authRequest(`${ACCOUNT_LOGIN_BASE}/cancel`, { id: attempt.id }).catch(() => {})
    }
  }, [])

  const attempt = state?.attempt
  const phase = attempt?.phase
  const waiting = phase === 'waiting-browser'
  const pending = phase === 'initializing' || phase === 'exchanging' || phase === 'committing'
  const active = attempt && isActiveAccountLogin(attempt.phase)
  const statusMessage =
    phase === 'expired'
      ? 'accountLoginExpired'
      : phase === 'failed'
        ? attempt?.errorCode === 'no-response'
          ? 'accountLoginNoResponse'
          : 'accountLoginFailed'
        : undefined

  async function run(operation: () => Promise<void>): Promise<void> {
    if (busy) return
    setBusy(true)
    revision.current++
    setMessage(undefined)
    try {
      await operation()
    } catch (error) {
      if (isUnauthorized(error)) goToLogin()
      else if (live.current) setMessage(failureMessage(error))
    } finally {
      if (live.current) setBusy(false)
    }
  }

  function start(): void {
    // The only popup is opened by this explicit button click, before the POST.
    popup.current?.close()
    popup.current = window.open('about:blank', '_blank')
    if (popup.current) popup.current.opener = null
    setBlocked(popup.current === null)
    navigated.current = undefined
    setCallbackUrl('')
    void run(async () => {
      try {
        accept(
          await authRequest<AccountLoginState>(`${ACCOUNT_LOGIN_BASE}/start`, {
            locale: locale(),
            timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
          }),
        )
      } catch (error) {
        popup.current?.close()
        throw error
      }
    })
  }

  function dismiss(): void {
    if (busy || phase === 'committing') return
    void run(async () => {
      if (active) await authRequest(`${ACCOUNT_LOGIN_BASE}/cancel`, { id: attempt.id })
      setCallbackUrl('')
      onClose.current()
    })
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (!waiting || !attempt) return
    void run(async () => {
      accept(
        await authRequest<AccountLoginState>(`${ACCOUNT_LOGIN_BASE}/submit`, {
          id: attempt.id,
          callbackUrl,
        }),
      )
    })
  }

  return (
    <dialog
      ref={dialog}
      className="auth-remote-account-dialog"
      aria-labelledby="auth-remote-account-title"
      onCancel={(event) => {
        event.preventDefault()
        dismiss()
      }}
    >
      <form onSubmit={submit}>
        <div className="auth-remote-account-header">
          <h2 id="auth-remote-account-title">{t('accountLoginTitle')}</h2>
          <button
            type="button"
            className="auth-remote-account-close"
            aria-label={t('accountLoginClose')}
            disabled={busy || phase === 'committing'}
            onClick={dismiss}
          >
            ×
          </button>
        </div>
        <div className="auth-remote-account-body">
          <p className="auth-remote-account-description">{t('accountLoginDescription')}</p>
          <ol className="auth-remote-account-steps">
            <li>{t('accountLoginStepOpen')}</li>
            <li>{t('accountLoginStepCopy')}</li>
            <li>{t('accountLoginStepSubmit')}</li>
          </ol>
          <div className="auth-remote-account-callback">
            <label className="auth-remote-account-field">
              {t('accountLoginCallbackLabel')}
              <textarea
                rows={3}
                value={callbackUrl}
                onChange={(event) => setCallbackUrl(event.currentTarget.value)}
                placeholder="http://127.0.0.1:49183/oauth/callback?code=…&state=…"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={8192}
                disabled={!waiting || busy}
                required
                aria-describedby="auth-remote-account-hint"
              />
            </label>
            <p id="auth-remote-account-hint" className="auth-remote-account-hint">
              {t('accountLoginCallbackHint')}
            </p>
          </div>
          {attempt?.authorizeUrl && waiting && (
            <p className="auth-remote-account-reopen">
              {blocked && <span>{t('accountLoginPopupBlocked')} </span>}
              <a href={attempt.authorizeUrl} target="_blank" rel="noopener noreferrer">
                {t('accountLoginReopen')}
              </a>
            </p>
          )}
          <p className="auth-remote-account-status" role="status" aria-live="polite">
            {pending
              ? t(phase === 'initializing' ? 'accountLoginInitializing' : 'accountLoginExchanging')
              : waiting
                ? t('accountLoginWaiting')
                : ''}
          </p>
          <p className="auth-remote-account-error" role="alert">
            {state?.supported === false
              ? t('accountLoginUnavailable')
              : message || statusMessage
                ? t(message ?? statusMessage!)
                : ''}
          </p>
        </div>
        <div className="auth-remote-account-actions">
          <button
            type="button"
            disabled={busy || phase === 'committing'}
            onClick={active || !useApiKey ? dismiss : useApiKey}
          >
            {t(active || !useApiKey ? 'accountLoginCancel' : 'accountLoginUseApiKey')}
          </button>
          {active ? (
            <button
              type="submit"
              className="auth-remote-account-primary"
              disabled={busy || !waiting || !callbackUrl.trim()}
            >
              {t(
                busy || phase === 'exchanging' || phase === 'committing'
                  ? 'accountLoginExchanging'
                  : 'accountLoginConfirm',
              )}
            </button>
          ) : (
            <button
              type="button"
              className="auth-remote-account-primary"
              onClick={start}
              disabled={busy || !state?.supported}
            >
              {t(attempt ? 'accountLoginRetry' : 'accountLoginOpen')}
            </button>
          )}
        </div>
      </form>
    </dialog>
  )
}
