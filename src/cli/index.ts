#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { AuthError, AuthService } from '../auth/service.js'
import { PasswordValidationError, validatePassword } from '../auth/password.js'
import {
  ADMIN_PROTOCOL_VERSION,
  type AdminRequest,
  type AdminStatus,
} from '../shared/admin-contract.js'
import { AuthStateStore } from '../storage/store.js'
import { AdminOutcomeUnknown, AdminRejected, AdminUnavailable, requestAdmin } from './ipc-client.js'
import { CliDiagnostic, cliText, environmentLocale, parseLanguage } from './language.js'
import { resolveProfileTarget, type ProfileTarget } from './profile.js'
import { TerminalPrompt } from './prompt.js'
import type { Locale, MessageKey } from '../shared/i18n.js'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string
}

type Command = AdminRequest['command']
let currentLocale = environmentLocale(process.env)
const output = (key: MessageKey, params: Record<string, string | number> = {}): string =>
  cliText(currentLocale, key, params)

function authErrorKey(code: string): MessageKey {
  switch (code) {
    case 'already_initialized':
      return 'cliErrorAlreadyInitialized'
    case 'invalid_input':
      return 'cliErrorInvalidInput'
    case 'invalid_credentials':
      return 'cliErrorInvalidCredentials'
    case 'invalid_factor':
      return 'cliErrorInvalidFactor'
    case 'uninitialized':
      return 'cliErrorUninitialized'
    case 'totp_required':
      return 'cliErrorTotpRequired'
    case 'conflict':
      return 'cliErrorConflict'
    case 'busy':
      return 'cliErrorBusy'
    default:
      return 'cliErrorUnknown'
  }
}

function errorText(error: unknown, locale: Locale): string {
  if (error instanceof CliDiagnostic) return cliText(error.locale ?? locale, error.key)
  if (error instanceof PasswordValidationError) return cliText(locale, 'cliErrorPasswordLength')
  if (error instanceof AdminOutcomeUnknown) return cliText(locale, 'cliErrorOutcomeUnknown')
  if (error instanceof AdminUnavailable) return cliText(locale, 'cliErrorManagementUnavailable')
  if (error instanceof AdminRejected || error instanceof AuthError) {
    if (error.code === 'rate_limited')
      return cliText(locale, 'errorRateLimited', {
        seconds: error instanceof AuthError ? (error.retryAfter ?? 1) : 1,
      })
    return cliText(locale, authErrorKey(error.code))
  }
  return cliText(locale, 'cliErrorUnknown')
}

async function offline(
  target: ProfileTarget,
  request: AdminRequest,
): Promise<AdminStatus | { ok: true }> {
  let store: AuthStateStore
  try {
    store = await AuthStateStore.open(target.dir)
  } catch (error) {
    if (error instanceof Error && /state lock held|state lock is held/u.test(error.message))
      throw new CliDiagnostic(
        'cliErrorOfflineLock',
        'dsh-auth-remote: management socket is unavailable while the service holds the profile lock; refusing offline access',
      )
    throw error
  }
  const auth = new AuthService(store, { requireTotp: false, sessionHours: 168 })
  try {
    switch (request.command) {
      case 'status':
        return { ...auth.status(), online: false, ready: false }
      case 'init':
        await auth.initialize(request.username, request.password)
        return { ok: true }
      case 'reset-password':
        await auth.resetPassword(request.password)
        return { ok: true }
      case 'reset-totp':
        await auth.resetTotp()
        return { ok: true }
      case 'revoke-sessions':
        await auth.revokeAll()
        return { ok: true }
    }
  } finally {
    auth.dispose()
    await store.close()
  }
}

async function execute(
  target: ProfileTarget,
  request: AdminRequest,
): Promise<AdminStatus | { ok: true }> {
  try {
    return await requestAdmin(target.socketPath, request)
  } catch (error) {
    if (!(error instanceof AdminUnavailable)) throw error
    return offline(target, request)
  }
}

