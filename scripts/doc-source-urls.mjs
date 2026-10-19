const historyGuides = new Set(['docs/support-history.md', 'docs/support-history.zh-CN.md'])
const version = String.raw`[0-9]+\.[0-9]+\.[0-9]+`
const dshVersion = String.raw`${version}(?:-(?:alpha|rc)\.[0-9]+)?`
const registry = new RegExp(
  String.raw`^https://registry\.npmjs\.org/(?:@deepseek-ai/dsh(?:/${dshVersion})?|dsh-auth-remote(?:/${version})?)$`,
  'u',
)
const repository = new RegExp(
  String.raw`^https://github\.com/ChenLuoi/dsh-auth-remote/(?:tree/v${version}|blob/v${version}/(?:package\.json|README(?:\.zh-CN)?\.md|\.github/workflows/(?:ci|release)\.yml))$`,
  'u',
)

/** Only historical evidence links receive a source exception; deployment examples do not. */
export function isHistoricalSourceUrl(file, url) {
  return historyGuides.has(file) && (registry.test(url) || repository.test(url))
}
