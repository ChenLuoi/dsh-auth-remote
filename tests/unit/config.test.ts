import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Config } from '../../src/config.js'

async function api() {
  return import('../../src/config.js')
}

const context = { version: '0.2.1-alpha.2', profileDir: '/tmp/profile/web', cwd: '/tmp/start' }

test('Loader schema keeps omitted legacy field distinct from an explicit empty array', () => {
  assert.equal(Object.hasOwn(Config({}), 'allowedOrigins'), false)
  assert.deepEqual(Config({ allowedOrigins: [] }).allowedOrigins, [])
})

test('startup parser independently applies CLI, file and default host/port/URL priority', async () => {
  const { resolveStartupConfig } = await api()
  assert.equal(typeof resolveStartupConfig, 'function', 'startup parser must exist')
  const defaults = resolveStartupConfig({}, {}, context)
  assert.equal(defaults.host, '127.0.0.1')
  assert.equal(defaults.port, 3080)
  assert.equal(defaults.publicUrl, undefined)
  assert.equal(defaults.publicUrlSource, 'derived')
  const file = resolveStartupConfig(
    { host: '::1', port: 0, publicUrl: 'https://file.example' },
    {},
    context,
  )
  assert.equal(file.host, '::1')
  assert.equal(file.port, 0)
  assert.equal(file.publicUrl?.url, 'https://file.example/')
  assert.equal(file.publicUrlSource, 'file')
  const cli = resolveStartupConfig(
    { host: '::1', port: 8443, publicUrl: 'https://file.example' },
    { host: '127.0.0.2', port: 0, publicUrl: 'http://cli.example:8080/' },
    context,
  )
  assert.equal(cli.host, '127.0.0.2')
  assert.equal(cli.port, 0)
  assert.deepEqual(cli.publicUrl, {
    url: 'http://cli.example:8080/',
    origin: 'http://cli.example:8080',
  })
  assert.equal(cli.publicUrlSource, 'cli')
  assert.equal(
    resolveStartupConfig({ host: '127.0.0.2', port: 8443 }, { port: 0 }, context).host,
    '127.0.0.2',
  )
  assert.equal(resolveStartupConfig({ port: 8443 }, { host: '::1' }, context).port, 8443)
})

test('legacy conversion has explicit conflict checks and never edits user input', async () => {
  const { resolveStartupConfig } = await api()
  assert.equal(typeof resolveStartupConfig, 'function')
  for (const allowedOrigins of [[], ['https://legacy.example/']]) {
    const input = { allowedOrigins }
    const before = JSON.stringify(input)
    const result = resolveStartupConfig(input, {}, context)
    assert.equal(result.legacyWarning, true)
    assert.equal(result.publicUrlSource, allowedOrigins.length ? 'legacy' : 'derived')
    assert.equal(
      result.publicUrl?.url,
      allowedOrigins.length ? 'https://legacy.example/' : undefined,
    )
    assert.equal(JSON.stringify(input), before)
    for (const startup of [{}, { publicUrl: 'https://legacy.example' }])
      assert.throws(
        () =>
          resolveStartupConfig({ ...input, publicUrl: 'https://legacy.example' }, startup, context),
        /publicUrl.*allowedOrigins/u,
      )
    assert.throws(
      () => resolveStartupConfig(input, { publicUrl: 'https://legacy.example' }, context),
      /publicUrl.*allowedOrigins/u,
    )
  }
  for (const allowedOrigins of [
    ['https://a.example', 'https://b.example'],
    ['https://a.example', 'https://a.example'],
  ])
    assert.throws(() => resolveStartupConfig({ allowedOrigins }, {}, context), /one|unique|唯一/u)
})

test('all effective URL sources reject empty, child and credential-bearing URLs', async () => {
  const { resolveStartupConfig } = await api()
  assert.equal(typeof resolveStartupConfig, 'function')
  for (const publicUrl of [
    '',
    'https://app.example/child',
    'https://user@app.example',
    'https://app.example?',
  ]) {
    assert.throws(() => resolveStartupConfig({ publicUrl }, {}, context), /publicUrl/u)
    assert.throws(() => resolveStartupConfig({}, { publicUrl }, context), /publicUrl/u)
    assert.throws(
      () => resolveStartupConfig({ allowedOrigins: [publicUrl] }, {}, context),
      /publicUrl/u,
    )
  }
})

