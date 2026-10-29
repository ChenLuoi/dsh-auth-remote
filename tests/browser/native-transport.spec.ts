import assert from 'node:assert/strict'
import { createHash, X509Certificate } from 'node:crypto'
import { access, copyFile, readFile, readdir, appendFile } from 'node:fs/promises'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { networkInterfaces } from 'node:os'
import { test } from 'node:test'
import { expect } from '@playwright/test'
import { checkDshVersion, dshVersion, testRuntime } from '../../scripts/runtime.mjs'
import { totpCode } from '../../src/auth/totp.js'
import { AuthStateStore } from '../../src/storage/store.js'
import { AuthService } from '../../src/auth/service.js'
import {
  nativeCertificate,
  nativeCertPath,
  nativeKeyPath,
  nativeHttp,
  nativeStream,
  type NativeRequestOptions,
} from '../helpers/native-http.js'
import { packedAdmin, packedCommand, packedProfile } from '../helpers/packed-runtime.js'
import { clickThroughDshPrompts, dsh, launchBrowser, openDshSettings } from '../helpers/runtime.js'
import { startForwarder, type Forwarder } from '../helpers/proxy.js'

const password = 'native packed browser password 123'
const pin = createHash('sha256')
  .update(new X509Certificate(nativeCertificate).publicKey.export({ type: 'spki', format: 'der' }))
  .digest('base64')

// Observe only frame headers; native ws still owns framing, ping/pong and decompression.
function firstTextCompression(socket: any): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let pending = Buffer.alloc(0)
    const cleanup = () => {
      clearTimeout(timer)
      socket._socket.off('data', data)
      socket.off('close', closed)
    }
    const closed = () => {
      cleanup()
      reject(new Error('native mux closed before a text frame'))
    }
    const data = (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk])
      while (pending.length >= 2) {
        const opcode = pending[0]! & 15
        if (opcode === 1) {
          cleanup()
          resolve(Boolean(pending[0]! & 64))
          return
        }
        // Before the first text frame, only complete unmasked control frames may intervene.
        if (![8, 9, 10].includes(opcode) || pending[1]! & 128 || (pending[1]! & 127) > 125) {
          cleanup()
          reject(new Error('unexpected native mux frame header'))
          return
        }
        const size = 2 + (pending[1]! & 127)
        if (pending.length < size) return
        pending = pending.subarray(size)
      }
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('native mux text frame timed out'))
    }, 5000)
    socket._socket.on('data', data)
    socket.once('close', closed)
  })
}

