import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { appendFile, copyFile, readFile, readdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { expect } from '@playwright/test'
import { dshVersion } from '../../scripts/runtime.mjs'
import { requestAdmin } from '../../src/cli/ipc-client.js'
import { checkBrowserDelegation } from '../fixtures/remote-alpha2/browser-delegation-check.mjs'
import { checkPackedSessions } from '../fixtures/remote-alpha2/packed-session-check.js'
import { nativeHttp } from '../helpers/native-http.js'
import { packedCommand, packedProfile } from '../helpers/packed-runtime.js'
import { launchBrowser, openDshSettings } from '../helpers/runtime.js'

const nativeDelegation = dshVersion === '0.2.3-alpha.2'

if (nativeDelegation) {
  test(
    'delegated sessions preserve native HTTPS admission and expire both transports',
    { timeout: 90000 },
    () => checkPackedSessions(false),
  )
  test(
    'delegated sessions preserve absolute deadlines across proxy, policy reload and restart',
    { timeout: 120000 },
    () => checkPackedSessions(true),
  )
}

test(
  nativeDelegation
    ? 'native remote authorization issues sessions through real QR and pairing in separate browsers'
    : 'legacy remote login keeps password access and hides native device authorization',
  { timeout: 120_000 },
  async () => {
    const reservation = createServer().listen(0, '127.0.0.1')
    await once(reservation, 'listening')
    const bound = reservation.address()
    assert(bound && typeof bound !== 'string')
    const { port } = bound
    await new Promise<void>((resolve) => reservation.close(() => resolve()))
    const address = `http://127.0.0.1:${port}`
    const base = nativeDelegation ? `http://dsh-packed-remote.test:${port}` : address
    const password = randomBytes(24).toString('base64url')
    const f = await packedProfile({ publicUrl: base, port, requireTotp: false })
    let host: ReturnType<typeof packedCommand> | undefined
    let phase = 'installing the exact runtime'
    try {
      if (nativeDelegation) {
        const installed = await readdir(join(f.profile, 'node_modules/.pnpm'))
        assert(
          installed.every(
            (entry) => !/^@deepseek-ai\+(?:cordis|dsh-host-webserver|schemastery)@/u.test(entry),
          ),
        )
        const observer = join(f.profile, 'packed-peer-observer.mjs')
        await copyFile(
          new URL('../fixtures/remote-alpha2/packed-peer-observer.mjs', import.meta.url),
          observer,
        )
        await appendFile(
          join(f.profile, 'cordis.patch.yml'),
          '- id: remote-connection\n  config:\n    ticketLifetimeMs: 14000\n    pairing:\n      requestTtlMs: 12000\n      pollIntervalMs: 800\n      requestIntervalMs: 1\n' +
            `- insert:\n    - id: packed-peer-observer\n      name: ${observer}\n      inject: [webServer, profileContext]\n`,
        )
      }
      phase = 'waiting for the installed production listener'
      host = packedCommand(f.home, ['web', '--no-open', '--port', String(port)], f.cwd)
      await expect
        .poll(
          async () => {
            if (host!.child.exitCode !== null) return -1
            return nativeHttp(address, '/auth-remote/ready')
              .then((response) => response.status)
              .catch(() => 0)
          },
          { timeout: 25000 },
        )
        .toBe(200)
      const admin = join(f.profile, 'auth-remote/admin.sock')
      if (nativeDelegation) {
        phase = 'resolving installed peer identities inside the Loader'
        const facts = join(f.profile, 'packed-peer-facts.json')
        await expect.poll(() => readFile(facts, 'utf8').then(Boolean, () => false)).toBe(true)
        assert.deepEqual(JSON.parse(await readFile(facts, 'utf8')), {
          '@deepseek-ai/cordis': { same: true, version: '4.2.0-alpha.1' },
          '@deepseek-ai/dsh-host-webserver': { same: true, version: '0.2.3-alpha.2' },
          '@deepseek-ai/schemastery': { same: true, version: '3.20.0-alpha.1' },
        })
        await checkBrowserDelegation(base, admin, password, (step: string) => {
          phase = step
        })
      } else {
        phase = 'legacy password login and Settings'
        await requestAdmin(admin, { version: 1, command: 'init', username: 'owner', password })
        const browser = await launchBrowser()
        try {
          const page = await browser.newPage({ locale: 'zh-CN' })
          await page.goto(base)
          await expect(page.locator('#login-form')).toBeVisible()
          await expect(page.locator('#login-method')).toHaveCount(0)
          await expect(page.locator('dsh-device-pairing')).toHaveCount(0)
          await page.locator('#username').fill('owner')
          await page.locator('#password').fill(password)
          await page.locator('#login-form button[type=submit]').click()
          await page.locator('#skip-binding').click()
          await page.waitForURL((url) => url.pathname === '/')
          await openDshSettings(page)
          await expect(
            page.getByRole('button', { name: /^(?:Remote connection|远程连接)$/iu }),
          ).toHaveCount(0)
        } finally {
          await browser.close()
        }
      }
    } catch (error) {
      const location =
        error instanceof Error &&
        error.stack?.match(
          /(?:remote-delegation\.spec\.ts|browser-delegation-check\.mjs):\d+:\d+/u,
        )?.[0]
      throw new Error(`${phase} failed (${location || 'unknown location'})`)
    } finally {
      try {
        await host?.stop()
      } finally {
        await f.cleanup()
      }
    }
  },
)
