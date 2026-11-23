// Run with Node 24.22.3+, the exact alpha.2 npm runtime and Playwright Chromium.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { build } from 'esbuild'
import { isolatedDshEnv } from '../../../scripts/runtime.mjs'
import { localModelEndpoint, openDshSettings } from '../../helpers/runtime.ts'

const runtime = resolve(process.argv[2] ?? '.')
const bin = join(runtime, 'node_modules/.bin/dsh')
const home = await mkdtemp('/tmp/dsh-c1-')
const password = randomBytes(24).toString('base64url')
const env = { ...isolatedDshEnv(home), DSH_C1_PASSWORD: password }
const profile = join(home, 'profiles/web')
const fixture = join(profile, 'remote-proof.mjs')
let child
let done
let browser
let model
let phase = 'boot'

async function post(page, path, data, headers = {}) {
  return page.evaluate(
    async ({ path, data, headers }) => {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(data),
      })
      return {
        status: response.status,
        body: await response.json().catch(() => null),
      }
    },
    { path, data, headers },
  )
}

async function rpc(page, method, args = {}) {
  const endpoint = 'remoteConnection/' + method
  const result = await post(page, '/api/' + endpoint, {
    type: 'client-request',
    rpcId: randomBytes(16).toString('hex'),
    method: endpoint,
    payload: { args },
  })
  assert.equal(result.status, 200, 'expected Gateway HTTP response')
  return result.body.result
}

async function readSession(page) {
  return page.evaluate(async () => {
    const response = await fetch('/__c1/session')
    return { status: response.status, body: await response.json().catch(() => null) }
  })
}

async function waitForSession(page) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const result = await readSession(page).catch(() => null)
    if (result?.status === 200) return result.body
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('independent delegated session did not reach Web admission')
}

function elapsed(session, days, start, end) {
  assert.equal(session.role, 'B')
  assert(session.expiresAt >= start + days * 86_400_000)
  assert(session.expiresAt <= end + days * 86_400_000)
}

async function mux(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const socket = new WebSocket(location.origin.replace(/^http/u, 'ws') + '/api/remote.mux')
        const timer = setTimeout(() => {
          socket.close()
          resolve(false)
        }, 3000)
        socket.addEventListener('open', () => {
          clearTimeout(timer)
          socket.close()
          resolve(true)
        })
        socket.addEventListener('error', () => {
          clearTimeout(timer)
          resolve(false)
        })
      }),
  )
}

