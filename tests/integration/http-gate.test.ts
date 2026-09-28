import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import { NativeBrowserAuth } from '../../src/adapters/dsh/browser-auth.js'
import { totpCode } from '../../src/auth/totp.js'
import { AuthRemoteWebServer } from '../../src/index.js'

const origin = 'https://secure.example:442'
const host = 'secure.example:442'
const password = 'secure password 123'

interface HttpAnswer {
  status: number | undefined
  headers: Record<string, string | string[] | undefined>
  body: string
}

async function request(
  port: number,
  path: string,
  options: {
    method?: string
    host?: string
    origin?: string | null
    cookie?: string
    accept?: string
    body?: string
    headers?: Record<string, string>
  } = {},
): Promise<HttpAnswer> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      host: options.host ?? host,
      ...(options.origin === null ? {} : { origin: options.origin ?? origin }),
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.accept ? { accept: options.accept } : {}),
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    }
    const req = httpRequest(
      { hostname: '127.0.0.1', port, path, method: options.method ?? 'GET', headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        )
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    req.end(options.body)
  })
}

async function fixture(
  requireTotp = false,
  allowedOrigins: string[] = [origin],
  startupHost = '127.0.0.1',
  preserveOriginPaths: string[] = ['/api', '/plugins/example'],
) {
  const profile = await mkdtemp(join(tmpdir(), 'auth-remote-gate-'))
  const ctx = new Context()
  ctx.provide('profileContext', { dir: profile, name: 'web' } as never)
  ctx.provide('webStartup', { host: startupHost, port: 0 } as never)
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
  await ctx.plugin(AuthRemoteWebServer, {
    allowedOrigins,
    requireTotp,
    preserveOriginPaths,
  })
  const connectionFiber = await ctx.plugin(Connection, {
    trustedHosts: preserveOriginPaths.length
      ? allowedOrigins.map((entry) => new URL(entry).host)
      : [],
  })
  await ctx.fiber.await()
  const server = ctx.webServer as AuthRemoteWebServer
  return {
    ctx,
    connectionFiber,
    server,
    port: server.port,
    async cleanup() {
      await ctx.fiber.dispose()
      await rm(profile, { recursive: true, force: true })
    },
  }
}

test('authenticated listener can bind a specific IPv4 address without a relay', async () => {
  const f = await fixture(false, [origin], '127.0.0.2')
  try {
    assert.equal(f.server.host, '127.0.0.2')
    const response = await fetch(`http://127.0.0.2:${f.port}/auth-remote/ready`)
    assert.equal(response.status, 200)
    assert.equal((await response.json()).ready, true)
    await assert.rejects(fetch(`http://127.0.0.1:${f.port}/auth-remote/ready`))
  } finally {
    await f.cleanup()
  }
})

async function login(port: number): Promise<string> {
  const response = await request(port, '/auth-remote/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'alice', password }),
  })
  assert.equal(response.status, 200, response.body)
  assert.equal(JSON.parse(response.body).kind, 'session')
  const cookie = response.headers['set-cookie']
  assert.equal(Array.isArray(cookie), true)
  assert.match(cookie![0]!, /HttpOnly; SameSite=Lax; Max-Age=.*; Secure/u)
  return cookie![0]!.split(';')[0]!
}

test('HTTPS public origin reaches native API through the internal bridge without trustedHosts', async () => {
  const f = await fixture(false, [origin], '127.0.0.1', [])
  try {
    await f.server.authentication.initialize('alice', password)
    f.server.register({
      kind: 'exact',
      path: '/api/bridge-check',
      handler: (req, res) => {
        const rejection = f.ctx.connection.requestRejection(req)
        res.writeHead(rejection ?? 200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ host: req.headers.host, origin: req.headers.origin }))
      },
    })
    assert.equal((await request(f.port, '/auth-remote/ready')).status, 200)
    const cookie = await login(f.port)
    const admitted = await request(f.port, '/api/bridge-check', { cookie })
    assert.equal(admitted.status, 200, admitted.body)
    assert.deepEqual(JSON.parse(admitted.body), {
      host: `127.0.0.1:${f.port}`,
      origin: `http://127.0.0.1:${f.port}`,
    })
    assert.equal(
      (await request(f.port, '/api/bridge-check', { cookie, origin: 'https://other.example' }))
        .status,
      403,
    )
  } finally {
    await f.cleanup()
  }
})

