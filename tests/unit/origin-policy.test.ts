import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createOriginPolicy,
  evaluateRequestOrigin,
  type RawRequestHead,
} from '../../src/http/origin-policy.js'

function request(
  host: string,
  options: {
    origin?: string
    method?: string
    target?: string
    upgrade?: boolean
    fetchSite?: string
    extra?: string[]
  } = {},
): RawRequestHead {
  return {
    rawHeaders: [
      'Host',
      host,
      ...(options.origin === undefined ? [] : ['Origin', options.origin]),
      ...(options.fetchSite === undefined ? [] : ['Sec-Fetch-Site', options.fetchSite]),
      ...(options.extra ?? []),
    ],
    method: options.method ?? 'GET',
    target: options.target ?? '/',
    upgrade: options.upgrade,
  }
}

test('registered origins normalize case and default ports without ambiguous authority', () => {
  const policy = createOriginPolicy([
    'HTTPS://EXAMPLE.COM:443',
    'http://example.com:8080',
    'http://other.example',
    'http://xn--bcher-kva.example',
    'http://[::1]:13090',
  ])
  assert.deepEqual(
    policy.registeredOrigins.map((entry) => entry.origin),
    [
      'https://example.com',
      'http://example.com:8080',
      'http://other.example',
      'http://xn--bcher-kva.example',
      'http://[::1]:13090',
    ],
  )
  assert.equal(policy.matchAuthority('EXAMPLE.COM:443')?.origin, 'https://example.com')
  assert.equal(policy.matchAuthority('example.com')?.origin, 'https://example.com')
  assert.equal(policy.matchAuthority('example.com:8080')?.origin, 'http://example.com:8080')
  assert.equal(policy.matchAuthority('other.example:80')?.origin, 'http://other.example')
  assert.equal(policy.matchAuthority('example.com:80'), undefined)
  assert.equal(policy.matchAuthority('example.com:000443'), undefined)
})

test('malformed, duplicate and protocol ambiguous entries fail before use', () => {
  for (const value of [
    'ftp://example.com',
    'https://example.com/',
    'https://example.com/path',
    'https://example.com?x=1',
    'https://example.com#part',
    'https://user@example.com',
    'https://*.example.com',
    'https://192.0.2.0/24',
    'https://bücher.example',
    'http://127.1',
    'http://0177.0.0.1',
    'http://0x7f000001',
    'http://2130706433',
    'http://[0:0:0:0:0:0:0:1]',
    'http://example.com:0',
    'http://example.com:65536',
    'http://example.com:080',
    'http://example.com:',
  ]) {
    assert.throws(() => createOriginPolicy([value]), /allowedOrigins/u, value)
  }
  assert.throws(
    () => createOriginPolicy(['https://example.com', 'HTTPS://EXAMPLE.COM:443']),
    /duplicate allowedOrigins/u,
  )
  for (const pair of [
    ['http://example.com', 'https://example.com'],
    ['https://example.com', 'http://example.com:443'],
    ['http://example.com', 'https://example.com:80'],
  ]) {
    assert.throws(() => createOriginPolicy(pair), /ambiguous allowedOrigins/u)
  }
})

test('registered requests bind Host, Origin and protocol to one entry', () => {
  const policy = createOriginPolicy(['https://alpha.example', 'http://beta.example:8080'])
  const admitted = evaluateRequestOrigin(
    policy,
    request('ALPHA.EXAMPLE:443', {
      origin: 'HTTPS://ALPHA.EXAMPLE:443',
      method: 'POST',
      target: '/api/settings?part=1',
      fetchSite: 'same-origin',
      extra: ['X-Forwarded-Proto', 'http', 'Forwarded', 'host=evil.example;proto=http'],
    }),
  )
  assert.deepEqual(admitted, {
    origin: 'https://alpha.example',
    protocol: 'https:',
    authority: 'alpha.example:443',
    downstreamAuthority: 'alpha.example',
    hostname: 'alpha.example',
    pathname: '/api/settings',
    returnPath: '/api/settings?part=1',
    registered: true,
    mayWriteCookie: true,
  })
  assert.equal(Object.isFrozen(admitted), true)
  assert.equal(
    evaluateRequestOrigin(policy, request('alpha.example'))?.origin,
    'https://alpha.example',
  )
  assert.equal(
    evaluateRequestOrigin(policy, request('alpha.example', { origin: 'http://beta.example:8080' })),
    null,
  )
  assert.equal(
    evaluateRequestOrigin(policy, request('alpha.example', { origin: 'https://evil.example' })),
    null,
  )
  assert.equal(evaluateRequestOrigin(policy, request('alpha.example', { method: 'POST' })), null)
  assert.equal(evaluateRequestOrigin(policy, request('alpha.example', { upgrade: true })), null)
  assert.equal(
    evaluateRequestOrigin(
      policy,
      request('alpha.example', { origin: 'https://alpha.example', upgrade: true }),
    )?.protocol,
    'https:',
  )
})

