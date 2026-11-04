import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { expect } from '@playwright/test'
import { dshVersion, project } from '../../scripts/runtime.mjs'
import { packedAdmin, packedCommand, packedProfile } from '../helpers/packed-runtime.js'
import {
  launchBrowser,
  openDshSettings,
  selectDshTheme,
  waitForAnimations,
} from '../helpers/runtime.js'

test(
  'native settings security icon preserves host navigation and contribution lifecycle',
  { timeout: 120_000 },
  async () => {
    const f = await packedProfile({ requireTotp: false, port: 0 })
    let server: ReturnType<typeof packedCommand> | undefined
    let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined
    const password = 'isolated native icon password'
    try {
      await packedAdmin(f.home, 'init', [
        ['Username: ', 'alice'],
        ['Password: ', password],
        ['Enter password again: ', password],
      ])
      server = packedCommand(f.home, ['web', '--no-open', '--port', '0'], f.cwd)
      let origin = ''
      await expect
        .poll(
          async () => {
            if (server!.child.exitCode !== null) throw new Error(server!.output().stderr)
            origin = /http:\/\/127\.0\.0\.1:[0-9]+/u.exec(server!.output().stdout)?.[0] ?? ''
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
      const context = await browser.newContext({
        locale: 'zh-CN',
        viewport: { width: 1280, height: 900 },
      })
      const login = await context.request.post(origin + '/auth-remote/login', {
        headers: { origin },
        data: { username: 'alice', password },
      })
      assert.equal(login.status(), 200, await login.text())
      const page = await context.newPage()
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.addInitScript({
        path: new URL('../fixtures/settings-icon-observer.js', import.meta.url).pathname,
      })
      await page.goto(origin)
      await openDshSettings(page)
      const nav = page
        .getByRole('dialog', { name: '设置', exact: true })
        .getByRole('button', { name: '安全与登录', exact: true })
      await expect(nav).toHaveCount(1)
      const hasSlot = dshVersion === '0.2.2-alpha.3'
      const facts = () =>
        page.evaluate(() => {
          const s = (window as any).__settingsIcon
          const slots = s.ctx.get('slots')
          return {
            declared: Boolean(slots.snapshot('settings.section.icon').length),
            count: slots
              .entries('settings.section.icon')
              .filter((e: any) => e.options.id === 'security').length,
            renders: s.renders,
            modules: s.modules,
            registrations: s.registrations,
          }
        })
      const initial = await facts()
      assert.equal(initial.declared, hasSlot)
      assert.equal(initial.count, hasSlot ? 1 : 0)
      assert(initial.modules.includes('@deepseek-ai/dsh-client-ui-primitives'))
      const review = join(project, '.cache/ui-review', dshVersion, 'settings-icon')
      await mkdir(review, { recursive: true })
      for (const theme of ['light', 'dark'] as const) {
        await page.getByRole('button', { name: '通用设置', exact: true }).click()
        await selectDshTheme(page, theme)
        for (const width of [1280, 390]) {
          await page.setViewportSize({ width, height: 900 })
          for (const selected of [false, true]) {
            if (selected) await nav.click()
            else await page.getByRole('button', { name: '通用设置', exact: true }).click()
            await waitForAnimations(page)
            await expect(nav).toHaveAccessibleName('安全与登录')
            const svg = nav.locator('svg')
            await expect(svg).toHaveCount(1)
            if (hasSlot) {
              await expect(svg).toHaveAttribute('data-icon', /shield-outline.*medium/u)
              await expect(svg).toHaveAttribute('width', '16')
              await expect(svg).toHaveAttribute('height', '16')
              await expect(svg).toHaveAttribute('aria-hidden', 'true')
              if (selected) await expect(nav).toHaveAttribute('aria-current', 'true')
              else await expect(nav).not.toHaveAttribute('aria-current', 'true')
              assert.equal(
                await svg.evaluate(
                  (node) =>
                    getComputedStyle(node).color ===
                    getComputedStyle(node.closest('button')!).color,
                ),
                true,
              )
            }
            await page.screenshot({
              path: join(review, `${theme}-${width}-${selected ? 'selected' : 'idle'}.png`),
            })
          }
        }
        await page.setViewportSize({ width: 1280, height: 900 })
      }
      if (hasSlot) {
        const rendered = (await facts()).renders
        assert(rendered.every((r: any) => r.native && r.size === 16))
        assert(rendered.some((r: any) => r.active) && rendered.some((r: any) => !r.active))
        await page.evaluate(() => (window as any).__settingsIcon.releaseIcon())
        await expect(nav.locator('svg[data-icon*="shield-outline"]')).toHaveCount(0)
        await expect(nav).toHaveCount(1)
        await expect(nav.locator('svg')).toHaveCount(1)
        assert.equal((await facts()).count, 0)
        // Withdraw the actual declaring plugin, then reload that same native export twice.
        for (let iteration = 0; iteration < 2; iteration++) {
          await page.evaluate(async () => {
            const s = (window as any).__settingsIcon
            const { ctx, exports } = s.general
            const parent = ctx.fiber.parent
            await ctx.fiber.dispose()
            if (s.ctx.get('slots').snapshot('settings.section.icon').length)
              throw new Error('native declaration survived disposal')
            if (s.ctx.get('slots').entries('settings.section.icon').length)
              throw new Error('stale icon contribution')
            await parent.plugin(exports)
            await parent.fiber.await()
          })
          await openDshSettings(page)
          await nav.click()
          await expect(nav.locator('svg[data-icon*="shield-outline"]')).toHaveCount(1)
          assert.equal((await facts()).count, 1)
        }
        assert.equal((await facts()).registrations, 3)
      } else {
        assert.equal(initial.registrations, 0)
        await expect(nav.locator('svg[data-icon*="shield-outline"]')).toHaveCount(0)
      }
      // The full production entry must exit before any administrator Context access.
      await page.evaluate(() => {
        const s = (window as any).__settingsIcon
        const baseline = (window as any).__DSH_REMOTE_ACCESS__
        const remembered = localStorage.getItem('dsh-auth-remote-lang')
        try {
          ;(window as any).__DSH_REMOTE_ACCESS__ = { type: 'baseline', owner: false, grants: [] }
          s.exports.apply(
            new Proxy(
              {},
              {
                get() {
                  throw new Error('viewer touched administrator Context')
                },
              },
            ),
          )
          if (localStorage.getItem('dsh-auth-remote-lang') !== remembered)
            throw new Error('viewer changed language memory')
        } finally {
          ;(window as any).__DSH_REMOTE_ACCESS__ = baseline
        }
      })
      await page.evaluate(async () => {
        await (window as any).__settingsIcon.ctx.fiber.dispose()
      })
      await expect(page.locator('style[data-plugin="dsh-auth-remote"]')).toHaveCount(0)
      await expect(nav).toHaveCount(0)
      assert.equal((await facts()).count, 0)
      assert.deepEqual(errors, [])
      console.log(
        'native icon coverage',
        JSON.stringify({ dshVersion, hasSlot, modules: initial.modules }),
      )
    } finally {
      await browser?.close()
      await server?.stop()
      await f.cleanup()
    }
  },
)
