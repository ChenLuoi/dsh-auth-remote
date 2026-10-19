import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import {
  appendFile,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { expect, type Page } from '@playwright/test'
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
import { classifyDshSupport, dshSupportWarning } from '../../src/shared/dsh-support.js'
import { accountPlatform } from '../helpers/account-platform.js'

const hasAccount = [
  '0.2.1-alpha.3',
  '0.2.1-alpha.4',
  '0.2.1-alpha.5',
  '0.2.1-rc.1',
  '0.2.1-rc.2',
].includes(dshVersion)

async function fixture({
  keepOnboarding = false,
  manualEnabled = true,
  loopback = false,
  preferenceOnly = false,
  hmrProbeEnabled = false,
  supportReloadProbe = false,
} = {}) {
  const home = await mkdtemp(join(tmpdir(), 'auth-remote-manual-browser-'))
  const platform = await accountPlatform()
  const portProbe = createServer().listen(0, '127.0.0.1')
  await once(portProbe, 'listening')
  const address = portProbe.address()
  assert.ok(address && typeof address !== 'string')
  const port = address.port
  await new Promise<void>((resolve) => portProbe.close(() => resolve()))
  const origin = `http://${loopback ? '127.0.0.1' : 'account-remote.test'}:${port}`
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
    const reloadPackage = join(profile, 'support-reload-package')
    const moduleEntry = supportReloadProbe
      ? join(reloadPackage, 'dist/index.js')
      : join(profile, 'node_modules/dsh-auth-remote/dist/index.js')
    if (supportReloadProbe) {
      // Native source HMR is opt-in and excludes node_modules. Keep the exact
      // candidate and its manifest while using the documented watchable location.
      await mkdir(reloadPackage)
      await copyFile(
        join(profile, 'node_modules/dsh-auth-remote/package.json'),
        join(reloadPackage, 'package.json'),
      )
      await cp(join(profile, 'node_modules/dsh-auth-remote/dist'), join(reloadPackage, 'dist'), {
        recursive: true,
      })
    }
    const hmrProbe = join(profile, 'hmr-config-probe.mjs')
    if (hmrProbeEnabled)
      await copyFile(new URL('../fixtures/hmr-config-probe.mjs', import.meta.url), hmrProbe)
    assert.equal(
      (await stat(join(profile, 'node_modules/dsh-auth-remote/dist/client.js'))).nlink,
      1,
    )
    await writeFile(
      join(profile, 'cordis.patch.yml'),
      [
        '- id: webserver',
        '  disabled: true',
        ...(!preferenceOnly
          ? [
              '- id: auth-remote',
              ...(supportReloadProbe
                ? [
                    '  disabled: true',
                    '- insert:',
                    '  - id: auth-remote-support-probe',
                    `    name: ${JSON.stringify(moduleEntry)}`,
                    '    inject: [webStartup]',
                  ]
                : []),
              `${supportReloadProbe ? '    ' : '  '}config:`,
              `${supportReloadProbe ? '      ' : '    '}publicUrl: ${origin}`,
              `${supportReloadProbe ? '      ' : '    '}requireTotp: false`,
              `${supportReloadProbe ? '      ' : '    '}manualAccountLogin: ${manualEnabled}`,
            ]
          : []),
        ...(supportReloadProbe
          ? [
              '- id: hmr',
              '  config:',
              `    base: ${JSON.stringify(profile)}`,
              '    root: [support-reload-package/dist]',
            ]
          : []),
        ...(hasAccount
          ? [
              '- id: deepseek-account',
              '  config:',
              `    platformOrigin: ${platform.origin}`,
              '    allowLoopbackHttp: true',
            ]
          : []),
        ...(hmrProbeEnabled
          ? [
              '- insert:',
              '    - id: hmr-config-probe',
              '      name: ' + JSON.stringify(hmrProbe),
              '      inject: [webServer, hmr]',
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
    child = spawn(
      dsh,
      [
        'web',
        '--no-open',
        '--port',
        String(port),
        ...(preferenceOnly ? ['--public-url', origin] : []),
      ],
      {
        cwd: home,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
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
    try {
      await page.waitForSelector('[class*="frame"]')
    } catch (error) {
      console.error('Account fixture startup output:', output)
      console.error('Account fixture browser errors:', errors)
      console.error('Account fixture page:', await page.locator('body').innerText())
      throw error
    }
    const notice = page.getByRole('dialog', { name: /^(?:内测声明|预览版说明)$/u })
    await notice.waitFor()
    if (await notice.isVisible()) {
      // The notice closes optimistically. Its native profile write must settle
      // before a test edits the same patch file or the old snapshot can win.
      const acknowledged = page.waitForResponse((response) => {
        if (new URL(response.url()).pathname !== '/api/settings/mutate') return false
        const args = response.request().postDataJSON()?.payload?.args
        return (
          args?.ns === 'ui-settings-general' &&
          Array.isArray(args.ops) &&
          args.ops.some(
            (op: { op?: string; path?: string[] }) =>
              op.op === 'set' && op.path?.length === 1 && op.path[0] === 'welcomeNoticeVersion',
          )
        )
      })
      await notice.getByRole('button', { name: '继续' }).click()
      const saved = await acknowledged
      assert.equal(saved.status(), 200)
      assert.equal((await saved.json()).result.ok, true)
      await notice.waitFor({ state: 'hidden' })
    }
    // Dismiss first-run onboarding without ever initiating Platform authorization.
    const manual = page.getByRole('dialog', { name: '登录 DeepSeek 账号', exact: true })
    if (hasAccount && manualEnabled && !keepOnboarding) {
      await manual.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
      if (await manual.isVisible())
        await manual.getByRole('button', { name: '关闭', exact: true }).click()
    }
    if (hasAccount && !manualEnabled && !keepOnboarding) {
      const welcome = page.getByRole('dialog', { name: '开始使用', exact: true })
      await welcome.waitFor({ state: 'visible', timeout: 5000 })
      await welcome.getByRole('button', { name: '关闭', exact: true }).click()
    }
    return {
      profile,
      moduleEntry,
      page,
      context,
      platform,
      origin,
      errors,
      output: () => output,
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
          name: locale === 'zh' ? '登录 DeepSeek 账号' : 'Sign in to DeepSeek',
          exact: true,
        })
        await dialog.waitFor()
        return dialog
      },
      async close() {
        // Settings can issue another describe after the last UI assertion.
        // Finish active route callbacks before disposing their request context.
        await page.unrouteAll({ behavior: 'wait' })
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

async function openSecurity(page: Page) {
  await openDshSettings(page)
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await clickThroughDshPrompts(
    page,
    settings.getByRole('button', { name: /^安全(?:与登录)?$/u }),
    () => openDshSettings(page),
  )
  return { settings, toggle: settings.getByRole('switch', { name: '远程 DeepSeek 账号登录' }) }
}

async function nativeSettingsRpc(page: Page, method: string, args: Record<string, unknown>) {
  return page.evaluate(
    async ({ method, args, rpcId }) =>
      (
        await fetch('/api/' + method, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'client-request',
            rpcId,
            method,
            payload: { args },
          }),
        })
      ).json(),
    { method, args, rpcId: randomUUID() },
  )
}

test(
  'configuration retry recovers the shared mirror after its initial describe fails',
  { timeout: 90000 },
  async () => {
    const f = await fixture()
    try {
      let fail = true
      let reads = 0
      await f.page.route('**/api/settings/describe', async (route) => {
        reads++
        if (!fail) return route.continue()
        await route.fulfill({
          json: {
            type: 'server-response',
            rpcId: route.request().postDataJSON().rpcId,
            result: {
              ok: false,
              error: { code: 'settings/unavailable', message: 'Temporary configuration failure' },
            },
          },
        })
      })
      await f.page.reload()
      const { settings, toggle } = await openSecurity(f.page)
      await expect(settings.getByText('登录配置暂时不可用。')).toBeVisible()
      await expect(toggle).toHaveCount(0)
      const before = reads
      fail = false
      await settings.getByRole('button', { name: '重试', exact: true }).click()
      await expect.poll(() => reads).toBeGreaterThan(before)
      await expect(toggle).toBeChecked()
      if (hasAccount) await expect(toggle).toBeEnabled()
      await expect(settings.getByText('登录配置暂时不可用。')).toHaveCount(0)
      assert.deepEqual(f.errors, [])
    } finally {
      await f.close()
    }
  },
)

test(
  'native settings after HMR wait for the existing transaction and still reject genuine nesting',
  { timeout: 90000 },
  async () => {
    const maintenance = dshSupportWarning(classifyDshSupport(dshVersion, new Set([dshVersion])))
    const f = await fixture({ hmrProbeEnabled: true })
    const probe = (action: string) =>
      f.page.evaluate(async (action) => {
        try {
          return await (
            await fetch('/plugins/hmr-config/' + action, {
              method: action === 'state' ? 'GET' : 'POST',
            })
          ).json()
        } catch {
          return null
        }
      }, action)
    try {
      const warningCount = () => (maintenance ? f.output().split(maintenance).length - 1 : 0)
      if (maintenance) assert.equal(warningCount(), 1)
      const before = await probe('state')
      assert.ok(before.generation > 0)
      const patchPath = join(f.profile, 'cordis.patch.yml')
      const patch = await readFile(patchPath, 'utf8')
      await writeFile(
        patchPath,
        patch.replace(/^( +)requireTotp: false$/mu, '$&\n$1sessionHours: 167'),
      )
      try {
        await expect
          .poll(() => probe('state'), { timeout: 20000 })
          .toMatchObject({ generation: before.generation + 1 })
      } catch (error) {
        console.error('HMR profile patch:', await readFile(patchPath, 'utf8'))
        console.error('HMR native output:', f.output())
        throw error
      }
      assert.match(await readFile(patchPath, 'utf8'), /sessionHours: 167/u)
      await f.page.reload()
      await probe('hold')
      await expect.poll(() => probe('state')).toMatchObject({ held: true, nestedRejected: true })
      const described = await nativeSettingsRpc(f.page, 'settings/describe', {})
      const view = described.result.value.namespaces.find(
        (value: any) => value.ns === 'auth-remote',
      )
      assert.ok(view, JSON.stringify(described))
      let settled = false
      const save = nativeSettingsRpc(f.page, 'settings/mutate', {
        ns: 'auth-remote',
        ops: [{ op: 'set', path: ['manualAccountLogin'], value: false }],
        expectedRevision: view.revision,
      }).then(
        (reply) => {
          settled = true
          return { reply }
        },
        (error: unknown) => {
          settled = true
          return { error }
        },
      )
      try {
        await new Promise((resolve) => setTimeout(resolve, 250))
        assert.equal(settled, false, 'external settings write must wait for the native HMR queue')
      } finally {
        await probe('release')
      }
      const result = await save
      if ('error' in result) throw result.error
      const reply = result.reply
      assert.equal(reply.result.ok, true, JSON.stringify(reply))
      assert.equal(reply.result.value.value.manualAccountLogin, false)
      assert.equal(await f.page.evaluate(async () => (await fetch('/auth-remote/me')).status), 200)
      if (maintenance)
        assert.equal(warningCount(), 1, 'configuration HMR must not repeat maintenance diagnostics')
      else
        assert.doesNotMatch(
          f.output(),
          /auth-remote: DSH .* (?:legacy|retired|support commitment)/u,
        )
    } finally {
      await probe('release').catch(() => {})
      await f.close()
    }
  },
)

if (classifyDshSupport(dshVersion, new Set([dshVersion])).state === 'legacy')
  test(
    'legacy maintenance diagnostics survive native source module replacement',
    { timeout: 90000 },
    async () => {
      const f = await fixture({ hmrProbeEnabled: true, supportReloadProbe: true })
      const maintenance = dshSupportWarning(classifyDshSupport(dshVersion, new Set([dshVersion])))!
      const warningCount = () => f.output().split(maintenance).length - 1
      const generation = () =>
        f.page.evaluate(
          async () => (await (await fetch('/plugins/hmr-config/state')).json()).generation,
        )
      try {
        assert.equal(warningCount(), 1)
        const previousGeneration = await generation()
        const marker = 'auth-remote support diagnostic module replacement loaded'
        await appendFile(f.moduleEntry, '\nconsole.info(' + JSON.stringify(marker) + ');\n')
        try {
          await expect.poll(f.output, { timeout: 20_000 }).toContain(marker)
          await expect.poll(generation, { timeout: 20_000 }).toBe(previousGeneration + 1)
        } catch (error) {
          console.error('Support module HMR output:', f.output())
          throw error
        }
        assert.equal(
          await f.page.evaluate(async () => (await fetch('/auth-remote/me')).status),
          200,
        )
        assert.equal(warningCount(), 1, 'module HMR must preserve process-wide warning history')
      } finally {
        await f.close()
      }
    },
  )

if (hasAccount) {
  test(
    'manual switch remains writable after native HMR replaces the installed plugin',
    { timeout: 90000 },
    async () => {
      const f = await fixture()
      try {
        let { settings, toggle } = await openSecurity(f.page)
        await expect(toggle).toBeChecked()
        const marker = 'auth-remote real HMR regression replacement loaded'
        await appendFile(
          join(f.profile, 'node_modules/dsh-auth-remote/dist/index.js'),
          '\nconsole.info(' + JSON.stringify(marker) + ');\n',
        )
        await toggle.click()
        await expect(toggle).not.toBeChecked()
        await expect.poll(f.output, { timeout: 20000 }).toContain(marker)
        await expect
          .poll(
            async () => {
              try {
                const target = new URL(f.origin)
                const response = await fetch(
                  'http://127.0.0.1:' + target.port + '/auth-remote/ready',
                  {
                    headers: { host: target.host },
                    signal: AbortSignal.timeout(1000),
                  },
                )
                return response.status
              } catch {
                return 0
              }
            },
            { timeout: 20000 },
          )
          .toBe(200)
        await f.page.reload()
        ;({ settings, toggle } = await openSecurity(f.page))
        await expect(toggle).not.toBeChecked()
        const answered = f.page.waitForResponse(
          (response) => new URL(response.url()).pathname === '/api/settings/mutate',
        )
        await toggle.click()
        const reply = await (await answered).json()
        assert.equal(reply.result.ok, true, JSON.stringify(reply))
        await expect(toggle).toBeChecked()
        await expect(toggle).toBeEnabled()
        await expect(settings.getByRole('alert').filter({ hasText: '配置保存失败' })).toHaveCount(0)
      } finally {
        await f.close()
      }
    },
  )

  test(
    'manual switch enables an initially disabled profile and keeps the accepted value after refresh',
    { timeout: 90000 },
    async () => {
      const f = await fixture({ manualEnabled: false })
      try {
        let { settings, toggle } = await openSecurity(f.page)
        await expect(toggle).not.toBeChecked()
        for (const enabled of [true, false, true]) {
          const answered = f.page.waitForResponse(
            (response) => new URL(response.url()).pathname === '/api/settings/mutate',
          )
          await toggle.click()
          const reply = await (await answered).json()
          assert.equal(reply.result.ok, true, JSON.stringify(reply))
          await expect(toggle).toBeChecked({ checked: enabled })
          await expect(toggle).toBeEnabled()
          await expect(settings.getByRole('alert').filter({ hasText: '配置保存失败' })).toHaveCount(
            0,
          )
        }
        await f.page.reload()
        ;({ settings, toggle } = await openSecurity(f.page))
        await expect(toggle).toBeChecked()
        await expect(toggle).toBeEnabled()
      } finally {
        await f.close()
      }
    },
  )
  test(
    'manual switch can re-enable when it is the only auth profile override',
    { timeout: 90000 },
    async () => {
      const f = await fixture({ preferenceOnly: true })
      try {
        const { settings, toggle } = await openSecurity(f.page)
        await expect(toggle).toBeChecked()
        for (const enabled of [false, true, false, true]) {
          const answered = f.page.waitForResponse(
            (response) => new URL(response.url()).pathname === '/api/settings/mutate',
          )
          await toggle.click()
          const reply = await (await answered).json()
          assert.equal(reply.result.ok, true, JSON.stringify(reply))
          await expect(toggle).toBeChecked({ checked: enabled })
          await expect(toggle).toBeEnabled()
          await expect(settings.getByRole('alert').filter({ hasText: '配置保存失败' })).toHaveCount(
            0,
          )
        }
      } finally {
        await f.close()
      }
    },
  )

  test(
    'native configuration saves immediately, restores native entries, preserves failure values and survives refresh',
    { timeout: 90000 },
    async () => {
      const f = await fixture()
      try {
        let { settings, toggle } = await openSecurity(f.page)
        await expect(toggle).toBeChecked()
        await expect(toggle).toBeEnabled()
        assert.equal(await toggle.evaluate((node) => node.tagName), 'BUTTON')
        await expect(settings.getByRole('checkbox')).toHaveCount(0)
        await expect(
          settings
            .locator('.auth-remote-manual-copy')
            .getByText('在新标签页授权后，粘贴回调地址登录。'),
        ).toBeVisible()
        await toggle.focus()
        await toggle.press('Space')
        await expect(toggle).not.toBeChecked()
        await expect(toggle).toBeEnabled()
        await toggle.press('Space')
        await expect(toggle).toBeChecked()
        await expect(toggle).toBeEnabled()
        await f.page.route('**/api/settings/mutate', (route) => route.abort('failed'))
        await toggle.click()
        await expect(settings.getByRole('alert').filter({ hasText: '配置保存失败' })).toBeVisible()
        await expect(toggle).toBeEnabled()
        await expect(toggle).toBeChecked()
        await f.page.unroute('**/api/settings/mutate')
        let release!: () => void
        const held = new Promise<void>((resolve) => {
          release = resolve
        })
        await f.page.route('**/api/settings/mutate', async (route) => {
          await held
          await route.continue()
        })
        try {
          await toggle.click()
          await expect(toggle).toBeDisabled()
          await expect(toggle).toBeChecked()
        } finally {
          release()
        }
        await expect(toggle).not.toBeChecked()
        await expect(toggle).toBeEnabled()
        await f.page.unroute('**/api/settings/mutate')
        assert.match(
          await (
            await import('node:fs/promises')
          ).readFile(join(f.profile, 'cordis.patch.yml'), 'utf8'),
          /manualAccountLogin: false/u,
        )
        await settings.getByRole('button', { name: '关闭', exact: true }).click()
        await f.page.getByRole('button', { name: '账号菜单', exact: true }).click()
        await f.page.getByRole('menuitem', { name: '登录', exact: true }).click()
        const native = f.page.getByRole('dialog', { name: '登录失败', exact: true })
        await expect(native).toBeVisible()
        await expect(f.page.locator('.auth-remote-account-dialog')).toHaveCount(0)
        await native.getByRole('button', { name: '关闭', exact: true }).click()
        await f.page.reload()
        ;({ settings, toggle } = await openSecurity(f.page))
        await expect(toggle).not.toBeChecked()
        await toggle.click()
        await expect(toggle).toBeChecked()
        await expect(toggle).toBeEnabled()
        await settings.getByRole('button', { name: '关闭', exact: true }).click()
        const dialog = await f.open()
        await expect(dialog.getByLabel('完整回调地址')).toBeVisible()
        assert.equal(f.platform.attempts.length, 0)
      } finally {
        await f.close()
      }
    },
  )

  test(
    'disabling from Settings preserves an admitted manual dialog through successful native exchange',
    { timeout: 90000 },
    async () => {
      const f = await fixture()
      try {
        const other = await f.context.newPage()
        await other.goto(f.origin)
        const { toggle } = await openSecurity(other)
        const dialog = await f.open()
        const opened = f.context.waitForEvent('page')
        await dialog.getByRole('button', { name: '打开登录页' }).click()
        const popup = await opened
        await expect(dialog.getByLabel('完整回调地址')).toBeEnabled()
        await toggle.click()
        await expect(toggle).not.toBeChecked()
        await expect(toggle).toBeEnabled()
        await expect(dialog.getByLabel('完整回调地址')).toBeEnabled()
        const denied = await other.evaluate(async () => {
          const response = await fetch('/auth-remote/account/start', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ locale: 'en', timezoneOffsetSeconds: 0 }),
          })
          return { status: response.status, body: await response.json() }
        })
        assert.equal(denied.status, 403)
        assert.equal(denied.body.error, 'account_disabled')
        const callback = popup.waitForRequest(
          (request) => new URL(request.url()).pathname === '/oauth/callback',
        )
        await popup.getByRole('button', { name: 'Authorize test account' }).click()
        await dialog.getByLabel('完整回调地址').fill((await callback).url())
        await dialog.getByRole('button', { name: '确认登录' }).click()
        await expect(dialog).not.toBeVisible()
        assert.equal(f.platform.exchanges.length, 1)
        assert.deepEqual(f.errors, [])
      } finally {
        await f.close()
      }
    },
  )

  test(
    'a stale instructions dialog reports disabled instead of starting a new authorization',
    { timeout: 90000 },
    async () => {
      const f = await fixture()
      try {
        const other = await f.context.newPage()
        await other.goto(f.origin)
        const { toggle } = await openSecurity(other)
        const dialog = await f.open()
        await toggle.click()
        await expect(toggle).not.toBeChecked()
        await dialog.getByRole('button', { name: '打开登录页' }).click()
        await expect(dialog.getByRole('alert')).toContainText('请刷新页面')
        assert.equal(f.platform.attempts.length, 0)
      } finally {
        await f.close()
      }
    },
  )

  test(
    'enabling while a native authorization is open preserves its dialog and provider attempt',
    { timeout: 90000 },
    async () => {
      const f = await fixture({ manualEnabled: false, loopback: true })
      try {
        const other = await f.context.newPage()
        await other.goto(f.origin)
        const { toggle } = await openSecurity(other)
        const opened = f.context.waitForEvent('page')
        await f.page.getByRole('button', { name: '账号菜单', exact: true }).click()
        await f.page.getByRole('menuitem', { name: '登录', exact: true }).click()
        const popup = await opened
        const native = f.page.getByRole('dialog', { name: '等待登录', exact: true })
        await expect(native).toBeVisible()
        await expect(native.getByRole('button', { name: '复制登录链接' })).toBeEnabled()
        await toggle.click()
        await expect(toggle).toBeChecked()
        await expect(native).toBeVisible()
        await expect(f.page.locator('.auth-remote-account-dialog')).toHaveCount(0)
        assert.equal(popup.isClosed(), false)
        assert.equal(f.platform.attempts.length, 1)
        const state = await f.page.evaluate(async () =>
          (await fetch('/auth-remote/account/state')).json(),
        )
        assert.equal(
          state.attempt,
          null,
          'a native attempt must not become owned by the manual adapter',
        )
        await native.getByRole('button', { name: '取消', exact: true }).click()
      } finally {
        await f.close()
      }
    },
  )

  test(
    'configuration retry restores a temporarily missing namespace through its injected transport',
    { timeout: 90000 },
    async () => {
      const f = await fixture()
      try {
        let hide = true
        let reads = 0
        await f.page.route('**/api/settings/describe', async (route) => {
          reads++
          const local = new URL(route.request().url())
          local.hostname = '127.0.0.1'
          const response = await route.fetch({
            url: local.href,
            headers: { ...route.request().headers(), host: new URL(f.origin).host },
          })
          const body = await response.json()
          if (hide)
            body.result.value.namespaces = body.result.value.namespaces.filter(
              (entry: any) => entry.ns !== 'auth-remote',
            )
          await route.fulfill({ response, json: body })
        })
        await f.page.reload()
        const { settings, toggle } = await openSecurity(f.page)
        await expect(settings.getByText('登录配置暂时不可用。')).toBeVisible()
        await expect(toggle).toHaveCount(0)
        const before = reads
        hide = false
        await settings.getByRole('button', { name: '重试', exact: true }).click()
        await expect.poll(() => reads).toBeGreaterThan(before)
        await expect(toggle).toBeChecked()
        await expect(toggle).toBeEnabled()
        await toggle.click()
        await expect(toggle).not.toBeChecked()
        await expect(toggle).toBeEnabled()
        assert.deepEqual(f.errors, [])
      } finally {
        await f.close()
      }
    },
  )

  for (const manualEnabled of [true, false])
    test(
      `sign-in waits for the initial preference before choosing ${manualEnabled ? 'manual' : 'native'} routing`,
      { timeout: 90000 },
      async () => {
        const f = await fixture({ manualEnabled })
        let release!: () => void
        const held = new Promise<void>((resolve) => {
          release = resolve
        })
        try {
          let reads = 0
          let nativeStarts = 0
          f.page.on('request', (request) => {
            if (new URL(request.url()).pathname === '/api/account/startSignIn') nativeStarts++
          })
          await f.page.route('**/api/settings/describe', async (route) => {
            reads++
            await held
            await route.continue()
          })
          await f.page.reload()
          await expect.poll(() => reads).toBeGreaterThan(0)
          await f.page.getByRole('button', { name: '账号菜单', exact: true }).click()
          await f.page.getByRole('menuitem', { name: '登录', exact: true }).click()
          await f.page.waitForTimeout(250)
          assert.equal(nativeStarts, 0, 'unknown preference must not start native authorization')
          await expect(f.page.locator('.auth-remote-account-dialog')).toHaveCount(0)
          release()
          if (manualEnabled) {
            await expect(
              f.page.getByRole('dialog', { name: '登录 DeepSeek 账号', exact: true }),
            ).toBeVisible()
            assert.equal(nativeStarts, 0)
          } else {
            await expect.poll(() => nativeStarts).toBe(1)
            await expect(
              f.page.getByRole('dialog', { name: '登录失败', exact: true }),
            ).toBeVisible()
            await expect(f.page.locator('.auth-remote-account-dialog')).toHaveCount(0)
          }
          assert.equal(f.platform.attempts.length, 0)
          assert.deepEqual(f.errors, [])
        } finally {
          release()
          await f.close()
        }
      },
    )

  test(
    'an unavailable native configuration form keeps authentication and native entries available without a local substitute',
    { timeout: 90000 },
    async () => {
      const f = await fixture()
      try {
        await f.page.route('**/api/settings/describe', async (route) => {
          const local = new URL(route.request().url())
          local.hostname = '127.0.0.1'
          const response = await route.fetch({
            url: local.href,
            headers: { ...route.request().headers(), host: new URL(f.origin).host },
          })
          const body = await response.json()
          body.result.value.namespaces = body.result.value.namespaces.filter(
            (entry: any) => entry.ns !== 'auth-remote',
          )
          await route.fulfill({ response, json: body })
        })
        await f.page.reload()
        const { settings, toggle } = await openSecurity(f.page)
        await expect(settings.getByText('登录配置暂时不可用。')).toBeVisible()
        await expect(toggle).toHaveCount(0)
        await expect(settings.getByText('手动登录已关闭，已开始的授权仍可继续。')).toHaveCount(0)
        assert.equal(
          await f.page.evaluate(async () => (await fetch('/auth-remote/me')).status),
          200,
        )
        assert.equal(f.platform.attempts.length, 0)
      } finally {
        await f.close()
      }
    },
  )

  test(
    'credential-free onboarding preserves native API-key setup without starting account authorization',
    { timeout: 90000 },
    async () => {
      const f = await fixture({ keepOnboarding: true })
      try {
        const dialog = f.page.getByRole('dialog', { name: '登录 DeepSeek 账号', exact: true })
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
        await expect(dialog.getByRole('listitem')).toHaveCount(2)
        assert.equal(f.platform.attempts.length, 0)
        assert.equal(f.context.pages().length, 1)
        const screenshotDir = join(project, '.cache/ui-review', dshVersion)
        await mkdir(screenshotDir, { recursive: true })
        await f.page.screenshot({ path: join(screenshotDir, 'account-login-light-desktop.png') })
        const opened = f.context.waitForEvent('page')
        await dialog.getByRole('button', { name: '打开登录页' }).click()
        const popup = await opened
        await popup.getByRole('button', { name: 'Authorize test account' }).waitFor()
        await expect(dialog.getByLabel('完整回调地址')).toBeEnabled()
        await expect(dialog.getByRole('listitem')).toHaveCount(0)
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
        await dialog.getByRole('button', { name: '打开登录页' }).click()
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
        await f.page.setViewportSize({ width: 390, height: 480 })
        await expect(
          dialog.getByRole('button', { name: 'Use API key', exact: true }),
        ).toBeInViewport({ ratio: 1 })
        await expect(
          dialog.getByRole('button', { name: /^(?:Start again|Open sign-in page)$/u }),
        ).toBeInViewport({ ratio: 1 })
        await f.page.setViewportSize({ width: 390, height: 844 })
        f.platform.expiresIn(0.15)
        await dialog.getByRole('button', { name: /^(?:Start again|Open sign-in page)$/u }).click()
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
        const { settings, toggle } = await openSecurity(f.page)
        await expect(toggle).toBeDisabled()
        await expect(settings.getByText('当前 DSH 环境不支持手动账号登录。')).toBeVisible()
        assert.equal(f.platform.attempts.length, 0)
        assert.deepEqual(f.errors, [])
      } finally {
        await f.close()
      }
    },
  )
}