try {
  assert.equal(
    execFileSync(bin, ['--version'], { cwd: home, env, encoding: 'utf8' }).trim(),
    '0.2.3-alpha.2',
  )
  await mkdir(profile, { recursive: true })
  model = await localModelEndpoint()
  await build({
    entryPoints: [fileURLToPath(new URL('./host.mjs', import.meta.url))],
    outfile: fixture,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
  })
  await writeFile(
    join(profile, 'cordis.patch.yml'),
    [
      ...model.patch,
      '- id: authentication-token',
      '  disabled: true',
      '- insert:',
      '    - id: remote-c1-proof',
      `      name: ${fixture}`,
      '',
    ].join('\n'),
  )

  const listener = createServer().listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const { port } = listener.address()
  await new Promise((resolve) => listener.close(resolve))
  const hostname = 'dsh-remote-c1.test'
  const authority = hostname + ':' + port
  const base = 'http://' + authority
  const loopback = 'http://127.0.0.1:' + port
  child = spawn(
    bin,
    ['web', '--no-open', '--port', String(port), '--public-url', base, '--trusted-host', authority],
    {
      cwd: home,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  done = once(child, 'close')
  let diagnostic = ''
  let providerIndex
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => {
      diagnostic += chunk
        .toString()
        .split('\n')
        .filter((line) =>
          /unexpected alpha\.2 hook|TypeError|ReferenceError|SyntaxError|MODULE_NOT_FOUND|cannot set/i.test(
            line,
          ),
        )
        .join('\n')
    })
  }

  for (let attempt = 0; ; attempt++) {
    assert(
      child.exitCode === null && attempt < 120,
      'the exact-version fixture did not become ready ' + diagnostic,
    )
    const response = await fetch(loopback + '/__c1/ready', {
      signal: AbortSignal.timeout(1000),
    }).catch(() => null)
    if (response?.ok) {
      providerIndex = (await response.json()).pluginProviderIndex
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }

  browser = await chromium.launch({
    args: ['--no-proxy-server', `--host-resolver-rules=MAP ${hostname} 127.0.0.1`],
  })
  async function open() {
    const context = await browser.newContext()
    await context.route('**/*', (route) =>
      new URL(route.request().url()).origin === base ? route.continue() : route.abort(),
    )
    const page = await context.newPage()
    await page.goto(base, { waitUntil: 'domcontentloaded' })
    return { context, page }
  }

  phase = 'password Peer and action-scoped factor'
  const { page: owner } = await open()
  const login = await post(owner, '/__c1/login', {}, { authorization: 'Proof ' + password })
  assert.equal(login.status, 200)
  const backups = login.body.backupCodes
  const a = await waitForSession(owner)
  assert.equal(a.role, 'A')
  assert(a.expiresAt <= Date.now() + 12 * 3_600_000)
  assert.equal((await rpc(owner, 'create')).ok, false)
  assert.equal((await rpc(owner, 'loginUrl')).ok, false)
  const step = (action, id, days, code) => post(owner, '/__c1/step', { action, id, days, code })
  assert.equal((await step('create', null, 7, '000000-invalid')).status, 403)

  phase = 'native pairing request and owner approval'
  const paired = await open()
  const ticketInput = () => ({
    id: crypto.randomUUID(),
    secret: randomBytes(32).toString('base64url'),
  })
  const request = ticketInput()
  const requested = await post(paired.page, '/pairing/request', request)
  assert.equal(requested.status, 200)
  assert(requested.body.id === request.id && /^[A-Z2-9]{8}$/u.test(requested.body.code))
  assert(requested.body.expiresInMs > 295_000 && requested.body.expiresInMs <= 300_000)
  const pollAt = Date.now() + requested.body.pollIntervalMs
  const pending = await rpc(owner, 'pairingRequests')
  assert.equal(pending.ok, true)
  assert(
    pending.value.requests.some(
      ({ id, code, sourceIp }) =>
        id === request.id && code === requested.body.code && typeof sourceIp === 'string',
    ),
  )
  assert.equal((await rpc(owner, 'decidePairing', { id: request.id, decision: 'allow' })).ok, false)
  assert.equal((await step('approve', request.id, 1, backups[0])).status, 200)
  assert.equal((await rpc(owner, 'create')).ok, false, 'approval step-up cannot create QR')
  assert.equal(
    (await rpc(owner, 'decidePairing', { id: request.id, decision: 'allow', days: 7 })).ok,
    false,
  )
  const approval = await rpc(owner, 'decidePairing', { id: request.id, decision: 'allow' })
  assert(approval.ok && approval.value === 'approved', 'native pairing must be approved')
  assert.equal(
    (await step('create', null, 7, backups[0])).status,
    403,
    'backup code already consumed',
  )

  phase = 'native QR invite and concurrent browser collections'
  assert.equal((await step('create', null, 7, backups[1])).status, 200)
  assert.equal((await rpc(owner, 'create', { days: 1 })).ok, false)
  const invite = await rpc(owner, 'create')
  assert(invite.ok, 'native QR generation should succeed')
  assert.equal(invite.value.lifetimeMs, 120_000)
  assert.equal((await rpc(owner, 'create')).ok, false, 'step-up is single-use')
  const scanner = await open()
  assert.equal((await readSession(scanner.page)).status, 401)
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, pollAt - Date.now())))
  const start = Date.now()
  const [scan, poll] = await Promise.all([
    scanner.page.goto(invite.value.url, { waitUntil: 'commit' }).catch(() => null),
    post(paired.page, '/pairing/status', request),
  ])
  assert(scan && [200, 401].includes(scan.status()), 'native QR page is reachable')
  assert.equal(poll.status, 200)
  assert.equal(poll.body.status, 'completed')
  const qr = await waitForSession(scanner.page)
  const pairing = await waitForSession(paired.page)
  const end = Date.now()
  elapsed(qr, 7, start, end)
  elapsed(pairing, 1, start, end)
  assert(await mux(scanner.page))
  assert(await mux(paired.page))

  phase = 'native settings reflect the delegated admission decision'
  const remoteSettings = async (page) => {
    const menu = page.getByRole('button', { name: /^(?:Account menu|账号菜单)$/iu })
    await menu.waitFor({ state: 'attached', timeout: 15_000 })
    const locale = (await menu.getAttribute('aria-label')) === 'Account menu' ? 'en' : 'zh'
    await openDshSettings(page, locale)
    await page.getByRole('button', { name: /^(?:Remote Connection|远程连接)$/iu }).click()
  }
  const generate = { name: /^(?:Create QR code|生成二维码)$/iu }
  await owner.goto(base, { waitUntil: 'domcontentloaded' })
  await remoteSettings(owner)
  await owner.getByRole('button', generate).waitFor()
  await remoteSettings(scanner.page)
  await scanner.page
    .getByRole('alert')
    .filter({
      hasText: /Could not load remote connection settings|无法加载远程连接设置/iu,
    })
    .waitFor()
  assert.equal(await scanner.page.getByRole('button', generate).count(), 0)

  phase = 'duplicate delivery and native credential isolation'
  await new Promise((resolve) => setTimeout(resolve, 2100))
  assert.equal((await post(paired.page, '/pairing/status', request)).body.status, 'completed')
  assert.equal((await readSession(paired.page)).body.expiresAt, pairing.expiresAt)
  const onlyNative = await open()
  const cookie = (await scanner.context.cookies()).find(({ name }) =>
    name.startsWith('dsh-remote-'),
  )
  assert(Boolean(cookie), 'the successful native exchange created a native cookie')
  await onlyNative.context.addCookies([cookie])
  assert.equal((await readSession(onlyNative.page)).status, 401)
  assert.equal(await mux(onlyNative.page), false)
  const replay = await onlyNative.page.evaluate(async (body) => {
    const response = await fetch('/?login=qr', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body,
    })
    return response.status
  }, new URL(invite.value.url).hash.slice(1))
  assert.equal(replay, 410)

  phase = 'delegation cannot become an owner'
  for (const page of [scanner.page, paired.page]) {
    for (const [method, args] of [
      ['create', {}],
      ['pairingRequests', {}],
      ['status', { id: null }],
      ['decidePairing', { id: request.id, decision: 'allow' }],
      ['cancel', { id: invite.value.id }],
    ])
      assert.equal((await rpc(page, method, args)).ok, false)
    assert.equal(
      (await post(page, '/__c1/step', { action: 'create', id: null, days: 3 })).status,
      403,
    )
  }
  const cancellation = ticketInput()
  const requestedCancellation = await post(paired.page, '/pairing/request', cancellation)
  assert.equal(requestedCancellation.status, 200)
  await new Promise((resolve) => setTimeout(resolve, requestedCancellation.body.pollIntervalMs))
  assert.equal((await post(paired.page, '/pairing/status', cancellation)).body.status, 'pending')
  assert.equal((await post(paired.page, '/pairing/cancel', cancellation)).body.status, 'cancelled')
  phase = 'host unload withdraws the adapter and its Peers'
  await browser.close()
  browser = undefined
  child.kill()
  const [code] = await done
  child = undefined
  assert.equal(code, 0)
  assert.equal(
    await readFile(join(home, 'c1-auth/unloaded'), 'utf8'),
    'hooks restored, provider withdrawn, peers disposed\n',
  )
  assert([0, 1].includes(providerIndex))
  console.log('Plugin authentication provider registration index:', providerIndex)
  console.log(
    'PASS alpha.2 native QR and pairing, action binding, independent Peer admission and mux, and delegation boundaries',
  )
} catch (error) {
  // Do not include browser call logs, URLs, HTTP bodies or credentials.
  const location = error.stack?.match(/prove\.mjs:(\d+):(\d+)/u)?.[0]
  const values = [error.actual, error.expected]
  const comparison = values.every((value) => ['number', 'boolean'].includes(typeof value))
    ? values.join(' != ')
    : error.name
  console.error(`FAIL ${phase} (${location ?? 'setup'}, ${comparison})`)
  process.exitCode = 1
} finally {
  if (browser) await browser.close()
  if (child) {
    child.kill()
    await done
  }
  if (model) await model.close()
  await rm(home, { recursive: true, force: true })
}
