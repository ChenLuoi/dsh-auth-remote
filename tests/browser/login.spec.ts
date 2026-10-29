import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  chromium,
  expect,
  type BrowserContext,
  type Page,
  type Request,
  type Locator,
} from '@playwright/test'
import { dictionaries, type Locale } from '../../src/shared/i18n.js'
import { totpCode } from '../../src/auth/totp.js'
import {
  archive,
  clickThroughDshPrompts,
  completeApiKeyPrompt,
  dsh,
  launchBrowser,
  isolatedDshEnv,
  localModelEndpoint,
  openDshSettings,
  selectDshTheme,
  setDshLocale as setNativeLocale,
  waitForAnimations,
} from '../helpers/runtime.js'
import { dshVersion, project } from '../../scripts/runtime.mjs'
import { nativeHttp } from '../helpers/native-http.js'

const password = 'browser test password 123'
const hostName = 'auth-remote.test'

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

async function command(bin: string, args: string[], home: string): Promise<void> {
  const child = spawn(bin, args, {
    cwd: home,
    env: isolatedDshEnv(home),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })
  const [code] = (await once(child, 'close')) as [number]
  if (code !== 0) throw new Error(`DSH command failed: ${stderr.slice(0, 2000)}`)
}

async function initialize(home: string): Promise<void> {
  const args = [dsh, 'plugin', '--profile', 'web', 'exec', 'dsh-auth-remote', 'init']
  const child = spawn('script', ['-q', '-e', '-f', '-c', args.map(quote).join(' '), '/dev/null'], {
    cwd: home,
    env: isolatedDshEnv(home),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const prompts = [
    ['Username: ', 'alice'],
    ['Password: ', password],
    ['Enter password again: ', password],
  ] as const
  let output = ''
  let cursor = 0
  let index = 0
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8')
    while (index < prompts.length) {
      const [label, answer] = prompts[index]!
      const found = output.indexOf(label, cursor)
      if (found < 0) break
      cursor = found + label.length
      index++
      child.stdin.write(`${answer}\n`)
    }
  })
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000)
  const [code] = (await once(child, 'close')) as [number]
  clearTimeout(timer)
  assert.equal(code, 0, output.slice(0, 2000))
  assert.equal(output.includes(password), false, 'password was echoed by CLI')
}

async function probe(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path: '/auth-remote/ready',
        headers: { host: `${hostName}:${port}` },
      },
      (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

async function fixture(requireTotp: boolean, port: number, storedLocale: string | null = 'zh') {
  const home = await mkdtemp(join(tmpdir(), 'dsh-auth-remote-browser-login-'))
  const profile = join(home, 'profiles/web')
  const origin = `http://${hostName}:${port}`
  const runtimeEnv = isolatedDshEnv(home)
  const model = await localModelEndpoint()
  let server: ReturnType<typeof spawn> | undefined
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    await command(dsh, ['plugin', '--profile', 'web', 'add', archive], home)
    await writeFile(
      join(profile, 'cordis.patch.yml'),
      [
        ...model.patch,
        '- id: webserver',
        '  disabled: true',
        '- id: auth-remote',
        '  config:',
        `    allowedOrigins: [${origin}]`,
        `    requireTotp: ${String(requireTotp)}`,
        '    sessionHours: 168',
        '    preserveOriginPaths: []',
        '',
      ].join('\n'),
    )
    server = spawn(dsh, ['web', '--no-open', '--port', String(port)], {
      cwd: home,
      env: runtimeEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    server.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    let ready = false
    for (let attempt = 0; attempt < 150; attempt++) {
      if (server.exitCode !== null) throw new Error(`DSH exited: ${stderr.slice(0, 2000)}`)
      try {
        if ((await probe(port)) === 200) {
          ready = true
          break
        }
      } catch {
        // Wait for the local listener.
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.equal(ready, true, `formal plugin never became ready: ${stderr.slice(0, 2000)}`)
    browser = await launchBrowser([
      '--no-proxy-server',
      `--host-resolver-rules=MAP ${hostName} 127.0.0.1`,
    ])
    const context = await browser.newContext({ locale: 'zh-CN' })
    if (storedLocale) {
      await context.addInitScript((value) => {
        try {
          if (localStorage.getItem('dsh-auth-remote-lang') === null)
            localStorage.setItem('dsh-auth-remote-lang', value)
        } catch {
          /* opaque origins */
        }
      }, storedLocale)
    }
    const page = await context.newPage()
    return {
      home,
      origin,
      page,
      context,
      model,
      cleanup: async () => {
        await browser?.close()
        if (server && server.exitCode === null && server.signalCode === null) {
          server.kill('SIGTERM')
          await once(server, 'exit').catch(() => {})
        }
        await model.close()
        if (process.env.DSH_KEEP_TEST_HOME === '1') console.error(`Browser login home: ${home}`)
        else await rm(home, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await browser?.close()
    if (server && server.exitCode === null && server.signalCode === null) {
      server.kill('SIGTERM')
      await once(server, 'exit').catch(() => {})
    }
    await model.close()
    await rm(home, { recursive: true, force: true })
    throw error
  }
}

async function openSecurity(page: Page): Promise<void> {
  await openDshSettings(page)
  const settings = page.getByRole('dialog', { name: '设置' })
  await clickThroughDshPrompts(
    page,
    settings.getByRole('button', { name: '安全与登录', exact: true }),
    () => openDshSettings(page),
  )
  await settings.getByRole('heading', { name: '安全与登录' }).waitFor()
}

async function submitWithRateLimit(page: Page, button: Locator, path: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const answered = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === path && response.request().method() === 'POST',
    )
    await button.click()
    const response = await answered
    if (response.status() !== 429) return
    const seconds = Number(response.headers()['retry-after'])
    assert.ok(
      Number.isInteger(seconds) && seconds > 0 && seconds <= 60,
      'authentication retry must use the real bounded Retry-After',
    )
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000 + 50))
  }
  throw new Error('Authentication rate limit did not clear after its reported window')
}

async function loginWithBackup(
  page: Page,
  origin: string,
  currentPassword: string,
  code: string,
  locale: Locale = 'zh',
): Promise<void> {
  const text = dictionaries[locale]
  await page.goto(`${origin}/auth-remote/login`)
  await page.getByRole('heading', { name: text.loginTitle, exact: true }).waitFor()
  await page.getByLabel(text.loginUsername).fill('alice')
  await page.getByLabel(text.loginPassword).fill(currentPassword)
  await submitWithRateLimit(
    page,
    page.getByRole('button', { name: text.loginContinue }),
    '/auth-remote/login',
  )
  await page.getByRole('heading', { name: text.loginMfaTitle }).waitFor()
  await page.getByLabel(text.loginMfaCode).fill(code)
  await submitWithRateLimit(
    page,
    page.getByRole('button', { name: text.loginMfaSubmit }),
    '/auth-remote/mfa/verify',
  )
  await page.waitForURL(`${origin}/`, { timeout: 8000 }).catch(async () => {
    throw new Error(
      `backup login did not return to DSH: ${JSON.stringify({ url: page.url(), body: (await page.locator('body').innerText()).slice(0, 500) })}`,
    )
  })
  await page.waitForSelector('[class*="frame"]')
}

test('anonymous sign-in exposes the native PWA manifest and icons without business access', async () => {
  const f = await fixture(false, 13114)
  try {
    const manifestRequests: Request[] = []
    f.page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/manifest.webmanifest')
        manifestRequests.push(request)
    })
    const response = await f.page.goto(`${f.origin}/`)
    assert.equal(new URL(f.page.url()).pathname, '/auth-remote/login')
    assert.match(response!.headers()['content-security-policy']!, /manifest-src 'self'/u)
    assert.equal(
      await f.page.locator('link[rel="manifest"]').getAttribute('href'),
      '/manifest.webmanifest',
    )
    const cdp = await f.context.newCDPSession(f.page)
    const manifest = await cdp.send('Page.getAppManifest')
    assert.equal(manifest.url, `${f.origin}/manifest.webmanifest`)
    assert.deepEqual(manifest.errors, [])
    const metadata = JSON.parse(manifest.data!)
    assert.equal(metadata.name, 'DeepSeek Harness')
    assert.equal(new URL(metadata.start_url, manifest.url).href, `${f.origin}/`)
    assert.equal(manifestRequests.length > 0, true)
    const manifestHeaders = await Promise.all(
      manifestRequests.map((request) => request.allHeaders()),
    )
    assert.equal(
      manifestHeaders.every((headers) => headers.cookie === undefined),
      true,
    )
    const paths = ['/manifest.webmanifest', '/favicon.svg', '/favicon-dark.svg']
    const assets = await f.page.evaluate(async (paths) => {
      const results = []
      for (const path of paths) {
        for (const method of ['GET', 'HEAD']) {
          const response = await fetch(path, { method, credentials: 'omit' })
          results.push({
            path,
            method,
            status: response.status,
            type: response.headers.get('content-type'),
            body: await response.text(),
          })
        }
      }
      return results
    }, paths)
    for (const asset of assets) {
      assert.equal(asset.status, 200, `${asset.method} ${asset.path}`)
      assert.match(
        asset.type!,
        asset.path.endsWith('.svg') ? /image\/svg\+xml/u : /application\/manifest\+json/u,
      )
      if (asset.method === 'HEAD') assert.equal(asset.body, '')
      else if (asset.path.endsWith('.svg')) assert.match(asset.body, /<svg/u)
    }
    assert.deepEqual(await f.context.cookies(), [])
    assert.equal(await f.page.evaluate(async () => (await fetch('/api/settings')).status), 401)
    await cdp.detach()
  } finally {
    await f.cleanup()
  }
})

test('login and security settings follow DSH themes and fit narrow screens', async () => {
  const f = await fixture(false, 13113)
  const screenshots = join(project, '.cache', 'ui-review', dshVersion)
  await mkdir(screenshots, { recursive: true })
  try {
    await initialize(f.home)
    await f.page.goto(`${f.origin}/auth-remote/login`)
    await f.page.getByLabel('用户名').waitFor()
    for (const colorScheme of ['light', 'dark'] as const) {
      await f.page.emulateMedia({ colorScheme })
      for (const width of [1280, 390]) {
        await f.page.setViewportSize({ width, height: 900 })
        assert.equal(
          await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        )
        await expect(f.page.getByLabel('用户名')).toBeVisible()
        await f.page.screenshot({ path: join(screenshots, `login-${colorScheme}-${width}.png`) })
      }
    }
    await f.page.setViewportSize({ width: 1280, height: 900 })
    await f.page.getByLabel('用户名').fill('alice')
    await f.page.getByLabel('密码').fill(password)
    await f.page.getByRole('button', { name: '继续' }).click()
    await f.page.getByRole('button', { name: '跳过，进入 DSH' }).click()
    await f.page.waitForSelector('[class*="frame"]')
    await openSecurity(f.page)
    const dialog = f.page.getByRole('dialog', { name: '设置' })
    const backgrounds: string[] = []
    for (const theme of ['light', 'dark'] as const) {
      await dialog.getByRole('button', { name: '通用设置' }).click()
      await selectDshTheme(f.page, theme)
      await dialog.getByRole('button', { name: '安全与登录', exact: true }).click()
      await expect(dialog.locator('.auth-remote-overview')).toBeVisible()
      for (const width of [1280, 390]) {
        await f.page.setViewportSize({ width, height: 900 })
        await waitForAnimations(f.page)
        assert.equal(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth), true)
        const toggle = dialog.getByRole('switch', { name: '远程 DeepSeek 账号登录' })
        const thumb = toggle.locator('span')
        await expect(thumb).toBeVisible()
        await expect(thumb).toHaveCSS('width', '16px')
        await expect(thumb).toHaveCSS('height', '16px')
        const colors = await toggle.evaluate((node) => ({
          track: getComputedStyle(node).backgroundColor,
          thumb: getComputedStyle(node.firstElementChild!).backgroundColor,
        }))
        assert.notEqual(colors.thumb, 'rgba(0, 0, 0, 0)', 'switch thumb must have a visible fill')
        assert.notEqual(colors.thumb, colors.track, 'switch thumb must differ from its track')
        // Enter keyboard modality without traversing native off-screen tab stops.
        // Use an enabled control even where the manual switch is disabled.
        await f.page.keyboard.press('Shift')
        const passwordAction = dialog.getByRole('button', { name: '修改密码', exact: true })
        await expect(passwordAction).toBeEnabled()
        await passwordAction.evaluate((node) =>
          (node as HTMLElement).focus({ preventScroll: true }),
        )
        await expect(passwordAction).toBeFocused()
        await expect(passwordAction).toBeInViewport()
        await passwordAction.click({ trial: true })
        assert.equal(await passwordAction.evaluate((node) => node.matches(':focus-visible')), true)
        await expect(passwordAction).toHaveCSS('outline-style', 'solid')
        await expect(passwordAction).toHaveCSS('outline-width', '2px')
        await expect(passwordAction).not.toHaveCSS('outline-color', 'rgba(0, 0, 0, 0)')
        await f.page.screenshot({
          path: join(screenshots, `security-overview-${theme}-${width}.png`),
        })
      }
      await f.page.setViewportSize({ width: 1280, height: 900 })
      await dialog.getByRole('button', { name: '修改密码', exact: true }).click()
      const input = dialog.getByLabel('当前密码')
      await input.fill('unsaved draft')
      await expect(input).not.toHaveCSS('border-top-left-radius', '0px')
      backgrounds.push(await input.evaluate((node) => getComputedStyle(node).backgroundColor))
      for (const width of [1280, 390]) {
        await f.page.setViewportSize({ width, height: 900 })
        await waitForAnimations(f.page)
        await expect(input).toBeVisible()
        assert.equal(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth), true)
        await expect(input).toHaveValue('unsaved draft')
        await f.page.screenshot({
          path: join(screenshots, `security-${theme}-${width}.png`),
        })
      }
      await f.page.setViewportSize({ width: 1280, height: 900 })
      await f.page
        .getByRole('dialog', { name: '修改密码', exact: true })
        .getByRole('button', { name: '取消', exact: true })
        .click()
    }
    assert.notEqual(
      backgrounds[0],
      backgrounds[1],
      'security inputs must react to host theme changes',
    )
  } finally {
    await f.cleanup()
  }
})

