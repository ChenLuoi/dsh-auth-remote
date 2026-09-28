import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { chromium, expect, type BrowserContext, type Locator, type Page } from '@playwright/test'
import { totpCode } from '../../src/auth/totp.js'
import { archive, dsh, launchBrowser } from '../helpers/runtime.js'

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
      env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' },
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

async function openSecurity(page: Page): Promise<void> {
  const notice = page.getByRole('dialog', { name: '内测声明' })
  async function clickAfterNotice(target: Locator): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await notice.isVisible()) await notice.getByRole('button', { name: '继续' }).click()
      try {
        await target.click({ timeout: 3000 })
        return
      } catch (error) {
        if (attempt === 2 || !(await notice.isVisible())) throw error
      }
    }
  }
  await clickAfterNotice(page.getByRole('button', { name: '设置', exact: true }))
  const settings = page.getByRole('dialog', { name: '设置' })
  await clickAfterNotice(settings.getByText('安全', { exact: true }))
  await settings.getByRole('heading', { name: '账号安全' }).waitFor()
}

async function loginWithBackup(
  page: Page,
  origin: string,
  currentPassword: string,
  code: string,
): Promise<void> {
  await page.goto(`${origin}/auth-remote/login`)
  await page.getByRole('heading', { name: '登录 DSH' }).waitFor()
  await page.getByLabel('用户名').fill('alice')
  await page.getByLabel('密码').fill(currentPassword)
  await page.getByRole('button', { name: '继续' }).click()
  await page.getByRole('heading', { name: '验证第二因素' }).waitFor()
  await page.getByLabel('验证码或备用码').fill(code)
  await page.getByRole('button', { name: '验证并登录' }).click()
  await page.waitForURL(`${origin}/`, { timeout: 8000 }).catch(async () => {
    throw new Error(
      `backup login did not return to DSH: ${JSON.stringify({ url: page.url(), body: (await page.locator('body').innerText()).slice(0, 500) })}`,
    )
  })
  await page.waitForSelector('[class*="frame"]')
}

test('standalone login defaults to English and persists only its own language choice', async () => {
  const f = await fixture(false, 13110, null)
  try {
    await initialize(f.home)
    const response = await f.page.goto(`${f.origin}/auth-remote/login`)
    assert.match(await response!.text(), /<html lang="en">/u)
    await f.page.getByRole('heading', { name: 'Sign in to DSH' }).waitFor()
    assert.equal(await f.page.title(), 'Sign in to DSH')
    assert.equal(await f.page.locator('html').getAttribute('lang'), 'en')
    await f.page.evaluate(() => localStorage.setItem('dsh-auth-remote.locale', 'invalid'))
    await f.page.reload()
    await f.page.getByRole('heading', { name: 'Sign in to DSH' }).waitFor()
    await f.page.getByLabel('Username').fill('alice')
    await f.page.getByLabel('Password').fill('unsent secret')
    let loginPosts = 0
    f.page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/auth-remote/login' && request.method() === 'POST')
        loginPosts++
    })
    await f.page.getByLabel('Language').selectOption('zh')
    await f.page.getByRole('heading', { name: '登录 DSH' }).waitFor()
    assert.equal(await f.page.getByLabel('用户名').inputValue(), 'alice')
    assert.equal(await f.page.getByLabel('密码').inputValue(), 'unsent secret')
    assert.equal(loginPosts, 0)
    assert.equal(await f.page.locator('html').getAttribute('lang'), 'zh')
    assert.equal(await f.page.title(), '登录 DSH')
    assert.deepEqual(
      await f.page.evaluate(() =>
        Object.keys(localStorage).filter((key) => key.startsWith('dsh-auth-remote')),
      ),
      ['dsh-auth-remote.locale'],
    )
    await f.page.reload()
    await f.page.getByRole('heading', { name: '登录 DSH' }).waitFor()
    assert.equal(await f.page.getByLabel('密码').inputValue(), '')
    await f.page.getByLabel('语言').selectOption('en')
    await f.page.getByRole('heading', { name: 'Sign in to DSH' }).waitFor()
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
    await f.page.getByRole('heading', { name: 'Sign in to DSH' }).waitFor()
    await f.page.getByLabel('Language').selectOption('zh')
    await f.page.getByRole('heading', { name: '登录 DSH' }).waitFor()
    await f.page.reload()
    await f.page.getByRole('heading', { name: 'Sign in to DSH' }).waitFor()
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
    await f.page.getByRole('heading', { name: '登录 DSH' }).waitFor()
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
    await f.page.getByRole('heading', { name: '登录 DSH' }).waitFor()
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
    await f.page.getByRole('heading', { name: '登录 DSH' }).waitFor()
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
    await f.page.getByRole('button', { name: '重新绑定 TOTP' }).click()
    await f.page.getByRole('heading', { name: '关闭 TOTP' }).waitFor()
    await f.page.getByLabel('当前密码').last().fill(password)
    await f.page.getByLabel('当前验证码或备用码').last().fill(codes[1]!)
    await f.page.getByRole('button', { name: '关闭 TOTP' }).click()
    await f.page.getByRole('heading', { name: '登录 DSH' }).waitFor()
    assert.equal(await f.context.cookies().then((cookies) => cookies.length), 0)
    await f.page.getByLabel('用户名').fill('alice')
    await f.page.getByLabel('密码').fill(password)
    await f.page.getByRole('button', { name: '继续' }).click()
    await f.page.getByRole('button', { name: '跳过，进入 DSH' }).click()
    await f.page.waitForSelector('[class*="frame"]')
    await openSecurity(f.page)
    await f.page.getByRole('button', { name: '会话管理' }).click()
    await f.page.getByRole('button', { name: '退出当前设备' }).click()
    await f.page.getByRole('heading', { name: '登录 DSH' }).waitFor()
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
    await f.page.getByRole('heading', { name: '登录 DSH' }).waitFor()
    await f.page.getByText('本次挑战已用尽，请重新输入密码。').waitFor()
    assert.equal(verifyPosts, 5)
    assert.equal(await f.context.cookies().then((cookies) => cookies.length), 0)
    assert.equal(await f.page.evaluate(async () => (await fetch('/auth-remote/me')).status), 401)
  } finally {
    await f.cleanup()
  }
})