test('empty policy admits only literal canonical loopback with a matching Origin for mutation', () => {
  const policy = createOriginPolicy([])
  const defaultPort = evaluateRequestOrigin(policy, request('LOCALHOST:80'))
  assert.equal(defaultPort?.authority, 'localhost:80')
  assert.equal(defaultPort?.downstreamAuthority, 'localhost')
  assert.equal(defaultPort?.origin, 'http://localhost')
  assert.equal(defaultPort?.mayWriteCookie, false)
  for (const host of ['localhost:13090', '127.0.0.1:13090', '127.255.0.1:13090', '[::1]:13090']) {
    const context = evaluateRequestOrigin(policy, request(host))
    assert.equal(context?.protocol, 'http:')
    assert.equal(context?.mayWriteCookie, false)
    assert.equal(context?.registered, false)
    assert.equal(
      evaluateRequestOrigin(policy, request(host, { origin: `http://${host}`, method: 'POST' }))
        ?.mayWriteCookie,
      true,
    )
  }
  const secure = evaluateRequestOrigin(
    policy,
    request('localhost:13090', { origin: 'https://localhost:13090', method: 'POST' }),
  )
  assert.equal(secure?.protocol, 'https:')
  assert.equal(secure?.origin, 'https://localhost:13090')
  assert.equal(
    evaluateRequestOrigin(
      policy,
      request('localhost:13090', {
        origin: 'https://localhost:13090',
        method: 'POST',
        fetchSite: 'same-site',
      }),
    ),
    null,
  )
  assert.equal(
    evaluateRequestOrigin(
      policy,
      request('localhost:13090', {
        origin: 'https://localhost:13090',
        method: 'POST',
        fetchSite: 'same-origin',
      }),
    )?.protocol,
    'https:',
  )
  for (const host of [
    'localhost.evil:13090',
    '127.0.0.1.evil:13090',
    '127.1:13090',
    '0177.0.0.1:13090',
    '0x7f000001:13090',
    '192.0.2.20:13090',
    '192.0.2.10:13090',
    '[::2]:13090',
    '::1:13090',
    'localhost:0',
    'localhost:65536',
  ]) {
    assert.equal(evaluateRequestOrigin(policy, request(host)), null, host)
  }
  assert.equal(evaluateRequestOrigin(policy, request('localhost:13090', { method: 'POST' })), null)
  assert.equal(
    evaluateRequestOrigin(
      policy,
      request('192.0.2.10:13090', {
        extra: ['Forwarded', 'for=127.0.0.1;proto=https', 'X-Forwarded-Host', 'localhost:13090'],
      }),
    ),
    null,
  )
  assert.equal(
    evaluateRequestOrigin(policy, request('localhost:13090', { origin: 'http://localhost:13091' })),
    null,
  )
  assert.equal(evaluateRequestOrigin(policy, request('localhost:13090', { origin: 'null' })), null)
})

test('raw header counts, request target and Fetch Metadata are checked before rewrite', () => {
  const policy = createOriginPolicy(['https://app.example'])
  for (const extra of [
    ['Host', 'app.example'],
    ['Origin', 'https://app.example'],
    ['Sec-Fetch-Site', 'same-origin', 'Sec-Fetch-Site', 'none'],
    ['odd'],
  ]) {
    assert.equal(
      evaluateRequestOrigin(
        policy,
        request('app.example', { origin: 'https://app.example', extra }),
      ),
      null,
    )
  }
  for (const target of [
    'https://app.example/api',
    '//evil.example/api',
    '/bad\\path',
    '/bad#fragment',
    '/bad%GG',
    '/a/%2e%2e/admin',
    '/a/%2F/admin',
    '/bad path',
    '/bad\npath',
  ]) {
    assert.equal(evaluateRequestOrigin(policy, request('app.example', { target })), null, target)
  }
  for (const site of ['cross-site', 'same-site', 'unknown']) {
    assert.equal(evaluateRequestOrigin(policy, request('app.example', { fetchSite: site })), null)
  }
  assert.equal(
    evaluateRequestOrigin(policy, request('app.example', { fetchSite: 'none' }))?.registered,
    true,
  )
  assert.equal(
    evaluateRequestOrigin(
      policy,
      request('app.example', {
        origin: 'https://app.example',
        method: 'POST',
        fetchSite: 'none',
      }),
    ),
    null,
  )
  const root = evaluateRequestOrigin(
    policy,
    request('app.example', { target: '/?token=secret&next=1' }),
  )
  assert.equal(root?.returnPath, '/?next=1')
  assert.equal(
    evaluateRequestOrigin(policy, request('app.example', { target: '/page?token=secret' }))
      ?.returnPath,
    '/page?token=secret',
  )
})
