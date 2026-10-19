import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import {
  goToLogin,
  holdLoginRedirect,
  isUnauthorized,
  settingsError,
  type SettingsMessage,
} from './api.js'

export type SecurityTranslate = TranslateNS<'auth-remote'>

export function SecurityDialog({
  title,
  t,
  close,
  busy = false,
  locked = false,
  children,
}: {
  title: string
  t: SecurityTranslate
  close: () => void
  busy?: boolean
  locked?: boolean
  children: ReactNode
}): JSX.Element {
  const ref = useRef<HTMLDialogElement>(null)
  const current = useRef({ busy, locked, close })
  current.current = { busy, locked, close }
  useLayoutEffect(() => {
    const node = ref.current!
    const previous = document.activeElement
    const keyboard = (event: KeyboardEvent) => {
      if (!node.open || event.ctrlKey || event.altKey || event.metaKey) return
      const focusedDialog = document.activeElement?.closest('dialog[open]')
      if (focusedDialog && focusedDialog !== node) return
      if (event.key !== 'Tab' && event.key !== 'Escape') return
      // Own keyboard input before the host Settings layer, including a step
      // transition or disabled form that temporarily leaves focus on body.
      event.preventDefault()
      event.stopImmediatePropagation()
      if (event.key === 'Escape') {
        if (!event.isComposing && !event.repeat && !current.current.busy && !current.current.locked)
          current.current.close()
        return
      }
      const items = [
        ...node.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]',
        ),
      ].filter((item) => item.getClientRects().length > 0 && !item.closest('[hidden], [inert]'))
      const index = items.indexOf(document.activeElement as HTMLElement)
      const next = event.shiftKey
        ? index <= 0
          ? items.length - 1
          : index - 1
        : (index + 1) % items.length
      ;(items[next] ?? node).focus()
    }
    document.addEventListener('keydown', keyboard, true)
    node.showModal()
    ;(node.querySelector('input, [data-autofocus]') as HTMLElement | null)?.focus()
    return () => {
      document.removeEventListener('keydown', keyboard, true)
      node.close()
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])
  useLayoutEffect(() => {
    const node = ref.current
    if (node?.open && !node.contains(document.activeElement))
      (
        node.querySelector<HTMLElement>(
          'input:not(:disabled), [data-autofocus], button:not(:disabled)',
        ) ?? node
      ).focus()
  }, [title, locked])
  const dismiss = () => {
    if (!busy && !locked) close()
  }
  return (
    <dialog
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-labelledby="auth-remote-operation-title"
      className="auth-remote-security auth-remote-operation-dialog"
      tabIndex={-1}
      onCancel={(event) => {
        event.preventDefault()
        event.stopPropagation()
        dismiss()
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          const box = event.currentTarget.getBoundingClientRect()
          if (
            event.clientX < box.left ||
            event.clientX > box.right ||
            event.clientY < box.top ||
            event.clientY > box.bottom
          )
            dismiss()
        }
      }}
    >
      <div className="auth-remote-dialog-header">
        <h2 id="auth-remote-operation-title">{title}</h2>
        {!locked && (
          <button
            className="auth-remote-button auth-remote-dialog-close"
            type="button"
            disabled={busy}
            onClick={dismiss}
            aria-label={t('settingsClose')}
          >
            ×
          </button>
        )}
      </div>
      {children}
    </dialog>
  )
}

/** One atomic server request owns validation and execution, with a bounded expiry hold. */
export function useSecurityOperation() {
  const [busy, setBusy] = useState(false)
  const running = useRef(false)
  const [message, setMessage] = useState<SettingsMessage | null>(null)
  async function run<T>(operation: () => Promise<T>, done: (result: T) => void) {
    if (running.current) return
    running.current = true
    setBusy(true)
    setMessage(null)
    const release = holdLoginRedirect(30_000)
    try {
      done(await operation())
    } catch (error) {
      if (isUnauthorized(error)) goToLogin()
      else setMessage(settingsError(error))
    } finally {
      release()
      running.current = false
      setBusy(false)
    }
  }
  return { busy, message, setMessage, run }
}

export function OperationError({
  message,
  t,
}: {
  message: SettingsMessage | null
  t: SecurityTranslate
}): JSX.Element {
  return (
    <p className="auth-remote-error" role="alert">
      {message && t(message.key, message.params)}
    </p>
  )
}

export function CredentialFields({
  t,
  totpEnabled,
  passwordName = 'password',
  codeName = 'currentCode',
}: {
  t: SecurityTranslate
  totpEnabled: boolean
  passwordName?: string
  codeName?: string
}): JSX.Element {
  return (
    <>
      <label className="auth-remote-field">
        {t('settingsCurrentPassword')}
        <input type="password" name={passwordName} autoComplete="current-password" required />
      </label>
      {totpEnabled && (
        <label className="auth-remote-field">
          {t('settingsCurrentCode')}
          <input name={codeName} autoComplete="one-time-code" required />
        </label>
      )}
    </>
  )
}

export function CancelButton({
  t,
  close,
  busy,
}: {
  t: SecurityTranslate
  close: () => void
  busy: boolean
}): JSX.Element {
  return (
    <button className="auth-remote-button" type="button" onClick={close} disabled={busy}>
      {t('settingsCancel')}
    </button>
  )
}
