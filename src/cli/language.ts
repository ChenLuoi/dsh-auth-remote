import {
  formatMessage,
  localeFromLanguageTag,
  type Locale,
  type MessageKey,
} from '../shared/i18n.js'

export class CliDiagnostic extends Error {
  constructor(
    readonly key: MessageKey,
    englishMessage: string,
    readonly locale?: Locale,
  ) {
    super(englishMessage)
  }
}

export function environmentLocale(env: NodeJS.ProcessEnv): Locale {
  const value = [env.LC_ALL, env.LC_MESSAGES, env.LANG].find(
    (candidate) => candidate !== undefined && candidate.trim().length > 0,
  )
  return localeFromLanguageTag(value)
}

/** Strip one language option from either side of the command before command validation. */
export function parseLanguage(
  input: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): { locale: Locale; args: string[] } {
  let locale = environmentLocale(env)
  let explicit = false
  const args: string[] = []
  for (let index = 0; index < input.length; index++) {
    const token = input[index]!
    if (token !== '--lang' && !token.startsWith('--lang=')) {
      args.push(token)
      continue
    }
    if (explicit)
      throw new CliDiagnostic(
        'cliErrorDuplicateLanguage',
        'dsh-auth-remote: --lang may be specified only once',
        locale,
      )
    explicit = true
    const value = token === '--lang' ? input[++index] : token.slice('--lang='.length)
    if (value === undefined || value.length === 0 || value.startsWith('--'))
      throw new CliDiagnostic(
        'cliErrorMissingLanguage',
        'dsh-auth-remote: --lang requires en or zh',
        locale,
      )
    if (value !== 'en' && value !== 'zh')
      throw new CliDiagnostic(
        'cliErrorInvalidLanguage',
        'dsh-auth-remote: invalid --lang value; use en or zh',
        locale,
      )
    locale = value
  }
  return { locale, args }
}

export function cliText(
  locale: Locale,
  key: MessageKey,
  params: Record<string, string | number> = {},
): string {
  return formatMessage(locale, key, params)
}