test('real listener rejects anonymous and cross-site requests, then serves exact auth routes', async () => {
  const f = await fixture()
  try {
    f.server.registerFallback((_req, res) => {
      res.end('page')
    })
    assert.equal((await request(f.port, '/auth-remote/ready')).status, 200)
    assert.equal((await request(f.port, '/auth-remote/state', { origin: null })).status, 200)
    assert.equal((await request(f.port, '/auth-remote/login.js')).status, 200)
    assert.equal((await request(f.port, '/auth-remote/login.css')).status, 200)
    assert.equal((await request(f.port, '/auth-remote/state')).status, 200)
    assert.equal(JSON.parse((await request(f.port, '/auth-remote/state')).body).initialized, false)
    assert.equal((await request(f.port, '/auth-remote/me')).status, 401)
    assert.equal((await request(f.port, '/api/private')).status, 401)
    assert.equal((await request(f.port, '/auth-remote/login', { method: 'PUT' })).status, 401)
    const redirected = await request(f.port, '/page?q=1', { accept: 'text/html' })
    assert.equal(redirected.status, 302)
    assert.match(String(redirected.headers.location), /return=%2Fpage%3Fq%3D1/u)
    assert.equal((await request(f.port, '/page', { host: 'forged.example' })).status, 403)
    assert.equal((await request(f.port, '/page', { origin: 'https://evil.example' })).status, 403)
    assert.equal(
      (await request(f.port, '/auth-remote/login', { method: 'POST', origin: null, body: '{}' }))
        .status,
      403,
    )
    assert.equal((await request(f.port, '/auth-remote/ready', { method: 'POST' })).status, 405)
    assert.equal(
      (await request(f.port, '/auth-remote/ready', { method: 'POST', origin: null })).status,
      403,
    )
    const state = await request(f.port, '/auth-remote/state')
    assert.deepEqual(JSON.parse(state.body), {
      initialized: false,
      requireTotp: false,
      profileName: 'web',
    })
    await f.server.authentication.initialize('alice', password)
    assert.equal(JSON.parse((await request(f.port, '/auth-remote/state')).body).initialized, true)
    const oversized = await request(f.port, '/auth-remote/login', {
      method: 'POST',
      headers: { 'content-length': '20000', 'content-type': 'application/json' },
      body: 'x'.repeat(20000),
    })
    assert.equal(oversized.status, 413)
    assert.equal(
      (
        await request(f.port, '/auth-remote/login', {
          method: 'POST',
          body: '{}',
          headers: { 'content-type': 'text/plain' },
        })
      ).status,
      415,
    )
    const native = new NativeBrowserAuth().cookieFor(f.ctx.connection, host, origin)
    assert.equal((await request(f.port, '/api/private', { cookie: native })).status, 401)
    const cookie = await login(f.port)
    const me = await request(f.port, '/auth-remote/me', { cookie })
    assert.equal(me.status, 200)
    assert.equal(JSON.parse(me.body).username, 'alice')
    assert.equal(
      (await request(f.port, '/auth-remote/me', { cookie: `${cookie}; ${cookie}` })).status,
      401,
    )
    assert.equal((await request(f.port, '/auth-remote/unknown', { cookie: native })).status, 401)
  } finally {
    await f.cleanup()
  }
})

