import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import {
  clickThroughDshPrompts,
  completeApiKeyPrompt,
  dsh as dshBin,
  launchBrowser,
} from '../helpers/runtime.js'

const publicHost = 'auth-remote.test:13090'

test('target DSH boots at a non-loopback browser origin with Host settings access', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-auth-remote-browser-'))
  const patchPath = join(home, 'adapter.patch.yml')
  const adapterPath = fileURLToPath(
    new URL('../fixtures/browser-adapter/index.mjs', import.meta.url),
  )
  await writeFile(patchPath, `- insert:\n    - id: auth-client-probe\n      name: ${adapterPath}\n`)
  const args = [
    '--profile',
    'web',
    '--patch',
    patchPath,
    '--no-open',
    '--port',
    '13090',
    '--trusted-host',
    publicHost,
  ]
  const child = spawn(dshBin, args, {
    cwd: home,
    env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    const nativeUrl = await new Promise<URL>((resolve, reject) => {
      let output = ''
      const timeout = setTimeout(() => {
        reject(new Error('DSH start timed out'))
      }, 30_000)
      child.once('error', reject)
      child.once('exit', (code) => {
        reject(new Error(`DSH exited before listening: ${String(code)}`))
      })
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8')
        const match = /dsh web: (http:\/\/[^\s]+)/u.exec(output)
        if (match?.[1] === undefined) return
        clearTimeout(timeout)
        resolve(new URL(match[1]))
      })
    })
    nativeUrl.host = publicHost
    browser = await launchBrowser([
      '--no-proxy-server',
      '--host-resolver-rules=MAP auth-remote.test 127.0.0.1',
    ])
    const page = await browser.newPage({ locale: 'zh-CN' })
    const pageErrors: string[] = []
    page.on('pageerror', (error) => {
      pageErrors.push(error.message)
    })
    await page.goto(nativeUrl.href, { waitUntil: 'load', timeout: 30_000 })
    try {
      await page.waitForSelector('[class*="frame"]', { timeout: 10_000 })
    } catch {
      throw new Error(
        `DSH browser boot failed: ${JSON.stringify({ pageErrors, body: (await page.locator('body').innerText()).slice(0, 500) })}`,
      )
    }
    const notice = page.getByRole('dialog', { name: /^(?:内测声明|预览版说明)$/u })
    await notice.waitFor({ state: 'visible' })
    await notice.getByRole('button', { name: '继续' }).click()
    await notice.waitFor({ state: 'hidden' })
    await completeApiKeyPrompt(page, 5000)
    await page.waitForSelector('[class*="frame"]')
    await clickThroughDshPrompts(page, page.getByRole('button', { name: '设置', exact: true }))
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.waitFor()
    assert.equal(await dialog.getByRole('button', { name: '模型', exact: true }).count(), 1)
    const openDocument = dialog.getByRole('button', { name: '打开配置文件' })
    await openDocument.waitFor()
    assert.equal(await openDocument.isEnabled(), true)
    await dialog.getByRole('button', { name: '模型', exact: true }).click()
    await dialog.getByText('DeepSeek', { exact: true }).waitFor()
    await dialog.getByRole('button', { name: '通用设置' }).click()
    await dialog.getByRole('button', { name: '中文', exact: true }).click()
    const mutate = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/settings/mutate',
    )
    await page.getByRole('menuitem', { name: 'English' }).click()
    const result = await mutate
    assert.equal(result.status(), 200)
    assert.equal((await result.json()).result.ok, true)
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]')
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    assert.equal(
      await page
        .getByRole('dialog', { name: 'Settings' })
        .getByText('Language', { exact: true })
        .count(),
      1,
    )
  } finally {
    await browser?.close()
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await once(child, 'exit').catch(() => {})
    }
    await rm(home, { recursive: true, force: true })
  }
})
