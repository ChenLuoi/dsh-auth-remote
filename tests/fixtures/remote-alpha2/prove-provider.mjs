// Exercise the development host bundle against the exact official alpha.2 Loader.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isolatedDshEnv, project } from '../../../scripts/runtime.mjs'
import { requestAdmin } from '../../../src/cli/ipc-client.ts'
import { AuthService } from '../../../src/auth/service.ts'
import { issueDelegatedSession } from '../../../src/auth/sessions.ts'
import { AuthStateStore } from '../../../src/storage/store.ts'
import { linkRuntimeDependencies } from './runtime-dependencies.mjs'
import { checkDelegation } from './delegation-check.mjs'
import { checkBrowserDelegation } from './browser-delegation-check.mjs'
import { checkBrowserAccount } from './browser-account-check.mjs'
import { localModelEndpoint } from '../../helpers/runtime.ts'
import { accountPlatform } from '../../helpers/account-platform.ts'
import {
  nativeCertPath,
  nativeKeyPath,
  nativeHttp,
  nativeMux as upgrade,
  nativeStream,
} from '../../helpers/native-http.ts'

const runtime = resolve(process.argv[2] ?? '.')
const binary = join(runtime, 'node_modules/.bin/dsh')
const tls = process.argv[3] === 'https'
const legacy = process.argv[3] === 'legacy'
const nativeAccount = process.argv[3] === 'account-native'
const account = process.argv[3] === 'account' || nativeAccount
const loopback = process.argv[3] === 'browser-loopback' || nativeAccount
const browser = process.argv[3] === 'browser' || loopback || account
const root = await mkdtemp('/tmp/dsh-provider-')
const profile = join(root, 'profiles/web')
const packageDir = join(profile, 'node_modules/dsh-auth-remote')
const env = isolatedDshEnv(root)
const password = randomBytes(24).toString('base64url')
const adminPath = join(profile, 'auth-remote/admin.sock')
const providerPath = '/auth-remote'
let phase = 'initialize alpha.2 Loader'
let host
let stopped
let ws
let stream
let ready
let result
let model
let platform
const diagnostics = new Set()
let printedToken = false

