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
import { totpCode } from '../../src/auth/totp.js'
import {
  archive,
  clickThroughDshPrompts,
  completeApiKeyPrompt,
  dsh,
  launchBrowser,
  openDshSettings,
  selectDshTheme,
  waitForAnimations,
} from '../helpers/runtime.js'
import { dshVersion, project } from '../../scripts/runtime.mjs'

const password = 'browser test password 123'
const hostName = 'auth-remote.test'

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

async function command(bin: string, args: string[], home: string): Promise<void> {
  const child = spawn(bin, args, {
    cwd: home,
    env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' },
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
  const args = [
    dsh,
    'plugin',
    '--profile',
    'web',
    'exec',
    'dsh-auth-remote',
    'init',
    '--lang',
    'zh',
  ]
  const child = spawn('script', ['-q', '-e', '-f', '-c', args.map(quote).join(' '), '/dev/null'], {
    cwd: home,
    env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const prompts = [
    ['用户名: ', 'alice'],
    ['密码: ', password],
    ['再次输入密码: ', password],
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

async function fixture(
  requireTotp: boolean,
  port: number,
  storedLocale: 'en' | 'zh' | null = 'zh',
) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-auth-remote-browser-login-'))
  const profile = join(home, 'profiles/web')
  const origin = `http://${hostName}:${port}`
  const runtimeEnv: NodeJS.ProcessEnv = {
    ...process.env,
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
  }
  // A fresh profile must not inherit model credentials from the developer's shell.
  delete runtimeEnv.DEEPSEEK_API_KEY
  let server: ReturnType<typeof spawn> | undefined
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    await command(dsh, ['plugin', '--profile', 'web', 'add', archive], home)
    await writeFile(
      join(profile, 'cordis.patch.yml'),
      [
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
          if (localStorage.getItem('dsh-auth-remote.locale') === null)
            localStorage.setItem('dsh-auth-remote.locale', value)
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
      cleanup: async () => {
        await browser?.close()
        if (server && server.exitCode === null && server.signalCode === null) {
          server.kill('SIGTERM')
          await once(server, 'exit').catch(() => {})
        }
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
    await rm(home, { recursive: true, force: true })
    throw error
  }
}

async function setNativeLocale(page: Page, preference: 'zh' | 'en'): Promise<void> {
  const result = await page.evaluate(async (preference) => {
    const described = await (
      await fetch('/api/settings/describe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'locale-read-' + Date.now(),
          method: 'settings/describe',
          payload: { args: {} },
        }),
      })
    ).json()
    const locale = described.result.value.namespaces.find((entry: any) => entry.ns === 'locale')
    return (
      await fetch('/api/settings/mutate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'locale-write-' + Date.now(),
          method: 'settings/mutate',
          payload: {
            args: {
              ns: 'locale',
              ops: [{ op: 'set', path: ['preference'], value: preference }],
              expectedRevision: locale.revision,
            },
          },
        }),
      })
    ).json()
  }, preference)
  assert.equal(result.result.ok, true)
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
): Promise<void> {
  await page.goto(`${origin}/auth-remote/login`)
  await page.getByRole('heading', { name: '登录', exact: true }).waitFor()
  await page.getByLabel('用户名').fill('alice')
  await page.getByLabel('密码').fill(currentPassword)
  await submitWithRateLimit(page, page.getByRole('button', { name: '继续' }), '/auth-remote/login')
  await page.getByRole('heading', { name: '验证第二因素' }).waitFor()
  await page.getByLabel('验证码或备用码').fill(code)
  await submitWithRateLimit(
    page,
    page.getByRole('button', { name: '验证并登录' }),
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

test('standalone login defaults to English and persists only its own language choice', async () => {
  const f = await fixture(false, 13110, null)
  try {
    await initialize(f.home)
    const response = await f.page.goto(`${f.origin}/auth-remote/login`)
    assert.match(await response!.text(), /<html lang="en">/u)
    await f.page.getByRole('heading', { name: 'Sign in', exact: true }).waitFor()
    assert.equal(await f.page.title(), 'Sign in')
    await expect(f.page.locator('h1')).toHaveCount(1)
    await expect(f.page.locator('.brand, [data-i18n="loginDescription"]')).toHaveCount(0)
    await expect(
      f.page.getByText('Enter the single-user account created in the server terminal.'),
    ).toHaveCount(0)
    assert.equal(await f.page.locator('html').getAttribute('lang'), 'en')
    await f.page.evaluate(() => localStorage.setItem('dsh-auth-remote.locale', 'invalid'))
    await f.page.reload()
    await f.page.getByRole('heading', { name: 'Sign in', exact: true }).waitFor()
    await f.page.getByLabel('Username').fill('alice')
    await f.page.getByLabel('Password').fill('unsent secret')
    let loginPosts = 0
    f.page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/auth-remote/login' && request.method() === 'POST')
        loginPosts++
    })
    await f.page.getByLabel('Language').selectOption('zh')
    await f.page.getByRole('heading', { name: '登录', exact: true }).waitFor()
    await expect(f.page.locator('h1')).toHaveText('登录')
    await expect(f.page.getByText('DSH · 远程登录')).toHaveCount(0)
    await expect(f.page.getByText('输入服务器终端创建的单用户账号。')).toHaveCount(0)
    assert.equal(await f.page.getByLabel('用户名').inputValue(), 'alice')
    assert.equal(await f.page.getByLabel('密码').inputValue(), 'unsent secret')
    assert.equal(loginPosts, 0)
    assert.equal(await f.page.locator('html').getAttribute('lang'), 'zh')
    assert.equal(await f.page.title(), '登录')
    assert.deepEqual(
      await f.page.evaluate(() =>
        Object.keys(localStorage).filter((key) => key.startsWith('dsh-auth-remote')),
      ),
      ['dsh-auth-remote.locale'],
    )
    await f.page.reload()
    await f.page.getByRole('heading', { name: '登录', exact: true }).waitFor()
    assert.equal(await f.page.getByLabel('密码').inputValue(), '')
    await f.page.getByLabel('语言').selectOption('en')
    await f.page.getByRole('heading', { name: 'Sign in', exact: true }).waitFor()
    await f.page.getByLabel('Username').fill('alice')
    await f.page.getByLabel('Password').fill(password)
    await f.page.getByRole('button', { name: 'Continue' }).click()
    await f.page.getByRole('heading', { name: 'Protect your account' }).waitFor()
    await f.page.getByRole('button', { name: 'Skip and enter DSH' }).click()
    await f.page.waitForSelector('[class*="frame"]')
  } finally {
    await f.cleanup()
  }
})

test('standalone language switch works when localStorage is blocked', async () => {
  const f = await fixture(false, 13111, null)
  try {
    await initialize(f.home)
    await f.context.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() {
          throw new DOMException('blocked', 'SecurityError')
        },
      })
    })
    await f.page.goto(`${f.origin}/auth-remote/login`)
    await f.page.getByRole('heading', { name: 'Sign in', exact: true }).waitFor()
    await f.page.getByLabel('Language').selectOption('zh')
    await f.page.getByRole('heading', { name: '登录', exact: true }).waitFor()
    await f.page.reload()
    await f.page.getByRole('heading', { name: 'Sign in', exact: true }).waitFor()
  } finally {
    await f.cleanup()
  }
})