test('parallel HTTPS, HTTP and implicit loopback entries keep one strict gate and correct cookies', async () => {
  const plainOrigin = 'http://plain.example:13090'
  const defaultPlainOrigin = 'http://plain-default.example'
  const defaultSecureOrigin = 'https://default.example'
  const lanOrigin = 'http://192.0.2.20:13090'
  const f = await fixture(false, [
    origin,
    plainOrigin,
    defaultPlainOrigin,
    defaultSecureOrigin,
    lanOrigin,
  ])
  try {
    const native = new NativeBrowserAuth()
    for (const [authority, entryOrigin] of [
      [host, origin],
      ['plain.example:13090', plainOrigin],
      ['plain-default.example', defaultPlainOrigin],
      ['default.example', defaultSecureOrigin],
      ['192.0.2.20:13090', lanOrigin],
    ]) {
      try {
        native.cookieFor(f.ctx.connection, authority!, entryOrigin!)
      } catch (error) {
        throw new Error(`native preflight failed for ${authority}: ${String(error)}`)
      }
    }
    await f.server.authentication.initialize('alice', password)
    const seen: {
      host: string | undefined
      origin: string | undefined
      cookie: string | undefined
    }[] = []
    for (const path of ['/api/entry', '/private/entry', '/plugins/dsh-openai-codex/fast-mode']) {
      f.server.register({
        kind: 'exact',
        path,
        handler: (req, res) => {
          seen.push({
            host: req.headers.host,
            origin: req.headers.origin,
            cookie: req.headers.cookie,
          })
          res.end('ok')
        },
      })
    }
    f.server.registerUpgrade({
      path: '/entry-socket',
      handler: (_req, socket) => {
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\nUpgrade: test\r\nConnection: Upgrade\r\n\r\n',
        )
      },
    })
    for (const entry of [
      { host, origin, secure: true },
      { host: 'plain.example:13090', origin: plainOrigin, secure: false },
      { host: 'plain-default.example:80', origin: defaultPlainOrigin, secure: false },
      { host: 'default.example:443', origin: defaultSecureOrigin, secure: true },
      { host: '192.0.2.20:13090', origin: lanOrigin, secure: false },
    ]) {
      assert.equal((await request(f.port, '/auth-remote/ready', entry)).status, 200, entry.origin)
      assert.equal((await request(f.port, '/api/entry', entry)).status, 401)
      const authenticated = await request(f.port, '/auth-remote/login', {
        ...entry,
        method: 'POST',
        body: JSON.stringify({ username: 'alice', password }),
        headers: { 'sec-fetch-site': 'same-origin', 'x-forwarded-proto': 'http' },
      })
      assert.equal(authenticated.status, 200, authenticated.body)
      const setCookie = authenticated.headers['set-cookie']
      assert.ok(Array.isArray(setCookie))
      assert.equal(setCookie[0]?.includes('; Secure'), entry.secure)
      const cookie = setCookie[0]!.split(';')[0]!
      assert.equal((await request(f.port, '/auth-remote/me', { ...entry, cookie })).status, 200)
      assert.equal((await request(f.port, '/api/entry', { ...entry, cookie })).status, 200)
      assert.equal(seen.at(-1)?.host, new URL(entry.origin).host)
      assert.equal(seen.at(-1)?.origin, entry.origin)
      assert.ok(seen.at(-1)?.cookie && !seen.at(-1)?.cookie.includes('dsh_auth_remote='))
      assert.equal((await request(f.port, '/private/entry', { ...entry, cookie })).status, 200)
      assert.equal(seen.at(-1)?.host, `127.0.0.1:${f.port}`)
      assert.equal(seen.at(-1)?.origin, `http://127.0.0.1:${f.port}`)
      assert.equal(
        (
          await request(f.port, '/plugins/dsh-openai-codex/fast-mode', {
            ...entry,
            cookie,
            method: 'POST',
            origin: null,
          })
        ).status,
        403,
      )
      assert.equal(
        (
          await request(f.port, '/plugins/dsh-openai-codex/fast-mode', {
            ...entry,
            cookie,
            method: 'POST',
          })
        ).status,
        200,
      )
      assert.equal(seen.at(-1)?.host, `127.0.0.1:${f.port}`)
      assert.equal(seen.at(-1)?.origin, `http://127.0.0.1:${f.port}`)
      const socket = connect(f.port, '127.0.0.1')
      await once(socket, 'connect')
      const opened = once(socket, 'data')
      socket.write(
        `GET /entry-socket HTTP/1.1\r\nHost: ${entry.host}\r\nOrigin: ${entry.origin}\r\nCookie: ${cookie}\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n`,
      )
      const responseLine = String((await opened)[0])
      socket.destroy()
      assert.match(responseLine, /101 Switching Protocols/u)
      const signedOut = await request(f.port, '/auth-remote/logout', {
        ...entry,
        method: 'POST',
        cookie,
      })
      assert.equal(signedOut.status, 200)
      assert.equal(
        (signedOut.headers['set-cookie'] as string[] | undefined)?.[0]?.includes('; Secure'),
        entry.secure,
      )
      assert.equal((await request(f.port, '/auth-remote/me', { ...entry, cookie })).status, 401)
    }

    assert.equal(
      (await request(f.port, '/auth-remote/ready', { host: 'plain.example:13090', origin })).status,
      403,
    )
    assert.equal(
      (
        await request(f.port, '/auth-remote/login', {
          method: 'POST',
          host,
          origin: plainOrigin,
          body: JSON.stringify({ username: 'alice', password }),
        })
      ).status,
      403,
    )
    const crossSocket = connect(f.port, '127.0.0.1')
    await once(crossSocket, 'connect')
    const rejectedUpgrade = once(crossSocket, 'data')
    crossSocket.write(
      `GET /entry-socket HTTP/1.1\r\nHost: ${host}\r\nOrigin: ${plainOrigin}\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n`,
    )
    const deniedLine = String((await rejectedUpgrade)[0])
    crossSocket.destroy()
    assert.match(deniedLine, /403 Forbidden/u)
    assert.equal(
      (
        await request(f.port, '/auth-remote/ready', {
          host: '192.0.2.21:13090',
          origin: null,
          headers: { 'x-forwarded-host': host, 'x-forwarded-proto': 'https' },
        })
      ).status,
      403,
    )

    for (const loopbackHost of [`127.0.0.1:${f.port}`, `localhost:${f.port}`, `[::1]:${f.port}`]) {
      const state = await request(f.port, '/auth-remote/state', {
        host: loopbackHost,
        origin: null,
      })
      assert.equal(state.status, 200, loopbackHost)
      assert.equal(state.headers['set-cookie'], undefined)
    }
    const loopbackHost = `127.0.0.1:${f.port}`
    const loopbackOrigin = `http://${loopbackHost}`
    assert.equal(
      (
        await request(f.port, '/auth-remote/login', {
          host: loopbackHost,
          origin: null,
          method: 'POST',
          body: JSON.stringify({ username: 'alice', password }),
        })
      ).status,
      403,
    )
    const loopbackLogin = await request(f.port, '/auth-remote/login', {
      host: loopbackHost,
      origin: loopbackOrigin,
      method: 'POST',
      body: JSON.stringify({ username: 'alice', password }),
    })
    assert.equal(loopbackLogin.status, 200, loopbackLogin.body)
    const loopbackCookie = (loopbackLogin.headers['set-cookie'] as string[])[0]!.split(';')[0]!
    assert.equal((loopbackLogin.headers['set-cookie'] as string[])[0]!.includes('; Secure'), false)
    const loopbackMe = await request(f.port, '/auth-remote/me', {
      host: loopbackHost,
      origin: null,
      cookie: loopbackCookie,
    })
    assert.equal(loopbackMe.status, 200)
    assert.equal(loopbackMe.headers['set-cookie'], undefined)
    assert.equal(
      (
        await request(f.port, '/auth-remote/logout', {
          host: loopbackHost,
          origin: null,
          method: 'POST',
          cookie: loopbackCookie,
        })
      ).status,
      403,
    )
    assert.equal(
      (
        await request(f.port, '/auth-remote/logout', {
          host: loopbackHost,
          origin: loopbackOrigin,
          method: 'POST',
          cookie: loopbackCookie,
          headers: { 'sec-fetch-site': 'same-site' },
        })
      ).status,
      403,
    )
    const loopbackLogout = await request(f.port, '/auth-remote/logout', {
      host: loopbackHost,
      origin: loopbackOrigin,
      method: 'POST',
      cookie: loopbackCookie,
    })
    assert.equal(loopbackLogout.status, 200)
    assert.equal((loopbackLogout.headers['set-cookie'] as string[])[0]!.includes('; Secure'), false)
  } finally {
    await f.cleanup()
  }
})

