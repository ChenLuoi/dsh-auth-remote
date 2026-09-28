import QRCode from 'qrcode'
import type {
  AuthErrorResponse,
  BindingResponse,
  LoginResponse,
  PublicStateResponse,
} from '../../shared/auth-contract.js'
import { formatMessage, parseExactLocale, type Locale, type MessageKey } from '../../shared/i18n.js'
import './style.css'

const root = document.getElementById('login-root')
if (!root) throw new Error('Missing login root')

class RequestFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryAfter?: number,
  ) {
    super(code)
  }
}

let state: PublicStateResponse | undefined
let busy = false
let lastUsername = ''
const localeKey = 'dsh-auth-remote.locale'
let locale: Locale = readLocale()
let titleKey: MessageKey = 'loginInitialTitle'
type Message = {
  key: MessageKey
  params?: Record<string, string | number>
  tone?: 'error' | 'info'
}
let currentMessage: Message | null = null

function readLocale(): Locale {
  try {
    return parseExactLocale(localStorage.getItem(localeKey)) ?? 'en'
  } catch {
    return 'en'
  }
}

function setLocale(value: string): void {
  const next = parseExactLocale(value)
  if (!next) return
  locale = next
  try {
    localStorage.setItem(localeKey, next)
  } catch {
    // The current page can still switch when storage is unavailable.
  }
  localize()
}

function t(key: MessageKey, params?: Record<string, string | number>): string {
  return formatMessage(locale, key, params ?? {})
}

function localize(): void {
  document.documentElement.lang = locale
  document.title = t(titleKey)
  for (const node of root!.querySelectorAll<HTMLElement>('[data-i18n]')) {
    node.textContent = t(node.dataset.i18n as MessageKey)
  }
  for (const node of root!.querySelectorAll<HTMLElement>('[data-i18n-aria-label]')) {
    node.setAttribute('aria-label', t(node.dataset.i18nAriaLabel as MessageKey))
  }
  const select = document.getElementById('language') as HTMLSelectElement | null
  if (select) select.value = locale
  paintMessage()
}

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id)
  if (!found) throw new Error(`Missing login element ${id}`)
  return found as T
}

function returnPath(): string {
  const raw = new URLSearchParams(location.search).get('return')
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '/'
  try {
    const target = new URL(raw, location.origin)
    if (target.origin !== location.origin || target.pathname.startsWith('/auth-remote')) return '/'
    if (target.pathname === '/') target.searchParams.delete('token')
    return target.pathname + target.search + target.hash
  } catch {
    return '/'
  }
}

function enterDsh(): void {
  location.assign(returnPath())
}

async function api<T>(path: string, body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    cache: 'no-store',
    credentials: 'same-origin',
  })
  const result: unknown = await response.json().catch(() => ({}))
  if (!response.ok) {
    const failure = result as AuthErrorResponse
    const seconds = Number(response.headers.get('retry-after'))
    throw new RequestFailure(
      response.status,
      typeof failure.error === 'string' ? failure.error : 'service_unavailable',
      Number.isFinite(seconds) && seconds > 0 ? seconds : failure.retryAfter,
    )
  }
  return result as T
}

function errorMessage(error: unknown): Message {
  if (!(error instanceof RequestFailure)) return { key: 'errorNetwork' }
  switch (error.code) {
    case 'invalid_credentials':
      return { key: 'loginErrorInvalidCredentials' }
    case 'invalid_factor':
      return { key: 'loginErrorInvalidFactor' }
    case 'invalid_challenge':
    case 'challenge_expired':
    case 'conflict':
      return { key: 'loginErrorChallenge' }
    case 'rate_limited':
    case 'busy':
      return { key: 'errorRateLimited', params: { seconds: error.retryAfter ?? 1 } }
    case 'uninitialized':
      return { key: 'loginErrorUninitialized' }
    case 'unauthorized':
      return { key: 'errorUnauthorized' }
    default:
      return { key: error.status === 503 ? 'errorServiceUnavailable' : 'errorGeneric' }
  }
}

function paintMessage(): void {
  const target = document.getElementById('message')
  if (!target) return
  target.textContent = currentMessage ? t(currentMessage.key, currentMessage.params) : ''
  target.className = currentMessage?.tone === 'info' ? 'message info' : 'message error'
}

function showMessage(message: Message): void {
  currentMessage = message
  paintMessage()
}

async function perform(action: () => Promise<void>): Promise<void> {
  if (busy) return
  busy = true
  const buttons = [...root!.querySelectorAll<HTMLButtonElement>('button')]
  for (const button of buttons) button.disabled = true
  try {
    await action()
  } catch (error) {
    showMessage(errorMessage(error))
  } finally {
    busy = false
    for (const button of buttons) button.disabled = false
  }
}