async function interactiveRequest(
  target: ProfileTarget,
  command: Exclude<Command, 'status'>,
): Promise<AdminRequest> {
  const prompt = new TerminalPrompt()
  try {
    if (command === 'init') {
      const username = await prompt.ask(output('cliPromptUsername'), false, 64)
      const password = await prompt.ask(output('cliPromptPassword'), true, 256)
      const again = await prompt.ask(output('cliPromptPasswordAgain'), true, 256)
      if (password !== again)
        throw new CliDiagnostic(
          'cliErrorPasswordsMismatch',
          'dsh-auth-remote: passwords do not match',
        )
      validatePassword(password)
      return { version: ADMIN_PROTOCOL_VERSION, command, username, password }
    }
    const confirmation = await prompt.ask(
      output('cliPromptConfirmTarget', { profile: target.name, command }),
      false,
      64,
    )
    if (confirmation !== target.name)
      throw new CliDiagnostic(
        'cliErrorConfirmationMismatch',
        'dsh-auth-remote: confirmation did not match the target profile',
      )
    if (command === 'reset-password') {
      const password = await prompt.ask(output('cliPromptNewPassword'), true, 256)
      const again = await prompt.ask(output('cliPromptNewPasswordAgain'), true, 256)
      if (password !== again)
        throw new CliDiagnostic(
          'cliErrorPasswordsMismatch',
          'dsh-auth-remote: passwords do not match',
        )
      validatePassword(password)
      return { version: ADMIN_PROTOCOL_VERSION, command, password }
    }
    return { version: ADMIN_PROTOCOL_VERSION, command }
  } finally {
    prompt.close()
  }
}

async function main(): Promise<void> {
  const parsed = parseLanguage(process.argv.slice(2))
  currentLocale = parsed.locale
  const args = parsed.args
  if (args.length === 0 || (args.length === 1 && ['--help', '-h'].includes(args[0]!))) {
    process.stdout.write(output('cliHelp', { version: manifest.version }))
    return
  }
  if (args.length === 1 && ['--version', '-v'].includes(args[0]!)) {
    process.stdout.write(`${manifest.version}\n`)
    return
  }
  const command = args[0]
  if (
    !['init', 'status', 'reset-password', 'reset-totp', 'revoke-sessions'].includes(
      command ?? '',
    ) ||
    (command === 'status'
      ? args.length > 2 || (args.length === 2 && args[1] !== '--json')
      : args.length !== 1)
  )
    throw new CliDiagnostic(
      'cliErrorInvalidArguments',
      'dsh-auth-remote: invalid command or arguments; use --help',
    )
  const target = await resolveProfileTarget()
  if (command !== 'status')
    process.stdout.write(
      `${output('cliTargetProfile', { profile: target.name })}\n${output('cliDataFile', { path: target.statePath })}\n`,
    )
  const request: AdminRequest =
    command === 'status'
      ? { version: ADMIN_PROTOCOL_VERSION, command: 'status' }
      : await interactiveRequest(target, command as Exclude<Command, 'status'>)
  const result = await execute(target, request)
  if (command === 'status') {
    const status = result as AdminStatus
    if (args[1] === '--json')
      process.stdout.write(
        `${JSON.stringify({ profile: target.name, statePath: target.statePath, ...status })}\n`,
      )
    else
      process.stdout.write(
        [
          output('cliStatusProfile', { profile: target.name }),
          output('cliDataFile', { path: target.statePath }),
          output('cliStatusAccount', {
            state: output(status.initialized ? 'cliInitialized' : 'cliNotInitialized'),
          }),
          output('cliStatusTotp', {
            state: output(status.totpEnabled ? 'cliTotpEnabled' : 'cliTotpDisabled'),
          }),
          output('cliStatusSessions', { count: status.activeSessions }),
          output('cliStatusService', {
            state: output(
              status.online
                ? status.ready
                  ? 'cliOnlineReady'
                  : 'cliOnlineNotReady'
                : 'cliOffline',
            ),
          }),
        ].join('\n') + '\n',
      )
    return
  }
  process.stdout.write(`${output('cliCompleted', { command: command! })}\n`)
}

void main().catch((error: unknown) => {
  process.stderr.write(`${errorText(error, currentLocale)}\n`)
  process.exitCode = 1
})
