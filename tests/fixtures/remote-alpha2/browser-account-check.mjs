import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { expect } from '@playwright/test'
import { requestAdmin } from '../../../src/cli/ipc-client.ts'
import { nativeHttp } from '../../helpers/native-http.ts'
import { clickThroughDshPrompts, launchBrowser } from '../../helpers/runtime.ts'

const accountPath = '/auth-remote/account'

function requestAccount(page, action, body) {
  return page.evaluate(
    async ({ path, body }) => {
      const response = await fetch(
        path,
        body === undefined
          ? undefined
          : {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            },
      )
      return { status: response.status, body: await response.json() }
    },
    { path: `${accountPath}/${action}`, body },
  )
}

async function login(page, base, password) {
  await page.goto(base, { waitUntil: 'domcontentloaded' })
  await page.locator('#username').fill('owner')
  await page.locator('#password').fill(password)
  await page.locator('#login-form button[type=submit]').click()
  await page.locator('#skip-binding').click()
  await page.waitForURL((url) => url.pathname === '/')
}

async function accountMenu(page) {
  const menu = page.getByRole('button', { name: '账号菜单', exact: true })
  await clickThroughDshPrompts(page, menu)
  await page.getByRole('menuitem', { name: '登录', exact: true }).click()
}

export async function checkBrowserAccount({
  base,
  address,
  adminPath,
  password,
  platform,
  patchFile,
  native,
  setPhase,
}) {
  const publicUrl = new URL(base)
  const browser = await launchBrowser([
    '--no-proxy-server',
    `--host-resolver-rules=MAP ${publicUrl.hostname} 127.0.0.1`,
  ])
  try {
    const context = await browser.newContext({ locale: 'zh-CN' })
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url())
      return [base, platform.origin].includes(url.origin) ? route.continue() : route.abort()
    })
    const page = await context.newPage()
    await requestAdmin(adminPath, { version: 1, command: 'init', username: 'owner', password })
    await login(page, base, password)

    if (native) {
      setPhase('disabled manual preference preserves the native browser callback')
      assert.equal((await requestAccount(page, 'state')).body.enabled, false)
      const opened = context.waitForEvent('page')
      await accountMenu(page)
      const popup = await opened
      await expect(popup.getByRole('button', { name: 'Authorize test account' })).toBeVisible()
      assert.equal(new URL(platform.attempts[0].redirect_uri).origin, base)
      assert.equal((await requestAccount(page, 'state')).body.attempt, null)
      const raw = new URL(platform.callback())
      const noSession = await nativeHttp(address, raw.pathname + raw.search, {
        origin: null,
        headers: {
          'sec-fetch-site': 'cross-site',
          'sec-fetch-mode': 'navigate',
          'sec-fetch-dest': 'document',
        },
      })
      assert.equal(noSession.status, 401)
      assert.equal(noSession.headers.location, undefined)
      assert.equal(platform.exchanges.length, 0)
      const received = popup.waitForResponse(
        (response) => new URL(response.url()).pathname === '/oauth/callback',
      )
      await popup.getByRole('button', { name: 'Authorize test account' }).click()
      const code = (await received).status()
      if (![200, 204, 302, 303].includes(code))
        throw Object.assign(new Error('Native callback was refused'), {
          code: `NATIVE_HTTP_${code}`,
        })
      await expect.poll(() => platform.exchanges.length).toBe(1)
      await expect(page.getByText('Manual Test Account', { exact: true })).toBeVisible()
      return
    }

    const start = async () => {
      const started = await requestAccount(page, 'start', {
        locale: 'zh-CN',
        timezoneOffsetSeconds: 28800,
      })
      assert.equal(started.status, 200)
      const id = started.body.attempt.id
      await expect
        .poll(async () => (await requestAccount(page, 'state')).body.attempt?.phase)
        .toBe('waiting-browser')
      return { id, callbackUrl: platform.callback() }
    }
    const cancel = (attempt) => requestAccount(page, 'cancel', { id: attempt.id })
    const submit = (attempt) => requestAccount(page, 'submit', attempt)

    setPhase('manual callback expiry and explicit cancellation retain native lifecycle')
    platform.expiresIn(1)
    const expired = await start()
    await expect
      .poll(async () => (await requestAccount(page, 'state')).body.attempt?.phase)
      .toMatch(/^(?:expired|cancelled)$/u)
    assert.equal((await submit(expired)).status, 410)
    platform.expiresIn(600)
    const cancelled = await start()
    assert.equal((await cancel(cancelled)).status, 200)
    assert.equal((await submit(cancelled)).status, 410)

    setPhase('provider HMR withdraws the callback for the previous attempt')
    const stale = await start()
    const patch = await readFile(patchFile, 'utf8')
    await writeFile(patchFile, patch.replace('attemptTimeoutMs: 40000', 'attemptTimeoutMs: 45000'))
    await expect.poll(async () => (await requestAccount(page, 'state')).body.attempt).toBeNull()
    assert([409, 410].includes((await submit(stale)).status))

    setPhase('session revocation retires the manual callback before a new login')
    const revoked = await start()
    const revokedId = platform.attempts.at(-1).id
    const existingCookie = (await context.cookies(base)).find(
      ({ name }) => name === 'dsh_auth_remote',
    )
    await requestAdmin(adminPath, { version: 1, command: 'revoke-sessions' })
    const rejected = await nativeHttp(address, accountPath + '/submit', {
      method: 'POST',
      origin: base,
      host: publicUrl.host,
      cookie: `${existingCookie.name}=${existingCookie.value}`,
      body: JSON.stringify(revoked),
    })
    assert.equal(rejected.status, 401)
    await expect.poll(() => platform.cancellations.includes(revokedId)).toBe(true)
    await login(page, base, password)

    setPhase('browser validates the loopback address and native OAuth state before PKCE exchange')
    await accountMenu(page)
    const dialog = page.getByRole('dialog', { name: '登录 DeepSeek 账号', exact: true })
    const opened = context.waitForEvent('page')
    await dialog.getByRole('button', { name: '打开登录页', exact: true }).click()
    const popup = await opened
    await expect(popup.getByRole('button', { name: 'Authorize test account' })).toBeVisible()
    const field = dialog.getByLabel('完整回调地址')
    await expect(field).toBeEnabled()
    const callback = popup.waitForRequest(
      (request) => new URL(request.url()).pathname === '/oauth/callback',
    )
    await popup.getByRole('button', { name: 'Authorize test account' }).click()
    const addressToPaste = (await callback).url()
    assert(addressToPaste === platform.callback())
    const expected = new URL(addressToPaste)
    const rawSession = (await context.cookies(base)).find(({ name }) => name === 'dsh_auth_remote')
    const direct = await nativeHttp(address, expected.pathname + expected.search, {
      host: expected.host,
      origin: null,
      cookie: `${rawSession.name}=${rawSession.value}`,
    })
    assert.equal(direct.status, 403)
    const submitButton = dialog.getByRole('button', { name: '确认登录' })
    const id = (await requestAccount(page, 'state')).body.attempt.id
    const otherSession = await nativeHttp(address, '/auth-remote/login', {
      method: 'POST',
      origin: base,
      host: publicUrl.host,
      body: JSON.stringify({ username: 'owner', password }),
    })
    assert.equal(otherSession.status, 200)
    const otherCookie = otherSession.headers['set-cookie']?.[0]?.split(';', 1)[0]
    assert(otherCookie)
    assert.equal(
      (
        await nativeHttp(address, accountPath + '/submit', {
          method: 'POST',
          origin: base,
          host: publicUrl.host,
          cookie: otherCookie,
          body: JSON.stringify({ id, callbackUrl: addressToPaste }),
        })
      ).status,
      409,
    )
    const wrongOrigin = new URL(expected)
    wrongOrigin.hostname = 'localhost'
    assert.equal((await submit({ id, callbackUrl: wrongOrigin.href })).status, 400)
    const wrongState = new URL(expected)
    wrongState.searchParams.set('state', 'incorrect-value')
    await field.fill(wrongState.href)
    await submitButton.click()
    await expect(dialog.getByRole('alert')).toContainText('回调地址与当前授权不匹配')
    assert.equal(platform.exchanges.length, 0)
    await field.fill(addressToPaste)
    await submitButton.click()
    await expect(dialog).not.toBeVisible()
    await expect(page.getByText('Manual Test Account', { exact: true })).toBeVisible()
    assert.equal(platform.exchanges.length, 1)
    assert.equal((await submit({ id, callbackUrl: addressToPaste })).status, 409)
    assert.equal(platform.exchanges.length, 1)

    setPhase('native settings.notice renders one account notice after plugin sign-in')
    await expect(page.getByText(platform.notification.title, { exact: true })).toBeVisible()
    await expect
      .poll(() => platform.notificationEvents.filter(({ type }) => type === 'displayed').length)
      .toBe(1)
    await expect(page.getByText(platform.notification.title, { exact: true })).toHaveCount(1)
  } finally {
    await browser.close()
  }
}
