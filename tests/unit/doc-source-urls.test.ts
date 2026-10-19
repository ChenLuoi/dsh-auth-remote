import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isHistoricalSourceUrl } from '../../scripts/doc-source-urls.mjs'

test('only the history guides permit exact registry and tagged repository evidence URLs', () => {
  const sources = [
    'https://registry.npmjs.org/@deepseek-ai/dsh',
    'https://registry.npmjs.org/@deepseek-ai/dsh/0.2.1-rc.2',
    'https://registry.npmjs.org/dsh-auth-remote/0.1.10',
    'https://github.com/ChenLuoi/dsh-auth-remote/tree/v0.1.4',
    'https://github.com/ChenLuoi/dsh-auth-remote/blob/v0.1.0/README.md',
    'https://github.com/ChenLuoi/dsh-auth-remote/blob/v0.1.4/package.json',
    'https://github.com/ChenLuoi/dsh-auth-remote/blob/v0.1.10/.github/workflows/ci.yml',
  ]
  for (const source of sources) {
    assert(isHistoricalSourceUrl('docs/support-history.md', source))
    assert(isHistoricalSourceUrl('docs/support-history.zh-CN.md', source))
    for (const file of ['docs/deployment.md', 'README.md', 'examples/nginx.conf'])
      assert.equal(isHistoricalSourceUrl(file, source), false)
  }
  for (const source of [
    'http://registry.npmjs.org/dsh-auth-remote',
    'https://registry.npmjs.org/another-package',
    'https://registry.npmjs.org/dsh-auth-remote?token=secret',
    'https://registry.npmjs.org:8443/dsh-auth-remote',
    'https://registry.npmjs.org.evil.example/dsh-auth-remote',
    'https://user:secret@registry.npmjs.org/dsh-auth-remote',
    'https://github.com/ChenLuoi/dsh-auth-remote/blob/master/README.md',
    'https://github.com/another/repo/blob/v0.1.0/README.md',
    'https://github.com/ChenLuoi/dsh-auth-remote/blob/v0.1.0/../../private',
  ])
    assert.equal(isHistoricalSourceUrl('docs/support-history.md', source), false, source)
})