test(
  'eight languages render login and native security tasks at desktop and narrow widths',
  { timeout: 150000 },
  async () => {
    const f = await fixture(false, 13152)
    const review = join(project, '.cache/ui-review', dshVersion, 'languages')
    await mkdir(review, { recursive: true })
    try {
      await initialize(f.home)
      const locales = Object.keys(dictionaries) as Locale[]
      for (const locale of locales) {
        const t = dictionaries[locale]
        await f.page.goto(`${f.origin}/auth-remote/login`)
        await f.page.evaluate(
          (value) => localStorage.setItem('dsh-auth-remote-lang', value),
          locale,
        )
        await f.page.reload()
        await expect(f.page.getByLabel(t.loginUsername, { exact: true })).toBeVisible()
        for (const theme of ['light', 'dark'] as const) {
          await f.page.emulateMedia({ colorScheme: theme })
          for (const width of [1280, 390]) {
            await f.page.setViewportSize({ width, height: 900 })
            assert.equal(
              await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
              true,
              `${locale} login ${width}`,
            )
            await expect(
              f.page.getByRole('button', { name: t.loginContinue, exact: true }),
            ).toBeInViewport()
            await f.page.screenshot({ path: join(review, `${locale}-login-${theme}-${width}.png`) })
          }
        }
      }
      await f.page.evaluate(() => localStorage.setItem('dsh-auth-remote-lang', 'zh'))
      await f.page.setViewportSize({ width: 1280, height: 900 })
      await optionalSignIn(f.page, f.origin)
      await openSecurity(f.page)
      // Older hosts retain their own language catalog; dictionary registration does not extend it.
      const nativeLocales: Locale[] = dshVersion === '0.2.2-alpha.2' ? locales : ['zh', 'en']
      for (const theme of ['light', 'dark'] as const) {
        await setNativeLocale(f.page, 'zh')
        await f.page.getByRole('button', { name: '通用设置', exact: true }).click()
        await selectDshTheme(f.page, theme)
        await f.page.getByRole('button', { name: '安全与登录', exact: true }).click()
        for (const locale of nativeLocales) {
          const t = dictionaries[locale]
          await setNativeLocale(f.page, locale)
          const section = f.page.locator('.auth-remote-security')
          await expect(
            section.getByRole('heading', { name: t.settingsTitle, exact: true }),
          ).toBeVisible()
          for (const width of [1280, 390]) {
            await f.page.setViewportSize({ width, height: 900 })
            await waitForAnimations(f.page)
            assert.equal(
              await section.evaluate((node) => node.scrollWidth <= node.clientWidth),
              true,
              `${locale} overview ${width}`,
            )
            await f.page.screenshot({
              path: join(review, `${locale}-security-${theme}-${width}.png`),
            })
          }
          await section.getByRole('button', { name: t.settingsChangePassword, exact: true }).click()
          const passwordTask = f.page.getByRole('dialog', {
            name: t.settingsChangePassword,
            exact: true,
          })
          await expect(
            passwordTask.getByLabel(t.settingsCurrentPassword, { exact: true }),
          ).toBeVisible()
          for (const width of [1280, 390]) {
            await f.page.setViewportSize({ width, height: 900 })
            assert.equal(
              await passwordTask.evaluate((node) => node.scrollWidth <= node.clientWidth),
              true,
              `${locale} password ${width}`,
            )
            await f.page.screenshot({
              path: join(review, `${locale}-password-${theme}-${width}.png`),
            })
          }
          await passwordTask.getByRole('button', { name: t.settingsCancel, exact: true }).click()
          if (theme === 'light') {
            await section.getByRole('button', { name: t.settingsBindTotp, exact: true }).click()
            const credentials = f.page.getByRole('dialog', {
              name: t.settingsBindTotp,
              exact: true,
            })
            await credentials.getByLabel(t.settingsCurrentPassword).fill(password)
            await credentials
              .getByRole('button', { name: t.settingsStartBinding, exact: true })
              .click()
            const qr = f.page.getByRole('dialog', { name: t.settingsScanQr, exact: true })
            await expect(qr.getByRole('img', { name: t.settingsQrAlt })).toBeVisible()
            await expect(qr.getByLabel(t.settingsNewCode)).toBeVisible()
            assert.equal(
              await qr.evaluate((node) => node.scrollWidth <= node.clientWidth),
              true,
              `${locale} QR`,
            )
            await f.page.screenshot({ path: join(review, `${locale}-totp-light-390.png`) })
            await qr.getByRole('button', { name: t.settingsCancel, exact: true }).click()
          }
        }
      }
    } finally {
      await f.cleanup()
    }
  },
)

