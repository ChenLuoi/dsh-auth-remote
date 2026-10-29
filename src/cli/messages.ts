/** Fixed English text for the administration CLI. */
const messages = {
  errorRateLimited: 'Too many attempts. Try again in about {seconds} seconds.',
  cliHelp: `dsh-auth-remote {version}

Usage:
  dsh plugin --profile web exec dsh-auth-remote COMMAND

Commands:
  init              Create the single account interactively
  status [--json]   Show non-sensitive authentication status
  reset-password    Reset the password and revoke all sessions
  reset-totp        Clear TOTP, backup codes and all sessions
  revoke-sessions   Sign out every device

Options:
  --help, -h        Show this help
  --version, -v     Show the package version

The command uses the profile selected by dsh plugin exec and the caller's DSH_HOME.
`,
  cliPromptUsername: 'Username: ',
  cliPromptPassword: 'Password: ',
  cliPromptPasswordAgain: 'Enter password again: ',
  cliPromptNewPassword: 'New password: ',
  cliPromptNewPasswordAgain: 'Enter new password again: ',
  cliPromptConfirmTarget: 'Enter {profile} to confirm {command}: ',
  cliTargetProfile: 'Target profile: {profile}',
  cliDataFile: 'State file: {path}',
  cliStatusProfile: 'Profile: {profile}',
  cliStatusAccount: 'Account: {state}',
  cliStatusTotp: 'TOTP: {state}',
  cliStatusSessions: 'Active sessions: {count}',
  cliStatusService: 'Service: {state}',
  cliInitialized: 'Initialized',
  cliNotInitialized: 'Not initialized',
  cliTotpEnabled: 'Enabled',
  cliTotpDisabled: 'Disabled',
  cliOnlineReady: 'Online and ready',
  cliOnlineNotReady: 'Online but not ready',
  cliOffline: 'Offline',
  cliCompleted: '{command} completed; the change is durable and effective.',
  cliErrorInvalidArguments: 'Invalid command or arguments. Use --help.',
  cliErrorPasswordsMismatch: 'The passwords do not match.',
  cliErrorConfirmationMismatch: 'The confirmation did not match the target profile.',
  cliErrorPasswordLength: 'Password must contain 12–256 Unicode characters.',
  cliErrorTerminalRequired: 'An interactive terminal is required.',
  cliErrorTerminalClosed: 'Terminal input closed.',
  cliErrorCancelled: 'Cancelled.',
  cliErrorProfileDirectory: 'The current directory is not the selected DSH profile under DSH_HOME.',
  cliErrorProfileManifest: 'The profile package.json is missing.',
  cliErrorUnsafeManagementDirectory: 'The management directory has unsafe permissions.',
  cliErrorUnsafeManagementSocket: 'The management socket has unsafe permissions.',
  cliErrorManagementUnavailable: 'The management socket is unavailable.',
  cliErrorOutcomeUnknown:
    'The management request disconnected or timed out. Its result is unknown; check status before trying again.',
  cliErrorOfflineLock:
    'The management socket is unavailable while the service holds the profile lock. Offline access was refused.',
  cliErrorInvalidCredentials: 'The current credentials are incorrect.',
  cliErrorAlreadyInitialized: 'The account is already initialized.',
  cliErrorInvalidInput: 'The input is invalid.',
  cliErrorInvalidFactor: 'The verification or backup code is incorrect.',
  cliErrorUninitialized: 'The account is not initialized.',
  cliErrorTotpRequired: 'This profile requires TOTP.',
  cliErrorConflict: 'The account state changed. Check status and retry.',
  cliErrorBusy: 'The service is busy. Try again later.',
  cliErrorUnknown: 'The operation failed. Check status before trying again.',
} as const

export type CliMessageKey = keyof typeof messages

export function cliText(key: CliMessageKey, params: Record<string, string | number> = {}): string {
  return messages[key].replace(/\{([A-Za-z][A-Za-z0-9]*)\}/gu, (_match, name: string) => {
    if (!Object.hasOwn(params, name)) throw new Error(`Missing CLI parameter ${name} for ${key}`)
    return String(params[name])
  })
}

export class CliDiagnostic extends Error {
  constructor(key: CliMessageKey) {
    super(cliText(key))
  }
}