test('real HTTP parsing rejects duplicate headers, null Origin and forged request targets', async () => {
  const f = await fixture()
  try {
    f.server.registerFallback((_req, res) => res.end('fallback'))
    const rawStatus = async (head: string): Promise<number> => {
      const socket = connect(f.port, '127.0.0.1')
      await once(socket, 'connect')
      const data = once(socket, 'data')
      socket.write(head)
      const first = String((await data)[0])
      socket.destroy()
      const status = /HTTP\/1\.1 ([0-9]{3})/u.exec(first)?.[1]
      assert.ok(status, first)
      return Number(status)
    }
    for (const [head, expected] of [
      [`GET /auth-remote/state HTTP/1.1\r\nHost: ${host}\r\nHost: ${host}\r\n\r\n`, [400, 403]],
      [
        `GET /auth-remote/state HTTP/1.1\r\nHost: ${host}\r\nOrigin: ${origin}\r\nOrigin: ${origin}\r\n\r\n`,
        [403],
      ],
      [`GET /auth-remote/state HTTP/1.1\r\nHost: ${host}\r\nOrigin: null\r\n\r\n`, [403]],
      ['GET /auth-remote/state HTTP/1.1\r\nConnection: close\r\n\r\n', [400, 403]],
      [`GET //evil.example/path HTTP/1.1\r\nHost: ${host}\r\n\r\n`, [403]],
      ['GET /auth-remote/state HTTP/1.1\r\nHost: 127.1:13090\r\n\r\n', [403]],
      [
        `GET /auth-remote/state HTTP/1.1\r\nHost: 192.0.2.29:13090\r\nForwarded: host=${host};proto=https\r\n\r\n`,
        [403],
      ],
      [
        `GET /auth-remote/state HTTP/1.1\r\nHost: ${host}\r\nOrigin: ${origin}\r\nSec-Fetch-Site: same-site\r\n\r\n`,
        [403],
      ],
      [
        `POST /auth-remote/login HTTP/1.1\r\nHost: ${host}\r\nOrigin: ${origin}\r\nSec-Fetch-Site: none\r\nContent-Length: 0\r\n\r\n`,
        [403],
      ],
    ] as const) {
      assert.ok(expected.includes(await rawStatus(head)), head)
    }
  } finally {
    await f.cleanup()
  }
})

test('original authority check precedes path normalization and native credential replacement', async () => {
  const f = await fixture()
  try {
    await f.server.authentication.initialize('alice', password)
    const cookie = await login(f.port)
    const observed: {
      path: string
      url: string | undefined
      host: string | undefined
      origin: string | undefined
      cookie: string | undefined
    }[] = []
    for (const path of [
      '/default',
      '/api/item',
      '/plugins/example',
      '/plugins/example-other',
      '/',
    ]) {
      f.server.register({
        kind: 'exact',
        path,
        handler: (req, res) => {
          observed.push({
            path,
            url: req.url,
            host: req.headers.host,
            origin: req.headers.origin,
            cookie: req.headers.cookie,
          })
          res.end('ok')
        },
      })
    }
    const native = new NativeBrowserAuth()
    const localAuthority = `127.0.0.1:${f.port}`
    const localName = native
      .cookieFor(f.ctx.connection, localAuthority, `http://${localAuthority}`)
      .split('=')[0]!
    const publicName = native.cookieFor(f.ctx.connection, host, origin).split('=')[0]!
    const selected = [localName, publicName, publicName, localName]
    for (const path of ['/default', '/api/item', '/plugins/example', '/plugins/example-other']) {
      const selectedName =
        selected[
          ['/default', '/api/item', '/plugins/example', '/plugins/example-other'].indexOf(path)
        ]!
      const answer = await request(f.port, path, {
        cookie: `${cookie}; ${selectedName}=fake; unrelated=value`,
      })
      assert.equal(answer.status, 200)
    }
    const local = `127.0.0.1:${f.port}`
    assert.deepEqual(
      observed.map((row) => row.host),
      [local, host, host, local],
    )
    assert.deepEqual(
      observed.map((row) => row.origin),
      [`http://${local}`, origin, origin, `http://${local}`],
    )
    for (const [index, row] of observed.entries()) {
      assert.ok(row.cookie?.includes('unrelated=value'))
      assert.equal(row.cookie?.includes('dsh_auth_remote='), false)
      assert.equal(row.cookie?.includes(`${selected[index]}=fake`), false)
      assert.ok(row.cookie?.includes(`${selected[index]}=`))
    }
    assert.equal(
      (await request(f.port, '/default', { cookie, origin: 'https://evil.example' })).status,
      403,
    )
    assert.equal((await request(f.port, '/plugins/example', { cookie, origin: null })).status, 200)
    assert.equal(observed.at(-1)?.host, host)
    assert.equal(observed.at(-1)?.origin, undefined)
    assert.equal(observed.length, 5)
    const oldLink = await request(f.port, '/?token=launch-secret&keep=yes', { cookie })
    assert.equal(oldLink.status, 200)
    assert.equal(observed.at(-1)?.path, '/')
    assert.equal(observed.at(-1)?.url, '/?keep=yes')
    assert.equal(
      (
        await request(f.port, '/?token=launch-secret', { accept: 'text/html' })
      ).headers.location?.includes('token'),
      false,
    )
  } finally {
    await f.cleanup()
  }
})