test('standalone locale uses new memory then navigator.language, ignores old memory and stays fixed per page', async () => {
  const f = await fixture(false, 13110, null)
  try {
    await initialize(f.home)
    for (const [stored, browserLanguage, expected] of [
      ['DE-de', 'ja-JP', 'de'],
      ['ZH-hans-CN', 'en-US', 'zh'],
      ['pt-PT', 'en-US', 'pt'],
      ['ko-KR', 'pt-BR', 'pt'],
      ['en--US', 'ja-JP', 'ja'],
      [null, 'es-ES', 'es'],
      [null, 'fr-CA', 'fr'],
      [null, 'ko-KR', 'en'],
    ] as const) {
      const context = await f.context.browser()!.newContext({ locale: browserLanguage })
      let releaseState: (() => void) | undefined
      try {
        await context.addInitScript((value) => {
          localStorage.setItem('dsh-auth-remote.locale', 'ru')
          if (value !== null) localStorage.setItem('dsh-auth-remote-lang', value)
          ;(window as any).__oldLocaleReads = 0
          const original = Storage.prototype.getItem
          Storage.prototype.getItem = function (key) {
            if (key === 'dsh-auth-remote.locale') (window as any).__oldLocaleReads++
            return original.call(this, key)
          }
          Object.defineProperty(navigator, 'languages', { get: () => ['ru-RU'] })
        }, stored)
        const page = await context.newPage()
        const heldState = new Promise<void>((resolve) => {
          releaseState = resolve
        })
        await page.route('**/auth-remote/state', async (route) => {
          await heldState
          await route.continue()
        })
        const apiRequests: string[] = []
        page.on('request', (request) => {
          if (new URL(request.url()).pathname.startsWith('/api/')) apiRequests.push(request.url())
        })
        await page.goto(`${f.origin}/auth-remote/login`)
        const t = dictionaries[expected]
        await expect(page.getByText(t.loginInitialLoading, { exact: true })).toBeVisible()
        await expect(page.locator('html')).toHaveAttribute('lang', expected)
        releaseState!()
        await expect(page.getByLabel(t.loginUsername, { exact: true })).toBeVisible()
        await expect(page.locator('html')).toHaveAttribute('lang', expected)
        assert.equal(await page.title(), t.loginTitle)
        await expect(page.locator('select, #language, .language-control')).toHaveCount(0)
        assert.equal(await page.evaluate(() => localStorage['dsh-auth-remote.locale']), 'ru')
        assert.equal(
          await page.evaluate(() => localStorage.getItem('dsh-auth-remote-lang')),
          stored,
        )
        await page.getByLabel(t.loginUsername, { exact: true }).fill('alice')
        await page.getByLabel(t.loginPassword, { exact: true }).fill('unsent secret')
        await page.evaluate(() => {
          localStorage.setItem('dsh-auth-remote-lang', 'ru')
          window.dispatchEvent(
            new StorageEvent('storage', { key: 'dsh-auth-remote-lang', newValue: 'ru' }),
          )
        })
        await expect(page.locator('html')).toHaveAttribute('lang', expected)
        assert.equal(
          await page.getByLabel(t.loginPassword, { exact: true }).inputValue(),
          'unsent secret',
        )
        assert.deepEqual(apiRequests, [])
        assert.equal(await page.evaluate(() => (window as any).__oldLocaleReads), 0)
      } finally {
        releaseState?.()
        await context.close()
      }
    }
  } finally {
    await f.cleanup()
  }
})

test('standalone locale falls back to navigator.language when localStorage is blocked', async () => {
  const f = await fixture(false, 13111, null)
  const context = await f.context.browser()!.newContext({ locale: 'pt-BR' })
  try {
    await initialize(f.home)
    await context.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() {
          throw new DOMException('blocked', 'SecurityError')
        },
      })
    })
    const page = await context.newPage()
    await page.route(
      '**/auth-remote/state',
      (route) => route.fulfill({ status: 503, json: { error: 'service_unavailable' } }),
      { times: 1 },
    )
    await page.goto(`${f.origin}/auth-remote/login`)
    await expect(
      page.getByRole('heading', { name: dictionaries.pt.loginUnavailableTitle, exact: true }),
    ).toBeVisible()
    await page.getByRole('button', { name: dictionaries.pt.loginRetry, exact: true }).click()
    await expect(
      page.getByRole('heading', { name: dictionaries.pt.loginTitle, exact: true }),
    ).toBeVisible()
    await expect(page.locator('select')).toHaveCount(0)
    await page.getByLabel(dictionaries.pt.loginUsername).fill('alice')
    await page.getByLabel(dictionaries.pt.loginPassword).fill(password)
    await page.getByRole('button', { name: dictionaries.pt.loginContinue, exact: true }).click()
    await expect(
      page.getByRole('heading', { name: dictionaries.pt.loginOptionalTitle, exact: true }),
    ).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'pt')
  } finally {
    await context.close()
    await f.cleanup()
  }
})

test(
  'locale memory waits for native acceptance, survives failed saves and logout, and clears explicit absence',
  { timeout: 90000 },
  async () => {
    const f = await fixture(false, 13153, null)
    let releaseRead: (() => void) | undefined
    let releaseWrite: (() => void) | undefined
    try {
      await initialize(f.home)
      await f.context.addInitScript(() => {
        ;(window as any).__observeAuthRemoteForms = true
      })
      await f.context.addInitScript({
        path: new URL('../fixtures/liveshare-client-observer.js', import.meta.url).pathname,
      })
      await f.page.goto(`${f.origin}/auth-remote/login`)
      await f.page.getByLabel('用户名').fill('alice')
      await f.page.getByLabel('密码').fill(password)
      await f.page.getByRole('button', { name: '继续', exact: true }).click()
      await f.page
        .getByRole('heading', { name: dictionaries.zh.loginOptionalTitle, exact: true })
        .waitFor()
      // Real Host preference is written before the native client/form is loaded.
      await setNativeLocale(f.page, 'en')
      await f.page.evaluate(() => {
        localStorage.setItem('dsh-auth-remote-lang', 'DE-de')
        localStorage.setItem('dsh-auth-remote.locale', 'old-value')
      })
      let reads = 0
      const heldRead = new Promise<void>((resolve) => {
        releaseRead = resolve
      })
      await f.page.route('**/api/settings/describe', async (route) => {
        reads++
        await heldRead
        await route.continue()
      })
      await f.page
        .getByRole('button', { name: dictionaries.zh.loginOptionalSkip, exact: true })
        .click()
      await expect.poll(() => reads).toBeGreaterThan(0)
      await f.page.waitForFunction(
        () => (window as any).__authRemoteContext && (window as any).__authRemoteConfigContext,
      )
      const memory = () => f.page.evaluate(() => localStorage.getItem('dsh-auth-remote-lang'))
      assert.equal(await memory(), 'DE-de')
      assert.equal(
        await f.page.evaluate(
          () =>
            (window as any).__authRemoteConfigContext.configForms.get('locale').getSnapshot()
              .status,
        ),
        'loading',
      )
      releaseRead!()
      await expect.poll(memory).toBe('en')
      await expect
        .poll(() =>
          f.page.evaluate(() => (window as any).__authRemoteContext.locale.getSnapshot().active),
        )
        .toBe('en')
      let action: 'pass' | 'fail' | 'hold' = 'pass'
      await f.page.route('**/api/settings/mutate', async (route) => {
        if (route.request().postDataJSON()?.payload?.args?.ns !== 'locale') return route.continue()
        if (action === 'hold')
          await new Promise<void>((resolve) => {
            releaseWrite = resolve
          })
        if (action === 'fail')
          return route.fulfill({
            json: {
              type: 'server-response',
              rpcId: route.request().postDataJSON().rpcId,
              result: {
                ok: false,
                error: { code: 'settings/unavailable', message: 'Temporary save failure' },
              },
            },
          })
        await route.continue()
      })
      action = 'hold'
      // A later native mirror notification can restore the accepted locale while this write waits.
      assert.deepEqual(
        await f.page.evaluate(() => {
          const locale = (window as any).__authRemoteContext.locale
          locale.setLocale('zh')
          return {
            active: locale.getSnapshot().active,
            memory: localStorage.getItem('dsh-auth-remote-lang'),
          }
        }),
        { active: 'zh', memory: 'en' },
      )
      await expect.poll(() => Boolean(releaseWrite)).toBe(true)
      assert.equal(
        await memory(),
        'en',
        'optimistic active locale must not overwrite accepted memory',
      )
      action = 'fail'
      releaseWrite!()
      await expect
        .poll(() =>
          f.page.evaluate(() => (window as any).__authRemoteContext.locale.getSnapshot().active),
        )
        .toBe('en')
      assert.equal(await memory(), 'en')
      action = 'pass'
      assert.equal(
        await f.page.evaluate(() =>
          (window as any).__authRemoteConfigContext.configForms
            .get('locale')
            .set('preference', 'PT-br'),
        ),
        true,
      )
      await expect.poll(memory).toBe('PT-br')
      assert.equal(
        await f.page.evaluate(() =>
          (window as any).__authRemoteConfigContext.configForms
            .get('locale')
            .set('preference', 'ko-KR'),
        ),
        true,
      )
      await expect.poll(memory).toBe('ko-KR')
      assert.equal(
        await f.page.evaluate(() =>
          (window as any).__authRemoteConfigContext.configForms.get('locale').unset('preference'),
        ),
        true,
      )
      await expect.poll(memory).toBe(null)
      assert.equal(
        await f.page.evaluate(() => localStorage.getItem('dsh-auth-remote.locale')),
        'old-value',
      )
      assert.equal(
        await f.page.evaluate(() =>
          (window as any).__authRemoteConfigContext.configForms
            .get('locale')
            .set('preference', 'pt-BR'),
        ),
        true,
      )
      await expect.poll(memory).toBe('pt-BR')
      assert.equal(
        await f.page.evaluate(
          async () => (await fetch('/auth-remote/logout', { method: 'POST' })).status,
        ),
        200,
      )
      await f.page.goto(`${f.origin}/auth-remote/login`)
      await expect(
        f.page.getByRole('heading', { name: dictionaries.pt.loginTitle, exact: true }),
      ).toBeVisible()
      assert.equal(await memory(), 'pt-BR')
      assert.equal(
        await f.page.evaluate(() => localStorage.getItem('dsh-auth-remote.locale')),
        'old-value',
      )
      await f.page.getByLabel(dictionaries.pt.loginUsername).fill('alice')
      await f.page.getByLabel(dictionaries.pt.loginPassword).fill(password)
      await f.page.getByRole('button', { name: dictionaries.pt.loginContinue, exact: true }).click()
      await f.page
        .getByRole('button', { name: dictionaries.pt.loginOptionalSkip, exact: true })
        .click()
      await f.page.waitForSelector('[class*="frame"]')
      await expect.poll(memory).toBe('pt-BR')
      const publicUrl = new URL(f.origin)
      const revoked = await nativeHttp(
        `http://127.0.0.1:${publicUrl.port}`,
        '/auth-remote/revoke-sessions',
        {
          host: publicUrl.host,
          origin: f.origin,
          method: 'POST',
          cookie: (await f.context.cookies(f.origin))
            .map(({ name, value }) => `${name}=${value}`)
            .join('; '),
          body: JSON.stringify({ password }),
        },
      )
      assert.equal(revoked.status, 200, revoked.body)
      await f.page.goto(`${f.origin}/auth-remote/login`)
      await expect(
        f.page.getByRole('heading', { name: dictionaries.pt.loginTitle, exact: true }),
      ).toBeVisible()
      assert.equal(
        await memory(),
        'pt-BR',
        'real session revocation must retain accepted language memory',
      )
    } finally {
      releaseRead?.()
      releaseWrite?.()
      await f.page.unrouteAll({ behavior: 'wait' })
      await f.cleanup()
    }
  },
)