if (dshVersion === '0.2.2-alpha.2')
  for (const ingress of ['native-https', 'https-http-proxy'] as const)
    for (const compression of ['default', 'none'] as const)
      test(
        `native mux ${ingress} ${compression} preserves native compression, expiry and revocation`,
        { timeout: 90000 },
        async () => {
          const origin = 'https://auth-remote.test:13156'
          const f = await packedProfile({ port: 13157, publicUrl: origin, requireTotp: false })
          let server: ReturnType<typeof packedCommand> | undefined
          let proxy: Forwarder | undefined
          const sockets: any[] = []
          try {
            if (compression === 'none')
              await appendFile(
                join(f.profile, 'cordis.patch.yml'),
                '- id: typert-gateway\n  config:\n    websocketCompression: none\n',
              )
            const store = await AuthStateStore.open(f.profile)
            const auth = new AuthService(store, { requireTotp: false, sessionHours: 1 })
            let expiringToken: string
            let normalToken: string
            let expiresAt: number
            try {
              await auth.initialize('alice', password)
              const expiring = await auth.login('alice', password)
              assert.equal(expiring.kind, 'session')
              if (expiring.kind !== 'session') throw new Error('session required')
              expiringToken = expiring.token
              expiresAt = Date.now() + 30000
              await store.transact((draft) => {
                for (const session of Object.values(draft.sessions)) session.expiresAt = expiresAt
              })
              const normal = await auth.login('alice', password)
              assert.equal(normal.kind, 'session')
              if (normal.kind !== 'session') throw new Error('session required')
              normalToken = normal.token
            } finally {
              auth.dispose()
              await store.close()
            }
            server = packedCommand(
              f.home,
              [
                'web',
                '--no-open',
                '--port',
                '13157',
                ...(ingress === 'native-https'
                  ? ['--tls-cert', nativeCertPath, '--tls-key', nativeKeyPath]
                  : []),
              ],
              f.cwd,
            )
            const options = { host: new URL(origin).host, origin }
            let target = await waitReady(
              server,
              () => server!.output().stdout.match(/dsh web start at\n  (https?:\/\/[^\s]+)/u)?.[1],
              options,
            )
            if (ingress === 'https-http-proxy') {
              proxy = await startForwarder({
                listenPort: 13156,
                upstreamPort: Number(new URL(target).port),
                tls: { cert: nativeCertificate, key: await readFile(nativeKeyPath) },
              })
              target = 'https://127.0.0.1:13156'
            }
            const runtime = createRequire(resolve(testRuntime, 'package.json'))
            const host = createRequire(runtime.resolve('@deepseek-ai/dsh/package.json'))
            const web = createRequire(host.resolve('@deepseek-ai/dsh-web-app/package.json'))
            const gateway = createRequire(web.resolve('@deepseek-ai/dsh-api-gateway/package.json'))
            const { WebSocket } = gateway('ws')
            const wsUrl = new URL('/api/remote.mux', target)
            wsUrl.protocol = 'wss:'
            const cookie = `dsh_auth_remote=${normalToken!}`
            const expiryCookie = `dsh_auth_remote=${expiringToken!}`
            const connect = (authCookie?: string, requestOrigin: string | null = origin) => {
              const socket = new WebSocket(wsUrl, {
                ca: nativeCertificate,
                perMessageDeflate: true,
                headers: {
                  host: options.host,
                  ...(requestOrigin === null ? {} : { origin: requestOrigin }),
                  ...(authCookie ? { cookie: authCookie } : {}),
                },
              })
              socket.on('error', () => {})
              sockets.push(socket)
              return socket
            }
            const refused = (authCookie?: string, requestOrigin: string | null = origin) =>
              new Promise<number>((resolve, reject) => {
                const socket = connect(authCookie, requestOrigin)
                const timer = setTimeout(() => {
                  socket.terminate()
                  reject(new Error('native mux refusal timed out'))
                }, 5000)
                socket.once('open', () => {
                  clearTimeout(timer)
                  socket.terminate()
                  resolve(101)
                })
                socket.once('unexpected-response', (_request: unknown, response: any) => {
                  clearTimeout(timer)
                  response.resume()
                  socket.terminate()
                  resolve(response.statusCode)
                })
                socket.once('error', (error) => {
                  clearTimeout(timer)
                  reject(error)
                })
              })
            assert.equal(await refused(), 401)
            assert.equal(await refused(cookie, 'https://evil.example'), 403)
            assert.equal(await refused(cookie, null), 403)
            const open = async (authCookie: string, streamId: string) => {
              const socket = connect(authCookie)
              await once(socket, 'open', { signal: AbortSignal.timeout(5000) })
              const closed = once(socket, 'close', { signal: AbortSignal.timeout(60000) })
              void closed.catch(() => {})
              const compressed = firstTextCompression(socket)
              const response = once(socket, 'message', { signal: AbortSignal.timeout(5000) })
              socket.send(
                JSON.stringify({
                  type: 'open',
                  streamId,
                  endpoint: '$events',
                  payload: { args: {} },
                }),
              )
              const [[data], compressedFrame] = await Promise.all([response, compressed])
              const text = data.toString('utf8')
              const frame = JSON.parse(text)
              assert.equal(frame.type, 'item')
              assert.equal(frame.streamId, streamId)
              assert.equal(frame.value.type, 'ready')
              assert.ok(frame.value.clientId)
              assert.equal(typeof frame.value.host.home, 'string')
              assert.equal(socket.protocol, '')
              assert.equal(
                socket.extensions.includes('permessage-deflate'),
                compression === 'default',
              )
              return { socket, closed, compressed: compressedFrame, text }
            }
            const large = await open(cookie, 'mux-' + 'a'.repeat(2048))
            assert.ok(large.text.length >= 1024)
            assert.equal(large.compressed, compression === 'default')
            assert.ok(
              expiresAt! - Date.now() > 1000,
              'the short session must still be live when its native mux opens',
            )
            const small = await open(expiryCookie, 'expiry')
            assert.ok(small.text.length < 1024)
            assert.equal(small.compressed, false)
            await small.closed
            assert.ok(Date.now() >= expiresAt!)
            assert.equal(large.socket.readyState, WebSocket.OPEN)
            assert.equal(await refused(expiryCookie), 401)
            await packedAdmin(f.home, 'revoke-sessions', [
              ['Enter web to confirm revoke-sessions: ', 'web'],
            ])
            await large.closed
            assert.equal(await refused(cookie), 401)
          } finally {
            for (const socket of sockets) if (socket.readyState !== 3) socket.terminate()
            await server?.stop()
            await proxy?.close()
            await f.cleanup()
          }
        },
      )