function shell(nextTitleKey: MessageKey, content: string): void {
  titleKey = nextTitleKey
  currentMessage = null
  root!.innerHTML = `<div class="login-page"><section class="login-card"><div class="login-header"><div class="brand" data-i18n="brand"></div><div class="language-control"><label for="language" data-i18n="loginLanguageLabel"></label><select id="language"><option value="en">English</option><option value="zh">中文</option></select></div></div><h1 data-i18n="${nextTitleKey}"></h1>${content}<p id="message" class="message" role="alert" aria-live="assertive"></p></section></div>`
  element<HTMLSelectElement>('language').addEventListener('change', (event) => {
    setLocale((event.currentTarget as HTMLSelectElement).value)
  })
  localize()
}

function copyText(value: string): Promise<boolean> {
  return (async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value)
        return true
      }
    } catch {
      // HTTP test origins may not expose Clipboard; use the selected-text fallback.
    }
    const field = document.createElement('textarea')
    field.value = value
    field.setAttribute('readonly', '')
    field.style.position = 'fixed'
    field.style.opacity = '0'
    document.body.append(field)
    field.select()
    const copied = document.execCommand('copy')
    field.remove()
    return copied
  })()
}

function renderSetup(): void {
  const profile = state?.profileName ?? 'web'
  const command = `dsh plugin --profile ${profile} exec dsh-auth-remote init`
  shell(
    'loginSetupTitle',
    '<p data-i18n="loginSetupDescription"></p><div class="command"><code id="setup-command"></code><button id="copy-command" type="button" class="secondary" data-i18n="loginSetupCopy"></button></div><button id="recheck" type="button" data-i18n="loginSetupRecheck"></button>',
  )
  element<HTMLElement>('setup-command').textContent = command
  element<HTMLButtonElement>('copy-command').addEventListener('click', () => {
    void perform(async () => {
      const copied = await copyText(command)
      showMessage({ key: copied ? 'loginSetupCopied' : 'loginSetupCopyFallback', tone: 'info' })
    })
  })
  element<HTMLButtonElement>('recheck').addEventListener('click', () => {
    void perform(async () => {
      state = await api<PublicStateResponse>('/auth-remote/state')
      if (state.initialized) renderLogin()
      else showMessage({ key: 'loginSetupNotFound' })
    })
  })
}

function renderLogin(message?: Message): void {
  shell(
    'loginTitle',
    '<p data-i18n="loginDescription"></p><form id="login-form"><label for="username" data-i18n="loginUsername"></label><input id="username" name="username" autocomplete="username" required><label for="password" data-i18n="loginPassword"></label><input id="password" name="password" type="password" autocomplete="current-password" required><button type="submit" data-i18n="loginContinue"></button></form>',
  )
  element<HTMLInputElement>('username').value = lastUsername
  if (message) showMessage(message)
  element<HTMLFormElement>('login-form').addEventListener('submit', (event) => {
    event.preventDefault()
    void perform(async () => {
      const username = element<HTMLInputElement>('username').value
      const password = element<HTMLInputElement>('password').value
      lastUsername = username
      const result = await api<LoginResponse>('/auth-remote/login', { username, password })
      element<HTMLInputElement>('password').value = ''
      if (result.kind === 'session') {
        if (state?.requireTotp === false) renderOptional()
        else enterDsh()
      } else if (result.kind === 'mfa') renderMfa(result.challenge)
      else {
        const binding = await api<{ secret: string; expiresAt: number }>(
          '/auth-remote/totp/start',
          {
            challenge: result.challenge,
          },
        )
        await renderBinding(result.challenge, binding.secret)
      }
    })
  })
}

function renderMfa(challenge: string): void {
  let failures = 0
  shell(
    'loginMfaTitle',
    '<p data-i18n="loginMfaDescription"></p><form id="mfa-form"><label for="mfa-code" data-i18n="loginMfaCode"></label><input id="mfa-code" name="code" autocomplete="one-time-code" required><button type="submit" data-i18n="loginMfaSubmit"></button></form><button id="restart" type="button" class="link-button" data-i18n="loginBackToPassword"></button>',
  )
  element<HTMLButtonElement>('restart').addEventListener('click', () => renderLogin())
  element<HTMLFormElement>('mfa-form').addEventListener('submit', (event) => {
    event.preventDefault()
    void perform(async () => {
      try {
        await api('/auth-remote/mfa/verify', {
          challenge,
          code: element<HTMLInputElement>('mfa-code').value.trim(),
        })
        enterDsh()
      } catch (error) {
        if (error instanceof RequestFailure && error.code === 'invalid_factor') {
          failures++
          if (failures >= 5) {
            renderLogin({ key: 'loginMfaExhausted' })
            return
          }
        }
        if (
          error instanceof RequestFailure &&
          ['invalid_challenge', 'challenge_expired', 'conflict'].includes(error.code)
        ) {
          renderLogin(errorMessage(error))
          return
        }
        throw error
      }
    })
  })
}