test(
  'locale memory preserves failed or unavailable reads and recovers with the real native mirror',
  { timeout: 90000 },
  async () => {
    const f = await fixture(false, 13154, null)
    try {
      await initialize(f.home)
      await f.context.addInitScript(() => {
        ;(window as any).__observeAuthRemoteForms = true
      })
      await f.context.addInitScript({
        path: new URL('../fixtures/liveshare-client-observer.js', import.meta.url).pathname,
      })
      await f.page.goto(`${f.origin}/auth-remote/login`)
      await f.page.getByLabel('用户名').fill('alice')
      await f.page.getByLabel('密码').fill(password)
      await f.page.getByRole('button', { name: '继续', exact: true }).click()
      await f.page
        .getByRole('heading', { name: dictionaries.zh.loginOptionalTitle, exact: true })
        .waitFor()
      await setNativeLocale(f.page, 'en')
      await f.page.evaluate(() => localStorage.setItem('dsh-auth-remote-lang', 'ja-JP'))
      let mode: 'fail' | 'unavailable' | 'pass' = 'fail'
      let reads = 0
      await f.page.route('**/api/settings/describe', async (route) => {
        reads++
        if (mode === 'fail')
          return route.fulfill({
            json: {
              type: 'server-response',
              rpcId: route.request().postDataJSON().rpcId,
              result: {
                ok: false,
                error: { code: 'settings/unavailable', message: 'Temporary read failure' },
              },
            },
          })
        if (mode === 'unavailable') {
          const url = new URL(route.request().url())
          const host = url.host
          url.hostname = '127.0.0.1'
          const response = await route.fetch({
            url: url.href,
            headers: { ...(await route.request().allHeaders()), host },
          })
          const value = await response.json()
          value.result.value.namespaces = value.result.value.namespaces.filter(
            (entry: { ns: string }) => entry.ns !== 'locale',
          )
          return route.fulfill({ response, json: value })
        }
        await route.continue()
      })
      await f.page
        .getByRole('button', { name: dictionaries.zh.loginOptionalSkip, exact: true })
        .click()
      await f.page.waitForFunction(
        () => (window as any).__authRemoteContext && (window as any).__authRemoteConfigContext,
      )
      await expect.poll(() => reads).toBeGreaterThan(0)
      const memory = () => f.page.evaluate(() => localStorage.getItem('dsh-auth-remote-lang'))
      assert.equal(await memory(), 'ja-JP')
      // Other native forms may initiate reads; recovery uses their real shared mirror.
      mode = 'pass'
      await f.page.evaluate(() =>
        (window as any).__authRemoteConfigContext.configForms.describe().ensure(),
      )
      await expect.poll(memory).toBe('en')
      mode = 'unavailable'
      await f.page.evaluate(() => localStorage.setItem('dsh-auth-remote-lang', 'ja-JP'))
      await f.page.reload()
      await f.page.waitForFunction(
        () =>
          (window as any).__authRemoteConfigContext?.configForms.get('locale').getSnapshot()
            .status === 'unavailable',
      )
      assert.equal(await memory(), 'ja-JP')
      mode = 'pass'
      await f.context.addInitScript(() => {
        const set = Storage.prototype.setItem
        const remove = Storage.prototype.removeItem
        Storage.prototype.setItem = function (key, value) {
          if (key === 'dsh-auth-remote-lang') throw new DOMException('blocked', 'SecurityError')
          return set.call(this, key, value)
        }
        Storage.prototype.removeItem = function (key) {
          if (key === 'dsh-auth-remote-lang') throw new DOMException('blocked', 'SecurityError')
          return remove.call(this, key)
        }
      })
      await f.page.reload()
      await f.page.waitForFunction(
        () =>
          (window as any).__authRemoteConfigContext?.configForms.get('locale').getSnapshot().value
            ?.preference === 'en',
      )
      assert.equal(await memory(), 'ja-JP')
      assert.equal(
        await f.page.evaluate(() =>
          (window as any).__authRemoteConfigContext.configForms
            .get('locale')
            .set('preference', 'pt'),
        ),
        true,
      )
      assert.equal(
        await memory(),
        'ja-JP',
        'storage failure must not block a real native settings save',
      )
      assert.equal(await f.page.evaluate(async () => (await fetch('/auth-remote/me')).status), 200)
    } finally {
      await f.page.unrouteAll({ behavior: 'wait' })
      await f.cleanup()
    }
  },
)

test('fresh profile guides CLI init, then forces QR binding and full MFA login', async () => {
  const f = await fixture(true, 13094)
  try {
    await f.page.goto(`${f.origin}/?source=login-test`)
    await f.page.getByRole('heading', { name: '先初始化账号' }).waitFor()
    await expect(f.page.locator('select')).toHaveCount(0)
    assert.equal(
      await f.page.locator('#setup-command').textContent(),
      'dsh plugin --profile web exec dsh-auth-remote init',
    )
    await f.page.getByRole('button', { name: '复制命令' }).click()
    assert.match((await f.page.locator('#message').textContent()) ?? '', /命令已复制|请手动选择/u)
    assert.equal(await f.page.getByRole('button', { name: '跳过，进入 DSH' }).count(), 0)
    await initialize(f.home)
    await f.page.getByRole('button', { name: '我已完成初始化' }).click()
    await f.page.getByRole('heading', { name: '登录', exact: true }).waitFor()
    await f.page.route(
      '**/auth-remote/login',
      (route) =>
        route.fulfill({
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '23' },
          body: JSON.stringify({ error: 'rate_limited', retryAfter: 23 }),
        }),
      { times: 1 },
    )
    await f.page.getByLabel('用户名').fill('alice')
    await f.page.getByLabel('密码').fill('wrong password')
    await f.page.getByRole('button', { name: '继续' }).click()
    await f.page.getByText('尝试过于频繁，请约 23 秒后重试。').waitFor()
    await f.page.getByRole('button', { name: '继续' }).click()
    await f.page.getByText('用户名或密码不正确').waitFor()
    await f.page.getByLabel('密码').fill(password)
    await f.page.getByRole('button', { name: '继续' }).click()
    await f.page.getByRole('heading', { name: '绑定身份验证器' }).waitFor()
    assert.equal(await f.page.getByRole('button', { name: '跳过，进入 DSH' }).count(), 0)
    assert.equal(await f.context.cookies().then((cookies) => cookies.length), 0)
    const secret = (await f.page.locator('#totp-secret').textContent()) ?? ''
    assert.match(secret, /^[A-Z2-7]+$/u)
    assert.equal(
      await f.page
        .locator('#totp-qr')
        .evaluate((canvas: HTMLCanvasElement) =>
          [...canvas.getContext('2d')!.getImageData(0, 0, 220, 220).data].some(
            (value) => value === 0,
          ),
        ),
      true,
    )
    await f.page.locator('#totp-qr').evaluate((canvas) => {
      canvas.dataset.probe = 'same-canvas'
    })
    await f.page.evaluate(() => localStorage.setItem('dsh-auth-remote-lang', 'en'))
    await expect(f.page.locator('html')).toHaveAttribute('lang', 'zh')
    assert.equal(await f.page.locator('#totp-secret').textContent(), secret)
    await f.page.getByLabel('身份验证器中的 6 位验证码').fill('123456')
    assert.equal(await f.page.locator('#totp-qr').getAttribute('data-probe'), 'same-canvas')
    await f.page
      .getByLabel('身份验证器中的 6 位验证码')
      .fill(totpCode(secret, Math.floor(Date.now() / 30_000)))
    await f.page.getByRole('button', { name: '确认绑定' }).click()
    await f.page.getByRole('heading', { name: '保存备用码' }).waitFor()
    const codes = await f.page.locator('#backup-codes li').allTextContents()
    assert.equal(codes.length, 10)
    assert.equal(await f.context.cookies().then((cookies) => cookies.length), 0)
    await expect(f.page.locator('select')).toHaveCount(0)
    await f.page.getByRole('button', { name: '我已保存，重新登录' }).click()
    assert.equal(await f.page.locator('#backup-codes').count(), 0)
    await f.page.getByLabel('密码').fill(password)
    await f.page.getByRole('button', { name: '继续' }).click()
    await f.page.getByRole('heading', { name: '验证第二因素' }).waitFor()
    await f.page.route(
      '**/auth-remote/mfa/verify',
      (route) =>
        route.fulfill({
          status: 410,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ error: 'challenge_expired' }),
        }),
      { times: 1 },
    )
    await f.page.getByLabel('验证码或备用码').fill(codes[0]!)
    await f.page.getByRole('button', { name: '验证并登录' }).click()
    await f.page.getByRole('heading', { name: '登录', exact: true }).waitFor()
    await f.page.getByText('本次验证已失效，请重新输入用户名和密码。').waitFor()
    assert.equal(await f.context.cookies().then((cookies) => cookies.length), 0)
    await f.page.getByLabel('密码').fill(password)
    await f.page.getByRole('button', { name: '继续' }).click()
    await f.page.getByRole('heading', { name: '验证第二因素' }).waitFor()
    await f.page.getByLabel('验证码或备用码').fill(codes[0]!)
    await f.page.getByRole('button', { name: '验证并登录' }).click()
    await f.page.waitForURL(`${f.origin}/?source=login-test`)
    await f.page.waitForSelector('[class*="frame"]')
    assert.deepEqual(
      (await f.context.cookies()).map((cookie) => cookie.name),
      ['dsh_auth_remote'],
    )
    await openSecurity(f.page)
  } finally {
    await f.cleanup()
  }
})