test('uploads pass untouched and revocation closes live HTTP and upgrade carriers', async () => {
  const f = await fixture()
  try {
    await f.server.authentication.initialize('alice', password)
    const cookie = await login(f.port)
    f.server.register({
      kind: 'exact',
      path: '/upload',
      handler: async (req, res) => {
        let bytes = 0
        for await (const chunk of req) bytes += (chunk as Buffer).length
        res.end(String(bytes))
      },
    })
    const payload = 'x'.repeat(64 * 1024)
    const upload = await request(f.port, '/upload', {
      method: 'POST',
      cookie,
      body: payload,
      headers: { 'content-type': 'application/octet-stream' },
    })
    assert.equal(upload.body, String(Buffer.byteLength(payload)))

    f.server.register({
      kind: 'exact',
      path: '/stream',
      handler: (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: ready\n\n')
      },
    })
    const stream = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      const req = httpRequest(
        { hostname: '127.0.0.1', port: f.port, path: '/stream', headers: { host, origin, cookie } },
        resolve,
      )
      req.on('error', reject)
      req.end()
    })
    assert.equal(stream.statusCode, 200)
    stream.on('error', () => undefined)
    const streamClosed = new Promise<void>((resolve) => {
      stream.once('close', resolve)
    })

    f.server.registerUpgrade({
      path: '/socket',
      handler: (_req, socket) => {
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\nUpgrade: test\r\nConnection: Upgrade\r\n\r\n',
        )
      },
    })
    for (const [requestHost, requestOrigin] of [
      [host, null],
      ['forged.example', origin],
      [host, 'https://evil.example'],
    ] as const) {
      const rejected = connect(f.port, '127.0.0.1')
      await once(rejected, 'connect')
      const answer = once(rejected, 'data')
      rejected.write(
        `GET /socket HTTP/1.1\r\nHost: ${requestHost}\r\n${requestOrigin ? `Origin: ${requestOrigin}\r\n` : ''}Cookie: ${cookie}\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n`,
      )
      assert.match(String((await answer)[0]), /403 Forbidden/u)
      rejected.destroy()
    }
    const anonymous = connect(f.port, '127.0.0.1')
    await once(anonymous, 'connect')
    const denied = once(anonymous, 'data')
    anonymous.write(
      `GET /socket HTTP/1.1\r\nHost: ${host}\r\nOrigin: ${origin}\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n`,
    )
    assert.match(String((await denied)[0]), /401 Unauthorized/u)
    anonymous.destroy()
    const socket = connect(f.port, '127.0.0.1')
    await once(socket, 'connect')
    const opened = once(socket, 'data')
    socket.write(
      `GET /socket HTTP/1.1\r\nHost: ${host}\r\nOrigin: ${origin}\r\nCookie: ${cookie}\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n`,
    )
    assert.match(String((await opened)[0]), /101 Switching Protocols/u)
    socket.on('error', () => undefined)
    const socketClosed = new Promise<void>((resolve) => {
      socket.once('close', resolve)
    })
    await f.server.authentication.revokeAll()
    await Promise.all([streamClosed, socketClosed])
    assert.equal((await request(f.port, '/upload', { cookie })).status, 401)
  } finally {
    await f.cleanup()
  }
})

test('protected streams retain backpressure and client cancellation semantics', async () => {
  const f = await fixture()
  try {
    await f.server.authentication.initialize('alice', password)
    const cookie = await login(f.port)
    let drains = 0
    f.server.register({
      kind: 'exact',
      path: '/large',
      handler: async (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/octet-stream' })
        for (let index = 0; index < 64; index++) {
          if (!res.write(Buffer.alloc(64 * 1024, 'a'))) {
            drains++
            await once(res, 'drain')
          }
        }
        res.end()
      },
    })
    const bytes = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { hostname: '127.0.0.1', port: f.port, path: '/large', headers: { host, origin, cookie } },
        (res) => {
          let length = 0
          res.pause()
          setTimeout(() => res.resume(), 50)
          res.on('data', (chunk: Buffer) => {
            length += chunk.length
          })
          res.on('end', () => resolve(length))
          res.on('error', reject)
        },
      )
      req.on('error', reject)
      req.end()
    })
    assert.equal(bytes, 64 * 64 * 1024)
    assert.ok(drains > 0)
    let closedOnServer: (() => void) | undefined
    const serverClosed = new Promise<void>((resolve) => {
      closedOnServer = resolve
    })
    f.server.register({
      kind: 'exact',
      path: '/cancel',
      handler: (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: open\n\n')
        res.once('close', () => closedOnServer?.())
      },
    })
    const canceled = await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        { hostname: '127.0.0.1', port: f.port, path: '/cancel', headers: { host, origin, cookie } },
        (res) => {
          res.on('error', () => undefined)
          res.once('data', () => {
            res.destroy()
            resolve()
          })
        },
      )
      req.on('error', reject)
      req.end()
    })
    void canceled
    await serverClosed
  } finally {
    await f.cleanup()
  }
})