test('TLS chooses whole CLI or file pair and resolves paths against their own base', async () => {
  const { resolveStartupConfig } = await api()
  assert.equal(typeof resolveStartupConfig, 'function')
  const file = resolveStartupConfig({ tlsCert: './cert.pem', tlsKey: '../key.pem' }, {}, context)
  assert.deepEqual(file.tls, {
    certFile: '/tmp/profile/web/cert.pem',
    keyFile: '/tmp/profile/key.pem',
  })
  assert.equal(file.tlsSource, 'file')
  const cli = resolveStartupConfig(
    { tlsCert: 'missing.pem' },
    { tls: { certFile: 'cli.pem', keyFile: '/tmp/key.pem' } },
    context,
  )
  assert.deepEqual(cli.tls, { certFile: '/tmp/start/cli.pem', keyFile: '/tmp/key.pem' })
  assert.equal(cli.tlsSource, 'cli')
  assert.equal(resolveStartupConfig({}, {}, context).tls, undefined)
  for (const input of [
    { tlsCert: 'cert.pem' },
    { tlsKey: 'key.pem' },
    { tlsCert: '', tlsKey: 'key.pem' },
  ])
    assert.throws(() => resolveStartupConfig(input, {}, context), /tlsCert|tlsKey|TLS/u)
  for (const tls of [{ certFile: 'cert.pem' }, { keyFile: 'key.pem' }])
    assert.throws(
      () => resolveStartupConfig({ tlsCert: 'cert.pem', tlsKey: 'key.pem' }, { tls }, context),
      /--tls-cert.*--tls-key/u,
    )
})

test('six exact versions enforce native transport capabilities and concrete bindings', async () => {
  const { resolveStartupConfig } = await api()
  assert.equal(typeof resolveStartupConfig, 'function')
  for (const version of [
    '0.1.7-rc.1',
    '0.1.7-rc.2',
    '0.2.0-rc.1',
    '0.2.0-rc.2',
    '0.2.1-alpha.1',
    '0.2.1-alpha.2',
  ]) {
    const options = { ...context, version }
    assert.equal(resolveStartupConfig({ host: '192.0.2.10' }, {}, options).host, '192.0.2.10')
    for (const host of ['0.0.0.0', '::', '::ffff:0.0.0.0', 'localhost', 'app.example'])
      assert.throws(() => resolveStartupConfig({ host }, {}, options))
    if (version === '0.2.1-alpha.2') {
      assert.equal(resolveStartupConfig({ host: '::1' }, {}, options).host, '::1')
      assert.equal(
        resolveStartupConfig({ host: '::ffff:127.0.0.1' }, {}, options).host,
        '::ffff:127.0.0.1',
      )
      assert.equal(
        resolveStartupConfig({ tlsCert: 'not-read.pem', tlsKey: 'not-read.key' }, {}, options)
          .tlsSource,
        'file',
      )
    } else {
      assert.throws(() => resolveStartupConfig({ host: '::1' }, {}, options), /IPv4|IPv6/u)
      assert.throws(
        () => resolveStartupConfig({ tlsCert: 'cert.pem', tlsKey: 'key.pem' }, {}, options),
        /TLS.*support|support.*TLS/u,
      )
    }
  }
})

test('startup parser rejects aliases, nested TLS, unsafe ports and auth policy', async () => {
  const { resolveStartupConfig } = await api()
  assert.equal(typeof resolveStartupConfig, 'function')
  for (const input of [
    { public_url: 'https://a.example' },
    { allowOrigins: [] },
    { tls: { cert: 'x', key: 'y' } },
  ])
    assert.throws(() => resolveStartupConfig(input, {}, context), /unknown config key/u)
  for (const port of [-1, 65536, 1.5, NaN])
    assert.throws(() => resolveStartupConfig({ port }, {}, context), /port/u)
  for (const sessionHours of [0, 1.1, Number.MAX_SAFE_INTEGER])
    assert.throws(() => resolveStartupConfig({ sessionHours }, {}, context))
  for (const preserveOriginPaths of [['/api/'], ['/api', '/api'], ['/a/../api'], ['/a%2fb']])
    assert.throws(
      () => resolveStartupConfig({ preserveOriginPaths }, {}, context),
      /preserveOriginPaths/u,
    )
})

test('version capabilities distinguish public URL projection from native transport', async () => {
  const { getRuntimeCapabilities } =
    await import('../../src/adapters/dsh/runtime-capabilities.js').catch((error: unknown) =>
      assert.fail(String(error)),
    )
  for (const [version, publicUrl, nativeTransport] of [
    ['0.1.7-rc.1', false, false],
    ['0.1.7-rc.2', false, false],
    ['0.2.0-rc.1', false, false],
    ['0.2.0-rc.2', false, false],
    ['0.2.1-alpha.1', true, false],
    ['0.2.1-alpha.2', true, true],
    ['0.2.1-rc.1', true, true],
    ['1.0.0', true, true],
  ] as const) {
    const result = getRuntimeCapabilities(version)
    assert.equal(result.publicUrl, publicUrl)
    assert.equal(result.nativeTransport, nativeTransport)
  }
  for (const version of ['0.1.6', 'invalid'])
    assert.throws(() => getRuntimeCapabilities(version), /unsupported/u)
})

test('modern capability branches fail closed if the loaded host lost native APIs', async () => {
  const { getRuntimeCapabilities, validateListenerConfig, listenerProtocol } =
    await import('../../src/adapters/dsh/runtime-capabilities.js')
  const native = await import('@deepseek-ai/dsh-host-webserver')
  const { normalizeBindAddress: _unused, ...missingApi } = native
  const modern = getRuntimeCapabilities('0.2.1-alpha.2')
  assert.throws(
    () => validateListenerConfig(modern, { host: '::1', port: 0 }, missingApi),
    /lacks native/u,
  )
  assert.equal(listenerProtocol({}, getRuntimeCapabilities('0.2.1-alpha.1')), 'http:')
  assert.equal(listenerProtocol({ protocol: 'https:' }, modern), 'https:')
  for (const protocol of [undefined, 'ws:', 'http'])
    assert.throws(() => listenerProtocol({ protocol }, modern), /native protocol/u)
})