test('optional profile offers skip and sanitizes unsafe return destinations', async () => {
  const f = await fixture(false, 13095)
  try {
    await initialize(f.home)
    await f.page.goto(
      `${f.origin}/auth-remote/login?return=${encodeURIComponent('//evil.example/')}`,
    )
    await f.page.getByRole('heading', { name: '登录', exact: true }).waitFor()
    await f.page.getByLabel('用户名').fill('alice')
    await f.page.getByLabel('密码').fill(password)
    await f.page.getByRole('button', { name: '继续' }).click()
    await f.page.getByRole('heading', { name: '保护你的账号' }).waitFor()
    await f.page.getByRole('button', { name: '跳过，进入 DSH' }).click()
    await f.page.waitForURL(`${f.origin}/`)
    await f.page.waitForSelector('[class*="frame"]')
    assert.equal(
      await f.page.evaluate(
        async () => (await fetch('/auth-remote/logout', { method: 'POST' })).status,
      ),
      200,
    )
    await f.page.goto(`${f.origin}/auth-remote/login`)
    await f.page.getByLabel('用户名').fill('alice')
    await f.page.getByLabel('密码').fill(password)
    await f.page.getByRole('button', { name: '继续' }).click()
    await f.page.getByRole('button', { name: '现在绑定 TOTP' }).click()
    await f.page.getByLabel('当前密码').fill(password)
    await f.page.getByRole('button', { name: '开始绑定' }).click()
    await f.page.getByRole('heading', { name: '绑定身份验证器' }).waitFor()
    const secret = (await f.page.locator('#totp-secret').textContent()) ?? ''
    await f.page
      .getByLabel('身份验证器中的 6 位验证码')
      .fill(totpCode(secret, Math.floor(Date.now() / 30_000)))
    await f.page.getByRole('button', { name: '确认绑定' }).click()
    await f.page.getByRole('heading', { name: '保存备用码' }).waitFor()
    const codes = await f.page.locator('#backup-codes li').allTextContents()
    assert.equal(await f.context.cookies().then((cookies) => cookies.length), 0)
    await loginWithBackup(f.page, f.origin, password, codes[0]!)
    await openSecurity(f.page)
    await f.page.getByRole('button', { name: '关闭 TOTP', exact: true }).click()
    const disable = f.page.getByRole('dialog', { name: '关闭 TOTP', exact: true })
    await disable.getByLabel('当前密码').fill(password)
    await disable.getByLabel('当前验证码或备用码').fill(codes[1]!)
    await disable.getByRole('button', { name: '关闭 TOTP', exact: true }).click()
    await f.page.getByRole('heading', { name: '登录', exact: true }).waitFor()
    assert.equal(await f.context.cookies().then((cookies) => cookies.length), 0)
    await f.page.getByLabel('用户名').fill('alice')
    await f.page.getByLabel('密码').fill(password)
    await f.page.getByRole('button', { name: '继续' }).click()
    await f.page.getByRole('button', { name: '跳过，进入 DSH' }).click()
    await f.page.waitForSelector('[class*="frame"]')
    await openSecurity(f.page)
    await f.page.getByRole('button', { name: '退出当前会话', exact: true }).click()
    await f.page
      .getByRole('dialog', { name: '退出当前会话', exact: true })
      .getByRole('button', { name: '退出当前会话', exact: true })
      .click()
    await f.page.getByRole('heading', { name: '登录', exact: true }).waitFor()
  } finally {
    await f.cleanup()
  }
})

test('fifth failed MFA code returns to password login without a session', async () => {
  const f = await fixture(true, 13096)
  try {
    await initialize(f.home)
    await f.page.goto(`${f.origin}/auth-remote/login`)
    await f.page.getByLabel('用户名').fill('alice')
    await f.page.getByLabel('密码').fill(password)
    await f.page.getByRole('button', { name: '继续' }).click()
    await f.page.getByRole('heading', { name: '绑定身份验证器' }).waitFor()
    const secret = (await f.page.locator('#totp-secret').textContent()) ?? ''
    await f.page
      .getByLabel('身份验证器中的 6 位验证码')
      .fill(totpCode(secret, Math.floor(Date.now() / 30_000)))
    await f.page.getByRole('button', { name: '确认绑定' }).click()
    await f.page.getByRole('heading', { name: '保存备用码' }).waitFor()
    await f.page.getByRole('button', { name: '我已保存，重新登录' }).click()
    await f.page.getByLabel('密码').fill(password)
    await f.page.getByRole('button', { name: '继续' }).click()
    await f.page.getByRole('heading', { name: '验证第二因素' }).waitFor()
    await f.page.getByLabel('验证码或备用码').fill('00000000')
    let verifyPosts = 0
    f.page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/auth-remote/mfa/verify') verifyPosts++
    })
    await f.page.evaluate(() => localStorage.setItem('dsh-auth-remote-lang', 'en'))
    await expect(f.page.locator('html')).toHaveAttribute('lang', 'zh')
    await expect(f.page.locator('select')).toHaveCount(0)
    assert.equal(await f.page.getByLabel('验证码或备用码').inputValue(), '00000000')
    assert.equal(verifyPosts, 0)
    await f.page.getByRole('button', { name: '验证并登录' }).click()
    await f.page.getByText('验证码或备用码不正确', { exact: false }).waitFor()
    for (let attempt = 1; attempt < 5; attempt++) {
      await f.page.getByLabel('验证码或备用码').fill('00000000')
      await f.page.getByRole('button', { name: '验证并登录' }).click()
      if (attempt < 4) {
        await f.page.getByText('验证码或备用码不正确').waitFor()
      }
    }
    await f.page.getByRole('heading', { name: '登录', exact: true }).waitFor()
    await f.page.getByText('本次挑战已用尽，请重新输入密码。').waitFor()
    assert.equal(verifyPosts, 5)
    assert.equal(await f.context.cookies().then((cookies) => cookies.length), 0)
    assert.equal(await f.page.evaluate(async () => (await fetch('/auth-remote/me')).status), 401)
  } finally {
    await f.cleanup()
  }
})

