import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { access, chmod, copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { startForwarder } from '../helpers/proxy.js'
import { Context } from '@deepseek-ai/cordis'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import { AuthRemoteWebServer } from '../../src/index.js'
import type { AuthConfig } from '../../src/config.js'
import { totpCode } from '../../src/auth/totp.js'
import { AuthStateStore } from '../../src/storage/store.js'
import {
  nativeCertificate,
  nativeCertPath,
  nativeKeyPath,
  nativeHttp,
  nativeRequest,
  nativeStream,
  type NativeRequestOptions,
} from '../helpers/native-http.js'

const password = 'native transport password 123'

async function fixture(
  host: string,
  secure: boolean,
  publicUrl?: string,
  preserveOriginPaths = ['/plugins/public'],
) {
  const profile = await mkdtemp(join(tmpdir(), 'auth-remote-native-'))
  await copyFile(nativeCertPath, join(profile, 'cert.pem'))
  await copyFile(nativeKeyPath, join(profile, 'key.pem'))
  const ctx = new Context()
  ctx.provide('profileContext', { dir: profile, name: 'web' } as never)
  ctx.provide('webStartup', {} as never)
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
    await ctx.plugin(AuthRemoteWebServer, {
      host,
      port: 0,
      requireTotp: true,
      preserveOriginPaths,
      ...(secure ? { tlsCert: './cert.pem', tlsKey: './key.pem' } : {}),
      ...(publicUrl ? { publicUrl } : {}),
    })
    await ctx.fiber.await()
    const server = ctx.webServer as AuthRemoteWebServer
    const connectionFiber = await ctx.plugin(Connection, {
      trustedHosts: [...server.connectionTrustedHosts],
    })
    await ctx.fiber.await()
    const address = host.split('%', 1)[0]!
    const physicalHost = address.includes(':') ? `[${address}]` : address
    const target = `${secure ? 'https' : 'http'}://${physicalHost}:${server.port}/`
    return {
      ctx,
      profile,
      server,
      connectionFiber,
      target,
      origin: new URL(server.publicUrl).origin,
      async cleanup() {
        await ctx.fiber.dispose()
        await rm(profile, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await ctx.fiber.dispose()
    await rm(profile, { recursive: true, force: true })
    throw error
  }
}

async function mfaLogin(
  f: Awaited<ReturnType<typeof fixture>>,
  transport: NativeRequestOptions = {},
) {
  const options = { ...transport, origin: f.origin, host: new URL(f.origin).host, method: 'POST' }
  const post = (path: string, value: unknown) =>
    nativeHttp(f.target, path, { ...options, body: JSON.stringify(value) })
  await f.server.authentication.initialize('alice', password)
  const first = await post('/auth-remote/login', { username: 'alice', password })
  assert.equal(first.status, 200)
  assert.equal(first.headers['set-cookie'], undefined)
  const binding = JSON.parse(first.body)
  assert.equal(binding.kind, 'binding')
  assert.equal(
    (
      await nativeHttp(f.target, '/api/native-probe', {
        ...options,
        method: 'GET',
        cookie: `dsh_auth_remote=${binding.challenge}`,
      })
    ).status,
    401,
  )
  const started = await post('/auth-remote/totp/start', { challenge: binding.challenge })
  assert.equal(started.status, 200)
  const secret = JSON.parse(started.body).secret
  const counter = Math.floor(Date.now() / 30_000)
  const bound = await post('/auth-remote/totp/confirm', {
    challenge: binding.challenge,
    code: totpCode(secret, counter),
  })
  assert.equal(bound.status, 200, bound.body)
  assert.equal(JSON.parse(bound.body).backupCodes.length, 10)
  const second = await post('/auth-remote/login', { username: 'alice', password })
  assert.equal(JSON.parse(second.body).kind, 'mfa')
  const verified = await post('/auth-remote/mfa/verify', {
    challenge: JSON.parse(second.body).challenge,
    code: totpCode(secret, counter + 1),
  })
  assert.equal(verified.status, 200, verified.body)
  const cookie = verified.headers['set-cookie']?.[0]
  assert.ok(cookie)
  assert.equal(cookie.includes('; Secure'), new URL(f.origin).protocol === 'https:')
  assert.equal(/;\s*Domain=/iu.test(cookie), false)
  return cookie.split(';')[0]!
}

async function upgrade(target: string, path: string, origin: string, cookie?: string) {
  const url = new URL(target)
  const hostname = url.hostname.replace(/^\[|\]$/gu, '')
  const socket =
    url.protocol === 'https:'
      ? tlsConnect({ host: hostname, port: Number(url.port), ca: nativeCertificate })
      : netConnect(Number(url.port), hostname)
  socket.on('error', () => {})
  await once(socket, url.protocol === 'https:' ? 'secureConnect' : 'connect')
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
  const response = once(socket, 'data')
  socket.write(
    `GET ${path} HTTP/1.1\r\nHost: ${new URL(origin).host}\r\nOrigin: ${origin}\r\n${cookie ? `Cookie: ${cookie}\r\n` : ''}Connection: Upgrade\r\nUpgrade: test\r\n\r\n`,
  )
  const line = String((await response)[0]).split('\r\n')[0]!
  return { socket, line, closed }
}

for (const [host, secure] of [
  ['127.0.0.1', false],
  ['::1', false],
  ['127.0.0.1', true],
  ['::1', true],
  ['::ffff:127.0.0.1', true],
  ['::1%lo', false],
] as const)
  test(`native ${secure ? 'HTTPS' : 'HTTP'} ${host} authenticates MFA, upload, SSE and upgrade with protocol-scoped cookies`, async () => {
    const f = await fixture(host, secure)
    const expectedHost = host === '::ffff:127.0.0.1' ? '127.0.0.1' : host.split('%', 1)[0]!
    const authority = `${expectedHost.includes(':') ? `[${expectedHost}]` : expectedHost}:${f.server.port}`
    const nativeOrigin = `${secure ? 'https:' : 'http:'}//${authority}`
    const options = { origin: f.origin, host: new URL(f.origin).host }
    try {
      let uploadStarted!: () => void
      let uploadAborted!: () => void
      const uploading = new Promise<void>((resolve) => {
        uploadStarted = resolve
      })
      const aborted = new Promise<void>((resolve) => {
        uploadAborted = resolve
      })
      f.server.register({
        kind: 'exact',
        path: '/api/native-held-upload',
        handler(req, _res) {
          req.on('error', () => {})
          req.once('data', () => uploadStarted())
          req.once('close', () => {
            assert.equal(req.complete, false)
            uploadAborted()
          })
          req.resume()
        },
      })
      const echo =
        (preserve: boolean) =>
        async (
          req: import('node:http').IncomingMessage,
          res: import('node:http').ServerResponse,
        ) => {
          const origin = preserve ? f.origin : nativeOrigin
          const host = preserve ? new URL(f.origin).host : authority
          const rejection = f.ctx.connection.requestRejection(req)
          if (rejection || req.headers.origin !== origin || req.headers.host !== host) {
            res.writeHead(rejection ?? 409)
            res.end('native transport metadata mismatch')
            return
          }
          const chunks: Buffer[] = []
          for await (const chunk of req) chunks.push(Buffer.from(chunk))
          const body = Buffer.concat(chunks)
          const pairs = (req.headers.cookie ?? '').split(';').map((value) => value.trim())
          const credential = pairs.find((value) => value.includes('=v1.'))!.split('=')[1]!
          const audience = JSON.parse(
            Buffer.from(credential.split('.')[1]!, 'base64url').toString('utf8'),
          ).authority
          res.end(
            JSON.stringify({
              host: req.headers.host,
              origin: req.headers.origin,
              audience,
              bytes: body.length,
              sha256: createHash('sha256').update(body).digest('hex'),
              pluginCookie: pairs.some((value) => value.startsWith('dsh_auth_remote=')),
            }),
          )
        }
      f.server.register({ kind: 'exact', path: '/api/native-probe', handler: echo(false) })
      f.server.register({ kind: 'exact', path: '/plugins/public/probe', handler: echo(true) })
      f.server.register({
        kind: 'exact',
        path: '/api/native-stream',
        handler(req, res) {
          if (req.headers.origin !== nativeOrigin) {
            res.writeHead(409)
            res.end()
            return
          }
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.write('data: ready\n\n')
          const timer = setInterval(() => res.write(': heartbeat\n\n'), 100)
          res.on('close', () => clearInterval(timer))
        },
      })
      f.server.registerUpgrade({
        path: '/api/native-upgrade',
        handler(req, socket) {
          const rejection = f.ctx.connection.requestRejection(req)
          if (rejection || req.headers.origin !== nativeOrigin) {
            socket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n')
            return
          }
          socket.write(
            'HTTP/1.1 101 Switching Protocols\r\nUpgrade: test\r\nConnection: Upgrade\r\n\r\n',
          )
        },
      })
      assert.equal((await nativeHttp(f.target, '/auth-remote/ready', options)).status, 200)
      assert.equal((await nativeHttp(f.target, '/api/native-probe', options)).status, 401)
      assert.equal(
        (
          await nativeHttp(f.target, '/api/native-probe', {
            ...options,
            method: 'POST',
            body: 'anonymous upload',
          })
        ).status,
        401,
      )
      assert.equal((await nativeHttp(f.target, '/api/native-stream', options)).status, 401)
      const anonymous = await upgrade(f.target, '/api/native-upgrade', f.origin)
      assert.match(anonymous.line, /401/u)
      anonymous.socket.destroy()
      const cookie = await mfaLogin(f)
      const bytes = Buffer.alloc(128 * 1024, 0x61)
      const uploaded = await nativeHttp(f.target, '/api/native-probe', {
        ...options,
        method: 'POST',
        cookie,
        body: bytes,
      })
      assert.equal(uploaded.status, 200, uploaded.body)
      const result = JSON.parse(uploaded.body)
      assert.equal(result.host, authority)
      assert.equal(result.origin, nativeOrigin)
      assert.equal(result.audience, secure ? nativeOrigin : authority)
      assert.equal(result.bytes, bytes.length)
      assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'))
      assert.equal(result.pluginCookie, false)
      const preserved = await nativeHttp(f.target, '/plugins/public/probe', { ...options, cookie })
      assert.equal(preserved.status, 200, preserved.body)
      assert.equal(JSON.parse(preserved.body).origin, f.origin)
      assert.equal(
        (
          await nativeHttp(f.target, '/api/native-probe', {
            ...options,
            cookie,
            origin: 'https://evil.example',
          })
        ).status,
        403,
      )
      assert.equal(
        (
          await nativeHttp(f.target, '/api/native-probe', {
            ...options,
            cookie,
            headers: { 'sec-fetch-site': 'cross-site' },
          })
        ).status,
        403,
      )
      const stream = await nativeStream(f.target, '/api/native-stream', { ...options, cookie })
      const socket = await upgrade(f.target, '/api/native-upgrade', f.origin, cookie)
      assert.match(socket.line, /101/u)
      const liveUpload = nativeRequest(f.target, '/api/native-held-upload', {
        ...options,
        method: 'POST',
        cookie,
      })
      liveUpload.on('error', () => {})
      const uploadClosed = new Promise<void>((resolve) => liveUpload.once('close', () => resolve()))
      liveUpload.write(Buffer.alloc(16 * 1024, 0x61))
      await uploading
      const loggedOut = await nativeHttp(f.target, '/auth-remote/logout', {
        ...options,
        method: 'POST',
        cookie,
      })
      assert.equal(loggedOut.status, 200)
      await Promise.all([stream.closed, socket.closed, uploadClosed, aborted])
      assert.equal(
        (await nativeHttp(f.target, '/api/native-probe', { ...options, cookie })).status,
        401,
      )
    } finally {
      await f.cleanup()
    }
  })

for (const failure of ['connection', 'storage'] as const)
  test(
    `native IPv6 HTTPS ${failure} failure closes carriers and all business admission`,
    { timeout: 10_000 },
    async () => {
      const f = await fixture('::1', true)
      try {
        const cookie = await mfaLogin(f)
        for (const path of ['/api/native-probe', '/api/native-held-upload'])
          f.server.register({
            kind: 'exact',
            path,
            handler(_req, res) {
              res.end('business')
            },
          })
        f.server.register({
          kind: 'exact',
          path: '/api/native-stream',
          handler(_req, res) {
            res.writeHead(200, { 'content-type': 'text/event-stream' })
            res.write('data: ready\n\n')
          },
        })
        f.server.registerUpgrade({
          path: '/api/native-upgrade',
          handler(_req, socket) {
            socket.write(
              'HTTP/1.1 101 Switching Protocols\r\nUpgrade: test\r\nConnection: Upgrade\r\n\r\n',
            )
          },
        })
        const stream = await nativeStream(f.target, '/api/native-stream', { cookie })
        const socket = await upgrade(f.target, '/api/native-upgrade', f.origin, cookie)
        assert.match(socket.line, /101/u)
        if (failure === 'connection') await f.connectionFiber.dispose()
        else {
          f.server.storage.subscribe(() => {
            throw new Error('native TLS test notification fault')
          })
          await assert.rejects(f.server.authentication.revokeAll(), /uncertain|fault/u)
        }
        await Promise.all([stream.closed, socket.closed])
        assert.equal((await nativeHttp(f.target, '/auth-remote/ready')).status, 503)
        assert.equal((await nativeHttp(f.target, '/api/native-probe', { cookie })).status, 503)
        assert.equal(
          (
            await nativeHttp(f.target, '/api/native-held-upload', {
              cookie,
              method: 'POST',
              body: 'blocked',
            })
          ).status,
          503,
        )
        const denied = await upgrade(f.target, '/api/native-upgrade', f.origin, cookie)
        assert.match(denied.line, /503/u)
        denied.socket.destroy()
      } finally {
        await f.cleanup()
      }
    },
  )

test('native concrete non-loopback IPv4 binding requires authentication and uses its real authority', async () => {
  const host = Object.values(networkInterfaces())
    .flat()
    .find((value) => value?.family === 'IPv4' && !value.internal)?.address
  assert.ok(host, 'a concrete non-loopback IPv4 interface is required')
  const f = await fixture(host, false)
  try {
    assert.equal((await nativeHttp(f.target, '/auth-remote/ready')).status, 200)
    assert.equal((await nativeHttp(f.target, '/api/native-probe')).status, 401)
    const cookie = await mfaLogin(f)
    f.server.register({
      kind: 'exact',
      path: '/api/native-probe',
      handler(req, res) {
        res.end(
          JSON.stringify({
            host: req.headers.host,
            origin: req.headers.origin,
            rejection: f.ctx.connection.requestRejection(req) ?? null,
          }),
        )
      },
    })
    const response = await nativeHttp(f.target, '/api/native-probe', { cookie })
    assert.equal(response.status, 200)
    assert.deepEqual(JSON.parse(response.body), {
      host: `${host}:${f.server.port}`,
      origin: `http://${host}:${f.server.port}`,
      rejection: null,
    })
  } finally {
    await f.cleanup()
  }
})

for (const secure of [false, true])
  test(`native mapped non-loopback ${secure ? 'HTTPS' : 'HTTP'} uses bind authority without preserved-path trust`, async () => {
    const address = Object.values(networkInterfaces())
      .flat()
      .find((value) => value?.family === 'IPv4' && !value.internal)?.address
    assert.ok(address, 'a concrete non-loopback IPv4 interface is required')
    const f = await fixture(`::ffff:${address}`, secure, undefined, [])
    // The public test certificate names this DNS identity; CA and name verification stay on.
    const options = secure ? { servername: 'auth-remote.test' } : {}
    const authority = new URL(`http://[::ffff:${address}]:${f.server.port}`).host
    const origin = `${secure ? 'https:' : 'http:'}//${authority}`
    const target = f.target
    try {
      assert.deepEqual(f.server.connectionTrustedHosts, [])
      assert.equal((await nativeHttp(target, '/auth-remote/ready', options)).status, 200)
      assert.equal((await nativeHttp(target, '/api/native-probe', options)).status, 401)
      const cookie = await mfaLogin(f, options)
      f.server.register({
        kind: 'exact',
        path: '/api/native-probe',
        handler(req, res) {
          const native = (req.headers.cookie ?? '')
            .split(';')
            .find((pair) => pair.includes('=v1.'))!
          const credential = native.slice(native.indexOf('=') + 1).trim()
          res.end(
            JSON.stringify({
              host: req.headers.host,
              origin: req.headers.origin,
              audience: JSON.parse(Buffer.from(credential.split('.')[1]!, 'base64url').toString())
                .authority,
              rejection: f.ctx.connection.requestRejection(req) ?? null,
              pluginCookie: (req.headers.cookie ?? '').includes('dsh_auth_remote='),
            }),
          )
        },
      })
      const response = await nativeHttp(target, '/api/native-probe', { ...options, cookie })
      assert.equal(response.status, 200)
      assert.deepEqual(JSON.parse(response.body), {
        host: authority,
        origin,
        audience: secure ? origin : authority,
        rejection: null,
        pluginCookie: false,
      })
      assert.equal(
        (
          await nativeHttp(target, '/api/native-probe', {
            ...options,
            cookie,
            origin: 'https://unregistered.example',
          })
        ).status,
        403,
      )
    } finally {
      await f.cleanup()
    }
    await assert.rejects(nativeHttp(target, '/auth-remote/ready', options), /ECONNREFUSED/u)
    await assert.rejects(access(f.profile), /ENOENT/u)
  })

test(
  'HTTP public proxy to IPv6 native HTTPS separates outer Secure and native audience',
  { timeout: 10_000 },
  async () => {
    const publicUrl = 'http://127.0.0.1:13136/'
    const f = await fixture('::1', true, publicUrl)
    let proxy: Awaited<ReturnType<typeof startForwarder>> | undefined
    try {
      proxy = await startForwarder({
        listenPort: 13136,
        upstreamPort: f.server.port,
        upstreamHost: '::1',
        upstreamTls: { ca: nativeCertificate },
      })
      const via = { ...f, target: publicUrl }
      assert.equal((await nativeHttp(publicUrl, '/auth-remote/ready')).status, 200)
      assert.equal((await nativeHttp(publicUrl, '/api/native-probe')).status, 401)
      const cookie = await mfaLogin(via)
      for (const path of ['/api/native-probe', '/plugins/public/probe'])
        f.server.register({
          kind: 'exact',
          path,
          handler(req, res) {
            const native = (req.headers.cookie ?? '')
              .split(';')
              .find((value) => value.includes('=v1.'))!
              .split('=')[1]!
            const audience = JSON.parse(
              Buffer.from(native.split('.')[1]!, 'base64url').toString('utf8'),
            ).authority
            res.end(
              JSON.stringify({
                host: req.headers.host,
                origin: req.headers.origin,
                audience,
                rejection: f.ctx.connection.requestRejection(req) ?? null,
              }),
            )
          },
        })
      const ordinary = await nativeHttp(publicUrl, '/api/native-probe', { cookie })
      assert.equal(ordinary.status, 200)
      assert.deepEqual(JSON.parse(ordinary.body), {
        host: `[::1]:${f.server.port}`,
        origin: `https://[::1]:${f.server.port}`,
        audience: `https://[::1]:${f.server.port}`,
        rejection: null,
      })
      const preserved = await nativeHttp(publicUrl, '/plugins/public/probe', { cookie })
      assert.equal(preserved.status, 200)
      assert.deepEqual(JSON.parse(preserved.body), {
        host: '127.0.0.1:13136',
        origin: 'http://127.0.0.1:13136',
        audience: 'https://127.0.0.1:13136',
        rejection: null,
      })
      f.server.register({
        kind: 'exact',
        path: '/api/native-stream',
        handler(_req, res) {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.write('data: ready\n\n')
        },
      })
      f.server.registerUpgrade({
        path: '/api/native-upgrade',
        handler(_req, socket) {
          socket.write(
            'HTTP/1.1 101 Switching Protocols\r\nUpgrade: test\r\nConnection: Upgrade\r\n\r\n',
          )
        },
      })
      const stream = await nativeStream(publicUrl, '/api/native-stream', { cookie })
      const socket = await upgrade(publicUrl, '/api/native-upgrade', via.origin, cookie)
      assert.match(socket.line, /101/u)
      assert.equal(
        (await nativeHttp(publicUrl, '/auth-remote/logout', { method: 'POST', cookie })).status,
        200,
      )
      await Promise.all([stream.closed, socket.closed])
    } finally {
      await proxy?.close()
      await f.cleanup()
    }
  },
)

test('TLS material errors fail before opening HTTP or HTTPS and release the profile lock', async () => {
  for (const kind of ['missing', 'unreadable', 'empty', 'pem', 'mismatch', 'unpaired'] as const) {
    const profile = await mkdtemp(join(tmpdir(), 'auth-remote-tls-invalid-'))
    const ctx = new Context()
    const port = 13134
    ctx.provide('profileContext', { dir: profile, name: 'web' } as never)
    ctx.provide('webStartup', { port } as never)
    await copyFile(nativeCertPath, join(profile, 'cert.pem'))
    await copyFile(nativeKeyPath, join(profile, 'key.pem'))
    if (kind === 'missing') await rm(join(profile, 'cert.pem'))
    if (kind === 'unreadable') await chmod(join(profile, 'cert.pem'), 0)
    if (kind === 'empty' || kind === 'pem')
      await writeFile(join(profile, 'cert.pem'), kind === 'empty' ? '' : 'invalid public test PEM')
    if (kind === 'mismatch')
      await copyFile(
        new URL('../fixtures/tls/native.mismatch.key.pem', import.meta.url),
        join(profile, 'key.pem'),
      )
    const config: AuthConfig = {
      tlsCert: './cert.pem',
      ...(kind === 'unpaired' ? {} : { tlsKey: './key.pem' }),
    }
    try {
      const fiber = ctx.plugin(AuthRemoteWebServer, config)
      await assert.rejects(fiber.await(), /tls|TLS/u)
      await assert.rejects(nativeHttp(`http://127.0.0.1:${port}/`, '/auth-remote/ready'))
      await assert.rejects(nativeHttp(`https://127.0.0.1:${port}/`, '/auth-remote/ready'))
      await assert.rejects(access(join(profile, 'auth-remote/admin.sock')))
      const store = await AuthStateStore.open(profile)
      await store.close()
    } finally {
      await ctx.fiber.dispose()
      await rm(profile, { recursive: true, force: true })
    }
  }
})
