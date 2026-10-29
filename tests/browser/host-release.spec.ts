import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { expect } from '@playwright/test'
import { dshVersion, project } from '../../scripts/runtime.mjs'
import { AuthService } from '../../src/auth/service.js'
import { AuthStateStore } from '../../src/storage/store.js'
import { AUTH_COOKIE } from '../../src/shared/auth-contract.js'
import { packedCommand, packedProfile } from '../helpers/packed-runtime.js'
import { clickThroughDshPrompts, launchBrowser, openDshSettings } from '../helpers/runtime.js'

// Exercise the native release gate with exact installed runtimes. Only the
// 0.2.1-alpha.3 destination lacks release metadata; no service is mocked.
const previousVersions: Record<string, string> = {
  '0.2.1-alpha.4': '0.2.1-alpha.3',
  '0.2.1-alpha.5': '0.2.1-alpha.4',
  '0.2.1-rc.1': '0.2.1-alpha.5',
  '0.2.1-rc.2': '0.2.1-rc.1',
  '0.2.1-rc.3': '0.2.1-rc.2',
  '0.2.1-rc.4': '0.2.1-rc.3',
  '0.2.2-alpha.2': '0.2.1-rc.4',
}
const previousVersion = previousVersions[dshVersion]
if (previousVersion)
  test(
    'native host-release prompt survives a real runtime switch and reload rechecks authentication and saved settings',
    { timeout: 180_000 },
    async () => {
      await promisify(execFile)(process.execPath, [join(project, 'scripts/prepare-test.mjs')], {
        cwd: project,
        env: {
          ...process.env,
          DSH_HOME: undefined,
          DSH_TEST_BIN: undefined,
          DSH_TEST_VERSION: previousVersion,
        },
      })
      const previousDsh = join(
        project,
        '.cache/test-runtime',
        previousVersion,
        'node_modules/.bin/dsh',
      )
      assert.equal(
        (await promisify(execFile)(previousDsh, ['--version'])).stdout.trim(),
        previousVersion,
      )
      const probe = createServer().listen(0, '127.0.0.1')
      await once(probe, 'listening')
      const address = probe.address()
      assert.ok(address && typeof address !== 'string')
      const port = address.port
      await new Promise<void>((resolve) => probe.close(() => resolve()))
      const origin = `http://127.0.0.1:${port}`
      const f = await packedProfile({ requireTotp: false, port })
      let server: ReturnType<typeof packedCommand> | undefined
      let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined
      try {
        const observer = join(f.profile, 'live-config-observer.mjs')
        await copyFile(new URL('../fixtures/live-config-observer.mjs', import.meta.url), observer)
        const patch = join(f.profile, 'cordis.patch.yml')
        await writeFile(
          patch,
          (await readFile(patch, 'utf8')) +
            `- insert:\n    - id: live-config-observer\n      name: ${observer}\n      inject: [webServer, loader, profileContext]\n`,
        )
        const store = await AuthStateStore.open(f.profile)
        const auth = new AuthService(store, { requireTotp: false, sessionHours: 168 })
        let token: string
        try {
          await auth.initialize('alice', 'isolated host release password')
          const login = await auth.login('alice', 'isolated host release password')
          assert.equal(login.kind, 'session')
          if (login.kind !== 'session') throw new Error('Expected session')
          token = login.token
        } finally {
          auth.dispose()
          await store.close()
        }
        async function start(binary?: string) {
          server = packedCommand(
            f.home,
            ['web', '--no-open', '--port', String(port)],
            f.cwd,
            {},
            binary,
          )
          await expect
            .poll(
              async () => {
                if (server!.child.exitCode !== null) throw new Error(server!.output().stderr)
                return fetch(origin + '/auth-remote/ready')
                  .then((response) => response.status)
                  .catch(() => 0)
              },
              { timeout: 30_000 },
            )
            .toBe(200)
        }
        await start()
        browser = await launchBrowser()
        const context = await browser.newContext({ locale: 'zh-CN' })
        await context.addCookies([{ name: AUTH_COOKIE, value: token!, url: origin }])
        const page = await context.newPage()
        const loadedVersion = async () => {
          const response = await context.request.get(origin + '/plugins/live-config/observation')
          assert.equal(response.status(), 200)
          return (await response.json()).packages['dsh-web-app']
        }
        await page.goto(origin)
        await expect(page.locator('[class*="frame"]').first()).toBeVisible()
        assert.equal(await loadedVersion(), dshVersion)
        const boot = () => page.evaluate(() => (window as any).__DSH_BOOT__?.release?.version)
        assert.equal(await boot(), dshVersion)
        await openDshSettings(page)
        const settings = page.getByRole('dialog', { name: '设置', exact: true })
        await clickThroughDshPrompts(
          page,
          settings.getByRole('button', { name: '安全与登录', exact: true }),
        )
        const toggle = settings.getByRole('switch', { name: '远程 DeepSeek 账号登录' })
        await expect(toggle).toBeChecked()
        await expect(toggle).toBeEnabled()
        const [mutation] = await Promise.all([
          page.waitForResponse(
            (response) =>
              new URL(response.url()).pathname === '/api/settings/mutate' &&
              response.request().postData()?.includes('manualAccountLogin') === true,
          ),
          toggle.click(),
        ])
        assert.equal((await mutation.json()).result.ok, true)
        await expect(toggle).not.toBeChecked()
        const before = await (await context.request.get(origin + '/auth-remote/me')).json()
        await settings.getByRole('button', { name: '关闭', exact: true }).click()
        await server!.stop()
        await start(previousDsh)
        assert.equal(await loadedVersion(), previousVersion)
        const prompt = page.getByRole('dialog', { name: '服务版本变化', exact: true })
        await expect(prompt).toBeVisible({ timeout: 45_000 })
        // Preserve the unknown-identity case and check a known destination too.
        await expect(prompt).toContainText(
          previousVersion === '0.2.1-alpha.3' ? '未解析' : previousVersion,
        )
        assert.equal(await boot(), dshVersion)
        const review = join(project, '.cache/ui-review', dshVersion)
        await mkdir(review, { recursive: true })
        await page.screenshot({ path: join(review, 'host-release-change.png') })
        const checked = page.waitForResponse(
          (response) => new URL(response.url()).pathname === '/auth-remote/me',
        )
        await prompt.getByRole('button', { name: '刷新以加载新版本', exact: true }).click()
        assert.equal((await checked).status(), 200)
        await expect(page.locator('[class*="frame"]').first()).toBeVisible()
        await expect(prompt).toHaveCount(0)
        if (previousVersion === '0.2.1-alpha.3') assert.equal(await boot(), undefined)
        else assert.equal(await boot(), previousVersion)
        await openDshSettings(page)
        await clickThroughDshPrompts(
          page,
          settings.getByRole('button', { name: '安全与登录', exact: true }),
        )
        await expect(toggle).not.toBeChecked()
        assert.deepEqual(
          await (await context.request.get(origin + '/auth-remote/me')).json(),
          before,
        )
        await server!.stop()
        await start()
        await page.reload()
        await expect.poll(boot).toBe(dshVersion)
        assert.equal(await loadedVersion(), dshVersion)
        await openDshSettings(page)
        await clickThroughDshPrompts(
          page,
          settings.getByRole('button', { name: '安全与登录', exact: true }),
        )
        await expect(toggle).not.toBeChecked()
        assert.equal((await context.request.get(origin + '/auth-remote/me')).status(), 200)
      } finally {
        await browser?.close()
        await server?.stop()
        await f.cleanup()
      }
    },
  )