test(
  'partial authentication body times out with 408 without affecting business streams',
  { timeout: 15_000 },
  async () => {
    const f = await fixture()
    try {
      const answer = await new Promise<HttpAnswer>((resolve, reject) => {
        const req = httpRequest(
          {
            hostname: '127.0.0.1',
            port: f.port,
            path: '/auth-remote/login',
            method: 'POST',
            headers: {
              host,
              origin,
              'content-type': 'application/json',
              'transfer-encoding': 'chunked',
            },
          },
          (res) => {
            const chunks: Buffer[] = []
            res.on('data', (chunk: Buffer) => chunks.push(chunk))
            res.on('end', () =>
              resolve({
                status: res.statusCode,
                headers: res.headers,
                body: Buffer.concat(chunks).toString('utf8'),
              }),
            )
            res.on('error', reject)
          },
        )
        req.on('error', reject)
        req.write('{')
      })
      assert.equal(answer.status, 408)
      assert.equal(JSON.parse(answer.body).error, 'request_timeout')
    } finally {
      await f.cleanup()
    }
  },
)

test('logout responds after closing its business stream; uncertain persistence withdraws ready', async () => {
  const f = await fixture()
  try {
    await f.server.authentication.initialize('alice', password)
    f.server.register({
      kind: 'exact',
      path: '/events',
      handler: (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: open\n\n')
      },
    })
    const cookie = await login(f.port)
    async function openStream(authCookie: string): Promise<{ closed: Promise<void> }> {
      const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
        const req = httpRequest(
          {
            hostname: '127.0.0.1',
            port: f.port,
            path: '/events',
            headers: { host, origin, cookie: authCookie },
          },
          resolve,
        )
        req.on('error', reject)
        req.end()
      })
      response.on('error', () => undefined)
      return {
        closed: new Promise((resolve) => {
          response.once('close', resolve)
        }),
      }
    }
    const first = await openStream(cookie)
    const response = await request(f.port, '/auth-remote/logout', { method: 'POST', cookie })
    assert.equal(response.status, 200)
    await first.closed
    const nextCookie = await login(f.port)
    const second = await openStream(nextCookie)
    f.server.storage.subscribe(() => {
      throw new Error('injected notification failure')
    })
    await assert.rejects(f.server.authentication.revokeAll(), /injected notification failure/u)
    await second.closed
    assert.equal((await request(f.port, '/auth-remote/ready')).status, 503)
    assert.equal((await request(f.port, '/auth-remote/state')).status, 503)
  } finally {
    await f.cleanup()
  }
})

test('HTTP challenge and TOTP binding grant no business access until full MFA login', async () => {
  const f = await fixture(true)
  try {
    await f.server.authentication.initialize('alice', password)
    f.server.register({
      kind: 'exact',
      path: '/api/protected',
      handler: (_req, res) => {
        res.end('protected')
      },
    })
    const first = await request(f.port, '/auth-remote/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'alice', password }),
    })
    assert.equal(first.status, 200)
    assert.equal(first.headers['set-cookie'], undefined)
    const binding = JSON.parse(first.body) as { kind: string; challenge: string }
    assert.equal(binding.kind, 'binding')
    assert.equal(
      (await request(f.port, '/auth-remote/me', { cookie: `dsh_auth_remote=${binding.challenge}` }))
        .status,
      401,
    )
    assert.equal(
      (await request(f.port, '/api/protected', { cookie: `dsh_auth_remote=${binding.challenge}` }))
        .status,
      401,
    )
    const started = await request(f.port, '/auth-remote/totp/start', {
      method: 'POST',
      body: JSON.stringify({ challenge: binding.challenge }),
    })
    const secret = JSON.parse(started.body).secret as string
    assert.match(secret, /^[A-Z2-7]{32}$/u)
    const confirmed = await request(f.port, '/auth-remote/totp/confirm', {
      method: 'POST',
      body: JSON.stringify({
        challenge: binding.challenge,
        code: totpCode(secret, Math.floor(Date.now() / 30_000)),
      }),
    })
    assert.equal(confirmed.status, 200, confirmed.body)
    const backups = JSON.parse(confirmed.body).backupCodes as string[]
    assert.equal(backups.length, 10)
    assert.match((confirmed.headers['set-cookie'] as string[])[0]!, /dsh_auth_remote=;.*Max-Age=0/u)
    const second = await request(f.port, '/auth-remote/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'alice', password }),
    })
    const challenge = JSON.parse(second.body) as { kind: string; challenge: string }
    assert.equal(challenge.kind, 'mfa')
    const verified = await request(f.port, '/auth-remote/mfa/verify', {
      method: 'POST',
      body: JSON.stringify({ challenge: challenge.challenge, code: backups[0] }),
    })
    assert.equal(verified.status, 200, verified.body)
    const cookie = (verified.headers['set-cookie'] as string[])[0]!.split(';')[0]!
    assert.equal((await request(f.port, '/api/protected', { cookie })).body, 'protected')
    const loggedOut = await request(f.port, '/auth-remote/logout', { method: 'POST', cookie })
    assert.equal(loggedOut.status, 200)
    assert.equal((await request(f.port, '/api/protected', { cookie })).status, 401)
    assert.equal(
      (await request(f.port, '/auth-remote/logout', { method: 'POST', cookie })).status,
      200,
    )
  } finally {
    await f.cleanup()
  }
})