test(
  'security settings reverify password changes and TOTP rebinding',
  { timeout: 150000 },
  async () => {
    const f = await fixture(true, 13097)
    const changedPassword = 'changed browser password 789'
    try {
      await initialize(f.home)
      await f.page.goto(`${f.origin}/auth-remote/login`)
      await f.page.getByLabel('用户名').fill('alice')
      await f.page.getByLabel('密码').fill(password)
      await f.page.getByRole('button', { name: '继续' }).click()
      await f.page.getByRole('heading', { name: '绑定身份验证器' }).waitFor()
      const originalSecret = (await f.page.locator('#totp-secret').textContent()) ?? ''
      await f.page
        .getByLabel('身份验证器中的 6 位验证码')
        .fill(totpCode(originalSecret, Math.floor(Date.now() / 30_000)))
      await f.page.getByRole('button', { name: '确认绑定' }).click()
      await f.page.getByRole('heading', { name: '保存备用码' }).waitFor()
      const originalCodes = await f.page.locator('#backup-codes li').allTextContents()
      await loginWithBackup(f.page, f.origin, password, originalCodes[0]!)
      await openSecurity(f.page)
      await f.page.getByRole('button', { name: '修改密码' }).click()
      await f.page.getByLabel('当前密码').fill('draft password')
      await f.page.getByLabel('当前验证码或备用码').fill('draft code')
      await f.page.getByLabel('新密码', { exact: true }).fill('first draft')
      await f.page.getByLabel('再次输入新密码').fill('second draft')
      await f.page.getByRole('button', { name: '保存新密码' }).click()
      await f.page.getByText('两次输入的新密码不一致。', { exact: true }).waitFor()
      await setNativeLocale(f.page, 'en')
      const enSettings = f.page.getByRole('dialog', { name: 'Settings' })
      const passwordDialog = f.page.getByRole('dialog', { name: 'Change password', exact: true })
      await expect(passwordDialog).toBeVisible()
      await passwordDialog.getByText('The new passwords do not match.', { exact: true }).waitFor()
      assert.equal(
        await passwordDialog.getByLabel('Current password').inputValue(),
        'draft password',
      )
      assert.equal(
        await passwordDialog.getByLabel('New password', { exact: true }).inputValue(),
        'first draft',
      )
      const review = join(project, '.cache/ui-review', dshVersion)
      await mkdir(review, { recursive: true })
      await f.page.screenshot({ path: join(review, 'security-password-en-desktop.png') })
      await f.page.setViewportSize({ width: 390, height: 844 })
      await f.page.screenshot({ path: join(review, 'security-password-en-mobile.png') })
      await f.page.setViewportSize({ width: 1280, height: 900 })
      await setNativeLocale(f.page, 'zh')
      await f.page.getByRole('dialog', { name: '修改密码', exact: true }).waitFor()
      await f.page.getByLabel('当前密码').fill(password)
      await f.page.getByLabel('当前验证码或备用码').fill(originalCodes[1]!)
      await f.page.getByLabel('新密码', { exact: true }).fill(changedPassword)
      await f.page.getByLabel('再次输入新密码').fill(changedPassword)
      // Force revocation monitoring to observe 401 before the successful mutation
      // response arrives, rather than depending on CI timing to expose the race.
      const revokedStatus = f.page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/auth-remote/me' && response.status() === 401,
      )
      void revokedStatus.catch(() => {})
      await f.page.route('**/auth-remote/password', async (route) => {
        const upstream = new URL(route.request().url())
        const authority = upstream.host
        upstream.hostname = '127.0.0.1'
        const response = await route.fetch({
          url: upstream.href,
          headers: { ...(await route.request().allHeaders()), host: authority },
        })
        assert.equal(response.status(), 200)
        await revokedStatus
        // Let the monitor consume the 401 while the update response is still withheld.
        await new Promise((resolve) => setTimeout(resolve, 200))
        await route.fulfill({ response })
      })
      await f.page.getByRole('button', { name: '保存新密码' }).click()
      await f.page.getByRole('heading', { name: '登录', exact: true }).waitFor()
      assert.equal(new URL(f.page.url()).searchParams.get('reason'), 'updated')
      await f.page.getByText('安全设置已更新，请重新登录。').waitFor()
      await f.page.unroute('**/auth-remote/password')
      await loginWithBackup(f.page, f.origin, changedPassword, originalCodes[2]!)
      await openSecurity(f.page)
      assert.equal(await f.page.getByRole('button', { name: '关闭 TOTP' }).count(), 0)
      const policy = f.page.getByRole('img', { name: '配置要求开启 TOTP，无法关闭。' })
      await expect(policy).toBeVisible()
      await expect(policy).toHaveAttribute('title', '配置要求开启 TOTP，无法关闭。')
      await policy.focus()
      await expect(policy).toBeFocused()
      const totpRow = f.page.locator('.auth-remote-totp-status')
      assert.ok((await totpRow.boundingBox())!.height <= 24, 'policy help must remain inline')
      await f.page.screenshot({ path: join(review, 'security-totp-required.png') })
      await f.page.getByRole('button', { name: '重新绑定 TOTP' }).click()
      await f.page.getByLabel('当前密码').fill(changedPassword)
      await f.page.getByLabel('当前验证码或备用码').fill(originalCodes[3]!)
      await f.page.getByRole('button', { name: '开始绑定' }).click()
      await f.page.getByRole('heading', { name: '扫描二维码' }).waitFor()
      await f.page.getByRole('img', { name: '身份验证器绑定二维码' }).waitFor()
      const replacementSecret = (
        (await f.page.locator('section[aria-label="安全与登录设置"] code').textContent()) ?? ''
      ).trim()
      assert.ok(replacementSecret !== originalSecret, 'rebind must create a new factor')
      await setNativeLocale(f.page, 'en')
      const rebind = f.page.getByRole('dialog', { name: 'Scan the QR code', exact: true })
      await expect(rebind).toBeVisible()
      assert.equal((await rebind.locator('code').textContent())?.trim(), replacementSecret)
      await rebind
        .getByLabel('Six-digit code from the new authenticator')
        .fill(totpCode(replacementSecret, Math.floor(Date.now() / 30_000)))
      const taskContainer = await rebind.elementHandle()
      assert.ok(taskContainer)
      const backupCodesPoll = f.page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/auth-remote/me' && response.status() === 401,
      )
      await rebind.getByRole('button', { name: 'Confirm setup' }).click()
      await f.page.getByRole('heading', { name: 'Save your backup codes' }).waitFor()
      const codes = await f.page
        .locator('section[aria-label="Security & sign-in settings"] ol li')
        .allTextContents()
      assert.equal(codes.length, 10)
      assert.equal(await f.context.cookies().then((cookies) => cookies.length), 0)
      const reboundState = JSON.parse(
        await readFile(join(f.home, 'profiles/web/auth-remote/auth-state.json'), 'utf8'),
      )
      assert.ok(
        reboundState.account.totp.secret === replacementSecret &&
          reboundState.account.totp.secret !== originalSecret,
        'the completed rebind must atomically retire the previous factor',
      )
      await backupCodesPoll
      assert.equal(await f.page.evaluate(async () => (await fetch('/api/settings')).status), 401)
      const backups = f.page.getByRole('dialog', { name: 'Save your backup codes', exact: true })
      await expect(backups).toBeVisible()
      assert.equal(await backups.evaluate((node, initial) => node === initial, taskContainer), true)
      await expect(backups.getByText('Your previous backup codes no longer work.')).toBeVisible()
      await expect(backups.getByRole('button', { name: 'Close', exact: true })).toHaveCount(0)
      await f.page.keyboard.press('Escape')
      await f.page.mouse.click(2, 2)
      await expect(backups).toBeVisible()
      await assert.rejects(
        enSettings.getByRole('button', { name: 'Close', exact: true }).click({ timeout: 1000 }),
      )
      await expect(backups).toBeVisible()
      await f.page.evaluate(() => {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            async writeText() {
              throw new Error('test clipboard rejection')
            },
          },
        })
      })
      await backups.getByRole('button', { name: 'Copy all', exact: true }).click()
      await expect(backups.getByRole('status')).toContainText('Could not copy')
      assert.equal(
        await backups.locator('ol').evaluate((node) => getComputedStyle(node).userSelect),
        'all',
      )
      await f.page.evaluate(() => {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            async writeText(value: string) {
              ;(window as any).copiedAllCodes =
                value ===
                [...document.querySelectorAll('.auth-remote-backup-codes li')]
                  .map((node) => node.textContent)
                  .join('\n')
            },
          },
        })
      })
      await backups.getByRole('button', { name: 'Copy all', exact: true }).click()
      await expect(backups.getByRole('status')).toContainText('Backup codes copied.')
      assert.equal(await f.page.evaluate(() => (window as any).copiedAllCodes), true)
      await f.page.setViewportSize({ width: 390, height: 844 })
      await f.page.screenshot({
        path: join(review, 'security-backups-en-mobile.png'),
        mask: [backups.locator('ol')],
      })
      // A fresh sign-in in another tab restores the normal native preference channel;
      // the original revoked session has already been rejected above.
      const preferences = await f.context.newPage()
      await loginWithBackup(preferences, f.origin, changedPassword, codes[0]!, 'en')
      await setNativeLocale(preferences, 'zh')
      await openDshSettings(preferences)
      const otherSettings = preferences.getByRole('dialog', { name: '设置', exact: true })
      await clickThroughDshPrompts(
        preferences,
        otherSettings.getByRole('button', { name: '通用设置', exact: true }),
        () => openDshSettings(preferences),
      )
      await selectDshTheme(preferences, 'dark')
      const translatedBackups = f.page.getByRole('dialog', { name: '保存备用码', exact: true })
      await expect(translatedBackups).toBeVisible({ timeout: 45000 })
      assert.ok(
        JSON.stringify(await translatedBackups.locator('ol li').allTextContents()) ===
          JSON.stringify(codes),
        'a native locale update must preserve the one-time codes',
      )
      await expect
        .poll(() =>
          f.page.locator('body').evaluate((node) => node.hasAttribute('data-ds-dark-theme')),
        )
        .toBe(true)
      await f.page.screenshot({
        path: join(review, 'security-backups-zh-dark-mobile.png'),
        mask: [translatedBackups.locator('ol')],
      })
      assert.equal(
        await preferences.evaluate(
          async () => (await fetch('/auth-remote/logout', { method: 'POST' })).status,
        ),
        200,
      )
      await expect(translatedBackups).toBeVisible()
      await translatedBackups
        .getByRole('button', { name: '我已保存，重新登录', exact: true })
        .click()
      await f.page.getByRole('heading', { name: '登录', exact: true }).waitFor()
      await expect(f.page.locator('.auth-remote-backup-codes')).toHaveCount(0)
      await f.page.getByLabel('用户名').fill('alice')
      await f.page.getByLabel('密码').fill(changedPassword)
      await submitWithRateLimit(
        f.page,
        f.page.getByRole('button', { name: '继续', exact: true }),
        '/auth-remote/login',
      )
      await f.page.getByLabel('验证码或备用码').fill(originalCodes[4]!)
      await submitWithRateLimit(
        f.page,
        f.page.getByRole('button', { name: '验证并登录', exact: true }),
        '/auth-remote/mfa/verify',
      )
      await expect(f.page.getByText('验证码或备用码不正确', { exact: false })).toBeVisible()
      await f.page.getByLabel('验证码或备用码').fill(codes[1]!)
      await submitWithRateLimit(
        f.page,
        f.page.getByRole('button', { name: '验证并登录', exact: true }),
        '/auth-remote/mfa/verify',
      )
      await f.page.waitForURL(f.origin + '/')
    } finally {
      await f.cleanup()
    }
  },
)