if (dshVersion === '0.2.2-alpha.2')
  test(
    'native resource caching retains asset and fallback ETags, immutable code and all session gates',
    { timeout: 90000 },
    async () => {
      const origin = 'http://auth-remote.test:13155'
      const f = await packedProfile({ port: 13155, publicUrl: origin, requireTotp: false })
      let server: ReturnType<typeof packedCommand> | undefined
      let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined
      try {
        await packedAdmin(f.home, 'init', [
          ['Username: ', 'alice'],
          ['Password: ', password],
          ['Enter password again: ', password],
        ])
        server = packedCommand(f.home, ['web', '--no-open', '--port', '13155'], f.cwd)
        const options = { host: new URL(origin).host, origin }
        const target = await waitReady(
          server,
          () => server!.output().stdout.match(/dsh web start at\n  (https?:\/\/[^\s]+)/u)?.[1],
          options,
        )
        const login = await nativeHttp(target, '/auth-remote/login', {
          ...options,
          method: 'POST',
          body: JSON.stringify({ username: 'alice', password }),
        })
        assert.equal(login.status, 200, login.body)
        const cookie = login.headers['set-cookie']![0]!.split(';')[0]!
        const authenticated = { ...options, cookie }
        const runtime = createRequire(resolve(testRuntime, 'package.json'))
        const host = createRequire(runtime.resolve('@deepseek-ai/dsh/package.json'))
        const web = createRequire(host.resolve('@deepseek-ai/dsh-web-app/package.json'))
        const assetPackage = '@deepseek-ai/dsh-client-ui-settings-account'
        const assetRoot = dirname(web.resolve(assetPackage + '/package.json'))
        const assetName = (await readdir(join(assetRoot, 'lib/assets'))).find((name) =>
          name.endsWith('.svg'),
        )
        assert.ok(assetName, 'the exact native package must ship an exported asset')
        const assetPath = `/plugins/${assetPackage}/assets/${assetName}`
        const frontendRoot = dirname(web.resolve('@deepseek-ai/dsh-web-frontend/package.json'))
        const html = await nativeHttp(target, '/', authenticated)
        assert.equal(html.status, 200, html.body)
        const style = /href="((?:\.\/|\/)?assets\/[^"<>]+\.css)"/u.exec(html.body)?.[1]
        assert.ok(style, 'discover a genuine fallback file from the native index')
        const fallbackPath = new URL(style, origin).pathname
        const cacheCases = [
          {
            path: assetPath,
            expected: await readFile(join(assetRoot, 'lib/assets', assetName), 'utf8'),
            policy: 'public, max-age=31536000, immutable',
          },
          {
            path: fallbackPath,
            expected: await readFile(join(frontendRoot, 'dist', fallbackPath), 'utf8'),
            policy: 'no-cache',
          },
        ]
        const cacheEtags = new Map<string, string>()
        for (const entry of cacheCases) {
          const initial = await nativeHttp(target, entry.path, authenticated)
          assert.equal(initial.status, 200, entry.path)
          assert.equal(initial.body, entry.expected)
          assert.equal(initial.headers['cache-control'], entry.policy)
          const etag = initial.headers.etag
          assert.ok(etag, entry.path)
          cacheEtags.set(entry.path, etag)
          for (const method of ['GET', 'HEAD']) {
            const plain = await nativeHttp(target, entry.path, { ...authenticated, method })
            assert.equal(plain.status, 200)
            assert.equal(plain.headers.etag, etag)
            if (method === 'HEAD') assert.equal(plain.body, '')
            const conditional = await nativeHttp(target, entry.path, {
              ...authenticated,
              method,
              headers: { 'if-none-match': etag },
            })
            assert.equal(conditional.status, 304, entry.path)
            assert.equal(conditional.body, '')
            assert.equal(conditional.headers['cache-control'], initial.headers['cache-control'])
            assert.equal(
              (
                await nativeHttp(target, entry.path, {
                  ...options,
                  method,
                  headers: { 'if-none-match': etag },
                })
              ).status,
              401,
            )
          }
          assert.equal(
            (
              await nativeHttp(target, entry.path, {
                ...authenticated,
                origin: 'https://evil.example',
                headers: { 'if-none-match': etag },
              })
            ).status,
            403,
          )
        }
        assert.equal(html.headers.etag, undefined)
        assert.doesNotMatch(String(html.headers['cache-control'] ?? ''), /immutable|max-age/u)
        assert.equal(
          (
            await nativeHttp(target, '/', {
              ...authenticated,
              headers: { 'if-none-match': '"irrelevant"' },
            })
          ).status,
          200,
        )
        assert.equal((await nativeHttp(target, '/', options)).status, 401)
        assert.equal(
          (await nativeHttp(target, '/', { ...options, headers: { accept: 'text/html' } })).status,
          302,
        )
        for (const path of ['/manifest.webmanifest', '/favicon.svg', '/favicon-dark.svg'])
          for (const method of ['GET', 'HEAD'])
            assert.equal((await nativeHttp(target, path, { ...options, method })).status, 200)

        browser = await launchBrowser([
          '--no-proxy-server',
          '--host-resolver-rules=MAP auth-remote.test 127.0.0.1',
        ])
        const context = await browser.newContext({ locale: 'zh-CN' })
        await context.addCookies([
          { name: 'dsh_auth_remote', value: cookie.slice(cookie.indexOf('=') + 1), url: origin },
        ])
        const page = await context.newPage()
        await page.goto(origin)
        const boot = await page.evaluate(
          () =>
            (window as any).__DSH_BOOT__ as { entries: { id: string; rev: string; url: string }[] },
        )
        assert.ok(boot.entries.length)
        const connection = boot.entries.find(
          (entry) => entry.id === '@deepseek-ai/dsh-client-connection',
        )
        assert.ok(connection, 'the native graph advertises the real connection artifact revision')
        const bundlePath = new URL(connection.url, origin)
        const bundle = await nativeHttp(
          target,
          bundlePath.pathname + bundlePath.search,
          authenticated,
        )
        assert.equal(bundle.status, 200)
        const mapReference = /sourceMappingURL=(\S+)/u.exec(bundle.body)?.[1]
        assert.ok(mapReference, 'the real native bundle advertises its own source map')
        const mapUrl = new URL(mapReference, bundlePath)
        const chunkPath = `/plugins/${connection.id}/client.browser.js?rev=${connection.rev}`
        for (const path of [
          bundlePath.pathname + bundlePath.search,
          mapUrl.pathname + mapUrl.search,
          chunkPath,
          chunkPath.replace('.js?', '.js.map?'),
        ]) {
          const response = await nativeHttp(target, path, {
            ...authenticated,
            headers: { 'if-none-match': '"irrelevant"' },
          })
          assert.equal(response.status, 200, path)
          assert.equal(response.headers['cache-control'], 'public, max-age=31536000, immutable')
          assert.equal(response.headers.etag, undefined)
          assert.ok(response.body.length > 0)
          if (new URL(path, origin).pathname.endsWith('.map'))
            assert.equal(JSON.parse(response.body).version, 3)
          const head = await nativeHttp(target, path, { ...authenticated, method: 'HEAD' })
          assert.equal(head.status, 200)
          assert.equal(head.body, '')
          assert.equal(head.headers['cache-control'], response.headers['cache-control'])
          assert.equal((await nativeHttp(target, path, options)).status, 401)
        }
        assert.equal(
          (
            await nativeHttp(
              target,
              chunkPath.replace(connection.rev, '000000000000'),
              authenticated,
            )
          ).status,
          404,
        )
        await browser.close()
        browser = undefined
        await packedAdmin(f.home, 'revoke-sessions', [
          ['Enter web to confirm revoke-sessions: ', 'web'],
        ])
        for (const entry of cacheCases) {
          const prior = await nativeHttp(target, entry.path, authenticated)
          assert.equal(prior.status, 401)
          for (const method of ['GET', 'HEAD'])
            assert.equal(
              (
                await nativeHttp(target, entry.path, {
                  ...authenticated,
                  method,
                  headers: { 'if-none-match': cacheEtags.get(entry.path)! },
                })
              ).status,
              401,
            )
        }
      } finally {
        await browser?.close()
        await server?.stop()
        await f.cleanup()
      }
    },
  )

