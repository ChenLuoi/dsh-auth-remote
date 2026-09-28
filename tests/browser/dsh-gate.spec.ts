import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { chromium } from '@playwright/test'
import { archive, dsh as dshBin, launchBrowser, packageName } from '../helpers/runtime.js'

const host = 'auth-remote.test:13090'
const origin = `http://${host}`

async function run(bin: string, args: string[], home: string): Promise<void> {
  const child = spawn(bin, args, {
    env: { ...process.env, DSH_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let diagnostic = ''
  child.stderr.on('data', (chunk: Buffer) => {
    diagnostic += chunk.toString('utf8')
  })
  const [code] = (await once(child, 'exit')) as [number]
  if (code !== 0) throw new Error(`DSH command failed: ${diagnostic.slice(0, 2000)}`)
}

async function request(path: string, port = 13090): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, headers: { host } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => {
        chunks.push(chunk)
      })
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
      })
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

test('installed package and test gate boot full DSH without exposing native credentials', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-auth-remote-gate-'))
  const profile = join(home, 'profiles/web')
  let server: ReturnType<typeof spawn> | undefined
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    await run(dshBin, ['plugin', '--profile', 'web', 'add', archive], home)
    const fixturePath = join(profile, 'node_modules', packageName, 'auth-gate.mjs')
    await copyFile(new URL('../fixtures/auth-gate-fixture.mjs', import.meta.url), fixturePath)
    await writeFile(
      join(profile, 'cordis.patch.yml'),
      [
        '- id: webserver',
        '  disabled: true',
        '- id: auth-remote',
        '  disabled: true',
        '- id: connection',
        '  inject: [webRuntime]',
        '  config:',
        `    trustedHosts: !!js "['${host}', ...ctx.webRuntime.trustedHosts]"`,
        '- insert:',
        '    - id: auth-gate',
        `      name: ${fixturePath}`,
        '      inject: [webStartup]',
        '      config:',
        `        allowedOrigins: [${origin}]`,
        '        requireTotp: true',
        '        sessionHours: 168',
        '        preserveOriginPaths: []',
        '',
      ].join('\n'),
    )
    const testCookie = randomBytes(32).toString('base64url')
    server = spawn(dshBin, ['web', '--no-open', '--port', '13090'], {
      cwd: home,
      env: {
        ...process.env,
        DSH_HOME: home,
        DSH_TELEMETRY_DISABLED: '1',
        DSH_GATE_TEST_COOKIE: testCookie,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    let stdout = ''
    server.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    server.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8').replace(/\?token=[A-Za-z0-9_-]+/gu, '?token=[redacted]')
    })
    let ready = false
    let lastResponse: { status: number; body: string } | undefined
    for (let attempt = 0; attempt < 150; attempt += 1) {
      if (server.exitCode !== null) throw new Error(`DSH exited: ${stderr.slice(0, 1500)}`)
      try {
        const response = await request('/auth-remote/ready')
        lastResponse = response
        if (response.status === 200 && JSON.parse(response.body).ready === true) {
          ready = true
          break
        }
      } catch {
        /* Server has not bound yet. */
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.equal(
      ready,
      true,
      `Test gate never became ready: ${JSON.stringify({ lastResponse, stdout: stdout.slice(0, 1500), stderr: stderr.slice(0, 1500) })}`,
    )
    assert.equal((await request('/')).status, 401)
    assert.equal((await request('/api')).status, 401)

    browser = await launchBrowser([
      '--no-proxy-server',
      '--host-resolver-rules=MAP auth-remote.test 127.0.0.1',
    ])
    const context = await browser.newContext({ locale: 'zh-CN' })
    await context.addCookies([
      {
        name: 'auth-gate-test',
        value: testCookie,
        domain: 'auth-remote.test',
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
      },
    ])
    const page = await context.newPage()
    await page.goto(`${origin}/`, { waitUntil: 'load', timeout: 30_000 })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    assert.equal(
      await page.evaluate(() =>
        (
          (globalThis as typeof globalThis & { __DSH_BOOT__?: { entries?: { id: string }[] } })
            .__DSH_BOOT__?.entries ?? []
        ).some((entry) => entry.id === 'dsh-auth-remote'),
      ),
      true,
    )
    assert.deepEqual(
      (await context.cookies()).map((cookie) => cookie.name),
      ['auth-gate-test'],
    )
    const notice = page.getByRole('dialog', { name: '内测声明' })
    if (await notice.isVisible()) await notice.getByRole('button', { name: '继续' }).click()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.waitFor()
    await dialog.getByRole('button', { name: '中文', exact: true }).click()
    const mutation = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/settings/mutate',
    )
    await page.getByRole('menuitem', { name: 'English' }).click()
    const result = await mutation
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
    assert.deepEqual(
      (await context.cookies()).map((cookie) => cookie.name),
      ['auth-gate-test'],
    )
  } finally {
    await browser?.close()
    if (server !== undefined && server.exitCode === null && server.signalCode === null) {
      server.kill('SIGTERM')
      await once(server, 'exit').catch(() => {})
    }
    if (process.env.DSH_KEEP_TEST_HOME === '1') console.error(`Gate test home: ${home}`)
    else await rm(home, { recursive: true, force: true })
  }
})

