import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  dictionaries,
  en,
  escapeHtmlText,
  formatMessage,
  localeFromLanguageTag,
  localePlaceholdersMatch,
  normalizeLocale,
  parseExactLocale,
  zh,
} from '../../src/shared/i18n.js'

test('English and Chinese have identical message keys and interpolation parameters', () => {
  assert.equal(localePlaceholdersMatch, true)
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort())
  assert.equal(dictionaries.en, en)
  assert.equal(dictionaries.zh, zh)
  for (const key of Object.keys(en) as (keyof typeof en)[]) {
    const parameters = (message: string) =>
      [...message.matchAll(/\{([^{}]+)\}/gu)].map((match) => match[1]).sort()
    assert.deepEqual(parameters(en[key]), parameters(zh[key]), key)
    assert.doesNotMatch(en[key], /<\/?[A-Za-z][^>]*>/u, key)
    assert.doesNotMatch(zh[key], /<\/?[A-Za-z][^>]*>/u, key)
  }
})

test('language selection has an exact stored form and an English fallback', () => {
  assert.equal(parseExactLocale('en'), 'en')
  assert.equal(parseExactLocale('zh'), 'zh')
  assert.equal(parseExactLocale('zh-CN'), null)
  assert.equal(parseExactLocale({ language: 'zh' }), null)
  assert.equal(normalizeLocale('zh-CN'), 'en')
  assert.equal(normalizeLocale(undefined), 'en')
  assert.equal(localeFromLanguageTag('zh_CN.UTF-8'), 'zh')
  assert.equal(localeFromLanguageTag('zh-Hans-CN'), 'zh')
  assert.equal(localeFromLanguageTag('C.UTF-8'), 'en')
  assert.equal(localeFromLanguageTag('POSIX'), 'en')
  assert.equal(localeFromLanguageTag('zho'), 'en')
})

test('formatting inserts text parameters without interpreting markup', () => {
  assert.equal(formatMessage('zh', 'loginTitle'), '登录 DSH')
  assert.equal(formatMessage('fr', 'loginTitle'), 'Sign in to DSH')
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
