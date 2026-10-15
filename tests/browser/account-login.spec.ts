import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { expect } from '@playwright/test'
import { AuthService } from '../../src/auth/service.js'
import { AuthStateStore } from '../../src/storage/store.js'
import { AUTH_COOKIE } from '../../src/shared/auth-contract.js'
import {
  archive,
  clickThroughDshPrompts,
  dsh,
  launchBrowser,
  openDshSettings,
  project,
  selectDshTheme,
} from '../helpers/runtime.js'
import { dshVersion } from '../../scripts/runtime.mjs'
import { accountPlatform } from '../helpers/account-platform.js'

const hasAccount = dshVersion === '0.2.1-alpha.3'

async function fixture({ keepOnboarding = false } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'auth-remote-manual-browser-'))
  const platform = await accountPlatform()
  const portProbe = createServer().listen(0, '127.0.0.1')
  await once(portProbe, 'listening')
  const address = portProbe.address()
  assert.ok(address && typeof address !== 'string')
  const port = address.port
  await new Promise<void>((resolve) => portProbe.close(() => resolve()))
  const origin = `http://account-remote.test:${port}`
  const env: NodeJS.ProcessEnv = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }
  delete env.DEEPSEEK_API_KEY
  let child: ReturnType<typeof spawn> | undefined
  let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined
  let output = ''
  try {
    await promisify(execFile)(dsh, ['plugin', '--profile', 'web', 'add', archive], {
      cwd: home,
      env,
    })
    const profile = join(home, 'profiles/web')
    assert.equal(
      (await stat(join(profile, 'node_modules/dsh-auth-remote/dist/client.js'))).nlink,
      1,
    )
    await writeFile(
      join(profile, 'cordis.patch.yml'),
      [
        '- id: webserver',
        '  disabled: true',
        '- id: auth-remote',
        '  config:',
        `    publicUrl: ${origin}`,
        '    requireTotp: false',
        ...(hasAccount
          ? [
              '- id: deepseek-account',
              '  config:',
              `    platformOrigin: ${platform.origin}`,
              '    allowLoopbackHttp: true',
            ]
          : []),
        '',
      ].join('\n'),
    )
    const store = await AuthStateStore.open(profile)
    const auth = new AuthService(store, { requireTotp: false, sessionHours: 168 })
    let token: string
    try {
      await auth.initialize('alice', 'manual browser password 123')
      const login = await auth.login('alice', 'manual browser password 123')
      if (login.kind !== 'session') throw new Error('Expected full session')
      token = login.token
    } finally {
      auth.dispose()
      await store.close()
    }
    child = spawn(dsh, ['web', '--no-open', '--port', String(port)], {
      cwd: home,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout!.on('data', (chunk) => {
      output += String(chunk)
    })
    child.stderr!.on('data', (chunk) => {
      output += String(chunk)
    })
    let ready = false
    for (let i = 0; i < 200; i++) {
      if (child.exitCode !== null) throw new Error(`DSH exited: ${output.slice(-3000)}`)
      try {
        const response = await fetch(`http://127.0.0.1:${port}/auth-remote/ready`, {
          headers: { host: `account-remote.test:${port}` },
        })
        if (response.ok) {
          ready = true
          break
        }
      } catch {
        /* Listener is starting. */
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.ok(ready, output.slice(-3000))
    browser = await launchBrowser([
      '--no-proxy-server',
      '--host-resolver-rules=MAP account-remote.test 127.0.0.1',
    ])
    const context = await browser.newContext({ locale: 'zh-CN' })
    await context.addCookies([{ name: AUTH_COOKIE, value: token!, url: origin }])
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(origin, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]')
    const notice = page.getByRole('dialog', { name: /^(?:内测声明|预览版说明)$/u })
    if (keepOnboarding) await notice.waitFor()
    if (await notice.isVisible()) await notice.getByRole('button', { name: '继续' }).click()
    // Dismiss first-run onboarding without ever initiating Platform authorization.
    const manual = page.getByRole('dialog', { name: '登录 DeepSeek 官方账号', exact: true })
    if (hasAccount && !keepOnboarding) {
      await manual.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
      if (await manual.isVisible())
        await manual.getByRole('button', { name: '关闭', exact: true }).click()
    }
    return {
      page,
      context,
      platform,
      origin,
      errors,
      async open(locale: 'zh' | 'en' = 'zh') {
        const menu = page.getByRole('button', {
          name: locale === 'zh' ? '账号菜单' : 'Account menu',
          exact: true,
        })
        await clickThroughDshPrompts(page, menu)
        await page
          .getByRole('menuitem', { name: locale === 'zh' ? '登录' : 'Sign in', exact: true })
          .click()
        const dialog = page.getByRole('dialog', {
          name: locale === 'zh' ? '登录 DeepSeek 官方账号' : 'Sign in to your DeepSeek account',
          exact: true,
        })
        await dialog.waitFor()
        return dialog
      },
      async close() {
        await browser?.close()
        if (child && child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM')
          await once(child, 'exit')
        }
        await platform.close()
        await rm(home, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await browser?.close()
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await once(child, 'exit')
    }
    await platform.close()
    await rm(home, { recursive: true, force: true })
    throw error
  }
}

if (hasAccount) {
  test(
    'credential-free onboarding preserves native API-key setup without starting account authorization',
    { timeout: 90000 },
    async () => {
      const f = await fixture({ keepOnboarding: true })
      try {
        const dialog = f.page.getByRole('dialog', { name: '登录 DeepSeek 官方账号', exact: true })
        await expect(dialog).toBeVisible()
        await dialog
          .getByRole('button', { name: '使用 API Key', exact: true })
          .click({ timeout: 5000 })
        await expect(dialog).not.toBeVisible()
        const editor = f.page.getByRole('dialog', {
          name: '添加一个 API Key 开始使用',
          exact: true,
        })
        await expect(editor).toBeVisible()
        await expect(editor.getByRole('button', { name: '保存并继续' })).toBeDisabled()
        assert.equal(f.platform.attempts.length, 0)
        assert.equal(f.context.pages().length, 1)
        await editor
          .getByRole('textbox', { name: 'API 密钥', exact: true })
          .fill('onboarding-test-key')
        const saved = f.page.waitForResponse(
          (response) => new URL(response.url()).pathname === '/api/credentials/set',
        )
        await editor.getByRole('button', { name: '保存并继续' }).click()
        const response = await saved
        assert.equal(response.status(), 200)
        assert.equal((await response.json()).result.ok, true)
        await expect(editor).not.toBeVisible()
        // The account menu must reopen the native editor even after a provider is configured.
        await f.open()
        await dialog.getByRole('button', { name: '使用 API Key', exact: true }).click()
        await expect(dialog).not.toBeVisible()
        await expect(editor).toBeVisible()
        await editor.getByRole('button', { name: '稍后配置', exact: true }).click()
        await expect(editor).not.toBeVisible()
        assert.equal(f.platform.attempts.length, 0)
        assert.deepEqual(f.errors, [])
      } finally {
        await f.close()
      }
    },
  )

  test(
    'account menu opens instructions first and a pasted failed-navigation URL completes native sign-in',
    { timeout: 90000 },
    async () => {
      const f = await fixture()
      try {
        const dialog = await f.open()
        await expect(dialog.getByLabel('完整回调地址')).toBeDisabled()
        assert.equal(f.platform.attempts.length, 0)
        assert.equal(f.context.pages().length, 1)
        const screenshotDir = join(project, '.cache/ui-review', dshVersion)
        await mkdir(screenshotDir, { recursive: true })
        await f.page.screenshot({ path: join(screenshotDir, 'account-login-light-desktop.png') })
        const opened = f.context.waitForEvent('page')
        await dialog.getByRole('button', { name: '打开 DeepSeek 登录页' }).click()
        const popup = await opened
        await popup.getByRole('button', { name: 'Authorize test account' }).waitFor()
        await expect(dialog.getByLabel('完整回调地址')).toBeEnabled()
        await expect(dialog.getByRole('button', { name: '使用 API Key', exact: true })).toHaveCount(
          0,
        )
        await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeEnabled()
        // Changing sidebar layout must not unmount/cancel pending authorization.
        await f.page.setViewportSize({ width: 390, height: 844 })
        await expect(dialog.getByLabel('完整回调地址')).toBeEnabled()
        await f.page.setViewportSize({ width: 1280, height: 900 })
        const callback = popup.waitForRequest(
          (request) => new URL(request.url()).pathname === '/oauth/callback',
        )
        await popup.getByRole('button', { name: 'Authorize test account' }).click()
        const address = (await callback).url()
        assert.equal(address, f.platform.callback())
        await dialog
          .getByLabel('完整回调地址')
          .fill(address.replace(new URL(address).searchParams.get('state')!, 'wrong-state'))
        await dialog.getByRole('button', { name: '确认登录' }).click()
        await expect(dialog.getByRole('alert')).toContainText('回调地址与当前授权不匹配')
        assert.equal(f.platform.exchanges.length, 0)
        await dialog.getByLabel('完整回调地址').fill(address)
        const submit = f.page.waitForResponse(
          (response) => new URL(response.url()).pathname === '/auth-remote/account/submit',
        )
        await dialog.getByRole('button', { name: '确认登录' }).click()
        assert.equal((await submit).status(), 200)
        await expect(dialog).not.toBeVisible()
        await expect(f.page.getByText('Manual Test Account', { exact: true })).toBeVisible()
        assert.equal(f.platform.exchanges.length, 1)
        assert.deepEqual(f.errors, [])
        assert.equal(
          (
            await f.page.evaluate(() =>
              JSON.stringify({ local: localStorage, session: sessionStorage }),
            )
          ).includes('dsh_mock_manual_account'),
          false,
        )
      } catch (error) {
        console.error(
          'Manual account browser diagnostics:',
          JSON.stringify({
            url: f.page.url(),
            body: (await f.page.locator('body').innerText()).slice(-5000),
            state: await f.page
              .evaluate(async () => (await fetch('/auth-remote/account/state')).json())
              .catch(() => null),
            errors: f.errors,
            exchanges: f.platform.exchanges.length,
          }),
        )
        throw error
      } finally {
        await f.close()
      }
    },
  )

  test(
    'manual sign-in supports blocked popups, cancellation, expiry, live language and narrow dark layout',
    { timeout: 90000 },
    async () => {
      const f = await fixture()
      try {
        let dialog = await f.open()
        await f.page.evaluate(() => {
          window.open = () => null
        })
        await dialog.getByRole('button', { name: '打开 DeepSeek 登录页' }).click()
        await expect(dialog.getByText('新标签页被浏览器拦截。')).toBeVisible()
        await expect(dialog.getByRole('link', { name: '重新打开授权页' })).toBeVisible()
        const cancel = f.page.waitForResponse(
          (response) => new URL(response.url()).pathname === '/auth-remote/account/cancel',
        )
        await dialog.getByRole('button', { name: '取消', exact: true }).click()
        assert.equal((await cancel).status(), 200)
        await expect(dialog).not.toBeVisible()
        assert.equal(f.platform.exchanges.length, 0)
        await openDshSettings(f.page)
        const settings = f.page.getByRole('dialog', { name: '设置', exact: true })
        await settings.getByRole('button', { name: '通用设置', exact: true }).click()
        await selectDshTheme(f.page, 'dark')
        await settings.getByRole('button', { name: '中文', exact: true }).click()
        await f.page.getByRole('menuitem', { name: 'English', exact: true }).click()
        await f.page
          .getByRole('dialog', { name: 'Settings', exact: true })
          .getByRole('button', { name: 'Close', exact: true })
          .click()
        dialog = await f.open('en')
        await expect(dialog.getByLabel('Full callback address')).toBeVisible()
        await expect(dialog.getByRole('button', { name: 'Use API key', exact: true })).toBeVisible()
        await f.page.setViewportSize({ width: 390, height: 844 })
        await f.page.screenshot({
          path: join(project, '.cache/ui-review', dshVersion, 'account-login-dark-mobile.png'),
        })
        const dimensions = await dialog.evaluate((node) => ({
          width: node.scrollWidth,
          client: node.clientWidth,
        }))
        assert.ok(dimensions.width <= dimensions.client + 1)
        f.platform.expiresIn(0.15)
        await dialog
          .getByRole('button', { name: /^(?:Start again|Open DeepSeek sign-in)$/u })
          .click()
        await expect(dialog.getByRole('alert')).toContainText('expired', { timeout: 5000 })
        await expect(dialog.getByRole('button', { name: 'Start again', exact: true })).toBeEnabled()
        assert.equal(f.platform.exchanges.length, 0)
        assert.deepEqual(f.errors, [])
      } finally {
        await f.close()
      }
    },
  )
} else {
  test(
    'older DSH retains its settings UI and reports official-account sign-in as unavailable',
    { timeout: 90000 },
    async () => {
      const f = await fixture()
      try {
        const state = await f.page.evaluate(async () =>
          (await fetch('/auth-remote/account/state')).json(),
        )
        assert.equal(state.supported, false)
        await openDshSettings(f.page)
        await expect(f.page.getByRole('dialog', { name: '设置', exact: true })).toBeVisible()
        assert.equal(f.platform.attempts.length, 0)
        assert.deepEqual(f.errors, [])
      } finally {
        await f.close()
      }
    },
  )
}
