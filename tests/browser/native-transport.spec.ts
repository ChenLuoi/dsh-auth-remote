import assert from 'node:assert/strict'
import { createHash, X509Certificate } from 'node:crypto'
import { access, copyFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { networkInterfaces } from 'node:os'
import { test } from 'node:test'
import { expect } from '@playwright/test'
import { checkDshVersion, dshVersion } from '../../scripts/runtime.mjs'
import { totpCode } from '../../src/auth/totp.js'
import { AuthStateStore } from '../../src/storage/store.js'
import { getRuntimeCapabilities } from '../../src/adapters/dsh/runtime-capabilities.js'
import {
  nativeCertificate,
  nativeCertPath,
  nativeKeyPath,
  nativeHttp,
  nativeStream,
  type NativeRequestOptions,
} from '../helpers/native-http.js'
import { packedAdmin, packedCommand, packedProfile } from '../helpers/packed-runtime.js'
import { clickThroughDshPrompts, dsh, launchBrowser } from '../helpers/runtime.js'

const password = 'native packed browser password 123'
const pin = createHash('sha256')
  .update(new X509Certificate(nativeCertificate).publicKey.export({ type: 'spki', format: 'der' }))
  .digest('base64')
const nativeTransport = getRuntimeCapabilities(dshVersion).nativeTransport

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
          ['用户名: ', 'alice'],
          ['密码: ', password],
          ['再次输入密码: ', password],
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
        const nativeAuthority = `${nativeTransport ? bindHost : '127.0.0.1'}:${port}`
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

if (nativeTransport) {
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
            ['用户名: ', 'alice'],
            ['密码: ', password],
            ['再次输入密码: ', password],
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
              localStorage.setItem('dsh-auth-remote.locale', 'zh')
            } catch {
              /* opaque origin */
            }
          })
          const page = await context.newPage()
          const requests: string[] = []
          page.on('request', (req) => requests.push(req.url()))
          await page.goto(target)
          await page.getByRole('heading', { name: '登录 DSH' }).waitFor()
          await page.getByLabel('用户名').fill('alice')
          await page.getByLabel('密码').fill(password)
          await page.getByRole('button', { name: '继续' }).click()
          await page.getByRole('heading', { name: '验证第二因素' }).waitFor()
          await page.getByLabel('验证码或备用码').fill(backupCode)
          await page.getByRole('button', { name: '验证并登录' }).click()
          await page.waitForSelector('[class*="frame"]')
          const openSettings = page.getByRole('button', { name: '设置', exact: true })
          await clickThroughDshPrompts(page, openSettings)
          const settings = page.getByRole('dialog', { name: '设置' })
          await expect(settings.getByRole('button', { name: '打开配置文件' })).toBeEnabled()
          await clickThroughDshPrompts(
            page,
            settings.getByRole('button', { name: '安全', exact: true }),
            openSettings,
          )
          await settings.getByRole('heading', { name: '账号安全' }).waitFor()
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
            ['输入 web 以确认 revoke-sessions: ', 'web'],
          ])
          await stream.closed
          await page.waitForFunction(
            () =>
              (window as typeof window & { __nativeSocketClosed?: boolean })
                .__nativeSocketClosed === true,
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
} else {
  test(
    `packed DSH ${dshVersion} keeps concrete non-loopback IPv4 usable through the legacy bridge`,
    { timeout: 30_000 },
    async () => {
      const host = Object.values(networkInterfaces())
        .flat()
        .find((value) => value?.family === 'IPv4' && !value.internal)?.address
      assert.ok(host, 'concrete non-loopback IPv4 is required')
      const f = await packedProfile({ host, port: 13138, requireTotp: false }, true)
      let server: ReturnType<typeof packedCommand> | undefined
      try {
        await packedAdmin(f.home, 'init', [
          ['用户名: ', 'alice'],
          ['密码: ', password],
          ['再次输入密码: ', password],
        ])
        server = packedCommand(f.home, ['web', '--no-open'], f.cwd)
        const target = await waitReady(server, () => `http://${host}:13138/`)
        assert.equal((await nativeHttp(target, '/api/settings')).status, 401)
        const login = await nativeHttp(target, '/auth-remote/login', {
          method: 'POST',
          body: JSON.stringify({ username: 'alice', password }),
        })
        assert.equal(login.status, 200)
        assert.equal(JSON.parse(login.body).kind, 'session')
        const cookie = login.headers['set-cookie']![0]!.split(';')[0]!
        const echo = await nativeHttp(target, '/plugins/strict/echo', { cookie })
        assert.equal(echo.status, 200, echo.body)
        assert.equal(JSON.parse(echo.body).host, '127.0.0.1:13138')
        assert.equal(JSON.parse(echo.body).origin, 'http://127.0.0.1:13138')
        const settings = await nativeHttp(target, '/api/settings/describe', {
          method: 'POST',
          cookie,
          body: JSON.stringify({
            type: 'client-request',
            rpcId: 'legacy-bind',
            method: 'settings/describe',
            payload: { args: {} },
          }),
        })
        assert.equal(settings.status, 200, settings.body)
        assert.equal(JSON.parse(settings.body).result.ok, true)
      } finally {
        await server?.stop()
        await f.cleanup()
      }
    },
  )
  for (const config of [{ host: '::1' }, { tlsCert: nativeCertPath, tlsKey: nativeKeyPath }])
    test(`packed DSH ${dshVersion} rejects unsupported ${'host' in config ? 'IPv6' : 'TLS'} before listening`, async () => {
      const f = await packedProfile(config)
      try {
        const result = await packedCommand(f.home, ['web', '--no-open', '--port', '13135'], f.cwd)
          .done
        assert.notEqual(result.code, 0)
        assert.match(result.stderr, /IPv4|IPv6|TLS.*support|support.*TLS/u)
        await assert.rejects(nativeHttp('http://127.0.0.1:13135/', '/auth-remote/ready'))
        await assert.rejects(nativeHttp('https://127.0.0.1:13135/', '/auth-remote/ready'))
      } finally {
        await f.cleanup()
      }
    })
  test(`DSH ${dshVersion} keeps native TLS CLI unavailable`, async () => {
    const f = await packedProfile({})
    try {
      const result = await packedCommand(f.home, [
        'web',
        '--no-open',
        '--tls-cert',
        nativeCertPath,
        '--tls-key',
        nativeKeyPath,
      ]).done
      assert.notEqual(result.code, 0)
      assert.match(result.stderr, /unknown option.*--tls-cert/u)
    } finally {
      await f.cleanup()
    }
  })
}
