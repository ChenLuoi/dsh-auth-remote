import { en } from './locales/en.js'
import { zh } from './locales/zh.js'

export { en, zh }
export const dictionaries = { en, zh } as const

export type Locale = keyof typeof dictionaries
export type MessageKey = keyof typeof en

type Placeholders<Text extends string> = Text extends `${string}{${infer Name}}${infer Rest}`
  ? Name | Placeholders<Rest>
  : never
type SameSet<Left, Right> = [Left] extends [Right] ? ([Right] extends [Left] ? true : false) : false
type MismatchedPlaceholderKeys = {
  [Key in MessageKey]: SameSet<
    Placeholders<(typeof en)[Key]>,
    Placeholders<(typeof zh)[Key]>
  > extends true
    ? never
    : Key
}[MessageKey]

/** A compile-time failure here identifies any key whose placeholder names differ by language. */
export const localePlaceholdersMatch: MismatchedPlaceholderKeys extends never ? true : never = true

type FormatArgs<Key extends MessageKey> = [Placeholders<(typeof en)[Key]>] extends [never]
  ? []
  : [values: Record<Placeholders<(typeof en)[Key]>, string | number>]

/** Only exact en/zh values are valid for the login page's stored preference. */
export function parseExactLocale(value: unknown): Locale | null {
  return value === 'en' || value === 'zh' ? value : null
}

/** CLI and language-tag inputs use Chinese for zh variants and English otherwise. */
export function localeFromLanguageTag(value: string | undefined): Locale {
  return value && /^zh(?:[-_.@]|$)/iu.test(value.trim()) ? 'zh' : 'en'
}

export function normalizeLocale(value: unknown): Locale {
  return parseExactLocale(value) ?? 'en'
}

/** Returns plain text. Insert into textContent, React text, or escape before HTML templates. */
export function formatMessage<Key extends MessageKey>(
  locale: Locale | string | undefined,
  key: Key,
  ...args: FormatArgs<Key>
): string {
  const template: string = dictionaries[normalizeLocale(locale)][key]
  const values = (args[0] ?? {}) as Record<string, string | number>
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/gu, (_match, name: string) => {
    if (!Object.hasOwn(values, name)) throw new Error(`Missing i18n parameter ${name} for ${key}`)
    return String(values[name])
  })
}

/** For the existing standalone login HTML templates; dynamic values remain text. */
export function escapeHtmlText(value: string): string {
  return value.replace(/[&<>"']/gu, (char) => {
    switch (char) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
}