function startHost(args) {
  host = spawn(binary, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  stopped = once(host, 'close')
  for (const output of [host.stdout, host.stderr]) {
    output.on('data', (chunk) => {
      const markers =
        /\b(?:TypeError|ReferenceError|EntryValidationError|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND)\b/gu
      for (const value of chunk.toString().match(markers) ?? []) diagnostics.add(value)
      if (/[?&]token=/u.test(chunk.toString())) printedToken = true
    })
  }
}

async function stopHost() {
  if (!host) return
  host.kill()
  await stopped
  host = undefined
}

async function verify() {
  assert.equal(
    execFileSync(binary, ['--version'], { cwd: root, env, encoding: 'utf8' }).trim(),
    legacy ? '0.2.2-rc.5' : '0.2.3-alpha.2',
  )
  await mkdir(packageDir, { recursive: true })
  await linkRuntimeDependencies(runtime, profile)
  for (const file of ['package.json', 'dist'])
    await cp(join(project, file), join(packageDir, file), { recursive: true })
  const patchFile = join(profile, 'cordis.patch.yml')
  let patch = (await readFile(join(project, 'cordis.patch.yml'), 'utf8')).replace(
    'name: dsh-auth-remote',
    'name: ' + join(packageDir, 'dist/index.js'),
  )
  if (nativeAccount) patch = patch.replace('manualAccountLogin: true', 'manualAccountLogin: false')
  const transport = join(profile, 'provider-transport.mjs')
  await cp(fileURLToPath(new URL('./transport.mjs', import.meta.url)), transport)
  if (browser) model = await localModelEndpoint()
  if (account) platform = await accountPlatform()
  await writeFile(
    patchFile,
    patch +
      `\n- insert:\n    - id: provider-transport\n      name: ${transport}\n` +
      (model ? model.patch.join('\n') + '\n' : '') +
      (platform
        ? `- id: deepseek-account\n  config:\n    platformOrigin: ${platform.origin}\n    harnessOrigin: ${platform.origin}\n    inferenceOrigin: ${new URL(model.baseURL).origin}\n    allowLoopbackHttp: true\n    attemptTimeoutMs: 40000\n`
        : '') +
      (browser
        ? '- id: remote-connection\n  config:\n    ticketLifetimeMs: 14000\n    pairing:\n      requestTtlMs: 12000\n      pollIntervalMs: 800\n      requestIntervalMs: 1\n'
        : ''),
  )
  let delegatedCookie
  if (legacy) {
    const store = await AuthStateStore.open(profile)
    const auth = new AuthService(store, { sessionHours: 12, requireTotp: false })
    try {
      await auth.initialize('owner', password)
      const b = await store.transact((draft) => issueDelegatedSession(draft, Date.now(), 7))
      delegatedCookie = 'dsh_auth_remote=' + b.token
    } finally {
      auth.dispose()
      await store.close()
    }
  }

  const reservation = createServer().listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const { port } = reservation.address()
  await new Promise((resolve) => reservation.close(resolve))
  const address = (tls ? 'https' : 'http') + '://127.0.0.1:' + port
  const publicOrigin = loopback
    ? address
    : browser
      ? `http://dsh-remote-c3.test:${port}`
      : 'https://plugin-auth-test.example'
  const externalHeaders = {
    host: new URL(publicOrigin).host,
    origin: publicOrigin,
    // The forwarded HTTP authority is independent of the fixture certificate.
    ...(tls ? { servername: 'localhost' } : {}),
  }
  const tlsArgs = tls ? ['--tls-cert', nativeCertPath, '--tls-key', nativeKeyPath] : []
  const startArgs = [
    'web',
    '--no-open',
    '--port',
    String(port),
    '--public-url',
    publicOrigin,
    ...tlsArgs,
  ]
  startHost(startArgs)

  for (let attempt = 0; attempt < 100 && host.exitCode === null; attempt++) {
    ready = await nativeHttp(address, providerPath + '/ready').catch(() => null)
    if (ready?.status === 200) break
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  assert.equal(ready?.status, 200, 'production listener did not become ready')
  if (account) {
    await checkBrowserAccount({
      base: publicOrigin,
      address,
      adminPath,
      password,
      platform,
      patchFile,
      native: nativeAccount,
      setPhase(step) {
        phase = step
      },
    })
    assert.equal(printedToken, false)
    return `PASS production alpha.2 ${nativeAccount ? 'native' : 'manual'} official-account callback`
  }
  if (browser) {
    await checkBrowserDelegation(
      publicOrigin,
      adminPath,
      password,
      (step) => {
        phase = step
      },
      loopback,
    )
    assert.equal(printedToken, false)
    return 'PASS production alpha.2 browser password, native QR and pairing authorization'
  }
  if (process.argv[3] === 'delegation') {
    await checkDelegation(address, externalHeaders, adminPath, password, upgrade, (step) => {
      phase = step
    })
    return 'PASS production alpha.2 delegation, native delivery and revocation'
  }

  phase = 'anonymous Web and source policy'
  const get = (path, options) => nativeHttp(address, path, options)
  const post = (path, payload, options) =>
    nativeHttp(address, path, {
      method: 'POST',
      body: JSON.stringify(payload),
      ...options,
    })
  if (legacy) {
    assert.equal((await get('/', { headers: { accept: 'text/html' } })).status, 302)
    assert.equal((await get(providerPath + '/login')).status, 200)
    assert.equal((await get('/pairing/client.js')).status, 401)
    assert.equal((await get('/index.html', { cookie: delegatedCookie })).status, 401)
    assert.equal((await upgrade(address, { origin: address, cookie: delegatedCookie })).status, 401)
    const response = await post(providerPath + '/login', { username: 'owner', password })
    assert.equal(response.status, 200)
    const cookie = response.headers['set-cookie']?.[0]?.split(';', 1)[0]
    assert(Boolean(cookie))
    assert.equal((await get('/', { cookie })).status, 200)
    assert.equal(printedToken, false)
    return 'PASS legacy 0.2.2-rc.5 Loader, independent profile patch and password bridge'
  }
  assert.equal(
    (await get('/?token=test-inert-value', { headers: { accept: 'text/html' } })).status,
    302,
  )
  assert.equal((await get(providerPath + '/login')).status, 200)
  assert.equal((await get('/index.html', { cookie: 'dsh-remote-example=untrusted' })).status, 401)
  assert.equal((await get('/manifest.webmanifest')).status, 200)
  assert.equal((await get('/', { method: 'HEAD', origin: null })).status, 401)
  assert.equal((await get('/index.html', { method: 'HEAD', origin: null })).status, 403)
  assert.equal((await get('/', { method: 'HEAD', origin: 'https://other.example' })).status, 403)
  assert.equal((await get('/pairing/client.js')).status, 200)
  assert.equal((await get('/pairing/client.js', { origin: 'https://other.example' })).status, 403)
  assert.equal((await get('/?login=qr')).status, 200)
  assert.equal((await post('/pairing/request', {})).status, 400)
  assert.equal((await post('/connect', {})).status, 403)
  assert.equal((await upgrade(address, { origin: address })).status, 401)

  phase = 'own password session and actual native HTTP/resource/mux admission'
  await requestAdmin(adminPath, { version: 1, command: 'init', username: 'owner', password })
  const response = await post(providerPath + '/login', { username: 'owner', password })
  assert.equal(response.status, 200)
  const header = response.headers['set-cookie']?.[0]
  assert.equal(typeof header, 'string')
  assert.equal(/; Secure/u.test(header), tls)
  const cookie = header.split(';', 1)[0]
  assert(cookie.startsWith('dsh_auth_remote='))
  assert.equal((await get('/', { cookie })).status, 200)
  assert.equal((await get('/', { method: 'HEAD', origin: null, cookie })).status, 200)
  const index = await get('/index.html', { cookie })
  assert.equal(index.status, 200)
  const cache = index.headers.etag
    ? { 'if-none-match': index.headers.etag }
    : { 'if-none-match': '*' }
  assert.equal((await get('/index.html', { headers: cache })).status, 401)
  assert.equal((await get('/index.html', { cookie, origin: 'https://other.example' })).status, 403)
  const method = 'settings/describe'
  const rpc = await post(
    '/api/' + method,
    {
      type: 'client-request',
      rpcId: crypto.randomUUID(),
      method,
      payload: { args: {} },
    },
    { cookie },
  )
  assert.equal(rpc.status, 200)
  assert.equal(JSON.parse(rpc.body).result.ok, true)
  const admitted = await upgrade(address, { origin: address, cookie })
  assert.equal(admitted.status, 101)
  ws = admitted.socket
  const proxyLogin = await post(
    providerPath + '/login',
    { username: 'owner', password },
    externalHeaders,
  )
  assert.equal(proxyLogin.status, 200)
  assert(/; Secure/u.test(proxyLogin.headers['set-cookie']?.[0] ?? ''))
  const proxyCookie = proxyLogin.headers['set-cookie'][0].split(';', 1)[0]
  assert.equal((await get('/', { ...externalHeaders, cookie: proxyCookie })).status, 200)
  assert.equal(
    (
      await get('/', {
        ...externalHeaders,
        origin: 'http://' + externalHeaders.host,
        cookie: proxyCookie,
      })
    ).status,
    403,
  )
  const proxySocket = await upgrade(address, { ...externalHeaders, cookie: proxyCookie })
  assert.equal(proxySocket.status, 101)
  proxySocket.socket.destroy()

  phase = 'native resource receives a Peer and a disconnect signal'
  const cancelled = await nativeStream(address, '/__provider/stream', { cookie })
  cancelled.close()
  await cancelled.closed
  let sawAbort
  for (let attempt = 0; attempt < 30; attempt++) {
    sawAbort = await readFile(join(root, 'resource-aborted'), 'utf8').catch(() => undefined)
    if (sawAbort) break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.equal(sawAbort, 'yes')
  stream = await nativeStream(address, '/__provider/stream', { cookie })

  phase = 'revocation closes the native mux and SSE and excludes subsequent HTTP'
  const onClose = once(ws, 'close')
  await requestAdmin(adminPath, { version: 1, command: 'revoke-sessions' })
  await Promise.race([
    Promise.all([onClose, stream.closed]),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('stream or mux timeout')), 3000).unref(),
    ),
  ])
  assert.equal((await get('/index.html', { cookie })).status, 401)
  assert.equal((await upgrade(address, { origin: address, cookie })).status, 401)

  phase = 'Connection loss leaves the guarded listener closed to business'
  const profilePatch = await readFile(patchFile, 'utf8')
  await writeFile(
    patchFile,
    profilePatch.replace('- id: connection\n', '- id: connection\n  disabled: true\n'),
  )
  let unavailable
  for (let attempt = 0; attempt < 50; attempt++) {
    unavailable = await get(providerPath + '/ready').catch(() => null)
    if (!unavailable || unavailable.status === 503) break
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  assert(!unavailable || unavailable.status === 503, 'Connection removal must withdraw readiness')
  assert(
    await get('/', { cookie: proxyCookie }).then(
      (res) => res.status === 503,
      () => true,
    ),
  )

  const assertClosed = async () => {
    startHost(startArgs)
    try {
      for (let attempt = 0; attempt < 20; attempt++) {
        await assert.rejects(get('/'), { code: 'ECONNREFUSED' })
        if (host.exitCode !== null) return
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    } finally {
      await stopHost()
    }
  }
  await stopHost()
  phase = 'independent protected patch with skipped auth activation'
  await writeFile(
    patchFile,
    profilePatch.replace('- id: auth-remote\n', '- id: auth-remote\n      disabled: true\n'),
  )
  await assertClosed()

  phase = 'corrupt isolated state blocks listener activation'
  await writeFile(patchFile, profilePatch)
  await writeFile(join(profile, 'auth-remote/auth-state.json'), '{invalid', { mode: 0o600 })
  await assertClosed()
  assert.equal(printedToken, false)
  return `PASS production alpha.2 ${tls ? 'HTTPS' : 'HTTP'} provider, origin, transports and fail-closed startup`
}

try {
  result = await verify()
} catch (error) {
  const location = error.stack?.match(
    /(?:prove-provider|(?:browser-)?delegation-check|browser-account-check)\.mjs:\d+:\d+/u,
  )?.[0]
  const states = [error.actual, error.expected].every((value) => typeof value === 'number')
    ? ` ${error.actual} != ${error.expected}`
    : ''
  const code = /^[A-Z0-9_]+$/u.test(error.code ?? '') ? error.code : ''
  result = `FAIL ${phase} (${location ?? error.name}${states}; ${[code, ...diagnostics].filter(Boolean).join(', ')})`
  process.exitCode = 1
} finally {
  stream?.close()
  ws?.destroy()
  await stopHost()
  await platform?.close()
  await model?.close()
  await rm(root, { recursive: true, force: true })
}
console.log(result)
