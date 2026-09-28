/** Human-facing text only. Protocol identifiers and command names stay unchanged. */
export const en = {
  brand: 'DSH · Remote sign-in',
  errorNetwork: 'Connection failed. Check your network and try again.',
  errorRateLimited: 'Too many attempts. Try again in about {seconds} seconds.',
  errorUnauthorized: 'Your session has expired. Sign in again.',
  errorServiceUnavailable: 'The service is temporarily unavailable. Try again later.',
  errorGeneric: 'The operation could not be completed. Try again.',

  loginInitialTitle: 'Sign in to DSH',
  loginInitialLoading: 'Checking sign-in status…',
  loginLanguageLabel: 'Language',
  loginSetupTitle: 'Set up your account first',
  loginSetupDescription:
    'Run this command in a terminal on the server running DSH, then create a username and password when prompted. The web page cannot create the account.',
  loginSetupCopy: 'Copy command',
  loginSetupRecheck: 'I finished setup',
  loginSetupCopied: 'Command copied.',
  loginSetupCopyFallback: 'Select and copy the command manually.',
  loginSetupNotFound:
    'No account was found. Check that the command used this profile, then try again.',
  loginTitle: 'Sign in to DSH',
  loginDescription: 'Enter the single-user account created in the server terminal.',
  loginUsername: 'Username',
  loginPassword: 'Password',
  loginContinue: 'Continue',
  loginMfaTitle: 'Verify your second factor',
  loginMfaDescription:
    'Enter the six-digit code from your authenticator or a one-time backup code. This challenge expires in five minutes.',
  loginMfaCode: 'Verification or backup code',
  loginMfaSubmit: 'Verify and sign in',
  loginBackToPassword: 'Back to password sign-in',
  loginMfaExhausted: 'This challenge is exhausted. Enter your password again.',
  loginBindingTitle: 'Connect an authenticator',
  loginBindingDescription:
    'Scan the QR code with your authenticator, or enter the secret below. After confirmation, ten one-time backup codes will appear and you will need to sign in again.',
  loginBindingQrAlt: 'Authenticator setup QR code',
  loginBindingManualSecret: 'Manual secret',
  loginBindingCode: 'Six-digit code from the authenticator',
  loginBindingConfirm: 'Confirm setup',
  loginBindingRestart: 'Sign in again',
  loginBindingQrUnavailable: 'The QR code is unavailable. Use the manual secret above.',
  loginBindingExhausted: 'This setup challenge is exhausted. Enter your password again.',
  loginBackupTitle: 'Save your backup codes',
  loginBackupDescription:
    'These codes are shown only once. Store them safely; each code can be used only once. Sign in again after saving them.',
  loginBackupSaved: 'I saved them; sign in again',
  loginOptionalTitle: 'Protect your account',
  loginOptionalDescription:
    'This profile lets you connect an authenticator later. Connecting one now adds protection; you can also do it in Security settings.',
  loginOptionalBindNow: 'Connect TOTP now',
  loginOptionalSkip: 'Skip and enter DSH',
  loginOptionalVerifyTitle: 'Verify again before setup',
  loginOptionalVerifyDescription: 'Enter your current password to protect your account.',
  loginOptionalCurrentPassword: 'Current password',
  loginOptionalStart: 'Start setup',
  loginOptionalSkipLater: 'Connect later and enter DSH',
  loginReasonExpired: 'Your session has expired. Sign in again.',
  loginReasonUpdated: 'Security settings changed. Sign in again.',
  loginReasonSignedOut: 'You signed out of this device.',
  loginUnavailableTitle: 'Sign-in is temporarily unavailable',
  loginUnavailableDescription: 'The service status is unavailable. Check the connection and retry.',
  loginRetry: 'Check again',
  loginErrorInvalidCredentials: 'The username or password is incorrect. Try again.',
  loginErrorInvalidFactor:
    'The verification or backup code is incorrect. After five failed attempts, you must enter your password again.',
  loginErrorChallenge: 'This verification expired. Enter your username and password again.',
  loginErrorUninitialized:
    'The account is not set up. Run the setup command in the server terminal.',

  settingsSectionLabel: 'Security',
  settingsSectionAria: 'Security settings',
  settingsTitle: 'Account security',
  settingsAccountSummary: 'Account: {username} · TOTP: {totp}',
  settingsTotpEnabled: 'Enabled',
  settingsTotpNotBound: 'Not connected',
  settingsLoading: 'Loading account status…',
  settingsChangePassword: 'Change password',
  settingsBindTotp: 'Connect TOTP',
  settingsRebindTotp: 'Reconnect TOTP',
  settingsSessions: 'Session management',
  settingsPasswordMismatch: 'The new passwords do not match.',
  settingsPasswordDescription: 'After this change, every device must sign in again.',
  settingsCurrentPassword: 'Current password',
  settingsCurrentCode: 'Current verification or backup code',
  settingsNewPassword: 'New password',
  settingsConfirmPassword: 'Confirm new password',
  settingsSavePassword: 'Save new password',
  settingsBindDescription:
    'Enter your current credentials. After connecting the new authenticator, every device must sign in again.',
  settingsStartBinding: 'Start setup',
  settingsDisableTotp: 'Turn off TOTP',
  settingsDisableDescription: 'After turning off TOTP, every device must sign in again.',
  settingsScanQr: 'Scan the QR code',
  settingsQrAlt: 'Authenticator setup QR code',
  settingsQrUnavailable: 'The QR code is unavailable. Use the manual secret below.',
  settingsQrLoading: 'Generating the QR code; you can use the manual secret below.',
  settingsManualSecret: 'Manual secret:',
  settingsNewCode: 'Six-digit code from the new authenticator',
  settingsConfirmBinding: 'Confirm setup',
  settingsRestartBinding: 'Start over',
  settingsSignOutCurrent: 'Sign out this device',
  settingsSignOutAll: 'Sign out every device',
  settingsSignOutAllDescription:
    'Enter your current credentials. All signed-in devices and open connections will be revoked.',
  settingsBackupTitle: 'Save your backup codes',
  settingsBackupDescription:
    'These codes are shown only once. Store them safely; each code can be used only once.',
  settingsBackupSaved: 'I saved them; sign in again',
  settingsErrorInvalidCredentials: 'The current password is incorrect.',
  settingsErrorInvalidFactor: 'The current verification or backup code is incorrect.',
  settingsErrorInvalidInput: 'The input is invalid. Passwords must meet the server length rules.',
  settingsErrorChallenge: 'The setup challenge expired. Start setup again.',
  settingsErrorTotpRequired: 'This profile requires TOTP, so it cannot be turned off.',

  cliHelp: `dsh-auth-remote {version}

Usage:
  dsh plugin --profile web exec dsh-auth-remote [--lang en|zh] COMMAND

Commands:
  init              Create the single account interactively
  status [--json]   Show non-sensitive authentication status
  reset-password    Reset the password and revoke all sessions
  reset-totp        Clear TOTP, backup codes and all sessions
  revoke-sessions   Sign out every device

Options:
  --lang en|zh      Choose the language for human-readable output
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
  cliErrorInvalidLanguage: 'Invalid --lang value. Use en or zh.',
  cliErrorDuplicateLanguage: 'Specify --lang only once.',
  cliErrorMissingLanguage: 'Missing value for --lang. Use en or zh.',
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
