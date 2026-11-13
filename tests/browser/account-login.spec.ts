import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
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
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { expect, type Page } from '@playwright/test'
import { AuthService } from '../../src/auth/service.js'
import { AuthStateStore } from '../../src/storage/store.js'
import { AUTH_COOKIE } from '../../src/shared/auth-contract.js'
import { dictionaries, type Locale } from '../../src/shared/i18n.js'
import {
  archive,
  clickThroughDshPrompts,
  dsh,
  launchBrowser,
  isolatedDshEnv,
  localModelEndpoint,
  openDshSettings,
  project,
  selectDshTheme,
  waitForAnimations,
} from '../helpers/runtime.js'
import { dshVersion, prepareDshRuntime } from '../../scripts/runtime.mjs'
import { classifyDshSupport, dshSupportWarning } from '../../src/shared/dsh-support.js'
import { accountPlatform } from '../helpers/account-platform.js'
import { nativeHttp } from '../helpers/native-http.js'

async function fixture({
  keepOnboarding = false,
  manualEnabled = true,
  loopback = false,
  preferenceOnly = false,
  hmrProbeEnabled = false,
  supportReloadProbe = false,
  observeClient = false,
  lifecycleProbe = false,
  entryObserver = false,
  privateRuntime = false,
} = {}) {
  const home = await mkdtemp(join(tmpdir(), 'auth-remote-manual-browser-'))
  const platform = await accountPlatform()
  const model = await localModelEndpoint()
  const portProbe = createServer().listen(0, '127.0.0.1')
  await once(portProbe, 'listening')
  const address = portProbe.address()
  assert.ok(address && typeof address !== 'string')
  const port = address.port
  await new Promise<void>((resolve) => portProbe.close(() => resolve()))
  const origin = `http://${loopback ? '127.0.0.1' : 'account-remote.test'}:${port}`
  const env: NodeJS.ProcessEnv = isolatedDshEnv(home)
  let child: ReturnType<typeof spawn> | undefined
  let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined
  let currentPage: Page | undefined
  let output = ''
  let phase = 'boot'
  const consoleErrors: { phase: string; text: string }[] = []
  const externalRequests: string[] = []
  const stopServer = async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await once(child, 'exit').catch(() => {})
    }
  }
  const cleanup = async () => {
    const failures: unknown[] = []
    for (const close of [
      () => currentPage?.unrouteAll({ behavior: 'wait' }),
      () => browser?.close(),
      stopServer,
      () => platform.close(),
      () => model.close(),
      () => rm(home, { recursive: true, force: true }),
    ]) {
      try {
        await close()
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Account fixture cleanup failed')
  }
  try {
    const runtime = join(home, 'private-runtime')
    const binary = privateRuntime
      ? await prepareDshRuntime(
          runtime,
          'auth-remote-private-client-runtime',
          dshVersion,
          undefined,
          'private-account',
        )
      : dsh
    let nativeClient: string | undefined
    if (privateRuntime) {
      const installed = createRequire(join(runtime, 'package.json'))
      const host = createRequire(installed.resolve('@deepseek-ai/dsh/package.json'))
      const web = createRequire(host.resolve('@deepseek-ai/dsh-web-app/package.json'))
      const manifest = web.resolve('@deepseek-ai/dsh-client-ui-settings-account/package.json')
      assert.equal(JSON.parse(await readFile(manifest, 'utf8')).version, dshVersion)
      nativeClient = join(dirname(manifest), 'lib/client.js')
      assert.equal((await stat(nativeClient)).nlink, 1)
      console.info(
        'private account runtime',
        JSON.stringify({
          dsh: dshVersion,
          lockSha256: createHash('sha256')
            .update(await readFile(join(runtime, 'pnpm-lock.yaml')))
            .digest('hex'),
          nativeClientSha256: createHash('sha256')
            .update(await readFile(nativeClient))
            .digest('hex'),
          packages: Object.fromEntries(
            [
              '@deepseek-ai/cordis',
              '@deepseek-ai/schemastery',
              '@deepseek-ai/cordis-plugin-loader',
              '@deepseek-ai/cordis-plugin-include',
              '@deepseek-ai/dsh-deepseek-account',
            ].map((name) => [name, web(name + '/package.json').version]),
          ),
        }),
      )
    }
    await promisify(execFile)(binary, ['plugin', '--profile', 'web', 'add', archive], {
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
    const lifecycle = join(profile, 'hmr-lifecycle-probe.mjs')
    if (lifecycleProbe)
      await copyFile(new URL('../fixtures/hmr-lifecycle-probe.mjs', import.meta.url), lifecycle)
    assert.equal(
      (await stat(join(profile, 'node_modules/dsh-auth-remote/dist/client.js'))).nlink,
      1,
    )
    await writeFile(
      join(profile, 'cordis.patch.yml'),
      [
        ...model.patch,
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
                    `    name: ${JSON.stringify(pathToFileURL(moduleEntry).href)}`,
                    '    inject: [webStartup]',
                    '- id: auth-remote-support-probe',
                  ]
                : []),
              '  config:',
              `    publicUrl: ${origin}`,
              '    requireTotp: false',
              `    manualAccountLogin: ${manualEnabled}`,
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
        '- id: deepseek-account',
        '  config:',
        `    platformOrigin: ${platform.origin}`,
        ...(dshVersion === '0.2.2-rc.2'
          ? [
              `    harnessOrigin: ${platform.origin}`,
              `    inferenceOrigin: ${new URL(model.baseURL).origin}`,
            ]
          : []),
        '    allowLoopbackHttp: true',
        ...(hmrProbeEnabled
          ? [
              '- insert:',
              '    - id: hmr-config-probe',
              '      name: ' + JSON.stringify(hmrProbe),
              '      inject: [webServer, hmr]',
            ]
          : []),
        ...(lifecycleProbe
          ? [
              '- insert:',
              '    - id: hmr-lifecycle-probe',
              `      name: ${JSON.stringify(lifecycle)}`,
              '      inject: [profileContext]',
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
      binary,
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
    if (entryObserver) {
      await context.addInitScript({
        path: new URL('../fixtures/account-entry-observer.js', import.meta.url).pathname,
      })
      await context.route('**/*', async (route) => {
        const url = new URL(route.request().url())
        if (['account-remote.test', '127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
          await route.continue()
        else {
          externalRequests.push(url.origin)
          await route.abort()
        }
      })
    } else if (observeClient)
      await context.addInitScript({
        path: new URL('../fixtures/liveshare-client-observer.js', import.meta.url).pathname,
      })
    await context.addCookies([{ name: AUTH_COOKIE, value: token!, url: origin }])
    const page = await context.newPage()
    currentPage = page
    const errors: string[] = []
    const resources: { path: string; status: number }[] = []
    page.on('response', (response) =>
      resources.push({ path: new URL(response.url()).pathname, status: response.status() }),
    )
    page.on('pageerror', (error) => errors.push(error.message))
    if (entryObserver)
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push({ phase, text: message.text() })
      })
    await page.goto(origin, { waitUntil: 'load' })
    try {
      await page.waitForSelector('[class*="frame"]')
    } catch (error) {
      console.error('Account fixture startup output:', output)
      console.error('Account fixture browser errors:', errors)
      console.error('Account fixture responses:', resources)
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
    if (manualEnabled && !keepOnboarding) {
      await manual.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
      if (await manual.isVisible())
        await manual.getByRole('button', { name: '关闭', exact: true }).click()
    }
    if (!manualEnabled && !keepOnboarding) {
      const welcome = page.getByRole('dialog', { name: '开始使用', exact: true })
      await welcome.waitFor({ state: 'visible', timeout: 5000 })
      await welcome.getByRole('button', { name: '关闭', exact: true }).click()
    }
    return {
      profile,
      moduleEntry,
      nativeClient,
      binary,
      page,
      context,
      platform,
      model,
      origin,
      errors,
      consoleErrors,
      externalRequests,
      setPhase(value: string) {
        phase = value
      },
      output: () => output,
      stopServer,
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
        await cleanup()
      },
    }
  } catch (error) {
    try {
      await cleanup()
    } catch (failure) {
      throw new AggregateError([error, failure], 'Account fixture setup and cleanup failed')
    }
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

if (dshVersion === '0.2.2-rc.2') {
  test(
    'native account entry decoration preserves child ownership across client reloads',
    { timeout: 240_000 },
    async () => {
      const f = await fixture({ entryObserver: true, privateRuntime: true, loopback: true })
      const facts = () => f.page.evaluate(() => (window as any).__accountEntry.snapshot())
      const owned = async () => {
        await expect.poll(facts).toMatchObject({ entryCount: 1, decorated: true, roots: 1 })
        const value = await facts()
        for (const key of [
          'sameEntry',
          'sameChildren',
          'sameInject',
          'sameOptions',
          'sameRegistrant',
        ])
          assert.equal(value[key], true, key)
        assert.equal(value.childIds.length, 1)
        assert(
          value.renders.some(
            (render: any) => render.entryId === value.entryId && render.bindingType === 'function',
          ),
        )
        return value
      }
      const preference = async (value: boolean) => {
        const described = await nativeSettingsRpc(f.page, 'settings/describe', {})
        const namespace = described.result.value.namespaces.find(
          (row: any) => row.ns === 'auth-remote',
        )
        const saved = await nativeSettingsRpc(f.page, 'settings/mutate', {
          ns: 'auth-remote',
          expectedRevision: namespace.revision,
          ops: [{ op: 'set', path: ['manualAccountLogin'], value }],
        })
        assert.equal(saved.result.ok, true)
        await expect
          .poll(() =>
            f.page.evaluate(() => {
              const ctx = (window as any).__accountEntry.auth.ctx
              return ctx.get('configForms').get('auth-remote').getSnapshot().value
                ?.manualAccountLogin
            }),
          )
          .toBe(value)
      }
      const nativeStart = async (phase: string) => {
        f.setPhase(phase)
        const count = f.platform.attempts.length
        await clickThroughDshPrompts(
          f.page,
          f.page.getByRole('button', { name: '账号菜单', exact: true }),
        )
        await f.page.getByRole('menuitem', { name: '登录', exact: true }).click()
        await expect.poll(() => f.platform.attempts.length).toBe(count + 1)
        assert.equal(await f.page.locator('.auth-remote-account-dialog').count(), 0)
        await f.page.evaluate(async () => {
          const s = (window as any).__accountEntry
          const answer = await s.native.ctx.remote.account.getState()
          if (answer.value.attempt?.id)
            await s.native.ctx.remote.account.cancelSignIn(answer.value.attempt.id)
          s.records.at(-1).entry.inject().showLogin(false)
        })
        for (const popup of f.context.pages()) if (popup !== f.page) await popup.close()
      }
      try {
        const initial = await owned()
        assert.equal(initial.registrations, 1)
        const before = await f.page.evaluate(async () => (await fetch('/auth-remote/me')).json())
        const dialog = await f.open()
        assert.equal(f.platform.attempts.length, 0)
        await dialog.getByRole('button', { name: '关闭', exact: true }).click()
        await preference(false)
        await nativeStart('native-delegation')
        await preference(true)

        // Real client module HMR, independently of Host entry HMR or fiber.restart.
        for (const [kind, path] of [
          ['auth', join(f.profile, 'node_modules/dsh-auth-remote/dist/client.js')],
          ['native', f.nativeClient!],
        ] as const) {
          f.setPhase(`${kind}-client-hmr`)
          let release!: () => void
          const held = new Promise<void>((resolve) => {
            release = resolve
          })
          let navigations = 0
          const authorize = f.platform.origin + '/dsh/authorize?**'
          // Keep the preopened window owned until cleanup; cross-origin COOP can sever its handle.
          await f.context.route(authorize, async (route) => {
            if (
              route.request().isNavigationRequest() &&
              route.request().frame().parentFrame() === null
            ) {
              navigations++
              await held
            }
            await route.continue()
          })
          try {
            const activeDialog = await f.open()
            const attempts = f.platform.attempts.length
            const popups = (await facts()).popupClosed.length
            const start = activeDialog.getByRole('button', { name: /^(?:打开登录页|重新开始)$/u })
            await expect(start).toBeEnabled()
            await start.click()
            await expect(activeDialog.getByLabel('完整回调地址', { exact: true })).toBeEnabled()
            await expect.poll(() => navigations).toBe(1)
            assert.deepEqual((await facts()).popupClosed.slice(popups), [false])
            assert.equal(f.platform.attempts.length, attempts + 1)
            const attempt = f.platform.attempts.at(-1)!.id
            assert.equal((await stat(path)).nlink, 1)
            const old = await facts()
            const marker = `account entry ${kind} client source HMR ${randomUUID()}`
            const loaded = f.page.waitForEvent('console', {
              predicate: (message) => message.text() === marker,
              timeout: 30_000,
            })
            await appendFile(path, '\nconsole.info(' + JSON.stringify(marker) + ');\n')
            await loaded
            await expect.poll(facts, { timeout: 30_000 }).toMatchObject({
              applies: { [kind]: old.applies[kind] + 1 },
              disposals: { [kind]: old.disposals[kind] + 1 },
            })
            const fresh = await owned()
            await expect(f.page.locator('.auth-remote-account-dialog')).toHaveCount(0)
            await expect.poll(async () => (await facts()).popupClosed.slice(popups)).toEqual([true])
            await expect
              .poll(() => f.platform.cancellations.filter((id) => id === attempt).length)
              .toBe(1)
            assert.equal(
              f.platform.attempts.length,
              attempts + 1,
              'client reload must not start another authorization',
            )
            if (kind === 'auth') {
              assert.equal(fresh.entryId, old.entryId)
              assert.deepEqual(fresh.childIds, old.childIds)
              await expect(f.page.locator('.auth-remote-account-dialog')).toHaveCount(0)
            } else {
              assert.notEqual(fresh.entryId, old.entryId)
              assert.notDeepEqual(fresh.childIds, old.childIds)
            }
            assert.deepEqual(
              await f.page.evaluate(async () => (await fetch('/auth-remote/me')).json()),
              before,
            )
          } finally {
            release()
            await f.context.unroute(authorize)
          }
        }

        const native = await owned()
        for (let iteration = 0; iteration < 2; iteration++) {
          await f.page.evaluate(async () => {
            const s = (window as any).__accountEntry
            s.savedAuth = { parent: s.auth.parent, exports: s.auth.exports }
            await s.auth.ctx.fiber.dispose()
          })
          await expect
            .poll(facts)
            .toMatchObject({ roots: 0, original: true, entryId: native.entryId })
          assert.deepEqual((await facts()).childIds, native.childIds)
          await f.page.evaluate(async () => {
            const s = (window as any).__accountEntry
            await s.savedAuth.parent.plugin(s.savedAuth.exports)
            await s.savedAuth.parent.fiber.await()
          })
          assert.equal((await owned()).entryId, native.entryId)
        }

        await f.page.evaluate(() => (window as any).__accountEntry.retainWrapper())
        await f.page.evaluate(async () => {
          await (window as any).__accountEntry.auth.ctx.fiber.dispose()
        })
        assert.equal(
          await f.page.evaluate(() => {
            const p = (window as any).__accountEntry.thirdParty
            return p.entry.component === p.component
          }),
          true,
        )
        assert.equal((await facts()).roots, 0)
        await nativeStart('inactive-wrapper')
        await f.page.evaluate(() => {
          const p = (window as any).__accountEntry.thirdParty
          p.entry.component = p.native
          p.release()
        })
        // A real local credential prevents fresh native onboarding from opening its own dialog.
        await f.page.reload()
        await owned()
        const setup = await f.open()
        await setup.getByRole('button', { name: '使用 API Key', exact: true }).click()
        const editor = f.page.getByRole('dialog', {
          name: '添加一个 API Key 开始使用',
          exact: true,
        })
        await expect(editor).toBeVisible()
        await editor
          .getByRole('textbox', { name: 'API 密钥', exact: true })
          .fill('pending-entry-local-test-key')
        const saved = f.page.waitForResponse(
          (response) => new URL(response.url()).pathname === '/api/credentials/set',
        )
        await editor.getByRole('button', { name: '保存并继续', exact: true }).click()
        assert.equal((await (await saved).json()).result.ok, true)
        const credential = await nativeSettingsRpc(f.page, 'credentials/describe', {
          refs: ['DEEPSEEK_API_KEY'],
        })
        assert.equal(credential.result.value.DEEPSEEK_API_KEY.configured, true)
        await editor.getByRole('button', { name: '稍后配置', exact: true }).click()
        await expect(editor).not.toBeVisible()
        // Hold the real settings read while the clicked wrapper awaits mirror.ensure().
        for (const value of [true, false]) {
          await f.page.reload()
          await owned()
          await preference(value)
          for (const target of ['auth', 'native'] as const) {
            f.setPhase(`pending-${target}-${value}`)
            let release!: () => void
            const held = new Promise<void>((resolve) => {
              release = resolve
            })
            let reads = 0
            const count = f.platform.attempts.length
            await f.page.route('**/api/settings/describe', async (route) => {
              reads++
              await held
              await route.continue()
            })
            try {
              await f.page.reload()
              await owned()
              await expect.poll(() => reads).toBeGreaterThan(0)
              await f.page.getByRole('button', { name: '账号菜单', exact: true }).click()
              await f.page.getByRole('menuitem', { name: '登录', exact: true }).click()
              await expect.poll(facts).toMatchObject({ starts: 1, settledStarts: 0 })
              assert.equal(f.platform.attempts.length, count)
              await expect(f.page.locator('.auth-remote-account-dialog')).toHaveCount(0)
              const pendingEntry = (await facts()).entryId
              await f.page.evaluate(async (target) => {
                const s = (window as any).__accountEntry
                s.pendingOwner = { parent: s[target].parent, exports: s[target].exports }
                if (target === 'auth') s.retainWrapper()
                await s[target].ctx.fiber.dispose()
              }, target)
              await expect.poll(facts).toMatchObject({ roots: 0 })
              if (target === 'native') {
                await f.page.evaluate(async () => {
                  const s = (window as any).__accountEntry
                  await s.pendingOwner.parent.plugin(s.pendingOwner.exports)
                  await s.pendingOwner.parent.fiber.await()
                })
                await expect.poll(facts).toMatchObject({ roots: 1, decorated: true })
                assert.notEqual((await facts()).entryId, pendingEntry)
              }
              release()
              await expect.poll(facts).toMatchObject({ settledStarts: 1 })
              await expect(f.page.locator('.auth-remote-account-dialog')).toHaveCount(0)
              assert.equal(f.platform.attempts.length, count)
              if (target === 'auth')
                await f.page.evaluate(async () => {
                  const s = (window as any).__accountEntry
                  if (s.thirdParty) {
                    s.thirdParty.entry.component = s.thirdParty.native
                    s.thirdParty.release()
                  }
                  await s.pendingOwner.parent.plugin(s.pendingOwner.exports)
                  await s.pendingOwner.parent.fiber.await()
                })
              await owned()
            } finally {
              release()
              await f.page.unroute('**/api/settings/describe')
            }
          }
        }
        assert.deepEqual(f.errors, [])
        assert.deepEqual(f.externalRequests, [])
        const popup =
          /^Unsafe attempt to initiate navigation for frame with URL 'http:\/\/127\.0\.0\.1:\d+\/dsh\/authorize\?/u
        const normalize = (text: string) =>
          text.replaceAll(/:[0-9]+/gu, ':PORT').replaceAll(/[a-f0-9]{8}-[a-f0-9-]{27,}/gu, 'ID')
        const control = f.consoleErrors
          .filter((row) => row.phase === 'inactive-wrapper')
          .map((row) => normalize(row.text))
        for (const row of f.consoleErrors) {
          assert(
            [
              'native-delegation',
              'inactive-wrapper',
              'auth-client-hmr',
              'native-client-hmr',
            ].includes(row.phase),
            JSON.stringify(row),
          )
          assert.match(row.text, popup)
          assert(control.includes(normalize(row.text)))
        }
      } catch (error) {
        console.error('Account entry observation:', await facts().catch(String))
        console.error('Account entry page errors:', f.errors)
        console.error('Account entry console:', f.consoleErrors)
        console.error(
          'Account entry attempts:',
          f.platform.attempts.map(({ id, cancelled }) => ({ id, cancelled })),
          f.platform.cancellations,
        )
        console.error(
          'Account entry pages:',
          f.context.pages().map((page) => page.url()),
        )
        console.error(
          'Account entry client services:',
          await f.page.evaluate(() => {
            const ctx = (window as any).__accountEntry.auth.ctx
            return {
              baseline: (window as any).__DSH_REMOTE_ACCESS__,
              services: [
                'slots',
                'configForms',
                'remote',
                'remote.account',
                'remote.session',
                'remoteAccess',
              ].map((name) => [name, !!ctx.get(name)]),
              entries: [...ctx.get('loader').entries()]
                .filter((entry: any) => entry.options.name.includes('account'))
                .map((entry: any) => ({
                  name: entry.options.name,
                  state: entry.fiber?.state,
                  error: String(entry.fiber?.error ?? ''),
                })),
            }
          }),
        )
        console.error('Account entry Host output:', f.output())
        throw error
      } finally {
        await f.close()
      }
    },
  )

  test(
    'native account notifications remain local across language and lifecycle changes',
    { timeout: 180_000 },
    async () => {
      const f = await fixture({ entryObserver: true, privateRuntime: true })
      f.platform.localizeNotifications()
      const facts = () => f.page.evaluate(() => (window as any).__accountEntry.snapshot())
      const card = f.page.locator('aside').filter({
        has: f.page.getByRole('status').filter({ hasText: f.platform.notification.title }),
      })
      const resize = async (width: number) => {
        await f.page.setViewportSize({ width, height: 900 })
        const drawer = f.page.locator('[data-sidebar-drawer]')
        if (width === 390) {
          await expect(drawer).toHaveCount(1)
          if ((await drawer.getAttribute('data-sidebar-collapsed')) !== null)
            await f.page.locator('button[data-sidebar-opener]').click()
          await expect(drawer).not.toHaveAttribute('data-sidebar-collapsed', 'true')
        } else await expect(drawer).toHaveCount(0)
        await waitForAnimations(f.page)
        await expect(card).toBeVisible()
      }
      const closeLabels = {
        zh: '关闭',
        en: 'Close',
        ja: '閉じる',
        es: 'Cerrar',
        fr: 'Fermer',
        de: 'Schließen',
        ru: 'Закрыть',
        pt: 'Fechar',
      }
      const review = join(project, '.cache/ui-review', dshVersion, 'notifications')
      await mkdir(review, { recursive: true })
      try {
        const dialog = await f.open()
        const opened = f.context.waitForEvent('page')
        await dialog.getByRole('button', { name: '打开登录页', exact: true }).click()
        const popup = await opened
        await popup.getByRole('button', { name: 'Authorize test account' }).waitFor()
        await dialog.getByLabel('完整回调地址', { exact: true }).fill(f.platform.callback())
        await dialog.getByRole('button', { name: '确认登录', exact: true }).click()
        await expect(dialog).not.toBeVisible()
        assert.equal(f.platform.exchanges.length, 1)
        await popup.close()
        await expect(card).toBeVisible()
        await expect
          .poll(
            () =>
              f.platform.notificationEvents.filter((event) => event.type === 'displayed').length,
          )
          .toBe(1)
        const initial = await facts()
        assert.equal(initial.entryCount, 1)
        assert.equal(initial.childIds.length, 1)
        for (const locale of Object.keys(closeLabels) as Locale[]) {
          const wireLocale = locale === 'zh' ? 'zh_CN' : 'en_US'
          const reads = f.platform.notificationRequests.filter((request) =>
            request.path.endsWith('/content'),
          ).length
          await f.page.evaluate(
            (locale) => (window as any).__accountEntry.auth.ctx.locale.setLocale(locale),
            locale,
          )
          if (locale !== 'zh')
            await expect
              .poll(
                () =>
                  f.platform.notificationRequests.filter((request) =>
                    request.path.endsWith('/content'),
                  ).length,
              )
              .toBeGreaterThan(reads)
          await expect(
            card.getByText(f.platform.notificationFor(wireLocale).title, { exact: true }),
          ).toBeVisible()
          await expect(
            card.getByText(f.platform.notificationFor(wireLocale).body, { exact: true }),
          ).toBeVisible()
          await expect(
            card.getByRole('button', { name: closeLabels[locale], exact: true }),
          ).toBeVisible()
          await expect(
            card.getByRole('button', { name: `Account [${wireLocale}]`, exact: true }),
          ).toBeVisible()
          for (const width of [1280, 390]) {
            await resize(width)
            await expect
              .poll(
                () =>
                  card.evaluate((node) => {
                    const bounds = node.getBoundingClientRect()
                    return (
                      node.scrollWidth <= node.clientWidth &&
                      bounds.left >= 0 &&
                      bounds.right <= innerWidth + 1
                    )
                  }),
                { message: `${locale} notification at ${width}px` },
              )
              .toBe(true)
            await f.page.screenshot({ path: join(review, `${locale}-light-${width}.png`) })
          }
          const current = await facts()
          assert.equal(current.entryId, initial.entryId)
          assert.deepEqual(current.childIds, initial.childIds)
          assert.deepEqual(current.childRegistrants, initial.childRegistrants)
        }
        assert.deepEqual(
          [...new Set(f.platform.notificationRequests.map((request) => request.locale))].sort(),
          ['en_US', 'zh_CN'],
        )
        assert.equal(
          f.platform.notificationEvents.filter((event) => event.type === 'displayed').length,
          1,
          'language and viewport changes retain consumption',
        )
        await card.getByRole('button', { name: 'Account [en_US]', exact: true }).click()
        await expect
          .poll(
            () =>
              f.platform.notificationEvents.filter((event) => event.type === 'cta_clicked').length,
          )
          .toBe(1)
        await expect(
          f.page.getByRole('dialog', { name: 'Configurações', exact: true }),
        ).toBeVisible()
        await f.page.keyboard.press('Escape')
        await f.page.evaluate(() => (window as any).__accountEntry.auth.ctx.locale.setLocale('zh'))
        await openDshSettings(f.page)
        await f.page
          .getByRole('dialog', { name: '设置', exact: true })
          .getByRole('button', { name: '通用设置', exact: true })
          .click()
        await selectDshTheme(f.page, 'dark')
        await f.page.keyboard.press('Escape')
        for (const width of [1280, 390]) {
          await resize(width)
          await f.page.screenshot({ path: join(review, `zh-dark-${width}.png`) })
        }
        for (const [kind, path] of [
          ['auth', join(f.profile, 'node_modules/dsh-auth-remote/dist/client.js')],
          ['native', f.nativeClient!],
        ] as const) {
          f.setPhase(`${kind}-notification-hmr`)
          const old = await facts()
          const marker = `notification ${kind} client HMR ${randomUUID()}`
          assert.equal((await stat(path)).nlink, 1)
          const loaded = f.page.waitForEvent('console', {
            predicate: (message) => message.text() === marker,
            timeout: 30_000,
          })
          await appendFile(path, '\nconsole.info(' + JSON.stringify(marker) + ');\n')
          await loaded
          await expect.poll(facts, { timeout: 30_000 }).toMatchObject({
            applies: { [kind]: old.applies[kind] + 1 },
            disposals: { [kind]: old.disposals[kind] + 1 },
            roots: 1,
            decorated: true,
          })
          await expect(card).toBeVisible()
          const current = await facts()
          if (kind === 'auth') {
            assert.deepEqual(current.childIds, old.childIds)
            assert.deepEqual(current.childRegistrants, old.childRegistrants)
          } else {
            assert.notDeepEqual(current.childIds, old.childIds)
          }
          assert.equal(current.childIds.length, 1)
          assert.equal(f.platform.exchanges.length, 1)
        }
        await card.getByRole('button', { name: '关闭', exact: true }).click()
        await expect(card).toHaveCount(0)
        await expect
          .poll(
            () =>
              f.platform.notificationEvents.filter((event) => event.type === 'dismissed').length,
          )
          .toBe(1)
        assert.deepEqual(
          [...new Set(f.platform.notificationEvents.map((event) => event.type))].sort(),
          ['cta_clicked', 'dismissed', 'displayed'],
        )
        assert(f.platform.notificationRequests.some((request) => request.path.endsWith('/list')))
        assert(f.platform.notificationRequests.some((request) => request.path.endsWith('/content')))
        assert(f.platform.notificationRequests.some((request) => request.path.endsWith('/events')))
        assert.deepEqual(f.externalRequests, [])
        assert.deepEqual(f.errors, [])
        assert.equal(f.consoleErrors.length, 3)
        const [navigation, initialization, reinitialization] = f.consoleErrors
        assert.equal(navigation!.phase, 'boot')
        assert.equal(
          navigation!.text.split("'")[1],
          `${f.platform.origin}/dsh/authorize?id=${f.platform.attempts[0]!.id}&theme=light`,
        )
        assert.equal(navigation!.text.split("'")[3], f.origin + '/')
        assert.match(
          navigation!.text,
          /^Unsafe attempt to initiate navigation for frame with URL 'http:\/\/127\.0\.0\.1:\d+\/dsh\/authorize\?[^']+' from frame with URL 'http:\/\/account-remote\.test:\d+\/'. The frame attempting navigation is neither same-origin with the target, nor is it the target's parent or opener\.(?:\\n|\n)$/u,
        )
        assert.deepEqual(initialization, {
          phase: 'boot',
          text: '[deepseek-account] default model initialization failed {reason: refused}',
        })
        assert.deepEqual(reinitialization, {
          phase: 'native-notification-hmr',
          text: '[deepseek-account] default model initialization failed {reason: refused}',
        })
      } catch (error) {
        console.error(
          'Notification observation:',
          await facts().catch(String),
          f.consoleErrors,
          f.platform.notificationRequests,
          f.platform.notificationEvents,
        )
        console.error('Notification page:', await f.page.locator('body').innerText())
        throw error
      } finally {
        await f.close()
      }
    },
  )
}

test(
  'eight language dictionaries render the real manual account dialog and errors',
  { timeout: 90000 },
  async () => {
    const f = await fixture({ observeClient: true })
    const review = join(project, '.cache/ui-review', dshVersion, 'languages')
    await mkdir(review, { recursive: true })
    try {
      const dialog = await f.open()
      const opened = f.context.waitForEvent('page')
      await dialog.getByRole('button', { name: '打开登录页', exact: true }).click()
      const popup = await opened
      await popup.getByRole('button', { name: 'Authorize test account' }).waitFor()
      await dialog
        .getByLabel('完整回调地址', { exact: true })
        .fill('https://example.invalid/?code=wrong&state=wrong')
      await dialog.getByRole('button', { name: '确认登录', exact: true }).click()
      await expect(
        dialog.getByText(dictionaries.zh.accountLoginInvalidCallback, { exact: true }),
      ).toBeVisible()
      const locales: Locale[] = ['0.2.2-alpha.3', '0.2.2-rc.1', '0.2.2-rc.2'].includes(dshVersion)
        ? (Object.keys(dictionaries) as Locale[])
        : ['zh', 'en']
      assert.deepEqual(
        await f.page.evaluate(() =>
          (window as any).__authRemoteContext.locale
            .getSnapshot()
            .locales.map((entry: { id: string }) => entry.id)
            .sort(),
        ),
        [...locales].sort(),
        'plugin dictionaries must preserve the native language catalog',
      )
      const visited = new Set<Locale>()
      for (const locale of locales) {
        const t = dictionaries[locale]
        await f.page.evaluate(
          (value) => (window as any).__authRemoteContext.locale.setLocale(value),
          locale,
        )
        await expect
          .poll(() =>
            f.page.evaluate(() => (window as any).__authRemoteContext.locale.getSnapshot().active),
          )
          .toBe(locale)
        const task = f.page.getByRole('dialog', { name: t.accountLoginTitle, exact: true })
        await expect(task.getByLabel(t.accountLoginCallbackLabel)).toBeVisible()
        await expect(task.getByText(t.accountLoginInvalidCallback, { exact: true })).toBeVisible()
        for (const width of [1280, 390]) {
          await f.page.setViewportSize({ width, height: 900 })
          assert.equal(
            await task.evaluate(
              (node) =>
                node.scrollWidth <= node.clientWidth &&
                node.getBoundingClientRect().left >= 0 &&
                node.getBoundingClientRect().right <= innerWidth + 1,
            ),
            true,
            `${locale} manual ${width}`,
          )
          await f.page.screenshot({ path: join(review, `${locale}-manual-${width}.png`) })
          visited.add(locale)
        }
      }
      assert.deepEqual([...visited].sort(), [...locales].sort())
      if (['0.2.2-alpha.3', '0.2.2-rc.1', '0.2.2-rc.2'].includes(dshVersion))
        assert.deepEqual([...visited].sort(), ['de', 'en', 'es', 'fr', 'ja', 'pt', 'ru', 'zh'])
      console.log('actual manual account language coverage', JSON.stringify([...visited].sort()))
      assert.deepEqual(f.errors, [])
    } finally {
      await f.close()
    }
  },
)

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
      await expect(toggle).toBeEnabled()
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

if (['0.2.2-alpha.3', '0.2.2-rc.1', '0.2.2-rc.2'].includes(dshVersion))
  test(
    'native HMR preserves preflight failures and cleans allocated replacement resources before rollback',
    { timeout: 150000 },
    async () => {
      const f = await fixture({
        hmrProbeEnabled: true,
        supportReloadProbe: true,
        lifecycleProbe: true,
      })
      const original = await readFile(f.moduleEntry, 'utf8')
      const target = new URL(f.origin)
      const cookie = `${AUTH_COOKIE}=${(await f.context.cookies()).find((entry) => entry.name === AUTH_COOKIE)!.value}`
      const options = { host: target.host, origin: f.origin, cookie }
      const observation = async () => {
        const response = await nativeHttp(
          `http://127.0.0.1:${target.port}`,
          '/plugins/hmr-lifecycle/observation',
          options,
        )
        assert.equal(response.status, 200, response.body)
        return JSON.parse(response.body)
      }
      const ready = async () => {
        try {
          return await observation()
        } catch {
          return undefined
        }
      }
      const openSocket = () =>
        f.page.evaluate(
          () =>
            new Promise<void>((resolve, reject) => {
              ;(window as any).__hmrSocketClosed = false
              const socket = new WebSocket(
                location.origin.replace('http:', 'ws:') + '/api/remote.mux',
              )
              const timer = setTimeout(() => {
                socket.close()
                reject(new Error('real HMR mux timed out'))
              }, 5000)
              socket.onopen = () =>
                socket.send(
                  JSON.stringify({
                    type: 'open',
                    streamId: 'hmr-lifecycle',
                    endpoint: '$events',
                    payload: { args: {} },
                  }),
                )
              socket.onmessage = (event) => {
                const frame = JSON.parse(String(event.data))
                if (frame.type !== 'item' || frame.value?.type !== 'ready') return
                clearTimeout(timer)
                resolve()
              }
              socket.onclose = () => {
                ;(window as any).__hmrSocketClosed = true
              }
              socket.onerror = () => {
                clearTimeout(timer)
                reject(new Error('real HMR mux failed'))
              }
            }),
        )
      try {
        const before = await observation()
        const saved = JSON.parse(
          await readFile(join(f.profile, 'auth-remote/auth-state.json'), 'utf8'),
        )
        await assert.rejects(AuthStateStore.open(f.profile), /state lock/u)
        await openSocket()
        const importFailure = 'task9 native import failure'
        await writeFile(
          f.moduleEntry,
          original + `\nthrow new Error(${JSON.stringify(importFailure)});\n`,
        )
        await expect
          .poll(async () => (await observation()).diagnostics.join('\n'), { timeout: 20000 })
          .toContain(importFailure)
        const preserved = await observation()
        assert.equal(preserved.current, before.current)
        assert.equal(preserved.nonce, before.nonce)
        assert.equal(preserved.entries[0].listening, true)
        assert.equal(preserved.entries[0].healthy, true)
        assert.equal(preserved.entries[0].fiberUid, before.entries[0].fiberUid)
        assert.equal(await f.page.evaluate(() => (window as any).__hmrSocketClosed), false)
        const allocated = 'task9 replacement allocated real resources'
        const activationFailure = 'task9 replacement init failure'
        await writeFile(
          f.moduleEntry,
          original +
            `
const task9NativeInit = AuthRemoteWebServer.prototype[Service.init];
AuthRemoteWebServer.prototype[Service.init] = async function () {
  await task9NativeInit.call(this);
  globalThis[Symbol.for('dsh-auth-remote.test.hmr-lifecycle')].record(this, 'failed-init');
  console.info(${JSON.stringify(allocated)});
  throw new Error(${JSON.stringify(activationFailure)});
};
`,
        )
        await expect.poll(f.output, { timeout: 20000 }).toContain(allocated)
        await expect
          .poll(async () => (await ready())?.diagnostics.join('\n'), { timeout: 30000 })
          .toContain(activationFailure)
        await expect
          .poll(
            async () => {
              const value = await ready()
              return (
                !!value &&
                value.current !== before.current &&
                value.entries.some((entry: any) => entry.kind === 'failed-init') &&
                value.entries
                  .filter((entry: any) => entry.id !== value.current)
                  .every(
                    (entry: any) =>
                      !entry.listening && !entry.healthy && entry.fiberUid === null && entry.closed,
                  )
              )
            },
            { timeout: 30000 },
          )
          .toBe(true)
        const rollback = await observation()
        assert.match(rollback.diagnostics.join('\n'), /failed to reload plugin at/u)
        assert.equal(rollback.port, before.port)
        assert.notEqual(rollback.nonce, before.nonce)
        assert.equal(
          rollback.entries.find((entry: any) => entry.id === rollback.current).healthy,
          true,
        )
        await expect.poll(() => f.page.evaluate(() => (window as any).__hmrSocketClosed)).toBe(true)
        assert.equal(
          (await nativeHttp(`http://127.0.0.1:${target.port}`, '/auth-remote/me', options)).status,
          200,
        )
        await assert.rejects(AuthStateStore.open(f.profile), /state lock/u)
        await openSocket()
        const success = 'task9 valid native replacement loaded'
        await writeFile(f.moduleEntry, original + `\nconsole.info(${JSON.stringify(success)});\n`)
        await expect.poll(f.output, { timeout: 20000 }).toContain(success)
        await expect
          .poll(
            async () => {
              const value = await ready()
              return (
                !!value &&
                value.current !== rollback.current &&
                value.entries
                  .filter((entry: any) => entry.id !== value.current)
                  .every(
                    (entry: any) =>
                      !entry.listening && !entry.healthy && entry.fiberUid === null && entry.closed,
                  )
              )
            },
            { timeout: 30000 },
          )
          .toBe(true)
        const replaced = await observation()
        assert.equal(replaced.port, before.port)
        assert.notEqual(replaced.nonce, rollback.nonce)
        await expect.poll(() => f.page.evaluate(() => (window as any).__hmrSocketClosed)).toBe(true)
        await f.page.reload()
        await f.page.waitForSelector('[class*="frame"]')
        const described = await nativeSettingsRpc(f.page, 'settings/describe', {})
        assert.equal(described.result.ok, true)
        const namespace = described.result.value.namespaces.find(
          (entry: any) => entry.ns === 'auth-remote-support-probe',
        )
        assert.ok(namespace, JSON.stringify(described))
        const changed = await nativeSettingsRpc(f.page, 'settings/mutate', {
          ns: namespace.ns,
          ops: [{ op: 'set', path: ['manualAccountLogin'], value: false }],
          expectedRevision: namespace.revision,
        })
        assert.equal(changed.result.ok, true, JSON.stringify(changed))
        assert.equal(changed.result.value.value.manualAccountLogin, false)
        assert.match(
          await readFile(join(f.profile, 'cordis.patch.yml'), 'utf8'),
          /manualAccountLogin: false/u,
        )
        await f.stopServer()
        const store = await AuthStateStore.open(f.profile)
        try {
          assert.deepEqual(store.current().account, saved.account)
          assert.deepEqual(store.current().sessions, saved.sessions)
        } finally {
          await store.close()
        }
      } catch (error) {
        await expect
          .poll(ready, { timeout: 10000 })
          .toBeTruthy()
          .catch(() => {})
        console.error('Native HMR lifecycle observation:', JSON.stringify(await ready()))
        console.error('Native HMR console:', f.output())
        throw error
      } finally {
        await f.close()
      }
    },
  )

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
        await expect(settings.getByRole('alert').filter({ hasText: '配置保存失败' })).toHaveCount(0)
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
        await expect(settings.getByRole('alert').filter({ hasText: '配置保存失败' })).toHaveCount(0)
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
          await expect(f.page.getByRole('dialog', { name: '登录失败', exact: true })).toBeVisible()
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
      assert.equal(await f.page.evaluate(async () => (await fetch('/auth-remote/me')).status), 200)
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
      await expect(dialog.getByRole('button', { name: '使用 API Key', exact: true })).toHaveCount(0)
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
      await expect(dialog.getByRole('button', { name: 'Use API key', exact: true })).toBeInViewport(
        { ratio: 1 },
      )
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