test('security settings revoke all sessions in two browsers', async () => {
  const f = await fixture(true, 13098)
  let secondContext: BrowserContext | undefined
  try {
    await initialize(f.home)
    await f.page.goto(`${f.origin}/auth-remote/login`)
    await f.page.getByLabel('用户名').fill('alice')
    await f.page.getByLabel('密码').fill(password)
    await f.page.getByRole('button', { name: '继续' }).click()
    await f.page.getByRole('heading', { name: '绑定身份验证器' }).waitFor()
    const secret = (await f.page.locator('#totp-secret').textContent()) ?? ''
    await f.page
      .getByLabel('身份验证器中的 6 位验证码')
      .fill(totpCode(secret, Math.floor(Date.now() / 30_000)))
    await f.page.getByRole('button', { name: '确认绑定' }).click()
    await f.page.getByRole('heading', { name: '保存备用码' }).waitFor()
    const codes = await f.page.locator('#backup-codes li').allTextContents()
    await loginWithBackup(f.page, f.origin, password, codes[0]!)
    secondContext = await f.context.browser()!.newContext({ locale: 'zh-CN' })
    await secondContext.addInitScript(() => {
      try {
        localStorage.setItem('dsh-auth-remote-lang', 'zh')
      } catch {
        /* opaque origins */
      }
    })
    const secondPage = await secondContext.newPage()
    await loginWithBackup(secondPage, f.origin, password, codes[1]!)
    await openSecurity(f.page)
    await f.page.getByRole('button', { name: '退出所有会话', exact: true }).click()
    await f.page.getByLabel('当前密码').fill(password)
    await f.page.getByLabel('当前验证码或备用码').fill(codes[2]!)
    await f.page.getByRole('button', { name: '退出所有会话' }).last().click()
    await f.page.getByRole('heading', { name: '登录', exact: true }).waitFor()
    await secondPage.getByRole('heading', { name: '登录', exact: true }).waitFor({ timeout: 12000 })
    assert.equal(
      await secondPage.evaluate(async () => (await fetch('/auth-remote/me')).status),
      401,
    )
  } finally {
    await secondContext?.close()
    await f.cleanup()
  }
})

async function optionalSignIn(page: Page, origin: string): Promise<void> {
  await page.goto(origin + '/auth-remote/login')
  await page.getByLabel('用户名').fill('alice')
  await page.getByLabel('密码').fill(password)
  await page.getByRole('button', { name: '继续', exact: true }).click()
  await page.getByRole('button', { name: '跳过，进入 DSH', exact: true }).click()
  await page.waitForSelector('[class*="frame"]')
}

test(
  'overview reserves labels while loading and retrying; password dialogs clear drafts and retain failed requests',
  { timeout: 90000 },
  async () => {
    const f = await fixture(false, 13111)
    let releaseOverview: (() => void) | undefined
    try {
      await initialize(f.home)
      await optionalSignIn(f.page, f.origin)
      const overview = await f.page.evaluate(async () => (await fetch('/auth-remote/me')).json())
      const pendingOverview = new Promise<void>((resolve) => {
        releaseOverview = resolve
      })
      await f.page.route('**/auth-remote/me', async (route) => {
        await pendingOverview
        await route.continue()
      })
      await openSecurity(f.page)
      const settings = f.page.getByRole('dialog', { name: '设置', exact: true })
      const summary = settings.locator('.auth-remote-overview')
      const labels = ['DSH 登录用户名', 'TOTP', '本次登录时间', '当前会话到期时间', '有效会话数量']
      await expect(summary).toHaveAttribute('aria-busy', 'true')
      await expect(summary.locator('dt')).toHaveText(labels)
      const details = settings.locator('.auth-remote-overview dd')
      await expect(details).toHaveText(Array(5).fill('—'))
      await expect(settings.getByRole('button', { name: '修改密码', exact: true })).toBeDisabled()
      const loadingBounds = await summary.boundingBox()
      assert.ok(loadingBounds)
      const review = join(project, '.cache', 'ui-review', dshVersion)
      await mkdir(review, { recursive: true })
      await waitForAnimations(f.page)
      await f.page.screenshot({ path: join(review, 'security-overview-loading.png') })
      releaseOverview!()
      await f.page.unrouteAll({ behavior: 'wait' })
      await expect(summary).toHaveAttribute('aria-busy', 'false')
      await expect(details.nth(0)).toHaveText('alice')
      await expect(details.nth(4)).toHaveText(String(overview.activeSessions))
      assert.equal((await summary.boundingBox())!.height, loadingBounds.height)
      const displayed = await f.page.evaluate(
        (createdAt) =>
          new Intl.DateTimeFormat('zh', { dateStyle: 'medium', timeStyle: 'short' }).format(
            createdAt,
          ),
        overview.createdAt,
      )
      await expect(details.nth(2)).toHaveText(displayed)
      await settings.getByRole('button', { name: '关闭', exact: true }).click()
      await f.page.route('**/auth-remote/me', (route) => route.fulfill({ status: 200, json: {} }))
      await openSecurity(f.page)
      await expect(summary.locator('dt')).toHaveText(labels)
      await expect(details).toHaveText(Array(5).fill('—'))
      assert.equal((await summary.boundingBox())!.height, loadingBounds.height)
      await expect(settings.getByRole('button', { name: '修改密码', exact: true })).toBeDisabled()
      await expect(settings.getByRole('alert')).toContainText('服务暂时不可用')
      await f.page.unroute('**/auth-remote/me')
      await settings.getByRole('button', { name: '重试', exact: true }).click()
      const trigger = settings.getByRole('button', { name: '修改密码', exact: true })
      await expect(trigger).toBeEnabled()
      await trigger.click()
      let dialog = f.page.getByRole('dialog', { name: '修改密码', exact: true })
      await expect(dialog.getByLabel('当前验证码或备用码')).toHaveCount(0)
      await dialog.getByLabel('当前密码').fill('wrong password')
      await dialog.getByLabel('新密码', { exact: true }).fill('new optional password 456')
      await dialog.getByLabel('再次输入新密码').fill('new optional password 456')
      await dialog.getByRole('button', { name: '保存新密码' }).click()
      await expect(dialog.getByRole('alert')).toContainText('当前密码不正确')
      assert.equal(await f.page.evaluate(async () => (await fetch('/auth-remote/me')).status), 200)
      await dialog.getByRole('button', { name: '取消', exact: true }).click()
      await expect(trigger).toBeFocused()
      await trigger.click()
      dialog = f.page.getByRole('dialog', { name: '修改密码', exact: true })
      await expect(dialog.getByLabel('当前密码')).toHaveValue('')
      await expect(dialog.getByLabel('新密码', { exact: true })).toHaveValue('')
      for (let i = 0; i < 8; i++) {
        await f.page.keyboard.press('Tab')
        assert.equal(await dialog.evaluate((node) => node.contains(document.activeElement)), true)
      }
      await f.page.keyboard.press('Escape')
      await expect(dialog).not.toBeVisible()
      await expect(trigger).toBeFocused()
      await expect(settings).toBeVisible()
    } finally {
      releaseOverview?.()
      await f.cleanup()
    }
  },
)

for (const action of ['current', 'all'] as const)
  test(
    `optional TOTP session operation ${action} verifies the exact intended sessions`,
    { timeout: 90000 },
    async () => {
      const f = await fixture(false, action === 'current' ? 13112 : 13113)
      let second: BrowserContext | undefined
      try {
        await initialize(f.home)
        await optionalSignIn(f.page, f.origin)
        await openSecurity(f.page)
        second = await f.context.browser()!.newContext({ locale: 'zh-CN' })
        await second.addInitScript(() => {
          try {
            localStorage.setItem('dsh-auth-remote-lang', 'zh')
          } catch {
            /* The standalone page will read this after navigation. */
          }
        })
        const other = await second.newPage()
        await optionalSignIn(other, f.origin)
        const me = async (page: Page) =>
          page.evaluate(async () => {
            const response = await fetch('/auth-remote/me')
            return { status: response.status, value: await response.json() }
          })
        assert.equal((await me(f.page)).value.activeSessions, 2)
        const name = action === 'current' ? '退出当前会话' : '退出所有会话'
        const trigger = f.page
          .getByRole('dialog', { name: '设置', exact: true })
          .getByRole('button', { name, exact: true })
        await trigger.click()
        let dialog = f.page.getByRole('dialog', { name, exact: true })
        if (action === 'current') {
          await expect(dialog.locator('input')).toHaveCount(0)
          await dialog.getByRole('button', { name: '取消', exact: true }).click()
          await expect(trigger).toBeFocused()
          assert.equal((await me(f.page)).value.activeSessions, 2)
          await trigger.click()
          dialog = f.page.getByRole('dialog', { name, exact: true })
        } else {
          await expect(dialog.getByLabel('当前验证码或备用码')).toHaveCount(0)
          await dialog.getByLabel('当前密码').fill('wrong password')
          await dialog.getByRole('button', { name, exact: true }).click()
          await expect(dialog.getByRole('alert')).toContainText('当前密码不正确')
          assert.equal((await me(other)).value.activeSessions, 2)
          await dialog.getByLabel('当前密码').fill(password)
          const posted = f.page.waitForRequest(
            (request) => new URL(request.url()).pathname === '/auth-remote/revoke-sessions',
          )
          await dialog.getByRole('button', { name, exact: true }).click()
          assert.deepEqual(Object.keys((await posted).postDataJSON()), ['password'])
        }
        if (action === 'current') await dialog.getByRole('button', { name, exact: true }).click()
        await f.page.getByRole('heading', { name: '登录', exact: true }).waitFor()
        const remaining = await me(other)
        assert.equal(remaining.status, action === 'current' ? 200 : 401)
        if (action === 'current') assert.equal(remaining.value.activeSessions, 1)
      } finally {
        await second?.close()
        await f.cleanup()
      }
    },
  )

