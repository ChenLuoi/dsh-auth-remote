import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { appendFile, copyFile, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { expect } from '@playwright/test'
import { requestAdmin } from '../../../src/cli/ipc-client.js'
import type { MeResponse } from '../../../src/shared/auth-contract.js'
import { DAY_MS } from '../../../src/shared/delegation.js'
import {
  nativeCertificate,
  nativeCertPath,
  nativeKeyPath,
  nativeHttp,
  nativeMux,
  nativeStream,
} from '../../helpers/native-http.js'
import { packedAdmin, packedCommand, packedProfile } from '../../helpers/packed-runtime.js'
import { startForwarder } from '../../helpers/proxy.js'

async function portNumber() {
  const socket = createServer().listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const address = socket.address()
  assert(address && typeof address !== 'string')
  await new Promise<void>((resolve) => socket.close(() => resolve()))
  return address.port
}

export async function checkPackedSessions(throughProxy: boolean): Promise<void> {
  const port = await portNumber()
  const publicPort = throughProxy ? await portNumber() : port
  const origin = `https://delegation-regression.test:${publicPort}`
  const address = `https://127.0.0.1:${publicPort}`
  const external = { origin, host: new URL(origin).host, servername: 'localhost' }
  const f = await packedProfile({ port, publicUrl: origin, requireTotp: false, sessionHours: 12 })
  const password = randomBytes(24).toString('base64url')
  const patch = join(f.profile, 'cordis.patch.yml')
  const admin = join(f.profile, 'auth-remote/admin.sock')
  let server: ReturnType<typeof packedCommand> | undefined
  let proxy: Awaited<ReturnType<typeof startForwarder>> | undefined
  let stream: Awaited<ReturnType<typeof nativeStream>> | undefined
  let mux: Awaited<ReturnType<typeof nativeMux>>['socket']

  const get = (path: string, cookie?: string) =>
    nativeHttp(address, path, { ...external, ...(cookie ? { cookie } : {}) })
  const post = (path: string, body: unknown, cookie?: string) =>
    nativeHttp(address, path, {
      ...external,
      method: 'POST',
      body: JSON.stringify(body),
      ...(cookie ? { cookie } : {}),
    })
  const readSession = (response: Awaited<ReturnType<typeof nativeHttp>>): MeResponse => {
    assert.equal(response.status, 200)
    return JSON.parse(response.body)
  }
  const session = async (cookie: string) => readSession(await get('/auth-remote/me', cookie))
  const pluginCookie = (response: Awaited<ReturnType<typeof nativeHttp>>) => {
    const cookies = response.headers['set-cookie']
    assert(
      cookies?.length === 1 &&
        cookies[0]?.startsWith('dsh_auth_remote=') &&
        cookies[0].includes('; Secure'),
    )
    return cookies[0].split(';', 1)[0]!
  }
  const loginOwner = () => post('/auth-remote/login', { username: 'owner', password })
  const authorize = async (owner: string, days: number, pairingId?: string) => {
    const response = await post(
      '/auth-remote/delegation',
      { requestId: randomUUID(), days, pairingId },
      owner,
    )
    assert.equal(response.status, 200)
    return JSON.parse(response.body).result
  }
  const pair = async (owner: string, days: number) => {
    const request = { id: randomUUID(), secret: randomBytes(32).toString('base64url') }
    const ticket = await post('/pairing/request', request)
    assert.equal(ticket.status, 200)
    assert.equal(await authorize(owner, days, request.id), 'approved')
    return { request, pollMs: JSON.parse(ticket.body).pollIntervalMs as number }
  }
  const claim = async ({ request, pollMs }: Awaited<ReturnType<typeof pair>>) => {
    await new Promise((resolve) => setTimeout(resolve, pollMs + 25))
    return post('/pairing/status', request)
  }
  const qr = (ticket: { url: string }) =>
    nativeHttp(address, '/?login=qr', {
      ...external,
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: new URL(ticket.url).hash.slice(1),
    })
  const waitStatus = (path: string, cookie: string, expected: number) =>
    expect.poll(async () => (await get(path, cookie)).status, { timeout: 8000 }).toBe(expected)
  const checkDuration = async (cookie: string, days: number) => {
    const view = await session(cookie)
    assert.equal(view.expiresAt - view.createdAt, days * DAY_MS)
    assert.equal(
      JSON.parse((await get('/auth-remote/delegation', cookie)).body).canAuthorize,
      false,
    )
    return view.expiresAt
  }

  try {
    const fixture = join(f.profile, 'delegation-transport.mjs')
    await copyFile(new URL('./transport.mjs', import.meta.url), fixture)
    await appendFile(
      patch,
      [
        '- id: remote-connection',
        '  config:',
        '    pairing:',
        '      pollIntervalMs: 350',
        '      requestIntervalMs: 1',
        '- insert:',
        '    - id: delegation-transport',
        `      name: ${fixture}`,
        '      inject: [webServer]',
        '',
      ].join('\n'),
    )
    if (throughProxy)
      proxy = await startForwarder({
        listenPort: publicPort,
        upstreamPort: port,
        tls: { cert: nativeCertificate, key: await readFile(nativeKeyPath) },
      })
    const start = async () => {
      server = packedCommand(
        f.home,
        [
          'web',
          '--no-open',
          '--port',
          String(port),
          ...(!throughProxy ? ['--tls-cert', nativeCertPath, '--tls-key', nativeKeyPath] : []),
        ],
        f.cwd,
      )
      await expect
        .poll(
          async () => {
            if (server!.child.exitCode !== null) return -1
            return get('/auth-remote/ready').then(
              (res) => res.status,
              () => 0,
            )
          },
          { timeout: 25000 },
        )
        .toBe(200)
    }
    await start()
    await requestAdmin(admin, { version: 1, command: 'init', username: 'owner', password })
    const owner = pluginCookie(await loginOwner())
    const initial = await session(owner)
    assert.equal(initial.expiresAt - initial.createdAt, 12 * 3_600_000)
    const issued = []
    for (const days of throughProxy ? [1, 3, 7] : [7]) {
      const invite = await authorize(owner, days)
      const scanned = await qr(invite)
      assert.equal(scanned.status, 204)
      const paired = await claim(await pair(owner, days))
      assert.equal(JSON.parse(paired.body).status, 'completed')
      for (const cookie of [pluginCookie(scanned), pluginCookie(paired)])
        issued.push({ cookie, expiresAt: await checkDuration(cookie, days) })
    }
    const first = issued[0]!
    const surviving = issued.at(-1)!
    assert.equal((await get('/index.html', surviving.cookie)).status, 200)
    const streamOptions = { ...external, cookie: first.cookie }
    const checkPrivateCarrier = (await get('/index.html', 'dsh-remote-test=untrusted')).status
    assert.equal(checkPrivateCarrier, 401)
    assert.equal((await post('/connect', {})).status, 403)

    if (throughProxy) {
      // The listener can briefly return 503 or disconnect, which the proxy reports as 502.
      const reloading = (status: number) => status === 502 || status === 503
      const expiryDuringReload = async (cookie: string) => {
        const response = await get('/auth-remote/me', cookie)
        return reloading(response.status) ? 0 : readSession(response).expiresAt
      }
      const originalPatch = await readFile(patch, 'utf8')
      await writeFile(patch, originalPatch.replace('sessionHours: 12', 'sessionHours: 1'))
      await expect.poll(() => expiryDuringReload(owner)).toBe(initial.createdAt + 3_600_000)
      await writeFile(patch, originalPatch.replace('sessionHours: 12', 'sessionHours: 24'))
      await expect
        .poll(
          async () => {
            const response = await loginOwner()
            if (reloading(response.status)) return 0
            assert.equal(response.status, 200)
            return (await expiryDuringReload(pluginCookie(response))) - Date.now()
          },
          { timeout: 9000 },
        )
        .toBeGreaterThan(23 * 3_600_000)
      for (const row of issued) assert.equal((await session(row.cookie)).expiresAt, row.expiresAt)

      const pendingInvite = await authorize(owner, 3)
      const pendingPair = await pair(owner, 3)
      assert.equal((await post('/__provider/session-near-expiry', {}, owner)).status, 204)
      const lastPair = pluginCookie(await claim(await pair(owner, 7)))
      const absoluteExpiry = await checkDuration(lastPair, 7)
      await waitStatus('/auth-remote/me', owner, 401)
      assert.equal((await qr(pendingInvite)).status, 410)
      assert.equal(JSON.parse((await claim(pendingPair)).body).status, 'expired')
      assert.equal((await session(lastPair)).expiresAt, absoluteExpiry)

      assert.equal(JSON.parse(await packedAdmin(f.home, 'status')).online, true)
      await server!.stop()
      assert.equal(JSON.parse(await packedAdmin(f.home, 'status')).online, false)
      await start()
      assert.equal((await session(lastPair)).expiresAt, absoluteExpiry)
      for (const row of issued) assert.equal((await session(row.cookie)).expiresAt, row.expiresAt)
    }

    stream = await nativeStream(address, '/__provider/stream', streamOptions)
    const socket = await nativeMux(address, streamOptions)
    assert.equal(socket.status, 101)
    mux = socket.socket!
    mux.resume()
    let sseClosed = false
    let muxClosed = false
    const closed = once(mux, 'close').then(() => {
      muxClosed = true
    })
    const endStream = stream.closed.then(() => {
      sseClosed = true
    })
    assert.equal((await post('/__provider/session-near-expiry', {}, first.cookie)).status, 204)
    await waitStatus('/auth-remote/me', first.cookie, 401)
    await Promise.race([
      Promise.all([closed, endStream]),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(new Error(`B expiry transport close status SSE=${sseClosed} mux=${muxClosed}`)),
          7000,
        ).unref(),
      ),
    ])
    assert.equal((await get('/index.html', first.cookie)).status, 401)
    assert.equal((await nativeMux(address, streamOptions)).status, 401)
    assert.equal((await session(surviving.cookie)).expiresAt, surviving.expiresAt)
  } finally {
    mux?.destroy()
    stream?.close()
    try {
      await proxy?.close()
      await server?.stop()
    } finally {
      await f.cleanup()
    }
  }
}