async function renderBinding(challenge: string, secret: string): Promise<void> {
  let failures = 0
  shell(
    'loginBindingTitle',
    '<p data-i18n="loginBindingDescription"></p><canvas id="totp-qr" width="220" height="220" data-i18n-aria-label="loginBindingQrAlt" role="img"></canvas><div class="secret"><span data-i18n="loginBindingManualSecret"></span><code id="totp-secret"></code></div><form id="bind-form"><label for="bind-code" data-i18n="loginBindingCode"></label><input id="bind-code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required><button type="submit" data-i18n="loginBindingConfirm"></button></form><button id="restart" type="button" class="link-button" data-i18n="loginBindingRestart"></button>',
  )
  element<HTMLElement>('totp-secret').textContent = secret
  const issuer = 'DSH Auth Remote'
  const label = `${issuer}:${lastUsername}`
  const uri = `otpauth://totp/${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`
  try {
    await QRCode.toCanvas(element<HTMLCanvasElement>('totp-qr'), uri, {
      width: 220,
      margin: 2,
      errorCorrectionLevel: 'M',
    })
  } catch {
    showMessage({ key: 'loginBindingQrUnavailable' })
  }
  element<HTMLButtonElement>('restart').addEventListener('click', () => renderLogin())
  element<HTMLFormElement>('bind-form').addEventListener('submit', (event) => {
    event.preventDefault()
    void perform(async () => {
      try {
        const result = await api<BindingResponse>('/auth-remote/totp/confirm', {
          challenge,
          code: element<HTMLInputElement>('bind-code').value.trim(),
        })
        renderBackupCodes(result.backupCodes)
      } catch (error) {
        if (error instanceof RequestFailure && error.code === 'invalid_factor') {
          failures++
          if (failures >= 5) {
            renderLogin({ key: 'loginBindingExhausted' })
            return
          }
        }
        if (
          error instanceof RequestFailure &&
          ['invalid_challenge', 'challenge_expired', 'conflict'].includes(error.code)
        ) {
          renderLogin(errorMessage(error))
          return
        }
        throw error
      }
    })
  })
}

function renderBackupCodes(codes: string[]): void {
  shell(
    'loginBackupTitle',
    '<p data-i18n="loginBackupDescription"></p><ol id="backup-codes" class="backup-codes"></ol><button id="relogin" type="button" data-i18n="loginBackupSaved"></button>',
  )
  const list = element<HTMLOListElement>('backup-codes')
  for (const code of codes) {
    const item = document.createElement('li')
    item.textContent = code
    list.append(item)
  }
  element<HTMLButtonElement>('relogin').addEventListener('click', () => renderLogin())
}

function renderOptional(): void {
  shell(
    'loginOptionalTitle',
    '<p data-i18n="loginOptionalDescription"></p><div class="actions"><button id="bind-now" type="button" data-i18n="loginOptionalBindNow"></button><button id="skip-binding" type="button" class="secondary" data-i18n="loginOptionalSkip"></button></div>',
  )
  element<HTMLButtonElement>('skip-binding').addEventListener('click', enterDsh)
  element<HTMLButtonElement>('bind-now').addEventListener('click', () => {
    shell(
      'loginOptionalVerifyTitle',
      '<p data-i18n="loginOptionalVerifyDescription"></p><form id="optional-bind-form"><label for="bind-password" data-i18n="loginOptionalCurrentPassword"></label><input id="bind-password" type="password" autocomplete="current-password" required><button type="submit" data-i18n="loginOptionalStart"></button></form><button id="skip-binding" type="button" class="link-button" data-i18n="loginOptionalSkipLater"></button>',
    )
    element<HTMLButtonElement>('skip-binding').addEventListener('click', enterDsh)
    element<HTMLFormElement>('optional-bind-form').addEventListener('submit', (event) => {
      event.preventDefault()
      void perform(async () => {
        const password = element<HTMLInputElement>('bind-password').value
        const result = await api<{ challenge: string; secret: string }>('/auth-remote/totp/start', {
          password,
        })
        element<HTMLInputElement>('bind-password').value = ''
        await renderBinding(result.challenge, result.secret)
      })
    })
  })
}

async function start(): Promise<void> {
  try {
    state = await api<PublicStateResponse>('/auth-remote/state')
    if (!state.initialized) {
      renderSetup()
      return
    }
    const existing = await fetch('/auth-remote/me', {
      credentials: 'same-origin',
      cache: 'no-store',
    })
    if (existing.ok) {
      enterDsh()
      return
    }
    const reason = new URLSearchParams(location.search).get('reason')
    renderLogin(
      reason === 'expired'
        ? { key: 'loginReasonExpired' }
        : reason === 'updated'
          ? { key: 'loginReasonUpdated' }
          : reason === 'signed-out'
            ? { key: 'loginReasonSignedOut' }
            : undefined,
    )
  } catch (error) {
    shell(
      'loginUnavailableTitle',
      '<p data-i18n="loginUnavailableDescription"></p><button id="retry" type="button" data-i18n="loginRetry"></button>',
    )
    showMessage(errorMessage(error))
    element<HTMLButtonElement>('retry').addEventListener('click', () => void start())
  }
}

void start()