test(
  'TOTP task dialogs preserve old factors on cancel and errors, then show first-time backup codes once',
  { timeout: 150000 },
  async () => {
    const f = await fixture(false, 13114)
    try {
      await initialize(f.home)
      await optionalSignIn(f.page, f.origin)
      await openSecurity(f.page)
      const trigger = f.page.getByRole('button', { name: '开启 TOTP', exact: true })
      await expect(f.page.getByRole('button', { name: '关闭 TOTP', exact: true })).toHaveCount(0)
      await trigger.click()
      let dialog = f.page.getByRole('dialog', { name: '开启 TOTP', exact: true })
      await expect(dialog.getByLabel('当前验证码或备用码')).toHaveCount(0)
      await dialog.getByLabel('当前密码').fill('wrong password')
      await dialog.getByRole('button', { name: '开始绑定' }).click()
      await expect(dialog.getByRole('alert')).toContainText('当前密码不正确')
      await dialog.getByLabel('当前密码').fill(password)
      await dialog.getByRole('button', { name: '开始绑定' }).click()
      dialog = f.page.getByRole('dialog', { name: '扫描二维码', exact: true })
      await expect(dialog.getByRole('img', { name: '身份验证器绑定二维码' })).toBeVisible()
      const abandoned = (await dialog.locator('code').textContent())!.trim()
      await dialog.getByRole('button', { name: '取消', exact: true }).click()
      await expect(trigger).toBeFocused()
      await trigger.click()
      dialog = f.page.getByRole('dialog', { name: '开启 TOTP', exact: true })
      await expect(dialog.getByLabel('当前密码')).toHaveValue('')
      await expect(dialog.locator('code')).toHaveCount(0)
      await dialog.getByLabel('当前密码').fill(password)
      await dialog.getByRole('button', { name: '开始绑定' }).click()
      dialog = f.page.getByRole('dialog', { name: '扫描二维码', exact: true })
      const activeSecret = (await dialog.locator('code').textContent())!.trim()
      assert.ok(activeSecret !== abandoned, 'a new setup must not reuse cancelled sensitive drafts')
      await dialog.getByLabel('新身份验证器的 6 位验证码').fill('invalid')
      await dialog.getByRole('button', { name: '确认绑定', exact: true }).click()
      await expect(dialog.getByRole('alert')).toContainText('验证码或备用码不正确')
      assert.equal(
        await f.page.evaluate(
          async () => (await (await fetch('/auth-remote/me')).json()).totpEnabled,
        ),
        false,
      )
      await dialog
        .getByLabel('新身份验证器的 6 位验证码')
        .fill(totpCode(activeSecret, Math.floor(Date.now() / 30_000)))
      await dialog.getByRole('button', { name: '确认绑定', exact: true }).click()
      const backups = f.page.getByRole('dialog', { name: '保存备用码', exact: true })
      await expect(backups).toBeVisible()
      await expect(backups.getByText('旧备用码已失效。')).toHaveCount(0)
      const codes = await backups.locator('ol li').allTextContents()
      assert.equal(codes.length, 10)
      await backups.getByRole('button', { name: '我已保存，重新登录', exact: true }).click()
      await loginWithBackup(f.page, f.origin, password, codes[0]!)
      await openSecurity(f.page)
      await expect(f.page.getByRole('button', { name: '开启 TOTP', exact: true })).toHaveCount(0)
      await expect(f.page.getByRole('button', { name: '关闭 TOTP', exact: true })).toBeVisible()
      await f.page.getByRole('button', { name: '重新绑定 TOTP', exact: true }).click()
      dialog = f.page.getByRole('dialog', { name: '重新绑定 TOTP', exact: true })
      await dialog.getByLabel('当前密码').fill('wrong password')
      await dialog.getByLabel('当前验证码或备用码').fill(codes[1]!)
      await dialog.getByRole('button', { name: '开始绑定' }).click()
      await expect(dialog.getByRole('alert')).toContainText('当前密码不正确')
      await dialog.getByLabel('当前密码').fill(password)
      await dialog.getByLabel('当前验证码或备用码').fill('invalid')
      await dialog.getByRole('button', { name: '开始绑定' }).click()
      await expect(dialog.getByRole('alert')).toContainText('验证码或备用码不正确')
      await dialog.getByLabel('当前验证码或备用码').fill(codes[1]!)
      await submitWithRateLimit(
        f.page,
        dialog.getByRole('button', { name: '开始绑定' }),
        '/auth-remote/totp/start',
      )
      dialog = f.page.getByRole('dialog', { name: '扫描二维码', exact: true })
      await expect(dialog).toBeVisible()
      await dialog.getByRole('button', { name: '取消', exact: true }).click()
      const state = JSON.parse(
        await readFile(join(f.home, 'profiles/web/auth-remote/auth-state.json'), 'utf8'),
      )
      assert.ok(
        state.account.totp.secret === activeSecret,
        'cancelling a rebind must retain the active authenticator',
      )
      assert.equal(await f.page.evaluate(async () => (await fetch('/auth-remote/me')).status), 200)
    } finally {
      await f.cleanup()
    }
  },
)

test('official plugin settings persist through the guarded remote browser', async () => {
  const f = await fixture(false, 13099)
  try {
    await initialize(f.home)
    await f.page.goto(`${f.origin}/auth-remote/login`)
    await f.page.getByLabel('用户名').fill('alice')
    await f.page.getByLabel('密码').fill(password)
    await f.page.getByRole('button', { name: '继续' }).click()
    await f.page.getByRole('button', { name: '跳过，进入 DSH' }).click()
    await f.page.waitForSelector('[class*="frame"]')
    const notice = f.page.getByRole('dialog', { name: /^(?:内测声明|预览版说明)$/u })
    await notice.waitFor()
    await notice.getByRole('button', { name: '继续' }).click()
    await notice.waitFor({ state: 'hidden' })
    await completeApiKeyPrompt(f.page, 5000)
    await f.page.waitForSelector('[class*="frame"]')
    await clickThroughDshPrompts(f.page, f.page.getByRole('button', { name: '选择工作区' }))
    const directory = f.page.getByRole('dialog', { name: '选择工作区目录' })
    const addWorkspace = f.page.getByText('添加工作区…', { exact: true })
    await Promise.any([
      directory.waitFor({ timeout: 10_000 }),
      addWorkspace.waitFor({ timeout: 10_000 }),
    ])
    if (await addWorkspace.isVisible()) await addWorkspace.click()
    await directory.getByRole('button', { name: '新建文件夹' }).waitFor()
    await directory.getByRole('button', { name: '取消' }).click()
    await directory.waitFor({ state: 'hidden' })
    await clickThroughDshPrompts(f.page, f.page.getByRole('button', { name: '插件', exact: true }))
    await clickThroughDshPrompts(f.page, f.page.getByRole('button', { name: /^(?:查看 )?终端$/u }))
    const timeout = f.page.getByLabel('命令超时（毫秒）')
    const original = Number(await timeout.inputValue())
    const updated = Math.max(original || 0, 60000) + 1000
    await timeout.fill(String(updated))
    const mutate = f.page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/settings/mutate',
    )
    await f.page.getByRole('button', { name: '保存', exact: true }).click()
    const response = await mutate
    assert.equal(response.status(), 200)
    assert.equal((await response.json()).result.ok, true)
    await f.page.reload()
    await f.page.waitForSelector('[class*="frame"]')
    await clickThroughDshPrompts(f.page, f.page.getByRole('button', { name: '插件', exact: true }))
    await clickThroughDshPrompts(f.page, f.page.getByRole('button', { name: /^(?:查看 )?终端$/u }))
    assert.equal(await f.page.getByLabel('命令超时（毫秒）').inputValue(), String(updated))
    await openDshSettings(f.page)
    const settings = f.page.getByRole('dialog', { name: '设置' })
    await settings.getByRole('button', { name: '模型', exact: true }).click()
    await settings.getByText('DeepSeek', { exact: true }).waitFor()
    await settings.getByRole('button', { name: /编辑/u }).click()
    await settings.getByText('自定义设置', { exact: true }).click()
    assert.equal(await settings.getByLabel('API 地址').inputValue(), f.model.baseURL)
    const modelAddress = f.model.baseURL + '/persisted'
    await settings.getByLabel('API 地址').fill(modelAddress)
    const modelMutate = f.page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/settings/mutate',
    )
    await settings.getByRole('button', { name: '保存', exact: true }).click()
    const modelResponse = await modelMutate
    assert.equal(modelResponse.status(), 200)
    assert.equal((await modelResponse.json()).result.ok, true)
    await f.page.reload()
    await f.page.waitForSelector('[class*="frame"]')
    await openDshSettings(f.page)
    const renewed = f.page.getByRole('dialog', { name: '设置' })
    await clickThroughDshPrompts(
      f.page,
      renewed.getByRole('button', { name: '模型', exact: true }),
      () => openDshSettings(f.page),
    )
    await renewed.getByRole('button', { name: /编辑/u }).click()
    await renewed.getByText('自定义设置', { exact: true }).click()
    assert.equal(await renewed.getByLabel('API 地址').inputValue(), modelAddress)
    await renewed.getByRole('button', { name: '通用设置' }).click()
    await selectDshTheme(f.page, 'light')
    await renewed.getByRole('button', { name: '安全与登录', exact: true }).click()
    const security = renewed.locator('section[aria-label="安全与登录设置"]')
    await security.waitFor()
    const light = await security.evaluate((node) => getComputedStyle(node).color)
    await renewed.getByRole('button', { name: '通用设置' }).click()
    await selectDshTheme(f.page, 'dark')
    await renewed.getByRole('button', { name: '安全与登录', exact: true }).click()
    await expect(security).not.toHaveCSS('color', light)
    const dark = await security.evaluate((node) => getComputedStyle(node).color)
    assert.notEqual(light, dark)
  } finally {
    await f.cleanup()
  }
})