test('profile-level native disable holds when the bundle is missing or invalid config fails', async () => {
  for (const scenario of ['missing-bundle', 'invalid-config'] as const) {
    const home = await mkdtemp(join(tmpdir(), `dsh-auth-remote-${scenario}-`))
    const profile = join(home, 'profiles/web')
    let child: ReturnType<typeof spawn> | undefined
    try {
      if (scenario === 'invalid-config') {
        await run(dshBin, ['plugin', '--profile', 'web', 'add', archive], home)
      } else {
        await mkdir(profile, { recursive: true })
        await writeFile(
          join(profile, 'package.json'),
          JSON.stringify({
            name: 'dsh-profile-web',
            private: true,
            dsh: {
              profile: {
                bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-auth-remote'],
              },
            },
          }),
        )
      }
      await writeFile(
        join(profile, 'cordis.patch.yml'),
        [
          '- id: webserver',
          '  disabled: true',
          ...(scenario === 'invalid-config'
            ? ['- id: auth-remote', '  config:', '    allowedOrigins: [https://example.com/path]']
            : []),
          '',
        ].join('\n'),
      )
      child = spawn(dshBin, ['web', '--no-open', '--port', '13092'], {
        cwd: home,
        env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8')
      })
      child.stderr.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8')
      })
      await Promise.race([
        once(child, 'exit').catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 4000)),
      ])
      const response = await request('/', 13092).catch(() => null)
      assert.equal(
        response,
        null,
        `${scenario}: unexpected listener ${JSON.stringify(response)}; ${output.slice(0, 2000)}`,
      )
    } finally {
      if (child !== undefined && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        await once(child, 'exit').catch(() => {})
      }
      await rm(home, { recursive: true, force: true })
    }
  }
})

test('formal package rejects corrupt persistent state before binding', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-auth-remote-formal-'))
  const profile = join(home, 'profiles/web')
  try {
    await run(dshBin, ['plugin', '--profile', 'web', 'add', archive], home)
    await mkdir(join(profile, 'auth-remote'), { mode: 0o700 })
    await writeFile(join(profile, 'auth-remote/auth-state.json'), '{bad', { mode: 0o600 })
    await writeFile(
      join(profile, 'cordis.patch.yml'),
      [
        '- id: webserver',
        '  disabled: true',
        '- id: auth-remote',
        '  config:',
        '    allowedOrigins: [http://auth-remote.test:13093]',
        '    requireTotp: true',
        '    sessionHours: 168',
        '    preserveOriginPaths: []',
        '',
      ].join('\n'),
    )
    const child = spawn(dshBin, ['web', '--no-open', '--port', '13093'], {
      cwd: home,
      env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    const [code] = (await once(child, 'exit')) as [number]
    assert.notEqual(code, 0)
    assert.match(stderr, /JSON|auth-state/u)
    await assert.rejects(request('/', 13093))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
