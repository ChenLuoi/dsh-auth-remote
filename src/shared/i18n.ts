import { en } from './locales/en.js'
import { zh } from './locales/zh.js'
import { ja } from './locales/ja.js'
import { es } from './locales/es.js'
import { fr } from './locales/fr.js'
import { de } from './locales/de.js'
import { ru } from './locales/ru.js'
import { pt } from './locales/pt.js'

export { en, zh, ja, es, fr, de, ru, pt }
export const dictionaries = { en, zh, ja, es, fr, de, ru, pt } as const

export type Locale = keyof typeof dictionaries
export type MessageKey = keyof typeof en

type Placeholders<Text extends string> = Text extends `${string}{${infer Name}}${infer Rest}`
  ? Name | Placeholders<Rest>
  : never
type SameSet<Left, Right> = [Left] extends [Right] ? ([Right] extends [Left] ? true : false) : false
type MismatchedPlaceholderKeys = {
  [Language in Locale]: {
    [Key in MessageKey]: SameSet<
      Placeholders<(typeof en)[Key]>,
      Placeholders<(typeof dictionaries)[Language][Key]>
    > extends true
      ? never
      : Key
  }[MessageKey]
}[Locale]

/** A compile-time failure here identifies any key whose placeholder names differ by language. */
export const localePlaceholdersMatch: MismatchedPlaceholderKeys extends never ? true : never = true

type FormatArgs<Key extends MessageKey> = [Placeholders<(typeof en)[Key]>] extends [never]
  ? []
  : [values: Record<Placeholders<(typeof en)[Key]>, string | number>]

export const localeMemoryKey = 'dsh-auth-remote-lang'

/** Match a valid language tag without treating arbitrary prefixes as language IDs. */
export function matchLocale(value: unknown): Locale | null {
  if (typeof value !== 'string') return null
  try {
    if (Intl.getCanonicalLocales(value).length === 0) return null
    const tag = value.toLowerCase()
    const key = Object.hasOwn(dictionaries, tag) ? tag : tag.split('-')[0]!
    return Object.hasOwn(dictionaries, key) ? (key as Locale) : null
  } catch {
    return null
  }
}

export function normalizeLocale(value: unknown): Locale {
  return matchLocale(value) ?? 'en'
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
