import assert from 'node:assert/strict'
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { expect } from '@playwright/test'
import { AuthService } from '../../src/auth/service.js'
import { AuthStateStore } from '../../src/storage/store.js'
import { AUTH_COOKIE } from '../../src/shared/auth-contract.js'
import { packedCommand, packedProfile } from '../helpers/packed-runtime.js'
import { launchBrowser } from '../helpers/runtime.js'
import { dshVersion } from '../../scripts/runtime.mjs'

test(
  'native Settings updates the live Loader reference without replacing auth, lock or long connections and survives restart',
  { timeout: 120_000 },
  async () => {
    const f = await packedProfile({ requireTotp: false, port: 0 }, true)
    let process: ReturnType<typeof packedCommand> | undefined
    let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined
    try {
      const fixture = join(f.profile, 'live-config-observer.mjs')
      await copyFile(new URL('../fixtures/live-config-observer.mjs', import.meta.url), fixture)
      const patchPath = join(f.profile, 'cordis.patch.yml')
      await writeFile(
        patchPath,
        (await readFile(patchPath, 'utf8')) +
          [
            '- insert:',
            '    - id: live-config-observer',
            `      name: ${fixture}`,
            '      inject: [webServer, loader, profileContext]',
            '',
          ].join('\n'),
      )
      const store = await AuthStateStore.open(f.profile)
      const auth = new AuthService(store, { requireTotp: false, sessionHours: 168 })
      let token: string
      try {
        await auth.initialize('alice', 'isolated live config test password')
        const login = await auth.login('alice', 'isolated live config test password')
        assert.equal(login.kind, 'session')
        if (login.kind !== 'session') throw new Error('Expected session')
        token = login.token
      } finally {
        auth.dispose()
        await store.close()
      }
      async function start() {
        process = packedCommand(f.home, ['web', '--no-open', '--port', '0'], f.cwd)
        await expect
          .poll(
            () => {
              const text = process!.output()
              if (process!.child.exitCode !== null) throw new Error(text.stderr)
              return text.stdout.match(/http:\/\/127\.0\.0\.1:(\d+)/u)?.[1]
            },
            { timeout: 30_000 },
          )
          .toBeTruthy()
        const origin = `http://127.0.0.1:${process.output().stdout.match(/http:\/\/127\.0\.0\.1:(\d+)/u)![1]}`
        return origin
      }
      let origin = await start()
      browser = await launchBrowser()
      const context = await browser.newContext()
      await context.addCookies([{ name: AUTH_COOKIE, value: token!, url: origin }])
      const page = await context.newPage()
      await page.goto(origin)
      const observation = async () => {
        const response = await context.request.get(origin + '/plugins/live-config/observation')
        assert.equal(response.status(), 200)
        return response.json()
      }
      const before = await observation()
      assert.deepEqual(before.packages, {
        'dsh-web-app': dshVersion,
        'dsh-host-webserver': dshVersion,
        'dsh-client-connection': dshVersion,
        'dsh-deepseek-account-platform': dshVersion,
      })
      assert.equal(before.enabled, true)
      // Real protected HTTP and upgrade carriers must remain open throughout each write.
      await page.evaluate(async () => {
        const state = { sseReady: false, sseClosed: false, wsClosed: false, wsReady: false }
        ;(window as any).liveConnections = state
        // POST carries the browser's Origin into the strict downstream route.
        const response = await fetch('/plugins/strict/stream', { method: 'POST' })
        if (!response.ok || !response.body) throw new Error('Protected stream failed')
        const reader = response.body.getReader()
        state.sseReady = !(await reader.read()).done
        void (async () => {
          try {
            while (!(await reader.read()).done) {
              /* Consume heartbeat frames. */
            }
          } finally {
            state.sseClosed = true
          }
        })().catch(() => {})
        const ws = new WebSocket(location.origin.replace('http:', 'ws:') + '/plugins/strict/socket')
        ws.onmessage = () => {
          state.wsReady = true
        }
        ws.onclose = () => {
          state.wsClosed = true
        }
      })
      await expect
        .poll(() => page.evaluate(() => (window as any).liveConnections))
        .toMatchObject({ sseReady: true, wsReady: true, sseClosed: false, wsClosed: false })
      async function rpc(method: string, args: Record<string, unknown>) {
        return page.evaluate(
          async ({ method, args }) => {
            const response = await fetch('/api/' + method, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                type: 'client-request',
                rpcId: crypto.randomUUID(),
                method,
                payload: { args },
              }),
            })
            return { status: response.status, value: await response.json() }
          },
          { method, args },
        )
      }
      for (const enabled of [false, true, false]) {
        const described = await rpc('settings/describe', {})
        assert.equal(described.status, 200)
        const descriptor = described.value.result.value.namespaces.find(
          (ns: any) => ns.ns === 'auth-remote',
        )
        const saved = await rpc('settings/mutate', {
          ns: 'auth-remote',
          ops: [{ op: 'set', path: ['manualAccountLogin'], value: enabled }],
          expectedRevision: descriptor.revision,
        })
        assert.equal(saved.status, 200)
        assert.equal(saved.value.result.ok, true, JSON.stringify(saved.value))
        await expect.poll(observation).toMatchObject({
          fiberUid: before.fiberUid,
          sameFiber: true,
          sameReference: true,
          sameAuthentication: true,
          sameStorage: true,
          sameListener: true,
          sameLock: true,
          port: before.port,
          enabled,
        })
        assert.match(
          await readFile(patchPath, 'utf8'),
          new RegExp(`manualAccountLogin: ${enabled}`, 'u'),
        )
        assert.equal((await context.request.get(origin + '/auth-remote/me')).status(), 200)
        assert.deepEqual(await page.evaluate(() => (window as any).liveConnections), {
          sseReady: true,
          wsReady: true,
          sseClosed: false,
          wsClosed: false,
        })
      }
      await page.close()
      await process.stop()
      origin = await start()
      await expect.poll(observation).toMatchObject({
        sameFiber: true,
        sameReference: true,
        sameAuthentication: true,
        sameStorage: true,
        sameListener: true,
        sameLock: true,
        enabled: false,
      })
      assert.equal((await context.request.get(origin + '/auth-remote/me')).status(), 200)
    } finally {
      await browser?.close()
      await process?.stop()
      await f.cleanup()
    }
  },
)
