import assert from 'node:assert/strict'
import { expect } from '@playwright/test'
import { requestAdmin } from '../../../src/cli/ipc-client.ts'
import { totpCode, TOTP_PERIOD_MS } from '../../../src/auth/totp.ts'
import { nativeHttp } from '../../helpers/native-http.ts'
import { clickThroughDshPrompts, launchBrowser, openDshSettings } from '../../helpers/runtime.ts'

const day = 86_400_000
const qrAction = /^(?:Create QR code|生成二维码|Regenerate|重新生成)$/iu
const qrImage = /^(?:One-time login QR code|一次性登录二维码)$/iu
const approveAction = /^(?:Approve|批准)$/iu

const nativeRemote = async (page) => {
  const menu = page.getByRole('button', { name: /^(?:Account menu|账号菜单)$/iu })
  const sidebar = page.locator('[data-sidebar-opener]:visible')
  await menu.or(sidebar).first().waitFor()
  if (!(await menu.isVisible())) await clickThroughDshPrompts(page, sidebar)
  await openDshSettings(
    page,
    (await menu.getAttribute('aria-label')) === 'Account menu' ? 'en' : 'zh',
  )
  await page.getByRole('button', { name: /^(?:Remote connection|远程连接)$/iu }).click()
}

function checkAccess(page) {
  return page.evaluate(async () => {
    const response = await fetch('/auth-remote/delegation')
    return { status: response.status, value: await response.json() }
  })
}

async function primaryLogin(page, password, factor) {
  await page.locator('#username').fill('owner')
  await page.locator('#password').fill(password)
  await page.locator('#login-form button[type=submit]').click()
  if (factor) {
    await page.locator('#mfa-code').fill(factor)
    await page.locator('#mfa-form button[type=submit]').click()
  } else {
    await page.locator('#skip-binding').click()
  }
  await page.waitForURL((url) => url.pathname === '/')
}

async function post(page, endpoint, value) {
  return page.evaluate(
    async ({ endpoint, value }) => {
      const response = await fetch('/auth-remote/' + endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(value),
      })
      return { status: response.status, value: await response.json() }
    },
    { endpoint, value },
  )
}

