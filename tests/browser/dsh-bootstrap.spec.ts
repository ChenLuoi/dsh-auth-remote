import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'
import { dshVersion } from '../../scripts/runtime.mjs'
import { nativeHttp, nativeMux } from '../helpers/native-http.js'
import { packedCommand } from '../helpers/packed-runtime.js'
import {
  archive,
  completeApiKeyPrompt,
  dsh as dshBin,
  launchBrowser,
  isolatedDshEnv,
  localModelEndpoint,
  openDshSettings,
} from '../helpers/runtime.js'

const publicHost = 'auth-remote.test:13090'
const provider = dshVersion === '0.2.3-alpha.2'

test('target DSH boots at a non-loopback browser origin with Host settings access', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-auth-remote-browser-'))
  const model = await localModelEndpoint()
  const patchPath = join(home, 'adapter.patch.yml')
  const adapterPath = fileURLToPath(
    new URL('../fixtures/browser-adapter/index.mjs', import.meta.url),
  )
  await writeFile(
    patchPath,
    model.patch.join('\n') +
      '\n' +
      `- insert:\n    - id: auth-client-probe\n      name: ${adapterPath}\n`,
  )
  const args = [
    '--profile',
    'web',
    '--patch',
    patchPath,
    '--no-open',
    '--port',
    '13090',
    '--trusted-host',
    publicHost,
    ...(provider ? ['--public-url', `http://${publicHost}`] : []),
  ]
  const child = spawn(dshBin, args, {
    cwd: home,
    env: isolatedDshEnv(home),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    const nativeUrl = await new Promise<URL>((resolve, reject) => {
      let output = ''
      const timeout = setTimeout(() => {
        reject(new Error('DSH start timed out'))
      }, 30_000)
      child.once('error', reject)
      child.once('exit', (code) => {
        reject(new Error(`DSH exited before listening: ${String(code)}`))
      })
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8')
        const match = /dsh web: (http:\/\/[^\s]+)/u.exec(output)
        if (match?.[1] === undefined) return
        clearTimeout(timeout)
        resolve(new URL(match[1]))
      })
    })
    nativeUrl.host = publicHost
    browser = await launchBrowser([
      '--no-proxy-server',
      '--host-resolver-rules=MAP auth-remote.test 127.0.0.1',
    ])
    const page = await browser.newPage({ locale: 'zh-CN' })
    const pageErrors: string[] = []
    page.on('pageerror', (error) => {
      pageErrors.push(error.message)
    })
    assert(
      await page.goto(nativeUrl.href, { waitUntil: 'load', timeout: 30_000 }).catch(() => null),
      'native startup link could not open',
    )
    try {
      await page.waitForSelector('[class*="frame"]', { timeout: 10_000 })
    } catch {
      throw new Error(
        `DSH browser boot failed: ${JSON.stringify({ pageErrors, body: (await page.locator('body').innerText()).slice(0, 500) })}`,
      )
    }
    const notice = page.getByRole('dialog', { name: /^(?:内测声明|预览版说明)$/u })
    await notice.waitFor({ state: 'visible' })
    await notice.getByRole('button', { name: '继续' }).click()
    await notice.waitFor({ state: 'hidden' })
    await completeApiKeyPrompt(page, 5000)
    await page.waitForSelector('[class*="frame"]')
    await openDshSettings(page)
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.waitFor()
    assert.equal(await dialog.getByRole('button', { name: '模型', exact: true }).count(), 1)
    const openDocument = dialog.getByRole('button', { name: '打开配置文件' })
    await openDocument.waitFor()
    assert.equal(await openDocument.isEnabled(), true)
    await dialog.getByRole('button', { name: '模型', exact: true }).click()
    if (provider)
      await expect(
        dialog.getByRole('button', { name: '添加模型提供商', exact: true }),
      ).toBeEnabled()
    else await dialog.getByText('DeepSeek', { exact: true }).waitFor()
    await dialog.getByRole('button', { name: '通用设置' }).click()
    await dialog.getByRole('button', { name: '中文', exact: true }).click()
    const mutate = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/settings/mutate',
    )
    await page.getByRole('menuitem', { name: 'English' }).click()
    const result = await mutate
    assert.equal(result.status(), 200)
    assert.equal((await result.json()).result.ok, true)
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]')
    await openDshSettings(page, 'en')
    assert.equal(
      await page
        .getByRole('dialog', { name: 'Settings' })
        .getByText('Language', { exact: true })
        .count(),
      1,
    )
    if (provider) {
      const native = await page.evaluate(async (rpcId) => {
        const method = 'remoteConnection/create'
        const response = await fetch('/api/' + method, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: {} } }),
        })
        return (await response.json()).result
      }, randomUUID())
      assert(native.ok, 'native installation could not issue a device invitation')
      const origin = `http://${publicHost}`
      const address = 'http://127.0.0.1:13090'
      const headers = { origin, host: publicHost }
      const exchanged = await nativeHttp(address, '/?login=qr', {
        ...headers,
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: new URL(native.value.url).hash.slice(1),
      })
      assert.equal(exchanged.status, 204)
      const nativeCookie = exchanged.headers['set-cookie']?.[0]?.split(';', 1)[0]
      assert(nativeCookie?.startsWith('dsh-remote-'))
      assert.equal(
        (await nativeHttp(address, '/index.html', { ...headers, cookie: nativeCookie })).status,
        200,
      )
      assert(nativeUrl.searchParams.has('token'), 'expected the stock startup credential')

      const exited = once(child, 'exit')
      child.kill('SIGTERM')
      await exited
      const installed = await packedCommand(home, ['plugin', '--profile', 'web', 'add', archive])
        .done
      assert.equal(installed.code, 0, 'protected plugin install failed')
      await writeFile(
        join(home, 'profiles/web/cordis.patch.yml'),
        [...model.patch, '- id: auth-remote', '  config:', `    publicUrl: ${origin}`, ''].join(
          '\n',
        ),
      )
      const protectedHost = packedCommand(home, ['web', '--no-open', '--port', '13090'])
      try {
        await expect
          .poll(
            () =>
              nativeHttp(address, '/auth-remote/ready', headers).then(
                (r) => r.status,
                () => 0,
              ),
            { timeout: 25000 },
          )
          .toBe(200)
        assert.equal(
          (await nativeHttp(address, '/index.html', { ...headers, cookie: nativeCookie })).status,
          401,
        )
        assert.equal((await nativeMux(address, { ...headers, cookie: nativeCookie })).status, 401)
        const startup = await nativeHttp(address, '/' + nativeUrl.search, headers)
        assert.equal(startup.status, 401)
        assert.equal(startup.headers['set-cookie'], undefined)
        assert.equal(
          (await nativeHttp(address, '/connect', { ...headers, method: 'POST', body: '{}' }))
            .status,
          403,
        )
        assert(!/[?&]token=/u.test(protectedHost.output().combined))
      } finally {
        await protectedHost.stop()
      }
    }
  } finally {
    await browser?.close()
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await once(child, 'exit').catch(() => {})
    }
    await model.close()
    await rm(home, { recursive: true, force: true })
  }
})