test('HTTP rate limit exposes Retry-After and does not reset after success', async () => {
  const f = await fixture()
  try {
    await f.server.authentication.initialize('alice', password)
    for (let index = 0; index < 10; index++) {
      const failed = await request(f.port, '/auth-remote/login', {
        method: 'POST',
        body: JSON.stringify({ username: `unknown-${index}`, password }),
        headers: { 'x-forwarded-for': `203.0.113.${index}` },
      })
      assert.equal(failed.status, 401)
    }
    const limited = await request(f.port, '/auth-remote/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'alice', password }),
    })
    assert.equal(limited.status, 429)
    assert.ok(Number(limited.headers['retry-after']) >= 1)
  } finally {
    await f.cleanup()
  }
})

test('sensitive HTTP methods require a full session and fresh credentials', async () => {
  const f = await fixture()
  try {
    await f.server.authentication.initialize('alice', password)
    const cookie = await login(f.port)
    const revision = f.server.storage.current().revision
    for (const newPassword of ['too short', 'x'.repeat(257)]) {
      const rejected = await request(f.port, '/auth-remote/password', {
        method: 'POST',
        cookie,
        body: JSON.stringify({ currentPassword: password, newPassword }),
      })
      assert.equal(rejected.status, 400, rejected.body)
      assert.deepEqual(JSON.parse(rejected.body), { error: 'invalid_input' })
      assert.equal(f.server.storage.current().revision, revision)
      assert.equal((await request(f.port, '/auth-remote/me', { cookie })).status, 200)
    }
    const newPassword = 'new secure password 456'
    const changeBody = JSON.stringify({ currentPassword: password, newPassword })
    assert.equal(
      (await request(f.port, '/auth-remote/password', { method: 'POST', body: changeBody })).status,
      401,
    )
    assert.equal(
      (
        await request(f.port, '/auth-remote/password', {
          method: 'POST',
          cookie,
          body: changeBody,
          origin: null,
        })
      ).status,
      403,
    )
    const changed = await request(f.port, '/auth-remote/password', {
      method: 'POST',
      cookie,
      body: changeBody,
    })
    assert.equal(changed.status, 200, changed.body)
    assert.equal((await request(f.port, '/auth-remote/me', { cookie })).status, 401)
    const oldLogin = await request(f.port, '/auth-remote/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'alice', password }),
    })
    assert.equal(oldLogin.status, 401)
    const newLogin = await request(f.port, '/auth-remote/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'alice', password: newPassword }),
    })
    const nextCookie = (newLogin.headers['set-cookie'] as string[])[0]!.split(';')[0]!
    const revoked = await request(f.port, '/auth-remote/revoke-sessions', {
      method: 'POST',
      cookie: nextCookie,
      body: JSON.stringify({ password: newPassword }),
    })
    assert.equal(revoked.status, 200)
    assert.equal((await request(f.port, '/auth-remote/me', { cookie: nextCookie })).status, 401)
  } finally {
    await f.cleanup()
  }
})

test('optional bound MFA can be disabled only with a full session and fresh second factor', async () => {
  const f = await fixture()
  try {
    await f.server.authentication.initialize('alice', password)
    const cookie = await login(f.port)
    const start = await request(f.port, '/auth-remote/totp/start', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ password }),
    })
    assert.equal(start.status, 200, start.body)
    const binding = JSON.parse(start.body) as { challenge: string; secret: string }
    const confirmed = await request(f.port, '/auth-remote/totp/confirm', {
      method: 'POST',
      body: JSON.stringify({
        challenge: binding.challenge,
        code: totpCode(binding.secret, Math.floor(Date.now() / 30_000)),
      }),
    })
    assert.equal(confirmed.status, 200, confirmed.body)
    assert.equal((await request(f.port, '/auth-remote/me', { cookie })).status, 401)
    const backups = JSON.parse(confirmed.body).backupCodes as string[]
    const loginChallenge = await request(f.port, '/auth-remote/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'alice', password }),
    })
    const mfa = JSON.parse(loginChallenge.body) as { challenge: string }
    const verified = await request(f.port, '/auth-remote/mfa/verify', {
      method: 'POST',
      body: JSON.stringify({ challenge: mfa.challenge, code: backups[0] }),
    })
    const fullCookie = (verified.headers['set-cookie'] as string[])[0]!.split(';')[0]!
    const denied = await request(f.port, '/auth-remote/totp/disable', {
      method: 'POST',
      cookie: fullCookie,
      body: JSON.stringify({ password, currentCode: 'bad' }),
    })
    assert.equal(denied.status, 401)
    const disabled = await request(f.port, '/auth-remote/totp/disable', {
      method: 'POST',
      cookie: fullCookie,
      body: JSON.stringify({ password, currentCode: backups[1] }),
    })
    assert.equal(disabled.status, 200, disabled.body)
    assert.equal((await request(f.port, '/auth-remote/me', { cookie: fullCookie })).status, 401)
    const plain = await request(f.port, '/auth-remote/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'alice', password }),
    })
    assert.equal(JSON.parse(plain.body).kind, 'session')
  } finally {
    await f.cleanup()
  }
})

