import assert from 'node:assert/strict'
import { once } from 'node:events'
import { request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { gunzipSync } from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { NativeBrowserAuth } from '../../src/adapters/dsh/browser-auth.js'
import {
  assertConnectionCompatibility,
  assertWebServerCompatibility,
} from '../../src/adapters/dsh/compatibility.js'
import { DshReadiness, watchConnection } from '../../src/adapters/dsh/readiness.js'
import { startupLines } from '../../src/adapters/dsh/startup-urls.js'
import { GuardedWebServer, READY_PATH, type WebGate } from '../../src/adapters/dsh/webserver.js'
import { resolveAuthConfig } from '../../src/config.js'
import { AuthRemoteWebServer } from '../../src/index.js'

const origin = 'http://auth-remote.test:13090'
const listener = { host: '127.0.0.1', port: 0 }
const config = resolveAuthConfig({ allowedOrigins: [origin] }, listener)
const require = createRequire(import.meta.url)

test('startup output groups the profile listener and each public origin without a token or login path', () => {
  const remote = resolveAuthConfig(
    { allowedOrigins: ['https://dsh.example.com:442', 'https://second.example'] },
    { host: '192.0.2.10', port: 13090 },
  )
  assert.deepEqual(startupLines('web', remote, 13090), [
    'dsh web start at',
    '  http://192.0.2.10:13090',
    '',
    'public access at',
    '  https://dsh.example.com:442',
    '  https://second.example',
  ])
  const loopback = resolveAuthConfig(
    { allowedOrigins: ['http://127.0.0.1:13090', 'https://dsh.example.com'] },
    { host: '127.0.0.1', port: 13090 },
  )
  assert.deepEqual(startupLines('private', loopback, 13090), [
    'dsh private start at',
    '  http://127.0.0.1:13090',
    '',
    'public access at',
    '  http://127.0.0.1:13090',
    '  https://dsh.example.com',
  ])
  assert.deepEqual(startupLines('web', resolveAuthConfig({}, listener), 13090), [
    'dsh web start at',
    '  http://127.0.0.1:13090',
  ])
})

test('configuration refuses unsafe origins, path prefixes and session lifetimes before listening', () => {
  const base = { allowedOrigins: [origin] }
  assert.equal(resolveAuthConfig(base, { host: '127.0.0.1', port: 13091 }).port, 13091)
  assert.equal(resolveAuthConfig(base, listener).compression, 'none')
  assert.equal(resolveAuthConfig(base, { host: '127.0.0.2', port: 0 }).host, '127.0.0.2')
  for (const host of ['localhost', '192.0.2.999', '::1', '', '0.0.0.0']) {
    assert.throws(() => resolveAuthConfig(base, { host, port: 0 }), /host/u)
  }
  assert.throws(
    () => resolveAuthConfig({ ...base, unexpected: true } as never, listener),
    /unknown config key/u,
  )
  for (const entry of [
    'https://user:pass@example.com',
    'https://example.com/path',
    'https://example.com?x=1',
    'https://example.com/#hash',
    'file:///tmp',
  ]) {
    assert.throws(
      () => resolveAuthConfig({ ...base, allowedOrigins: [entry] }, listener),
      /allowedOrigins/u,
    )
  }
  assert.deepEqual(resolveAuthConfig({}, listener).allowedOrigins, [])
  assert.deepEqual(
    resolveAuthConfig({ ...base, allowedOrigins: ['HTTPS://EXAMPLE.COM:443'] }, listener)
      .allowedOrigins,
    ['https://example.com'],
  )
  for (const path of [
    '/api/',
    '/api?x',
    '/api#x',
    '/api/*',
    '/api/%2F',
    '/api/%5c',
    '/api/../other',
    '//evil',
  ]) {
    assert.throws(
      () => resolveAuthConfig({ ...base, preserveOriginPaths: [path] }, listener),
      /preserveOriginPaths/u,
    )
  }
  assert.throws(
    () => resolveAuthConfig({ ...base, preserveOriginPaths: ['/api', '/api'] }, listener),
    /duplicate/u,
  )
  assert.throws(
    () => resolveAuthConfig({ ...base, sessionHours: 0 }, listener),
    /sessionHours|positive|number/u,
  )
  assert.throws(
    () => resolveAuthConfig({ ...base, sessionHours: Number.MAX_SAFE_INTEGER }, listener),
    /sessionHours/u,
  )
  assert.deepEqual(
    resolveAuthConfig({ ...base, preserveOriginPaths: ['/api', '/plugins/%E4%B8%AD'] }, listener)
      .preserveOriginPaths,
    ['/api', '/plugins/%E4%B8%AD'],
  )
})

test('formal entry refuses to bind without a profile storage location', async () => {
  const ctx = new Context()
  ctx.provide('webStartup', { host: '127.0.0.1', port: 13093 } as never)
  try {
    const fiber = ctx.plugin(AuthRemoteWebServer, {
      allowedOrigins: [origin],
    })
    await assert.rejects(fiber.await(), /profileContext is required/u)
    await assert.rejects(fetch('http://127.0.0.1:13093/auth-remote/ready'))
  } finally {
    await ctx.fiber.dispose()
  }
})

async function request(
  port: number,
  path: string,
  host = new URL(origin).host,
  headers: Record<string, string> = {},
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: '127.0.0.1', port, path, headers: { host, ...headers } },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk)
        })
        res.on('end', () => {
          resolve(
            new Response(Buffer.concat(chunks), {
              status: res.statusCode,
              headers: res.headers as HeadersInit,
            }),
          )
        })
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    req.end()
  })
}