for (const bindKind of ['loopback', 'interface'] as const)
  test(
    `packed DSH ${dshVersion} ${bindKind} declares the finalized bridge authority and retains CLI trust without widening public admission`,
    { timeout: 30_000 },
    async () => {
      const publicOrigin = 'https://secure.example:442'
      const extraAuthority = 'extra.example:8443'
      const bindHost =
        bindKind === 'loopback'
          ? '127.0.0.2'
          : Object.values(networkInterfaces())
              .flat()
              .find((value) => value?.family === 'IPv4' && !value.internal)?.address
      assert.ok(bindHost, 'concrete non-loopback IPv4 is required')
      const f = await packedProfile(
        { host: '127.0.0.1', port: 0, publicUrl: publicOrigin, requireTotp: false },
        true,
      )
      let server: ReturnType<typeof packedCommand> | undefined
      try {
        await packedAdmin(f.home, 'init', [
          ['Username: ', 'alice'],
          ['Password: ', password],
          ['Enter password again: ', password],
        ])
        server = packedCommand(
          f.home,
          [
            'web',
            '--no-open',
            '--host',
            bindHost,
            '--port',
            '0',
            '--trusted-host',
            extraAuthority,
            extraAuthority,
          ],
          f.cwd,
        )
        const active = server
        const options = { host: new URL(publicOrigin).host, origin: publicOrigin }
        const target = await waitReady(
          active,
          () => {
            const match = [
              ...active.output().stdout.matchAll(/http:\/\/([0-9.]+):([0-9]+)/gu),
            ].find((value) => value[1] === bindHost)
            return match ? `http://${bindHost}:${match[2]}/` : undefined
          },
          options,
        )
        const path = '/plugins/strict/trusted-host'
        assert.equal((await nativeHttp(target, path, { ...options, method: 'POST' })).status, 401)
        const login = await nativeHttp(target, '/auth-remote/login', {
          ...options,
          method: 'POST',
          body: JSON.stringify({ username: 'alice', password }),
        })
        assert.equal(login.status, 200, login.body)
        const cookie = login.headers['set-cookie']![0]!.split(';')[0]!
        const admitted = await nativeHttp(target, path, { ...options, method: 'POST', cookie })
        assert.equal(admitted.status, 200, admitted.body)
        const seen = JSON.parse(admitted.body)
        const port = new URL(target).port
        const nativeAuthority = `${bindHost}:${port}`
        assert.equal(seen.host, nativeAuthority)
        assert.equal(seen.origin, `http://${nativeAuthority}`)
        assert.deepEqual(seen.trustedHosts, [extraAuthority, nativeAuthority])
        assert.equal(seen.trustedHosts.includes(new URL(publicOrigin).host), false)
        assert.equal(
          seen.trustedHosts.some((value: string) => value.endsWith(':0')),
          false,
        )
        assert.equal(
          (
            await nativeHttp(target, path, {
              host: extraAuthority,
              origin: `https://${extraAuthority}`,
              method: 'POST',
              cookie,
            })
          ).status,
          403,
        )
        assert.equal(
          (
            await nativeHttp(target, path, {
              ...options,
              origin: 'https://evil.example',
              method: 'POST',
              cookie,
            })
          ).status,
          403,
        )
      } finally {
        await server?.stop()
        await f.cleanup()
      }
    },
  )