test('deadline and Connection loss close long responses and withdraw readiness', async () => {
  const f = await fixture()
  try {
    await f.server.authentication.initialize('alice', password)
    const cookie = await login(f.port)
    f.server.register({
      kind: 'exact',
      path: '/events',
      handler: (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: open\n\n')
      },
    })
    async function openEvents(authCookie: string): Promise<{ closed: Promise<void> }> {
      const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
        const req = httpRequest(
          {
            hostname: '127.0.0.1',
            port: f.port,
            path: '/events',
            headers: { host, origin, cookie: authCookie },
          },
          resolve,
        )
        req.on('error', reject)
        req.end()
      })
      response.on('error', () => undefined)
      return {
        closed: new Promise<void>((resolve) => {
          response.once('close', resolve)
        }),
      }
    }
    const expired = await openEvents(cookie)
    await f.server.storage.transact((draft) => {
      for (const session of Object.values(draft.sessions)) session.expiresAt = Date.now() + 100
    })
    await expired.closed
    assert.equal((await request(f.port, '/events', { cookie })).status, 401)
    const nextCookie = await login(f.port)
    const connectionLost = await openEvents(nextCookie)
    await f.connectionFiber.dispose()
    await connectionLost.closed
    assert.equal((await request(f.port, '/auth-remote/ready')).status, 503)
    f.server.register({
      kind: 'exact',
      path: '/probe',
      handler: (_req, res) => {
        res.end('resumed')
      },
    })
    assert.equal((await request(f.port, '/probe', { cookie: nextCookie })).status, 503)
    await f.ctx.plugin(Connection, { trustedHosts: [host] })
    await f.ctx.fiber.await()
    assert.equal((await request(f.port, '/auth-remote/ready')).status, 200)
    assert.equal((await request(f.port, '/probe', { cookie: nextCookie })).body, 'resumed')
  } finally {
    await f.cleanup()
  }
})

test('MFA policy tightening invalidates old page, API and upgrade access without revival', async () => {
  const f = await fixture()
  try {
    await f.server.authentication.initialize('alice', password)
    const cookie = await login(f.port)
    f.server.register({
      kind: 'exact',
      path: '/page',
      handler: (_req, res) => {
        res.end('page')
      },
    })
    f.server.register({
      kind: 'exact',
      path: '/api/item',
      handler: (_req, res) => {
        res.end('item')
      },
    })
    f.server.registerUpgrade({
      path: '/socket',
      handler: (_req, socket) => {
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\nUpgrade: test\r\nConnection: Upgrade\r\n\r\n',
        )
      },
    })
    assert.equal((await request(f.port, '/page', { cookie })).status, 200)
    assert.equal((await request(f.port, '/api/item', { cookie })).status, 200)
    await f.server.authentication.applyPolicy({ requireTotp: true, sessionHours: 168 })
    assert.equal((await request(f.port, '/page', { cookie, accept: 'text/html' })).status, 302)
    assert.equal((await request(f.port, '/api/item', { cookie })).status, 401)
    const socket = connect(f.port, '127.0.0.1')
    await once(socket, 'connect')
    const denied = once(socket, 'data')
    socket.write(
      `GET /socket HTTP/1.1\r\nHost: ${host}\r\nOrigin: ${origin}\r\nCookie: ${cookie}\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n`,
    )
    assert.match(String((await denied)[0]), /401 Unauthorized/u)
    socket.destroy()
    await f.server.authentication.applyPolicy({ requireTotp: false, sessionHours: 168 })
    assert.equal((await request(f.port, '/api/item', { cookie })).status, 401)
  } finally {
    await f.cleanup()
  }
})

test('native credential rejection fails closed without replaying a protected POST', async () => {
  const f = await fixture()
  try {
    await f.server.authentication.initialize('alice', password)
    const cookie = await login(f.port)
    let calls = 0
    f.server.register({
      kind: 'exact',
      path: '/effect',
      handler: (_req, res) => {
        calls++
        res.end('changed')
      },
    })
    const connection = f.ctx.connection
    const original = connection.requestRejection
    connection.requestRejection = () => 401
    try {
      const response = await request(f.port, '/effect', { method: 'POST', cookie, body: '{}' })
      assert.equal(response.status, 503)
      assert.equal(calls, 0)
      assert.equal((await request(f.port, '/auth-remote/ready')).status, 503)
    } finally {
      connection.requestRejection = original
    }
  } finally {
    await f.cleanup()
  }
})