test('security settings reverify password changes and TOTP rebinding', async () => {
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
    const zhSettings = f.page.getByRole('dialog', { name: '设置' })
    await zhSettings.getByRole('button', { name: '通用设置' }).click()
    await zhSettings.getByRole('button', { name: '中文', exact: true }).click()
    await f.page.getByRole('menuitem', { name: 'English' }).click()
    const enSettings = f.page.getByRole('dialog', { name: 'Settings' })
    await enSettings.getByText('Security', { exact: true }).click()
    await enSettings.getByRole('heading', { name: 'Account security' }).waitFor()
    await enSettings.getByText('The new passwords do not match.', { exact: true }).waitFor()
    assert.equal(await enSettings.getByLabel('Current password').inputValue(), 'draft password')
    assert.equal(
      await enSettings.getByLabel('New password', { exact: true }).inputValue(),
      'first draft',
    )
    await enSettings.getByRole('button', { name: 'General', exact: true }).click()
    await enSettings.getByRole('button', { name: 'English', exact: true }).click()
    await f.page.getByRole('menuitem', { name: '中文' }).click()
    await zhSettings.getByText('安全', { exact: true }).click()
    await zhSettings.getByRole('heading', { name: '账号安全' }).waitFor()
    await f.page.getByLabel('当前密码').fill(password)
    await f.page.getByLabel('当前验证码或备用码').fill(originalCodes[1]!)
    await f.page.getByLabel('新密码', { exact: true }).fill(changedPassword)
    await f.page.getByLabel('再次输入新密码').fill(changedPassword)
    await f.page.getByRole('button', { name: '保存新密码' }).click()
    await f.page.getByRole('heading', { name: '登录 DSH' }).waitFor()
    await f.page.getByText('安全设置已更新，请重新登录。').waitFor()
    await loginWithBackup(f.page, f.origin, changedPassword, originalCodes[2]!)
    await openSecurity(f.page)
    assert.equal(await f.page.getByRole('button', { name: '关闭 TOTP' }).count(), 0)
    await f.page.getByRole('button', { name: '重新绑定 TOTP' }).click()
    await f.page.getByLabel('当前密码').fill(changedPassword)
    await f.page.getByLabel('当前验证码或备用码').fill(originalCodes[3]!)
    await f.page.getByRole('button', { name: '开始绑定' }).click()
    await f.page.getByRole('heading', { name: '扫描二维码' }).waitFor()
    await f.page.getByRole('img', { name: '身份验证器绑定二维码' }).waitFor()
    const replacementSecret = (
      (await f.page.locator('section[aria-label="安全设置"] code').textContent()) ?? ''
    ).trim()
    assert.notEqual(replacementSecret, originalSecret)
    await zhSettings.getByRole('button', { name: '通用设置' }).click()
    await zhSettings.getByRole('button', { name: '中文', exact: true }).click()
    await f.page.getByRole('menuitem', { name: 'English' }).click()
    await enSettings.getByText('Security', { exact: true }).click()
    await enSettings.getByRole('heading', { name: 'Scan the QR code' }).waitFor()
    assert.equal(
      (
        await enSettings.locator('section[aria-label="Security settings"] code').textContent()
      )?.trim(),
      replacementSecret,
    )
    await enSettings
      .getByLabel('Six-digit code from the new authenticator')
      .fill(totpCode(replacementSecret, Math.floor(Date.now() / 30_000)))
    await enSettings.getByRole('button', { name: 'Confirm setup' }).click()
    await f.page.getByRole('heading', { name: 'Save your backup codes' }).waitFor()
    const codes = await f.page
      .locator('section[aria-label="Security settings"] ol li')
      .allTextContents()
    assert.equal(codes.length, 10)
    assert.equal(await f.context.cookies().then((cookies) => cookies.length), 0)
    await f.page.getByRole('button', { name: 'I saved them; sign in again' }).click()
    await f.page.getByRole('heading', { name: '登录 DSH' }).waitFor()
  } finally {
    await f.cleanup()
  }
})

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
    await f.page.getByRole('button', { name: '会话管理' }).click()
    await f.page.getByLabel('当前密码').fill(password)
    await f.page.getByLabel('当前验证码或备用码').fill(codes[2]!)
    await f.page.getByRole('button', { name: '退出全部设备' }).last().click()
    await f.page.getByRole('heading', { name: '登录 DSH' }).waitFor()
    await secondPage.getByRole('heading', { name: '登录 DSH' }).waitFor({ timeout: 12000 })
    assert.equal(
      await secondPage.evaluate(async () => (await fetch('/auth-remote/me')).status),
      401,
    )
  } finally {
    await secondContext?.close()
    await f.cleanup()
  }
})

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
    const notice = f.page.getByRole('dialog', { name: '内测声明' })
    await notice.waitFor()
    await notice.getByRole('button', { name: '继续' }).click()
    await notice.waitFor({ state: 'hidden' })
    await f.page.getByRole('button', { name: '选择工作区' }).click()
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
    await f.page.getByRole('button', { name: '插件', exact: true }).click()
    await f.page.getByRole('button', { name: /终端/u }).click()
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
    await f.page.getByRole('button', { name: '插件', exact: true }).click()
    await f.page.getByRole('button', { name: /终端/u }).click()
    assert.equal(await f.page.getByLabel('命令超时（毫秒）').inputValue(), String(updated))
    await f.page.getByRole('button', { name: '设置', exact: true }).click()
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
    await f.page.getByRole('button', { name: '设置', exact: true }).click()
    const renewed = f.page.getByRole('dialog', { name: '设置' })
    await renewed.getByRole('button', { name: '模型', exact: true }).click()
    await renewed.getByRole('button', { name: /编辑/u }).click()
    await renewed.getByText('自定义设置', { exact: true }).click()
    assert.equal(await renewed.getByLabel('API 地址').inputValue(), modelAddress)
    await renewed.getByRole('button', { name: '通用设置' }).click()
    await renewed.getByText('浅色', { exact: true }).click()
    await renewed.getByText('安全', { exact: true }).click()
    const security = renewed.locator('section[aria-label="安全设置"]')
    await security.waitFor()
    const light = await security.evaluate((node) => getComputedStyle(node).color)
    await renewed.getByRole('button', { name: '通用设置' }).click()
    await renewed.getByText('深色', { exact: true }).click()
    await renewed.getByText('安全', { exact: true }).click()
    await expect(security).not.toHaveCSS('color', light)
    const dark = await security.evaluate((node) => getComputedStyle(node).color)
    assert.notEqual(light, dark)
  } finally {
    await f.cleanup()
  }
})