function pairingReply(page, action) {
  return page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/pairing/${action}` &&
      response.request().method() === 'POST',
  )
}

async function switchToPairing(page) {
  const started = pairingReply(page, 'request')
  await page.getByRole('button', { name: 'Use a pairing code', exact: true }).click()
  assert.equal((await started).status(), 200)
  await expect(page.locator('#login-form')).toBeHidden()
  await expect(page.locator('#auth-pair-code')).toBeVisible()
}

async function failPairingCancellation(page, passwordSwitch) {
  await page.route('**/pairing/cancel', (route) => route.fulfill({ status: 403 }))
  try {
    await passwordSwitch.click()
    await expect(page.locator('#auth-pair-panel')).toHaveAttribute('data-state', 'error')
    await expect(page.locator('#login-form')).toBeHidden()
    await expect(passwordSwitch).toBeEnabled()
  } finally {
    await page.unroute('**/pairing/cancel')
  }
}

export async function checkBrowserDelegation(
  base,
  adminPath,
  password,
  setPhase,
  loopback = false,
) {
  const host = new URL(base).hostname
  const browser = await launchBrowser([
    '--no-proxy-server',
    `--host-resolver-rules=MAP ${host} 127.0.0.1`,
  ])
  try {
    async function open(options = {}) {
      const context = await browser.newContext({ locale: 'en-US', ...options })
      await context.route('**/*', (route) =>
        new URL(route.request().url()).origin === base ? route.continue() : route.abort(),
      )
      const page = await context.newPage()
      await page.goto(base, { waitUntil: 'domcontentloaded' })
      return { context, page }
    }
    const authorize = (page, title) => page.getByRole('dialog', { name: title })
    const duration = (dialog) => dialog.getByLabel(/^(?:Access duration|访问期限)$/iu)
    const factor = (dialog) => dialog.locator('input[name=code]')
    const response = (page) =>
      page.waitForResponse(
        (res) =>
          new URL(res.url()).pathname === '/auth-remote/delegation' &&
          res.request().method() === 'POST',
      )
    const withinBounds = async (page, days) => {
      const value = await page.evaluate(async () => (await fetch('/auth-remote/me')).json())
      assert.equal(value.expiresAt - value.createdAt, days * day)
      assert.deepEqual(await checkAccess(page), {
        status: 200,
        value: { canAuthorize: false, totpEnabled: true },
      })
    }

    setPhase('the password page places the pairing switch beside the login heading')
    await requestAdmin(adminPath, { version: 1, command: 'init', username: 'owner', password })
    const { page: owner } = await open({ colorScheme: 'light' })
    await expect(owner.locator('#login-form')).toBeVisible()
    await expect(owner.locator('dsh-device-pairing')).toHaveCount(0)
    const heading = owner.getByRole('heading', { name: 'Sign in', exact: true })
    const switcher = owner.getByRole('button', { name: 'Use a pairing code', exact: true })
    await expect(switcher).toBeVisible()
    const [titleBox, switchBox] = await Promise.all([heading.boundingBox(), switcher.boundingBox()])
    assert(titleBox && switchBox && switchBox.x >= titleBox.x + titleBox.width)
    assert(switchBox.y < titleBox.y + titleBox.height)
    assert.equal(await owner.evaluate(() => document.baseURI), base + '/')
    await primaryLogin(owner, password)
    assert.equal((await checkAccess(owner)).value.canAuthorize, true)
    if (loopback) {
      setPhase('native Settings exclude QR for a loopback announcement')
      await nativeRemote(owner)
      await expect(
        owner.getByText(/cannot be used to sign in from another device|无法.*其他设备/iu).first(),
      ).toBeVisible()
      await expect(owner.getByRole('button', { name: qrAction })).toHaveCount(0)
      return
    }
    const recovery = await owner.evaluate(async () => (await fetch('/pairing/client.js')).text())
    assert(/"requestTtlMs"\s*:\s*12000\b/u.test(recovery), 'fixture did not shorten pairing TTL')
    const started = await post(owner, 'totp/start', { password })
    assert.equal(started.status, 200)
    const confirmed = await post(owner, 'totp/confirm', {
      challenge: started.value.challenge,
      code: totpCode(started.value.secret, Math.floor(Date.now() / TOTP_PERIOD_MS)),
    })
    assert.equal(confirmed.status, 200)
    const backups = confirmed.value.backupCodes
    await owner.goto(base, { waitUntil: 'domcontentloaded' })
    await primaryLogin(owner, password, backups[0])

    setPhase('native Settings open a keyboard-accessible duration and factor dialog')
    await nativeRemote(owner)
    const copy = owner.getByRole('button', { name: /^(?:Copy link|复制链接)$/iu })
    await expect(copy).toBeVisible()
    await owner.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText(value) {
            window.copiedRemoteAddress = value
            return Promise.resolve()
          },
        },
      })
    })
    await copy.click()
    assert.equal(new URL(await owner.evaluate(() => window.copiedRemoteAddress)).href, base + '/')
    const trigger = owner.getByRole('button', { name: qrAction })
    await expect(trigger).toBeVisible()
    await trigger.press('Enter')
    let dialog = authorize(owner, /^(?:Create QR code|生成二维码)$/iu)
    await expect(dialog).toBeVisible()
    await expect(duration(dialog)).toHaveValue('3')
    await expect(dialog.locator('option')).toHaveCount(3)
    await owner.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await trigger.click()
    dialog = authorize(owner, /^(?:Create QR code|生成二维码)$/iu)
    await duration(dialog).selectOption('7')
    await factor(dialog).fill('wrong-code')
    let authorization = response(owner)
    await dialog.locator('button[type=submit]').click()
    assert.equal((await authorization).status(), 401)
    await expect(dialog.getByRole('alert')).not.toBeEmpty()
    await factor(dialog).fill(backups[1])
    authorization = response(owner)
    await dialog.locator('button[type=submit]').click()
    const issued = await authorization
    assert.equal(issued.status(), 200)
    const qr = (await issued.json()).result
    await expect(dialog).toBeHidden()
    await expect(owner.getByRole('img', { name: qrImage })).toBeVisible()
    await expect(owner.getByRole('timer')).toBeVisible()

    setPhase('a second browser performs the native QR exchange and enters the workspace')
    const scanner = await open({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' })
    assert(await scanner.page.goto(qr.url, { waitUntil: 'commit' }).catch(() => null))
    // The QR entry cleans the URL before exchanging the invitation and opening the workspace.
    await nativeRemote(scanner.page)
    await expect(scanner.page).toHaveURL(base + '/')
    await withinBounds(scanner.page, 7)
    await expect(
      scanner.page.getByText(
        /Device authorization is available to password sessions|设备授权仅对密码登录的会话开放/iu,
      ),
    ).toBeVisible()
    await expect(scanner.page.getByRole('button', { name: qrAction })).toHaveCount(0)
    await expect(scanner.page.getByRole('button', { name: approveAction })).toHaveCount(0)

    setPhase('applicant uses native display code and receives a one-day approval')
    const applicant = await open({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' })
    await switchToPairing(applicant.page)
    const pairingRow = async (page) => {
      const code = page.locator('#auth-pair-code')
      await expect(code).toBeVisible()
      const codeText = await code.textContent()
      assert(codeText)
      return owner
        .locator('div')
        .filter({
          has: owner.getByText(codeText, { exact: true }),
          hasText: /Source IP|来源 IP|来源/iu,
        })
        .filter({ has: owner.getByRole('button', { name: approveAction }) })
        .last()
    }
    const row = await pairingRow(applicant.page)
    await expect(applicant.page.locator('#auth-pair-countdown')).toBeVisible()
    let dropped = false
    await applicant.page.route('**/pairing/status', async (route) => {
      if (dropped) return route.continue()
      const publicUrl = new URL(base)
      const reply = await nativeHttp(`http://127.0.0.1:${publicUrl.port}`, '/pairing/status', {
        method: 'POST',
        body: route.request().postData() ?? '',
        host: publicUrl.host,
        origin: publicUrl.origin,
      }).catch(() => undefined)
      if (!reply) return route.abort('connectionreset')
      if (reply.status === 200 && JSON.parse(reply.body).status === 'completed') {
        dropped = true
        return route.abort('connectionreset')
      }
      await route.fulfill({
        status: reply.status,
        contentType: 'application/json',
        body: reply.body,
      })
    })
    await owner.emulateMedia({ colorScheme: 'dark' })
    await owner.setViewportSize({ width: 390, height: 844 })
    await expect(owner.locator('body')).toHaveAttribute('data-ds-dark-theme', /.*/u)
    await row.getByRole('button', { name: approveAction }).click()
    const approve = authorize(owner, /^(?:Approve device|批准设备)$/iu)
    const box = await approve.boundingBox()
    assert(box && box.x >= 0 && box.x + box.width <= 390)
    await expect(duration(approve)).toHaveValue('3')
    await duration(approve).selectOption('1')
    await factor(approve).fill(backups[2])
    authorization = response(owner)
    await approve.locator('button[type=submit]').click()
    assert.equal((await authorization).status(), 200)
    await applicant.page.waitForURL((url) => url.pathname === '/')
    assert(dropped)
    await withinBounds(applicant.page, 1)
    await expect(applicant.page.locator('#mfa-code')).toHaveCount(0)

    setPhase('switching back to password cancels the current pairing request')
    const pending = await open()
    await switchToPairing(pending.page)
    const cancelled = pairingReply(pending.page, 'cancel')
    const passwordSwitch = pending.page.getByRole('button', { name: 'Use a password', exact: true })
    await passwordSwitch.click()
    const cancellation = await cancelled
    assert.equal(cancellation.status(), 200)
    assert.equal((await cancellation.json()).status, 'cancelled')
    await expect(pending.page.locator('#login-form')).toBeVisible()
    await expect(pending.page.locator('dsh-device-pairing')).toHaveCount(0)

    setPhase('native refresh replaces the code and cancel stays in the pairing view')
    await switchToPairing(pending.page)
    const oldCode = await pending.page.locator('#auth-pair-code').textContent()
    const refreshed = pairingReply(pending.page, 'request')
    await pending.page.locator('#auth-pair-request').click()
    assert.equal((await refreshed).status(), 200)
    await expect(pending.page.locator('#auth-pair-code')).toBeVisible()
    await expect
      .poll(async () => {
        const code = await pending.page.locator('#auth-pair-code').textContent()
        return Boolean(code && code !== oldCode)
      })
      .toBe(true)

    setPhase('a failed cancellation preserves native recovery across login modes')
    await failPairingCancellation(pending.page, passwordSwitch)
    await passwordSwitch.click()
    await expect(pending.page.locator('#login-form')).toBeVisible()
    const recovered = pairingReply(pending.page, 'cancel')
    await switchToPairing(pending.page)
    const recoveredCancellation = await recovered
    assert.equal((await recoveredCancellation.json()).status, 'cancelled')

    await pending.page.locator('#auth-pair-cancel').click()
    await expect(pending.page.locator('#auth-pair-code')).toBeHidden()
    await expect(pending.page.locator('#login-form')).toBeHidden()
    assert(new URL(pending.page.url()).pathname === '/auth-remote/login')

    setPhase('native denial reports the result and allows a new application')
    await pending.page.locator('#auth-pair-request').click()
    const denial = await pairingRow(pending.page)
    await denial.getByRole('button', { name: /^(?:Deny|拒绝)$/iu }).click()
    await expect(pending.page.locator('#auth-pair-panel')).toHaveAttribute('data-state', 'denied', {
      timeout: 8000,
    })
    await expect(pending.page.locator('#auth-pair-request')).toBeEnabled()

    setPhase('native pairing and QR expire without logging in a new browser')
    await pending.page.locator('#auth-pair-request').click()
    await expect(pending.page.locator('#auth-pair-code')).toBeVisible()
    await owner.getByRole('button', { name: qrAction }).click()
    const expiry = authorize(owner, /^(?:Create QR code|生成二维码)$/iu)
    await expect(duration(expiry)).toHaveValue('3')
    await factor(expiry).fill(backups[3])
    authorization = response(owner)
    await expiry.locator('button[type=submit]').click()
    assert.equal((await authorization).status(), 200)
    await expect(owner.getByRole('img', { name: qrImage })).toBeVisible()
    await expect
      .poll(
        async () => {
          const state = await pending.page.locator('#auth-pair-panel').getAttribute('data-state')
          const terminal = ['expired', 'error', 'denied', 'cancelled'].indexOf(state)
          if (terminal > 0)
            throw Object.assign(new Error('Unexpected pairing phase'), {
              code: 'PAIRING_' + state.toUpperCase(),
            })
          return terminal
        },
        { timeout: 19000 },
      )
      .toBe(0)
    await expect(owner.getByText(/code has expired|二维码已过期/iu)).toBeVisible({ timeout: 19000 })
    assert.equal((await checkAccess(pending.page)).status, 401)

    setPhase('native QR regeneration can be cancelled without another factor')
    await owner.getByRole('button', { name: qrAction }).click()
    const regenerated = authorize(owner, /^(?:Create QR code|生成二维码)$/iu)
    await factor(regenerated).fill(backups[4])
    authorization = response(owner)
    await regenerated.locator('button[type=submit]').click()
    assert.equal((await authorization).status(), 200)
    await expect(owner.getByRole('img', { name: qrImage })).toBeVisible()
    const qrSection = owner.getByRole('region', {
      name: /^(?:QR code sign-in|QR code login|二维码登录)$/iu,
    })
    await qrSection.getByRole('button', { name: /^(?:Cancel|取消)$/iu }).click()
    await expect(owner.getByRole('img', { name: qrImage })).toHaveCount(0)

    setPhase('returning to a password page does not resume hidden pairing')
    const hidden = await open()
    const leave = hidden.page.getByRole('button', { name: 'Use a password', exact: true })
    await switchToPairing(hidden.page)
    await failPairingCancellation(hidden.page, leave)
    await leave.click()
    await expect(hidden.page.locator('#login-form')).toBeVisible()
    await expect(hidden.page.locator('dsh-device-pairing')).toHaveCount(1)
    await hidden.page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
    })
    await expect(hidden.page.locator('dsh-device-pairing')).toHaveCount(0)
    await expect(hidden.page.locator('#login-form')).toBeVisible()
  } finally {
    await browser.close()
  }
}