test('finalization admits only the effective root and uses the actual listener port', async () => {
  const { resolveStartupConfig, finalizeAuthConfig } = await api()
  assert.equal(typeof finalizeAuthConfig, 'function')
  const pending = resolveStartupConfig({ host: '192.0.2.10', port: 0 }, {}, context)
  const final = finalizeAuthConfig(pending, { host: '192.0.2.10', port: 13095, protocol: 'http:' })
  assert.equal(final.publicUrl, 'http://192.0.2.10:13095/')
  assert.equal(final.listenerUrl, 'http://192.0.2.10:13095/')
  assert.equal(
    final.originPolicy.matchAuthority('192.0.2.10:13095')?.origin,
    'http://192.0.2.10:13095',
  )
  assert.equal(final.originPolicy.matchAuthority('192.0.2.10:0'), undefined)
  const explicit = resolveStartupConfig(
    { publicUrl: 'https://old.example' },
    { publicUrl: 'http://final.example/' },
    context,
  )
  const replacement = finalizeAuthConfig(explicit, {
    host: '127.0.0.1',
    port: 13096,
    protocol: 'http:',
  })
  assert.equal(replacement.originPolicy.matchAuthority('old.example'), undefined)
  assert.equal(
    replacement.originPolicy.matchAuthority('final.example')?.origin,
    'http://final.example',
  )
  assert.throws(
    () => finalizeAuthConfig(pending, { host: '192.0.2.10', port: 0, protocol: 'http:' }),
    /port|listener|publicUrl/u,
  )
})

test('Loader-normalized null input remains explicit and cannot silently fall back', async () => {
  const { resolveStartupConfig } = await api()
  for (const input of [
    { publicUrl: null },
    { allowedOrigins: null },
    { publicUrl: 'https://same.example', allowedOrigins: null },
    { host: null },
    { port: null },
    { tlsCert: null },
    { tlsKey: null },
    { tlsCert: null, tlsKey: null },
  ]) {
    const parsed = Config(input as never)
    assert.throws(() => resolveStartupConfig(parsed, {}, context), undefined, JSON.stringify(input))
  }
  const pair = { certFile: 'cli-cert.pem', keyFile: 'cli-key.pem' }
  assert.equal(
    resolveStartupConfig(Config({ tlsCert: null } as never), { tls: pair }, context).tlsSource,
    'cli',
  )
})

test('native authority normalizes mapped and scoped binds while public URLs stay portable', async () => {
  const { resolveStartupConfig, finalizeAuthConfig } = await api()
  for (const [host, authority] of [
    ['::1', '[::1]:13137'],
    ['::ffff:127.0.0.1', '127.0.0.1:13137'],
    ['::1%lo', '[::1]:13137'],
    ['::ffff:127.0.0.1%lo', '127.0.0.1:13137'],
    ['2001:db8::10', '[2001:db8::10]:13137'],
    ['192.0.2.10', '192.0.2.10:13137'],
  ]) {
    const pending = resolveStartupConfig({ host }, {}, context)
    const final = finalizeAuthConfig(pending, { host: host!, port: 13137, protocol: 'https:' })
    assert.equal(final.nativeAuthority, authority)
    assert.equal(final.nativeOrigin, `https://${authority}`)
    assert.equal(final.publicUrl.includes('%'), false)
  }
  const host = 'fe80::10%eth0'
  const pending = resolveStartupConfig({ host }, {}, context)
  assert.throws(
    () => finalizeAuthConfig(pending, { host, port: 13137, protocol: 'http:' }),
    /scoped.*publicUrl/u,
  )
  const explicit = resolveStartupConfig(
    { host, publicUrl: 'https://portable.example/' },
    {},
    context,
  )
  const final = finalizeAuthConfig(explicit, { host, port: 13137, protocol: 'http:' })
  assert.equal(final.publicUrl, 'https://portable.example/')
  assert.equal(final.nativeOrigin, 'http://[fe80::10]:13137')
  assert.equal(final.listenerUrl, 'http://[fe80::10%eth0]:13137/')
})

test('old runtime retains the loopback bridge while exposing its concrete IPv4 public root', async () => {
  const { resolveStartupConfig, finalizeAuthConfig } = await api()
  const pending = resolveStartupConfig(
    { host: '192.0.2.10', port: 0 },
    {},
    { ...context, version: '0.1.7-rc.1' },
  )
  const final = finalizeAuthConfig(pending, { host: '192.0.2.10', port: 13138, protocol: 'http:' })
  assert.equal(final.publicUrl, 'http://192.0.2.10:13138/')
  assert.equal(final.nativeAuthority, '127.0.0.1:13138')
  assert.equal(final.nativeOrigin, 'http://127.0.0.1:13138')
})