async function waitReady(
  server: ReturnType<typeof packedCommand>,
  target: () => string | undefined,
  options: NativeRequestOptions = {},
) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (server.child.exitCode !== null) break
    const url = target()
    if (url) {
      try {
        if ((await nativeHttp(url, '/auth-remote/ready', options)).status === 200) return url
      } catch {
        /* real native startup */
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const output = server.output()
  assert.fail(
    `native packed startup failed: ${(output.stderr + output.stdout).replace(/\?token=[^\s]+/gu, '?token=[redacted]').slice(0, 2500)}`,
  )
}

for (const [host, secure, cli] of [
  ['127.0.0.1', false, false],
  ['::1', false, false],
  ['127.0.0.1', true, false],
  ['::1', true, true],
  ['::ffff:127.0.0.1', true, false],
] as const)
  test(
    `packed DSH ${dshVersion} ${secure ? 'HTTPS' : 'HTTP'} ${host} runs MFA, Host settings and confirmed CLI revocation`,
    { timeout: 90_000 },
    async () => {
      checkDshVersion(dsh)
      const f = await packedProfile(
        {
          host,
          port: 0,
          requireTotp: true,
          preserveOriginPaths: ['/plugins/public'],
          ...(secure
            ? cli
              ? { tlsCert: 'unused-missing-file.pem' }
              : { tlsCert: './native.cert.pem', tlsKey: './native.key.pem' }
            : {}),
        },
        true,
      )
      let server: ReturnType<typeof packedCommand> | undefined
      let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined
      try {
        await copyFile(nativeCertPath, join(cli ? f.cwd : f.profile, 'native.cert.pem'))
        await copyFile(nativeKeyPath, join(cli ? f.cwd : f.profile, 'native.key.pem'))
        const initialized = await packedAdmin(f.home, 'init', [
          ['Username: ', 'alice'],
          ['Password: ', password],
          ['Enter password again: ', password],
        ])
        assert.equal(initialized.includes(password), false)
        server = packedCommand(
          f.home,
          [
            'web',
            '--no-open',
            ...(cli
              ? ['--tls-cert', './native.cert.pem', '--tls-key', join(f.cwd, 'native.key.pem')]
              : []),
          ],
          f.cwd,
        )
        const address = () =>
          server!.output().stdout.match(/dsh web start at\n  (https?:\/\/[^\s]+)/u)?.[1]
        const target = await waitReady(server, address)
        const publicOrigin = new URL(target).origin
        assert.equal(new URL(target).protocol, secure ? 'https:' : 'http:')
        assert.notEqual(new URL(target).port, '0')
        assert.equal((await nativeHttp(target, '/api/settings')).status, 401)
        assert.equal(
          (
            await nativeHttp(target, '/plugins/strict/echo', {
              method: 'POST',
              body: 'anonymous',
            })
          ).status,
          401,
        )
        assert.equal((await nativeHttp(target, '/plugins/strict/stream')).status, 401)
        assert.equal(
          (await nativeHttp(target, '/plugins/strict/echo', { origin: 'https://evil.example' }))
            .status,
          403,
        )
        const post = (path: string, value: unknown) =>
          nativeHttp(target, path, { method: 'POST', body: JSON.stringify(value) })
        const first = await post('/auth-remote/login', { username: 'alice', password })
        assert.equal(first.status, 200)
        assert.equal(first.headers['set-cookie'], undefined)
        const challenge = JSON.parse(first.body).challenge
        const started = await post('/auth-remote/totp/start', { challenge })
        assert.equal(started.status, 200)
        const counter = Math.floor(Date.now() / 30_000)
        const bound = await post('/auth-remote/totp/confirm', {
          challenge,
          code: totpCode(JSON.parse(started.body).secret, counter),
        })
        assert.equal(bound.status, 200, bound.body)
        const backupCode = JSON.parse(bound.body).backupCodes[0]
        browser = await launchBrowser([
          '--no-proxy-server',
          `--ignore-certificate-errors-spki-list=${pin}`,
        ])
        const context = await browser.newContext({ locale: 'zh-CN' })
        await context.addInitScript(() => {
          try {
            localStorage.setItem('dsh-auth-remote-lang', 'zh')
          } catch {
            /* opaque origin */
          }
        })
        const page = await context.newPage()
        const requests: string[] = []
        page.on('request', (req) => requests.push(req.url()))
        await page.goto(target)
        await page.getByRole('heading', { name: '登录', exact: true }).waitFor()
        await page.getByLabel('用户名').fill('alice')
        await page.getByLabel('密码').fill(password)
        await page.getByRole('button', { name: '继续' }).click()
        await page.getByRole('heading', { name: '验证第二因素' }).waitFor()
        await page.getByLabel('验证码或备用码').fill(backupCode)
        await page.getByRole('button', { name: '验证并登录' }).click()
        await page.waitForSelector('[class*="frame"]')
        const openSettings = () => openDshSettings(page)
        await openSettings()
        const settings = page.getByRole('dialog', { name: '设置' })
        await expect(settings.getByRole('button', { name: '打开配置文件' })).toBeEnabled()
        await clickThroughDshPrompts(
          page,
          settings.getByRole('button', { name: '安全与登录', exact: true }),
          openSettings,
        )
        await settings.getByRole('heading', { name: '安全与登录' }).waitFor()
        const cookies = await context.cookies()
        assert.deepEqual(
          cookies.map((value) => value.name),
          ['dsh_auth_remote'],
        )
        assert.equal(cookies[0]!.secure, secure)
        const cookie = `dsh_auth_remote=${cookies[0]!.value}`
        const bytes = Buffer.alloc(128 * 1024, 0x61)
        const upload = await nativeHttp(target, '/plugins/strict/echo', {
          method: 'POST',
          cookie,
          body: bytes,
        })
        assert.equal(upload.status, 200, upload.body)
        const result = JSON.parse(upload.body)
        const authority = `${host === '::ffff:127.0.0.1' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host}:${new URL(target).port}`
        assert.equal(result.host, authority)
        assert.equal(result.origin, `${secure ? 'https:' : 'http:'}//${authority}`)
        assert.equal(result.bytes, bytes.length)
        assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'))
        const trusted = await nativeHttp(target, '/plugins/strict/trusted-host', {
          method: 'POST',
          cookie,
        })
        assert.equal(trusted.status, 200, trusted.body)
        const declared = JSON.parse(trusted.body).trustedHosts as string[]
        assert.equal(declared.includes(authority), true)
        assert.equal(declared.includes(new URL(publicOrigin).host), true)
        assert.equal(new Set(declared).size, declared.length)
        assert.equal(result.hasNative, true)
        assert.equal(result.hasPlugin, false)
        const preserved = await nativeHttp(target, '/plugins/public/echo', { cookie })
        assert.equal(preserved.status, 200, preserved.body)
        assert.equal(JSON.parse(preserved.body).origin, publicOrigin)
        const stream = await nativeStream(target, '/plugins/strict/stream', { cookie })
        const socketMessage = await page.evaluate(
          (address) =>
            new Promise<string>((resolve, reject) => {
              const state = window as typeof window & { __nativeSocketClosed?: boolean }
              state.__nativeSocketClosed = false
              const socket = new WebSocket(address)
              const timeout = setTimeout(
                () => reject(new Error('native WebSocket timed out')),
                5000,
              )
              socket.onmessage = (event) => {
                clearTimeout(timeout)
                resolve(String(event.data))
              }
              socket.onclose = () => {
                state.__nativeSocketClosed = true
              }
              socket.onerror = () => reject(new Error('native WebSocket failed'))
            }),
          `${secure ? 'wss' : 'ws'}://${new URL(target).host}/plugins/strict/socket`,
        )
        assert.equal(socketMessage, 'strict-ready')
        const status = JSON.parse(await packedAdmin(f.home, 'status'))
        assert.equal(status.online, true)
        assert.equal(status.ready, true)
        assert.equal(status.totpEnabled, true)
        const refused = await packedCommand(f.home, [
          'plugin',
          '--profile',
          'web',
          'exec',
          'dsh-auth-remote',
          'revoke-sessions',
        ]).done
        assert.notEqual(refused.code, 0, 'mutation must require a TTY and profile confirmation')
        assert.equal((await nativeHttp(target, '/auth-remote/me', { cookie })).status, 200)
        await packedAdmin(f.home, 'revoke-sessions', [
          ['Enter web to confirm revoke-sessions: ', 'web'],
        ])
        await stream.closed
        await page.waitForFunction(
          () =>
            (window as typeof window & { __nativeSocketClosed?: boolean }).__nativeSocketClosed ===
            true,
          undefined,
          { timeout: 5000 },
        )
        assert.equal((await nativeHttp(target, '/plugins/strict/echo', { cookie })).status, 401)
        const state = JSON.parse(
          await readFile(join(f.profile, 'auth-remote/auth-state.json'), 'utf8'),
        )
        assert.deepEqual(state.sessions, {})
        assert.equal(
          requests.some((url) => new URL(url).searchParams.has('token')),
          false,
        )
        const output = server.output()
        assert.equal((output.stdout + output.stderr).includes('?token='), false)
      } finally {
        await browser?.close()
        await server?.stop()
        await f.cleanup()
      }
    },
  )

test(`packed DSH ${dshVersion} rejects an incomplete CLI TLS pair without using the file pair`, async () => {
  const f = await packedProfile({ tlsCert: './native.cert.pem', tlsKey: './native.key.pem' })
  try {
    await copyFile(nativeCertPath, join(f.profile, 'native.cert.pem'))
    await copyFile(nativeKeyPath, join(f.profile, 'native.key.pem'))
    const result = await packedCommand(
      f.home,
      ['web', '--no-open', '--port', '13135', '--tls-cert', nativeCertPath],
      f.cwd,
    ).done
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /tls-key|supplied together|required|requires/u)
    await assert.rejects(nativeHttp('http://127.0.0.1:13135/', '/auth-remote/ready'))
    await assert.rejects(nativeHttp('https://127.0.0.1:13135/', '/auth-remote/ready'))
  } finally {
    await f.cleanup()
  }
})
for (const kind of ['missing', 'mismatch'] as const)
  test(`packed DSH ${dshVersion} CLI ${kind} TLS material leaves no listener, admin socket or storage lock`, async () => {
    const f = await packedProfile({ tlsCert: nativeCertPath, tlsKey: nativeKeyPath })
    try {
      const cert = kind === 'missing' ? './missing.pem' : nativeCertPath
      const key = kind === 'mismatch' ? join(f.cwd, 'wrong-key.pem') : nativeKeyPath
      if (kind === 'mismatch')
        await copyFile(new URL('../fixtures/tls/native.mismatch.key.pem', import.meta.url), key)
      const result = await packedCommand(
        f.home,
        ['web', '--no-open', '--port', '13135', '--tls-cert', cert, '--tls-key', key],
        f.cwd,
      ).done
      assert.notEqual(result.code, 0)
      await assert.rejects(nativeHttp('http://127.0.0.1:13135/', '/auth-remote/ready'))
      await assert.rejects(nativeHttp('https://127.0.0.1:13135/', '/auth-remote/ready'))
      await assert.rejects(access(join(f.profile, 'auth-remote/admin.sock')))
      const store = await AuthStateStore.open(f.profile)
      await store.close()
    } finally {
      await f.cleanup()
    }
  })