test('fresh profile guides CLI init, then forces QR binding and full MFA login', async () => {
  const f = await fixture(true, 13094)
  try {
    await f.page.goto(`${f.origin}/?source=login-test`)
    await f.page.getByRole('heading', { name: '先初始化账号' }).waitFor()
    await f.page.getByLabel('语言').selectOption('en')
    await f.page.getByRole('heading', { name: 'Set up your account first' }).waitFor()
    await f.page.getByRole('button', { name: 'Copy command' }).click()
    assert.match(
      (await f.page.locator('#message').textContent()) ?? '',
      /Command copied|Select and copy/u,
    )
    await f.page.getByLabel('Language').selectOption('zh')
    assert.match((await f.page.locator('#message').textContent()) ?? '', /命令已复制|请手动选择/u)
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
    await f.page.getByLabel('语言').selectOption('en')
    await f.page.getByRole('heading', { name: 'Connect an authenticator' }).waitFor()
    assert.equal(await f.page.locator('#totp-secret').textContent(), secret)
    await f.page.getByLabel('Six-digit code from the authenticator').fill('123456')
    await f.page.getByLabel('Language').selectOption('zh')
    assert.equal(await f.page.getByLabel('身份验证器中的 6 位验证码').inputValue(), '123456')
    assert.equal(await f.page.locator('#totp-qr').getAttribute('data-probe'), 'same-canvas')
    await f.page.getByLabel('语言').selectOption('en')
    await f.page
      .getByLabel('Six-digit code from the authenticator')
      .fill(totpCode(secret, Math.floor(Date.now() / 30_000)))
    await f.page.getByRole('button', { name: 'Confirm setup' }).click()
    await f.page.getByRole('heading', { name: 'Save your backup codes' }).waitFor()
    const codes = await f.page.locator('#backup-codes li').allTextContents()
    assert.equal(codes.length, 10)
    await f.page.getByLabel('Language').selectOption('zh')
    assert.deepEqual(await f.page.locator('#backup-codes li').allTextContents(), codes)
    assert.equal(await f.context.cookies().then((cookies) => cookies.length), 0)
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
    await f.page.getByLabel('语言').selectOption('en')
    await f.page.getByRole('heading', { name: 'Verify your second factor' }).waitFor()
    assert.equal(await f.page.getByLabel('Verification or backup code').inputValue(), '00000000')
    assert.equal(verifyPosts, 0)
    await f.page.getByRole('button', { name: 'Verify and sign in' }).click()
    await f.page
      .getByText('The verification or backup code is incorrect', { exact: false })
      .waitFor()
    await f.page.getByLabel('Language').selectOption('zh')
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
      await loginWithBackup(preferences, f.origin, changedPassword, codes[0]!)
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
        localStorage.setItem('dsh-auth-remote.locale', 'zh')
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
            localStorage.setItem('dsh-auth-remote.locale', 'zh')
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
    const modelAddress = 'https://example.invalid/anthropic'
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
