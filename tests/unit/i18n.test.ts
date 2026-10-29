import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  dictionaries,
  en,
  escapeHtmlText,
  formatMessage,
  matchLocale,
  localePlaceholdersMatch,
  normalizeLocale,
  zh,
} from '../../src/shared/i18n.js'

test('all eight browser languages have identical keys and interpolation parameters', () => {
  assert.equal(localePlaceholdersMatch, true)
  assert.deepEqual(Object.keys(dictionaries), ['en', 'zh', 'ja', 'es', 'fr', 'de', 'ru', 'pt'])
  assert.equal(dictionaries.en, en)
  assert.equal(dictionaries.zh, zh)
  for (const [locale, dictionary] of Object.entries(dictionaries)) {
    assert.deepEqual(Object.keys(dictionary).sort(), Object.keys(en).sort(), locale)
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      const parameters = (message: string) =>
        [...message.matchAll(/\{([^{}]+)\}/gu)].map((match) => match[1]).sort()
      assert.deepEqual(parameters(en[key]), parameters(dictionary[key]), `${locale}.${key}`)
      assert.doesNotMatch(key, /^cli[A-Z]/u)
      assert.ok(dictionary[key].trim(), `${locale}.${key}`)
      assert.doesNotMatch(dictionary[key], /<\/?[A-Za-z][^>]*>/u, `${locale}.${key}`)
    }
  }
})

test('valid language tags match case and regions while invalid or unsupported values do not', () => {
  for (const locale of Object.keys(dictionaries)) {
    assert.equal(matchLocale(locale), locale)
    assert.equal(matchLocale(locale.toUpperCase()), locale)
  }
  for (const [tag, expected] of [
    ['ZH-cn', 'zh'],
    ['zh-Hans-CN', 'zh'],
    ['ja-JP', 'ja'],
    ['pt-BR', 'pt'],
    ['pt-PT', 'pt'],
    ['eN-gB', 'en'],
    ['es-419', 'es'],
    ['fr-CA', 'fr'],
    ['de-DE-u-co-phonebk', 'de'],
    ['ru-RU', 'ru'],
  ])
    assert.equal(matchLocale(tag), expected, tag)
  for (const value of [
    undefined,
    null,
    1,
    {},
    '',
    ' en ',
    'zh_CN.UTF-8',
    'en--US',
    'pt_',
    'C.UTF-8',
    'POSIX',
    'zho',
    'ko-KR',
    'constructor',
    '__proto__',
  ]) {
    assert.equal(matchLocale(value), null, String(value))
  }
  assert.equal(normalizeLocale('zh-CN'), 'zh')
  assert.equal(normalizeLocale(undefined), 'en')
})

test('formatting inserts text parameters without interpreting markup', () => {
  assert.equal(formatMessage('zh', 'loginTitle'), '登录')
  assert.equal(formatMessage('ko', 'loginTitle'), 'Sign in')
  assert.equal(
    formatMessage('en', 'errorRateLimited', { seconds: 12 }),
    'Too many attempts. Try again in about 12 seconds.',
  )
  const account = formatMessage('en', 'settingsAccountSummary', {
    username: '<img src=x onerror=alert(1)>',
    totp: 'Enabled',
  })
  assert.match(account, /<img src=x onerror=alert\(1\)>/u)
  assert.equal(
    escapeHtmlText(account),
    'Account: &lt;img src=x onerror=alert(1)&gt; · TOTP: Enabled',
  )
  assert.equal(escapeHtmlText(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;')
  assert.throws(
    () => formatMessage('en', 'errorRateLimited', {} as never),
    /Missing i18n parameter seconds/u,
  )
})
