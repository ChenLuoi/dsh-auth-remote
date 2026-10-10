import assert from 'node:assert/strict'
import { test } from 'node:test'

async function api() {
  return import('../../src/adapters/dsh/public-url.js').catch((error: unknown) =>
    assert.fail(`public URL implementation is unavailable: ${String(error)}`),
  )
}

test('public root URL preserves display form separately from normalized origin', async () => {
  const { parsePublicUrl } = await api()
  for (const [input, url, origin] of [
    ['https://app.example', 'https://app.example/', 'https://app.example'],
    ['HTTPS://APP.EXAMPLE:443/', 'https://app.example/', 'https://app.example'],
    ['http://app.example:80', 'http://app.example/', 'http://app.example'],
    ['http://[::1]:3080/', 'http://[::1]:3080/', 'http://[::1]:3080'],
    ['https://192.0.2.10:8443', 'https://192.0.2.10:8443/', 'https://192.0.2.10:8443'],
  ]) {
    assert.deepEqual(parsePublicUrl(input!), { url, origin })
  }
})

test('public root URL rejects normalization that would hide forbidden input', async () => {
  const { parsePublicUrl } = await api()
  for (const input of [
    '',
    ' app.example ',
    'https://app.example/child',
    'https://app.example/.',
    'https://app.example/child/..',
    'https://app.example?',
    'https://app.example/#',
    'https://app.example/?x=1',
    'https://app.example/#part',
    'https://user:pass@app.example',
    'https://@app.example',
    'https://app.example\\',
    'https://app.example\n',
    'https://app.example\t/',
    'https://app.example:0',
    'https://app.example:080',
    'https://app.example:65536',
    'https://app.example:',
    'http://127.1',
    'http://0x7f000001',
    'https://*.example',
    'https://bücher.example',
    'file:///tmp/file',
    '//app.example',
    'https://[fe80::1%eth0]/',
  ])
    assert.throws(() => parsePublicUrl(input), /publicUrl/u, input)
})

test('listener root URLs use actual port, TLS scheme and IPv6 brackets', async () => {
  const { listenerPublicUrl } = await api()
  assert.equal(listenerPublicUrl('127.0.0.1', 13090, 'http:'), 'http://127.0.0.1:13090/')
  assert.equal(listenerPublicUrl('::1', 8443, 'https:'), 'https://[::1]:8443/')
  assert.equal(listenerPublicUrl('::ffff:127.0.0.1', 3080, 'http:'), 'http://[::ffff:7f00:1]:3080/')
  for (const [host, port] of [
    ['::', 3080],
    ['0.0.0.0', 3080],
    ['localhost', 3080],
    ['127.0.0.1', 0],
    ['fe80::1%eth0', 3080],
  ] as const)
    assert.throws(() => listenerPublicUrl(host, port, 'http:'), /publicUrl|listener/u)
})
