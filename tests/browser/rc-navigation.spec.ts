import assert from 'node:assert/strict'
import { once } from 'node:events'
import { appendFile, copyFile, mkdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { expect, type Locator } from '@playwright/test'
import { dshVersion } from '../../scripts/runtime.mjs'
import { AuthService } from '../../src/auth/service.js'
import { AuthStateStore } from '../../src/storage/store.js'
import { AUTH_COOKIE } from '../../src/shared/auth-contract.js'
import { packedCommand, packedProfile } from '../helpers/packed-runtime.js'
import { completeApiKeyPrompt, launchBrowser, openDshSettings } from '../helpers/runtime.js'

if (['0.2.1-rc.3', '0.2.1-rc.4', '0.2.2-alpha.2'].includes(dshVersion))
  test(
    `DSH ${dshVersion} exposes three native More menus, model controls and security behind a revocable remote session`,
    { timeout: 120_000 },
    async () => {
      const probe = createServer().listen(0, '127.0.0.1')
      await once(probe, 'listening')
      const address = probe.address()
      assert(address && typeof address !== 'string')
      const port = address.port
      await new Promise<void>((resolve) => probe.close(() => resolve()))
      const origin = `http://rc-navigation.test:${port}`
      const f = await packedProfile({ publicUrl: origin, requireTotp: false })
      let server: ReturnType<typeof packedCommand> | undefined
      let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined
      try {
        await mkdir(join(f.home, 'nav-workspace'))
        const fixture = join(f.profile, 'rc-navigation-state.mjs')
        await copyFile(new URL('../fixtures/rc-navigation-state.mjs', import.meta.url), fixture)
        await appendFile(join(f.profile, 'cordis.patch.yml'), '- id: webserver\n  disabled: true\n')
        await appendFile(
          join(f.profile, 'cordis.patch.yml'),
          `- insert:\n    - id: rc-navigation-state\n      name: ${JSON.stringify(fixture)}\n      inject: [webServer, sessions, sessionProjections]\n`,
        )
        const store = await AuthStateStore.open(f.profile)
        const auth = new AuthService(store, { requireTotp: false, sessionHours: 168 })
        let token: string
        try {
          await auth.initialize('alice', 'isolated navigation password')
          const login = await auth.login('alice', 'isolated navigation password')
          assert(login.kind === 'session')
          token = login.token
        } finally {
          auth.dispose()
          await store.close()
        }
        server = packedCommand(f.home, ['web', '--no-open', '--port', String(port)])
        await expect
          .poll(
            async () => {
              if (server!.child.exitCode !== null) throw new Error(server!.output().stderr)
              return fetch(`http://127.0.0.1:${port}/auth-remote/ready`, {
                headers: { host: new URL(origin).host },
              })
                .then((response) => response.status)
                .catch(() => 0)
            },
            { timeout: 30_000 },
          )
          .toBe(200)
        browser = await launchBrowser([
          '--no-proxy-server',
          '--host-resolver-rules=MAP rc-navigation.test 127.0.0.1',
        ])
        const context = await browser.newContext({
          locale: 'zh-CN',
          viewport: { width: 1440, height: 1000 },
        })
        await context.addCookies([{ name: AUTH_COOKIE, value: token!, url: origin }])
        const page = await context.newPage()
        const errors: string[] = []
        page.on('pageerror', (error) => errors.push(error.message))
        await page.goto(origin)
        await expect(page.locator('[class*="frame"]').first()).toBeVisible()
        assert.equal(
          await page.evaluate(() => (window as any).__DSH_BOOT__?.release?.version),
          dshVersion,
        )
        const notice = page.getByRole('dialog', { name: /^(?:内测声明|预览版说明)$/u })
        await notice.waitFor()
        await notice.getByRole('button', { name: '继续', exact: true }).click()
        await notice.waitFor({ state: 'hidden' })
        assert.equal(await completeApiKeyPrompt(page, 5000), true)

        await openDshSettings(page)
        const settings = page.getByRole('dialog', { name: '设置', exact: true })
        await settings.getByRole('button', { name: '安全与登录', exact: true }).click()
        await expect(
          settings.getByRole('heading', { name: '安全与登录', exact: true }),
        ).toBeVisible()

        await expect(settings.getByRole('switch', { name: '远程 DeepSeek 账号登录' })).toBeEnabled()
        await settings.getByRole('button', { name: '模型', exact: true }).click()
        await expect(settings.getByText('DeepSeek', { exact: true })).toBeVisible()
        await settings.getByRole('button', { name: '关闭', exact: true }).click()

        // Real native workspace selection creates a blank session without inference.
        await page.getByRole('button', { name: '选择工作区', exact: true }).click()
        const directory = page.getByRole('dialog', { name: '选择工作区目录', exact: true })
        const addWorkspace = page.getByText('添加工作区…', { exact: true })
        await Promise.any([directory.waitFor(), addWorkspace.waitFor()])
        if (await addWorkspace.isVisible()) await addWorkspace.click()
        await directory.getByText('nav-workspace', { exact: true }).click()
        await directory.getByRole('button', { name: '打开', exact: true }).click()
        await directory.waitFor({ state: 'hidden' })
        await expect(
          page.getByRole('textbox', { name: '描述你想要构建的内容, / 调用指令, @ 文件或对话' }),
        ).toBeVisible()

        const sessionId = await page
          .locator('[data-conversation-session]')
          .getAttribute('data-conversation-session')
        assert(sessionId, 'native workspace selection must create a real Session')
        assert.equal(
          await page.evaluate(
            async (sessionId) =>
              (
                await fetch('/plugins/rc-navigation/seed', {
                  method: 'POST',
                  credentials: 'omit',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ sessionId }),
                })
              ).status,
            sessionId,
          ),
          401,
        )
        const seed = await page.evaluate(async (sessionId) => {
          const response = await fetch('/plugins/rc-navigation/seed', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId }),
          })
          return { status: response.status, body: await response.json() }
        }, sessionId)
        assert.equal(seed.status, 200)
        assert.deepEqual(seed.body, { seeded: true, sessionId })
        assert.equal(
          await page.evaluate(
            async (sessionId) =>
              (
                await fetch('/plugins/rc-navigation/seed', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ sessionId }),
                })
              ).status,
            sessionId,
          ),
          409,
        )
        await page.reload()
        await expect(page.locator('[data-conversation-session]')).toHaveAttribute(
          'data-conversation-session',
          sessionId,
        )

        async function checkMore(trigger: Locator) {
          await trigger.click()
          await expect(trigger).toHaveAttribute('aria-expanded', 'true')
          const menu = page.getByRole('menu')
          await expect(
            menu.getByRole('menuitem', { name: '浏览更多插件', exact: true }),
          ).toBeVisible()
          await expect(
            menu.getByRole('menuitem', { name: '创建你的插件', exact: true }),
          ).toBeVisible()
          // Inspect entries only: no market request, installation or Creator draft.
          await page.keyboard.press('Escape')
          await expect(trigger).toHaveAttribute('aria-expanded', 'false')
        }
        await checkMore(
          page
            .getByRole('navigation', { name: '全局面板' })
            .getByRole('button', { name: '更多', exact: true }),
        )
        await checkMore(page.getByRole('button', { name: /^更多会话视图(?: · .+)?$/u }))
        const expand = page.getByRole('button', { name: '打开右侧边栏', exact: true })
        if (await expand.isVisible()) await expand.click()
        await checkMore(page.getByRole('button', { name: '更多工具', exact: true }))

        const model = page.getByRole('button', { name: /^(?:选择模型，当前|请选择模型)/u })
        await model.click()
        const selection = page.getByRole('menu', { name: '模型与推理等级', exact: true })
        await expect(selection).toBeVisible()
        await selection.getByRole('menuitem', { name: /^模型/u }).click()
        const choices = page
          .getByRole('group', { name: '模型与推理等级', exact: true })
          .getByRole('menuitemradio')
        await expect(choices.first()).toBeVisible()
        await choices.first().click()
        await expect(model).toHaveAttribute('aria-expanded', 'false')
        assert.deepEqual(f.model.requests, [])

        assert.equal(
          await page.evaluate(
            async () => (await fetch('/auth-remote/logout', { method: 'POST' })).status,
          ),
          200,
        )
        await context.addCookies([{ name: AUTH_COOKIE, value: token!, url: origin }])
        for (const path of ['/auth-remote/me', '/api/settings/describe'])
          assert.equal(await page.evaluate(async (path) => (await fetch(path)).status, path), 401)
        assert.equal(
          await page.evaluate(
            async (sessionId) =>
              (
                await fetch('/plugins/rc-navigation/seed', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ sessionId }),
                })
              ).status,
            sessionId,
          ),
          401,
        )
        await page.reload()
        await expect(page.getByLabel(/^(?:用户名|Username)$/u)).toBeVisible()
        assert.deepEqual(errors, [])
      } finally {
        await browser?.close()
        await server?.stop()
        await f.cleanup()
      }
    },
  )
