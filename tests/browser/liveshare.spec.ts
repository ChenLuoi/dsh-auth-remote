import assert from 'node:assert/strict'
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { expect } from '@playwright/test'
import { dshVersion } from '../../scripts/runtime.mjs'
import { packedAdmin, packedCommand, packedProfile } from '../helpers/packed-runtime.js'
import { launchBrowser } from '../helpers/runtime.js'

if (['0.2.2-alpha.3', '0.2.2-rc.1', '0.2.2-rc.2'].includes(dshVersion))
  test(
    'liveshare: native viewer carrier and index retain non-owner transport and administrator client is inert',
    { timeout: 90_000 },
    async () => {
      const f = await packedProfile({ requireTotp: false, port: 0 })
      let server: ReturnType<typeof packedCommand> | undefined
      let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined
      try {
        await packedAdmin(f.home, 'init', [
          ['Username: ', 'alice'],
          ['Password: ', 'isolated viewer password'],
          ['Enter password again: ', 'isolated viewer password'],
        ])
        const fixture = join(f.profile, 'liveshare-viewer.mjs')
        await copyFile(new URL('../fixtures/liveshare-viewer.mjs', import.meta.url), fixture)
        const patch = join(f.profile, 'cordis.patch.yml')
        await writeFile(
          patch,
          (await readFile(patch, 'utf8')) +
            `- insert:\n    - id: liveshare-viewer-fixture\n      name: ${fixture}\n      inject: [webServer, connection, profileContext]\n`,
        )
        server = packedCommand(f.home, ['web', '--no-open', '--port', '0'], f.cwd)
        const active = server
        let origin = ''
        await expect
          .poll(
            async () => {
              if (active.child.exitCode !== null) throw new Error(active.output().stderr)
              origin = /http:\/\/127\.0\.0\.1:[0-9]+/u.exec(active.output().stdout)?.[0] ?? ''
              return origin
                ? fetch(origin + '/auth-remote/ready')
                    .then((r) => r.status)
                    .catch(() => 0)
                : 0
            },
            { timeout: 30_000 },
          )
          .toBe(200)
        browser = await launchBrowser()
        const context = await browser.newContext()
        const login = await context.request.post(origin + '/auth-remote/login', {
          headers: { origin },
          data: { username: 'alice', password: 'isolated viewer password' },
        })
        assert.equal(login.status(), 200, await login.text())
        const page = await context.newPage()
        const pageErrors: string[] = []
        page.on('pageerror', (error) => pageErrors.push(error.message))
        // Observe the real module factory/apply without changing its dependencies or behavior.
        await page.addInitScript({
          path: new URL('../fixtures/liveshare-client-observer.js', import.meta.url).pathname,
        })
        const authRequests: string[] = []
        page.on('request', (req) => {
          if (new URL(req.url()).pathname.startsWith('/auth-remote/')) authRequests.push(req.url())
        })
        const documentResponse = await page.goto(origin + '/liveshare-fixture')
        assert.equal(documentResponse?.status(), 200, active.output().stderr)
        try {
          await expect
            .poll(() => page.evaluate(() => Boolean((window as any).__authRemoteExports)))
            .toBe(true)
        } catch (error) {
          console.error(
            'Viewer boot facts:',
            await page.evaluate(() => {
              const w = window as any
              return {
                baseline: w.__DSH_REMOTE_ACCESS__,
                transport: Object.keys(w.__DSH_TRANSPORT__ ?? {}),
                loader: Object.keys(w.__ModuleLoader__ ?? {}),
                text: document.body.innerText.slice(0, 1500),
                scripts: Array.from(document.scripts).map((script) => script.src),
                mode: w.__ModuleLoader__?.mode,
              }
            }),
          )
          console.error('Host errors:', active.output().stderr)
          throw error
        }
        const facts = await page.evaluate(() => {
          const w = window as any
          const before = w.__viewerTransportBefore
          return {
            same: before === w.__DSH_TRANSPORT__,
            fetch: before?.fetch === w.__DSH_TRANSPORT__?.fetch,
            stream: before?.openStream === w.__DSH_TRANSPORT__?.openStream,
            hasFetch: typeof before?.fetch,
            hasStream: typeof before?.openStream,
            ownsHost: w.__DSH_TRANSPORT__?.ownsHost,
            manual: w.__DSH_AUTH_REMOTE_MANUAL_ACCOUNT_LOGIN__,
            baseline: w.__DSH_REMOTE_ACCESS__,
            applies: w.__authRemoteApplies ?? 0,
          }
        })
        assert.ok(facts.applies >= 1, 'native Loader did not activate the real client entry')
        assert.equal(facts.same, true)
        assert.equal(facts.fetch, true)
        assert.equal(facts.stream, true)
        assert.equal(facts.hasFetch, 'function')
        assert.equal(facts.hasStream, 'function')
        assert.notEqual(facts.ownsHost, true)
        assert.equal(facts.manual, undefined)
        assert.equal(facts.baseline.owner, false)
        // Explicit calls also prove the full entry exits before touching any Context API.
        await page.evaluate(() => {
          const w = window as any
          const remembered = localStorage.getItem('dsh-auth-remote-lang')
          const sentinel = new Proxy(
            {},
            {
              get() {
                throw new Error('non-owner touched administrator Context')
              },
            },
          )
          for (const baseline of [
            { type: 'baseline', owner: false, grants: [] },
            null,
            {},
            { type: 'baseline', owner: 'true' },
          ]) {
            w.__DSH_REMOTE_ACCESS__ = baseline
            w.__authRemoteExports.apply(sentinel)
          }
          if (localStorage.getItem('dsh-auth-remote-lang') !== remembered) {
            throw new Error('non-owner changed language memory')
          }
        })
        assert.equal(await page.locator('style[data-plugin="dsh-auth-remote"]').count(), 0)
        await page.waitForTimeout(1200)
        assert.deepEqual(authRequests, [])
        assert.deepEqual(pageErrors, [])
        assert.equal(new URL(page.url()).pathname, '/liveshare-fixture')
      } finally {
        await browser?.close()
        await server?.stop()
        await f.cleanup()
      }
    },
  )