test('official WebServer dispatches every registered handler through the gate', async () => {
  const ctx = new Context()
  let admitted = false
  let calls = 0
  const gate: WebGate = {
    ready: () => admitted,
    async http(_req, res, next) {
      calls += 1
      if (!admitted) {
        res.writeHead(401)
        res.end('denied')
        return
      }
      await next()
    },
    async upgrade(_req, socket, _head, next) {
      calls += 1
      if (!admitted) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        return
      }
      await next()
    },
  }
  class TestServer extends GuardedWebServer {
    constructor(context: Context) {
      super(context, config, gate)
    }
  }
  try {
    assert.equal(
      assertWebServerCompatibility(ctx),
      require('@deepseek-ai/dsh-host-webserver/package.json').version,
    )
    await ctx.plugin(TestServer, config)
    await ctx.fiber.await()
    const server = ctx.webServer
    assert.ok(server instanceof WebServer)
    const port = server.port
    assert.equal((await request(port, READY_PATH)).status, 503)
    assert.equal((await request(port, READY_PATH, 'forged.test')).status, 403)
    assert.equal(
      (await request(port, READY_PATH, new URL(origin).host, { origin: 'http://evil.test' }))
        .status,
      403,
    )
    let called = 0
    const disposeRoute = server.register({
      kind: 'exact',
      path: '/late',
      handler: (_req, res) => {
        called += 1
        res.end('late')
      },
    })
    assert.equal((await request(port, '/late')).status, 401)
    assert.equal(called, 0)
    const disposeFallback = server.registerFallback((_req, res) => {
      res.end('fallback')
    })
    assert.equal((await request(port, '/other')).status, 401)
    let deniedUpgradeCalls = 0
    const disposeDeniedUpgrade = server.registerUpgrade({
      path: '/denied-up',
      handler: () => {
        deniedUpgradeCalls += 1
      },
    })
    const deniedSocket = connect(port, '127.0.0.1')
    await once(deniedSocket, 'connect')
    const deniedAnswer = once(deniedSocket, 'data')
    deniedSocket.write(
      `GET /denied-up HTTP/1.1\r\nHost: ${new URL(origin).host}\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n`,
    )
    assert.match(String((await deniedAnswer)[0]), /401 Unauthorized/u)
    assert.equal(deniedUpgradeCalls, 0)
    deniedSocket.destroy()
    disposeDeniedUpgrade()
    admitted = true
    const ready = await request(port, READY_PATH)
    assert.equal(ready.status, 200)
    assert.deepEqual(await ready.json(), {
      plugin: 'dsh-auth-remote',
      protocolVersion: 1,
      ready: true,
    })
    assert.equal(await (await request(port, '/late')).text(), 'late')
    assert.equal(await (await request(port, '/other')).text(), 'fallback')
    const disposeStream = server.register({
      kind: 'exact',
      path: '/stream',
      handler: async (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.write('first')
        await Promise.resolve()
        res.end('second')
      },
    })
    assert.equal(await (await request(port, '/stream')).text(), 'firstsecond')
    disposeStream()
    assert.equal(called, 1)
    disposeRoute()
    assert.equal(await (await request(port, '/late')).text(), 'fallback')
    disposeFallback()
    assert.equal((await request(port, '/late')).status, 404)
    assert.ok(calls >= 5)

    const disposeUpgrade = server.registerUpgrade({
      path: '/up',
      handler: (_req, socket) => {
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\nUpgrade: test\r\nConnection: Upgrade\r\n\r\n',
        )
      },
    })
    const socket = connect(port, '127.0.0.1')
    await once(socket, 'connect')
    const answer = once(socket, 'data')
    socket.write(
      `GET /up HTTP/1.1\r\nHost: ${new URL(origin).host}\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n`,
    )
    assert.match(String((await answer)[0]), /101 Switching Protocols/u)
    disposeUpgrade()
    const closed = once(socket, 'close')
    await ctx.fiber.dispose()
    await closed
    assert.equal(socket.destroyed, true)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('official gzip configuration remains effective through the guarded service', async () => {
  const ctx = new Context()
  const gzipConfig = resolveAuthConfig(
    { allowedOrigins: [origin] },
    { ...listener, compression: 'gzip', compressionLevel: 1, compressionThresholdBytes: 16 },
  )
  const gate: WebGate = {
    ready: () => true,
    async http(_req, _res, next) {
      await next()
    },
    async upgrade(_req, _socket, _head, next) {
      await next()
    },
  }
  class TestServer extends GuardedWebServer {
    constructor(context: Context) {
      super(context, gzipConfig, gate)
    }
  }
  try {
    await ctx.plugin(TestServer, gzipConfig)
    await ctx.fiber.await()
    const body = 'compressible body '.repeat(80)
    ctx.webServer.register({
      kind: 'exact',
      path: '/gzip',
      handler: (_req, res) => {
        res.writeHead(200, {
          'content-type': 'text/plain',
          'content-length': Buffer.byteLength(body),
        })
        res.end(body)
      },
    })
    const response = await request(ctx.webServer.port, '/gzip', new URL(origin).host, {
      'accept-encoding': 'gzip',
    })
    assert.equal(response.headers.get('content-encoding'), 'gzip')
    assert.equal(gunzipSync(Buffer.from(await response.arrayBuffer())).toString('utf8'), body)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('native browser exchange stays server-side and is bound to each authority and Connection', async () => {
  const ctx = new Context()
  let record: unknown
  ctx.provide('credentials', {
    readRecord: async () => record,
    modifyRecord: async (_key: unknown, mutate: (value: unknown) => Promise<unknown>) => {
      record = (await mutate(record)) ?? record
      return record
    },
    deleteRecord: async () => {
      record = undefined
    },
  } as never)
  try {
    await ctx.plugin(Connection, {
      trustedHosts: ['auth-remote.test:13090', 'secure.example:442', 'default.example'],
    })
    await ctx.fiber.await()
    const connection = ctx.connection
    assert.equal(
      assertConnectionCompatibility(connection),
      require('@deepseek-ai/dsh-client-connection/package.json').version,
    )
    const auth = new NativeBrowserAuth()
    let exchanges = 0
    const counted = {
      authenticatedUrl(baseUrl: string) {
        exchanges += 1
        return connection.authenticatedUrl(baseUrl)
      },
      authorizeIndex: connection.authorizeIndex.bind(connection),
      requestRejection: connection.requestRejection.bind(connection),
    } as unknown as HostConnectionHandle
    const issuedAt = Date.now()
    const publicCookie = auth.cookieFor(counted, 'auth-remote.test:13090', origin, issuedAt)
    const localCookie = auth.cookieFor(connection, '127.0.0.1:13090', 'http://127.0.0.1:13090')
    const secureCookie = auth.cookieFor(
      connection,
      'secure.example:442',
      'https://secure.example:442',
    )
    const defaultPortCookie = auth.cookieFor(
      connection,
      'default.example',
      'https://default.example',
    )
    assert.notEqual(publicCookie, localCookie)
    assert.notEqual(secureCookie, defaultPortCookie)
    assert.equal(
      connection.requestRejection({
        headers: {
          host: 'secure.example:442',
          origin: 'https://secure.example:442',
          cookie: secureCookie,
        },
      }),
      undefined,
    )
    assert.equal(
      connection.requestRejection({
        headers: {
          host: 'default.example',
          origin: 'https://default.example',
          cookie: defaultPortCookie,
        },
      }),
      undefined,
    )
    assert.equal(auth.cookieFor(counted, 'auth-remote.test:13090', origin, issuedAt), publicCookie)
    assert.equal(exchanges, 1)
    auth.cookieFor(counted, 'auth-remote.test:13090', origin, issuedAt + 30 * 86_400_000 - 30_000)
    assert.equal(exchanges, 2)
    assert.equal(
      connection.requestRejection({
        headers: { host: 'auth-remote.test:13090', cookie: localCookie },
      }),
      401,
    )
    assert.equal(
      connection.requestRejection({
        headers: { host: 'auth-remote.test:13090', cookie: publicCookie },
      }),
      undefined,
    )
    auth.clear(counted)
    auth.cookieFor(counted, 'auth-remote.test:13090', origin)
    assert.equal(exchanges, 3)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('Connection activation, loss and replacement drive ready without a startup dependency cycle', async () => {
  const ctx = new Context()
  let record: unknown
  ctx.provide('credentials', {
    readRecord: async () => record,
    modifyRecord: async (_key: unknown, mutate: (value: unknown) => Promise<unknown>) => {
      record = (await mutate(record)) ?? record
      return record
    },
    deleteRecord: async () => {
      record = undefined
    },
  } as never)
  let readiness: DshReadiness
  let unavailable = 0
  const gate: WebGate = {
    ready: () => readiness?.ready() ?? false,
    async http(_req, res, next) {
      if (!readiness?.ready()) {
        res.writeHead(503)
        res.end()
        return
      }
      await next()
    },
    async upgrade(_req, socket, _head, next) {
      if (!readiness?.ready()) {
        socket.destroy()
        return
      }
      await next()
    },
  }
  class TestServer extends GuardedWebServer {
    constructor(context: Context) {
      super(context, config, gate)
    }
  }
  try {
    await ctx.plugin(TestServer, config)
    await ctx.fiber.await()
    const server = ctx.webServer as GuardedWebServer
    readiness = new DshReadiness(server, config, () => {
      unavailable += 1
    })
    watchConnection(ctx, readiness)
    assert.equal((await request(server.port, READY_PATH)).status, 503)
    const firstFiber = await ctx.plugin(Connection, { trustedHosts: [new URL(origin).host] })
    await ctx.fiber.await()
    assert.equal((await request(server.port, READY_PATH)).status, 200)
    const first = readiness.currentConnection()
    assert.ok(first)
    const publicCookie = readiness.nativeCookie(new URL(origin).host, origin)
    assert.equal(
      first.requestRejection({ headers: { host: new URL(origin).host, cookie: publicCookie } }),
      undefined,
    )
    await firstFiber.dispose()
    assert.equal((await request(server.port, READY_PATH)).status, 503)
    assert.equal(unavailable, 1)
    const secondFiber = await ctx.plugin(Connection, { trustedHosts: [new URL(origin).host] })
    await ctx.fiber.await()
    assert.equal((await request(server.port, READY_PATH)).status, 200)
    assert.notEqual(readiness.currentConnection(), first)
    await secondFiber.dispose()
    assert.equal(unavailable, 2)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('public origins need native trust only when a path preserves their authority', async () => {
  const ctx = new Context()
  const defaultConfig = resolveAuthConfig(
    { allowedOrigins: [origin, 'https://second.example'] },
    listener,
  )
  const preservingConfig = resolveAuthConfig(
    {
      allowedOrigins: [origin, 'https://second.example'],
      preserveOriginPaths: ['/plugins/public'],
    },
    listener,
  )
  let record: unknown
  ctx.provide('credentials', {
    readRecord: async () => record,
    modifyRecord: async (_key: unknown, mutate: (value: unknown) => Promise<unknown>) => {
      record = (await mutate(record)) ?? record
      return record
    },
    deleteRecord: async () => {
      record = undefined
    },
  } as never)
  class TestServer extends GuardedWebServer {
    constructor(context: Context) {
      super(context, defaultConfig)
    }
  }
  try {
    await ctx.plugin(TestServer, defaultConfig)
    await ctx.plugin(Connection, {})
    await ctx.fiber.await()
    const server = ctx.webServer as GuardedWebServer
    const defaultReadiness = new DshReadiness(server, defaultConfig)
    defaultReadiness.attach(ctx.connection)
    assert.equal(defaultReadiness.ready(), true)
    const preservingReadiness = new DshReadiness(server, preservingConfig)
    assert.throws(() => preservingReadiness.attach(ctx.connection), /auth-remote\.test.*403/u)
    assert.equal(preservingReadiness.ready(), false)
    assert.equal((await request(ctx.webServer.port, READY_PATH)).status, 503)
  } finally {
    await ctx.fiber.dispose()
  }
})
