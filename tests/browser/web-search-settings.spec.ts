import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { expect } from '@playwright/test'
import { dshVersion } from '../../scripts/runtime.mjs'
import { AuthService } from '../../src/auth/service.js'
import { AuthStateStore } from '../../src/storage/store.js'
import { AUTH_COOKIE } from '../../src/shared/auth-contract.js'
import { packedCommand, packedProfile } from '../helpers/packed-runtime.js'
import { clickThroughDshPrompts, launchBrowser } from '../helpers/runtime.js'

// Verify the three-namespace native form on each exact RC target.
if (['0.2.1-rc.2', '0.2.1-rc.3', '0.2.1-rc.4'].includes(dshVersion))
  test(
    `DSH ${dshVersion} native web search settings persist all three namespaces and credentials behind the remote session gate`,
    { timeout: 120_000 },
    async () => {
      const probe = createServer().listen(0, '127.0.0.1')
      await once(probe, 'listening')
      const address = probe.address()
      assert.ok(address && typeof address !== 'string')
      const port = address.port
      await new Promise<void>((resolve) => probe.close(() => resolve()))
      const origin = `http://search-settings.test:${port}`
      const f = await packedProfile({
        publicUrl: origin,
        requireTotp: false,
        manualAccountLogin: false,
      })
      let calls = 0
      const provider = createHttpServer((_req, res) => {
        calls++
        res.writeHead(500).end('Settings verification must not invoke Search or Fetch')
      }).listen(0, '127.0.0.1')
      await once(provider, 'listening')
      const providerAddress = provider.address()
      assert.ok(providerAddress && typeof providerAddress !== 'string')
      const localProvider = `http://127.0.0.1:${providerAddress.port}`
      const messagesUrl = `${localProvider}/messages/v1`
      const apiUrl = `${localProvider}/tools/v1`
      const testKey = 'isolated-search-settings-test-key'
      let server: ReturnType<typeof packedCommand> | undefined
      let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined
      try {
        const store = await AuthStateStore.open(f.profile)
        const auth = new AuthService(store, { requireTotp: false, sessionHours: 168 })
        let token: string
        try {
          await auth.initialize('alice', 'isolated search settings password')
          const login = await auth.login('alice', 'isolated search settings password')
          assert.equal(login.kind, 'session')
          if (login.kind !== 'session') throw new Error('Expected session')
          token = login.token
        } finally {
          auth.dispose()
          await store.close()
        }
        async function start() {
          server = packedCommand(f.home, ['web', '--no-open', '--port', String(port)], f.cwd)
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
        }
        await start()
        browser = await launchBrowser([
          '--no-proxy-server',
          '--host-resolver-rules=MAP search-settings.test 127.0.0.1',
        ])
        const context = await browser.newContext({ locale: 'zh-CN' })
        await context.addCookies([{ name: AUTH_COOKIE, value: token!, url: origin }])
        let page = await context.newPage()
        async function rpc(method: string, args: unknown, omit = false) {
          return page.evaluate(
            async ({ method, args, omit, rpcId }) => {
              const response = await fetch('/api/' + method, {
                method: 'POST',
                credentials: omit ? 'omit' : 'same-origin',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  type: 'client-request',
                  rpcId,
                  method,
                  payload: { args },
                }),
              })
              return { status: response.status, body: await response.json() }
            },
            { method, args, omit, rpcId: randomUUID() },
          )
        }
        async function describe() {
          const result = await rpc('settings/describe', {})
          assert.equal(result.status, 200)
          assert.equal(result.body.result.ok, true)
          assert.equal(JSON.stringify(result.body).includes(testKey), false)
          return Object.fromEntries(
            result.body.result.value.namespaces.map((ns: any) => [ns.ns, ns.value]),
          )
        }
        async function openSearch() {
          await page.goto(origin)
          await page.locator('[class*="frame"]').first().waitFor()
          await clickThroughDshPrompts(
            page,
            page.getByRole('button', { name: '插件', exact: true }),
          )
          await clickThroughDshPrompts(
            page,
            page.getByRole('button', { name: /^(?:查看 )?网页搜索$/u }),
          )
          await expect(page.getByRole('switch', { name: '启用新版 Web 搜索 API' })).toBeVisible()
        }
        const saved = (ns: string) =>
          page.waitForResponse(
            (response) =>
              new URL(response.url()).pathname === '/api/settings/mutate' &&
              response.request().postDataJSON()?.payload?.args?.ns === ns,
          )
        async function save(ns: string) {
          const answer = saved(ns)
          await page.getByRole('button', { name: '保存', exact: true }).click()
          const response = await answer
          assert.equal(response.status(), 200)
          assert.equal((await response.json()).result.ok, true)
          // The native form writes credentials after its settings namespace response.
          await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled()
        }
        await openSearch()
        let sections = await describe()
        for (const ns of ['web', 'web-search-deepseek', 'web-deepseek-api'])
          assert.ok(sections[ns], ns)
        await expect(page.getByRole('switch', { name: '启用新版 Web 搜索 API' })).not.toBeChecked()
        await expect(page.getByText('未配置密钥；', { exact: false })).toBeVisible()
        await page.getByLabel('Messages API 基础地址', { exact: true }).fill(messagesUrl)
        await page.getByLabel('单次请求最多搜索次数', { exact: true }).fill('3')
        await save('web-search-deepseek')
        assert.deepEqual((await describe())['web-search-deepseek'], {
          ...sections['web-search-deepseek'],
          baseURL: messagesUrl,
          maxUses: 3,
        })

        await page.getByRole('switch', { name: '启用新版 Web 搜索 API' }).click()
        await page.getByLabel('Search / Fetch API 基础地址', { exact: true }).fill(apiUrl)
        const count = page.getByLabel('每次搜索结果数', { exact: true })
        await count.fill('51')
        await expect(
          page.getByText('请填 1–50 的整数；留空表示使用默认值。', { exact: true }),
        ).toBeVisible()
        await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled()
        await count.fill('7')
        await page.getByLabel('API Key', { exact: true }).fill(testKey)
        // Reject one transport response; do not replace a host settings provider.
        await page.route('**/api/settings/mutate', async (route) => {
          const request = route.request().postDataJSON()
          if (request?.payload?.args?.ns !== 'web-deepseek-api') return route.continue()
          await route.fulfill({
            json: {
              type: 'server-response',
              rpcId: request.rpcId,
              result: {
                ok: false,
                error: { code: 'settings/rejected', message: 'Isolated settings refusal' },
              },
            },
          })
        })
        await page.getByRole('button', { name: '保存', exact: true }).click()
        await expect(
          page.getByText('本部署没有接受这些值，已保留供你修改。', { exact: true }),
        ).toBeVisible()
        await expect(count).toHaveValue('7')
        assert.equal((await describe()).web.searchProvider, 'deepseek-official')
        await page.unroute('**/api/settings/mutate')
        await save('web')
        sections = await describe()
        assert.equal(sections.web.searchProvider, 'deepseek-search-api')
        assert.equal(sections.web.fetchProvider, 'deepseek-fetch-api')
        assert.equal(sections['web-deepseek-api'].baseURL, apiUrl)
        assert.equal(sections['web-deepseek-api'].count, 7)
        const credential = await rpc('credentials/describe', { refs: ['DEEPSEEK_API_KEY'] })
        assert.equal(credential.body.result.value.DEEPSEEK_API_KEY.configured, true)
        assert.equal(JSON.stringify(credential.body).includes(testKey), false)
        await expect(page.getByText('已配置密钥。', { exact: true })).toBeVisible()
        assert.equal(
          (await readFile(join(f.profile, 'cordis.patch.yml'), 'utf8')).includes(testKey),
          false,
        )
        await page.getByRole('switch', { name: '启用新版 Web 搜索 API' }).click()
        await save('web')
        sections = await describe()
        assert.equal(sections.web.searchProvider, 'deepseek-official')
        assert.equal(sections.web.fetchProvider, 'http')
        await expect(page.getByLabel('Messages API 基础地址', { exact: true })).toHaveValue(
          messagesUrl,
        )
        await expect(page.getByLabel('单次请求最多搜索次数', { exact: true })).toHaveValue('3')
        await page.getByRole('switch', { name: '启用新版 Web 搜索 API' }).click()
        await save('web')
        await openSearch()
        await expect(page.getByRole('switch', { name: '启用新版 Web 搜索 API' })).toBeChecked()
        await expect(page.getByLabel('每次搜索结果数', { exact: true })).toHaveValue('7')
        await page.close()
        await server!.stop()
        await start()
        page = await context.newPage()
        await openSearch()
        await expect(page.getByRole('switch', { name: '启用新版 Web 搜索 API' })).toBeChecked()
        await expect(page.getByLabel('Search / Fetch API 基础地址', { exact: true })).toHaveValue(
          apiUrl,
        )
        await expect(page.getByLabel('每次搜索结果数', { exact: true })).toHaveValue('7')
        await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('')
        await expect(page.getByText('已配置密钥。', { exact: true })).toBeVisible()
        assert.equal((await describe())['web-search-deepseek'].maxUses, 3)
        const denied = async (omit: boolean) => {
          for (const [method, args] of [
            ['settings/describe', {}],
            ...['web', 'web-search-deepseek', 'web-deepseek-api'].map(
              (ns) =>
                [
                  'settings/mutate',
                  {
                    ns,
                    ops: [{ op: 'set', path: ['baseURL'], value: 'https://example.invalid/' }],
                  },
                ] as const,
            ),
            ['credentials/describe', { refs: ['DEEPSEEK_API_KEY'] }],
            ['credentials/set', { ref: 'DEEPSEEK_API_KEY', value: 'must-not-save' }],
          ] as const)
            assert.equal((await rpc(method, args, omit)).status, 401, method)
        }
        await denied(true)
        const logout = await page.evaluate(
          async () => (await fetch('/auth-remote/logout', { method: 'POST' })).status,
        )
        assert.equal(logout, 200)
        // Present the stale credential again to prove revocation, beyond cookie clearing.
        await context.addCookies([{ name: AUTH_COOKIE, value: token!, url: origin }])
        await denied(false)
        assert.equal(calls, 0, 'No Search, Fetch or Messages request may reach the local provider')
      } finally {
        await browser?.close()
        await server?.stop()
        await new Promise<void>((resolve, reject) =>
          provider.close((error) => (error ? reject(error) : resolve())),
        )
        await f.cleanup()
      }
    },
  )
