import assert from 'node:assert/strict'
import { once } from 'node:events'
import { lstat, mkdtemp, rm } from 'node:fs/promises'
import { request } from 'node:http'
import { createRequire } from 'node:module'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import PlatformAccount from '@deepseek-ai/dsh-deepseek-account-platform'
import Authorization from '@deepseek-ai/dsh-authorization'
import { Config } from '../../src/config.js'
import { AuthRemoteWebServer } from '../../src/index.js'
import { accountPlatform } from '../helpers/account-platform.js'
import type { AccountLoginState } from '../../src/shared/account-login.js'
import { AUTH_COOKIE } from '../../src/shared/auth-contract.js'
import { AuthStateStore } from '../../src/storage/store.js'

const require = createRequire(import.meta.url)
assert.equal(
  require('@deepseek-ai/dsh-deepseek-account-platform/package.json').version,
  '0.2.1-rc.4',
)
const origin = 'https://manual.example'

async function fixture() {
  const profile = await mkdtemp(join(tmpdir(), 'auth-remote-account-'))
  const platform = await accountPlatform()
  const ctx = new Context()
  const records = new Map()
  ctx.provide('profileContext', { dir: profile, name: 'web' } as never)
  ctx.provide('webStartup', { host: '127.0.0.1', port: 0 } as never)
  ctx.provide('credentials', {
    async readRecord(key: unknown) {
      return records.get(key)
    },
    async modifyRecord(key: unknown, mutate: (old: unknown) => Promise<unknown>) {
      const next = await mutate(records.get(key))
      if (next !== undefined) {
        records.set(key, next)
        ctx.emit('credentials/record-updated' as never, key)
      }
      return records.get(key)
    },
    async writeRecord(key: unknown, value: unknown) {
      records.set(key, value)
      ctx.emit('credentials/record-updated' as never, key)
    },
    async deleteRecord(key: unknown) {
      records.delete(key)
    },
    async describeRecord(key: unknown) {
      return { configured: records.has(key) }
    },
  } as never)
  try {
    const authFiber = await ctx.plugin(AuthRemoteWebServer, {
      publicUrl: origin,
      requireTotp: false,
    })
    const config = authFiber.config as ReturnType<typeof Config>
    const server = ctx.webServer as AuthRemoteWebServer
    await ctx.plugin(Connection, { trustedHosts: [...server.connectionTrustedHosts] })
    await ctx.plugin(Authorization)
    const accountFiber = await ctx.plugin(PlatformAccount, {
      platformOrigin: platform.origin,
      allowLoopbackHttp: true,
    })
    await ctx.fiber.await()
    await server.authentication.initialize('alice', 'manual account test password')
    const login = await server.authentication.login('alice', 'manual account test password')
    assert.equal(login.kind, 'session')
    if (login.kind !== 'session') throw new Error('Expected full session')
    const call = async (
      path: string,
      body?: unknown,
      token: string = login.token,
      extra: Record<string, string> = {},
    ) => {
      const req = request({
        hostname: '127.0.0.1',
        port: server.port,
        path,
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          host: 'manual.example',
          origin,
          'sec-fetch-site': 'same-origin',
          cookie: `${AUTH_COOKIE}=${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...extra,
        },
      })
      const answer = once(req, 'response')
      req.end(body === undefined ? undefined : JSON.stringify(body))
      const [res] = await answer
      let text = ''
      for await (const chunk of res) text += String(chunk)
      return { status: res.statusCode as number, body: text ? JSON.parse(text) : undefined }
    }
    return {
      ctx,
      profile,
      server,
      platform,
      records,
      call,
      accountFiber,
      setManual(value: boolean) {
        const { updateVolatile } = createRequire(
          require.resolve('@deepseek-ai/cordis/package.json'),
        )('@deepseek-ai/cosmokit')
        updateVolatile(
          config.manualAccountLogin,
          Config({ manualAccountLogin: value }).manualAccountLogin,
        )
      },
      token: login.token,
      async start() {
        const started = await call('/auth-remote/account/start', {
          locale: 'zh-CN',
          timezoneOffsetSeconds: 28800,
        })
        assert.equal(started.status, 200, JSON.stringify(started.body))
        let state = started.body as AccountLoginState
        for (let i = 0; i < 100 && state.attempt?.phase === 'initializing'; i++) {
          await new Promise((resolve) => setTimeout(resolve, 10))
          state = (await call('/auth-remote/account/state')).body
        }
        assert.equal(state.attempt?.phase, 'waiting-browser', JSON.stringify(state))
        return state.attempt!
      },
      async close() {
        await ctx.fiber.dispose()
        await platform.close()
        await rm(profile, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await ctx.fiber.dispose()
    await platform.close()
    await rm(profile, { recursive: true, force: true })
    throw error
  }
}

test('manual callback completes the actual 0.2.1-rc.4 provider with the original PKCE and redirect URI', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.call('/auth-remote/account/state', undefined, '')).status, 401)
    const attempt = await f.start()
    assert.match(
      f.platform.attempts[0]!.redirect_uri,
      /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/u,
    )
    assert.equal(
      (await f.call('/oauth/callback?' + new URL(f.platform.callback()).searchParams)).status,
      403,
    )
    const submitted = await f.call('/auth-remote/account/submit', {
      id: attempt.id,
      callbackUrl: f.platform.callback(),
    })
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body))
    assert.equal(submitted.body.status, 'credential-stored')
    assert.equal(submitted.body.attempt.phase, 'succeeded')
    assert.equal(JSON.stringify(submitted.body).includes('dsh_mock_manual_account'), false)
    assert.equal(f.platform.exchanges.length, 1)
    assert.equal(f.platform.requests.includes('/dsh/authorized'), false)
    assert.equal(
      (
        await f.call('/auth-remote/account/submit', {
          id: attempt.id,
          callbackUrl: f.platform.callback(),
        })
      ).status,
      409,
    )
  } finally {
    await f.close()
  }
})

test('clipboard handoff rejects forged origins, states, duplicates and another session without consuming a valid attempt', async () => {
  const f = await fixture()
  try {
    const attempt = await f.start()
    const callback = f.platform.callback()
    for (const value of [
      'file:///etc/passwd',
      'https://attacker.example/oauth/callback?code=x&state=x',
      callback.replace('/oauth/callback', '/other'),
      callback + '&code=duplicate',
      callback + '&state=duplicate',
      callback + '#fragment',
      callback.replace(new URL(callback).searchParams.get('state')!, 'wrong-state'),
      callback.replace('127.0.0.1', 'localhost'),
    ]) {
      const answer = await f.call('/auth-remote/account/submit', {
        id: attempt.id,
        callbackUrl: value,
      })
      assert.equal(answer.status, 400, value)
    }
    assert.equal(f.platform.exchanges.length, 0)
    const other = await f.server.authentication.login('alice', 'manual account test password')
    assert.equal(other.kind, 'session')
    if (other.kind !== 'session') throw new Error('Expected full session')
    assert.equal(
      (await f.call('/auth-remote/account/state', undefined, other.token)).body.attempt,
      null,
    )
    assert.equal(
      (
        await f.call(
          '/auth-remote/account/submit',
          { id: attempt.id, callbackUrl: callback },
          other.token,
        )
      ).status,
      409,
    )
    assert.equal(
      (await f.call('/auth-remote/account/cancel', { id: attempt.id }, other.token)).status,
      409,
    )
    assert.equal(
      (
        await f.call(
          '/auth-remote/account/start',
          { locale: 'en', timezoneOffsetSeconds: 0 },
          other.token,
        )
      ).status,
      409,
    )
    assert.equal(
      (
        await f.call(
          '/auth-remote/account/submit',
          { id: attempt.id, callbackUrl: callback },
          f.token,
          { origin: 'https://attacker.example' },
        )
      ).status,
      403,
    )
    assert.equal(
      (
        await f.call(
          '/auth-remote/account/submit',
          { id: attempt.id, callbackUrl: callback },
          f.token,
          { 'sec-fetch-site': 'cross-site' },
        )
      ).status,
      403,
    )
    assert.equal(
      (await f.call('/auth-remote/account/submit', { id: attempt.id, callbackUrl: callback }))
        .status,
      200,
    )
  } finally {
    await f.close()
  }
})

test('cancellation, session revocation and expiry prevent late clipboard submission', async () => {
  const f = await fixture()
  try {
    const first = await f.start()
    assert.equal((await f.call('/auth-remote/account/cancel', { id: first.id })).status, 200)
    assert.equal(
      (
        await f.call('/auth-remote/account/submit', {
          id: first.id,
          callbackUrl: f.platform.callback(),
        })
      ).status,
      410,
    )
    const second = await f.start()
    await f.server.authentication.logout(f.token)
    assert.equal(
      (
        await f.call('/auth-remote/account/submit', {
          id: second.id,
          callbackUrl: f.platform.callback(),
        })
      ).status,
      401,
    )
    assert.equal(f.platform.exchanges.length, 0)
    assert.equal(
      (
        await (
          f.ctx.get('deepseekAccount') as { getState(): Promise<{ attempt: { phase: string } }> }
        ).getState()
      ).attempt.phase,
      'cancelled',
    )
  } finally {
    await f.close()
  }
  const expiring = await fixture()
  try {
    expiring.platform.expiresIn(0.1)
    const attempt = await expiring.start()
    await new Promise((resolve) => setTimeout(resolve, 160))
    assert.equal(
      (
        await expiring.call('/auth-remote/account/submit', {
          id: attempt.id,
          callbackUrl: expiring.platform.callback(),
        })
      ).status,
      410,
    )
    assert.equal(expiring.platform.exchanges.length, 0)
  } finally {
    await expiring.close()
  }
})

test('failed exchange permits a fresh attempt and simultaneous submissions exchange only once', async () => {
  const f = await fixture()
  try {
    f.platform.failExchange()
    const first = await f.start()
    assert.equal(
      (
        await f.call('/auth-remote/account/submit', {
          id: first.id,
          callbackUrl: f.platform.callback(),
        })
      ).status,
      409,
    )
    f.platform.failExchange(false)
    const next = await f.start()
    f.platform.holdExchange()
    const completion = f.call('/auth-remote/account/submit', {
      id: next.id,
      callbackUrl: f.platform.callback(),
    })
    for (let i = 0; i < 100 && f.platform.exchanges.length < 2; i++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(
      (
        await f.call('/auth-remote/account/submit', {
          id: next.id,
          callbackUrl: f.platform.callback(),
        })
      ).status,
      409,
    )
    f.platform.holdExchange(false)
    assert.equal((await completion).status, 200)
    assert.equal(f.platform.exchanges.length, 2)
  } finally {
    await f.close()
  }
})

test('session revocation during exchange prevents a late platform response from committing credentials', async () => {
  const f = await fixture()
  try {
    const attempt = await f.start()
    f.platform.holdExchange()
    const submission = f.call('/auth-remote/account/submit', {
      id: attempt.id,
      callbackUrl: f.platform.callback(),
    })
    for (let i = 0; i < 100 && f.platform.exchanges.length === 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(f.platform.exchanges.length, 1)
    await f.server.authentication.logout(f.token)
    f.platform.holdExchange(false)
    assert.equal((await submission).status, 401)
    assert.equal(
      (
        await (
          f.ctx.get('deepseekAccount') as { getState(): Promise<{ status: string }> }
        ).getState()
      ).status,
      'signed-out',
    )
    assert.equal(
      [...f.records.values()].some(
        (record) => record?.payload?.token === 'dsh_mock_manual_account',
      ),
      false,
    )
  } finally {
    await f.close()
  }
})

test('account provider replacement withdraws its pending callback and permits a fresh authorization', async () => {
  const f = await fixture()
  try {
    const first = await f.start()
    const oldCallback = f.platform.callback()
    await f.accountFiber.dispose()
    assert.equal((await f.call('/auth-remote/account/state')).body.supported, false)
    assert.equal(
      (await f.call('/auth-remote/account/start', { locale: 'en', timezoneOffsetSeconds: 0 })).body
        .error,
      'account_unavailable',
    )
    await f.ctx.plugin(PlatformAccount, {
      platformOrigin: f.platform.origin,
      allowLoopbackHttp: true,
    })
    await f.ctx.fiber.await()
    assert.equal(
      (await f.call('/auth-remote/account/submit', { id: first.id, callbackUrl: oldCallback }))
        .status,
      410,
    )
    const next = await f.start()
    assert.equal(
      (await f.call('/auth-remote/account/submit', { id: next.id, callbackUrl: oldCallback }))
        .status,
      400,
    )
    assert.equal(
      (
        await f.call('/auth-remote/account/submit', {
          id: next.id,
          callbackUrl: f.platform.callback(),
        })
      ).status,
      200,
    )
  } finally {
    await f.close()
  }
})

test('disabling rejects new starts but preserves an admitted attempt and its protected callback', async () => {
  const f = await fixture()
  try {
    const attempt = await f.start()
    f.setManual(false)
    const state = (await f.call('/auth-remote/account/state')).body
    assert.equal(state.supported, true)
    assert.equal(state.enabled, false)
    assert.equal(state.attempt.id, attempt.id)
    assert.equal(
      (await f.call('/auth-remote/account/start', { locale: 'en', timezoneOffsetSeconds: 0 })).body
        .error,
      'account_disabled',
    )
    assert.equal(
      (await f.call('/oauth/callback?' + new URL(f.platform.callback()).searchParams)).status,
      403,
    )
    assert.equal(
      (
        await f.call('/auth-remote/account/submit', {
          id: attempt.id,
          callbackUrl: f.platform.callback(),
        })
      ).status,
      200,
    )
    assert.equal(f.platform.exchanges.length, 1)
  } finally {
    await f.close()
  }
})

test('the admission reservation survives disabling during the first asynchronous provider read', async () => {
  const f = await fixture()
  const provider = f.ctx.get('deepseekAccount') as any
  const original = provider.getState.bind(provider)
  let release!: () => void
  let admitted!: () => void
  const entered = new Promise<void>((resolve) => {
    admitted = resolve
  })
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let first = true
  provider.getState = async () => {
    if (first) {
      first = false
      admitted()
      await held
    }
    return original()
  }
  try {
    const starting = f.call('/auth-remote/account/start', {
      locale: 'en',
      timezoneOffsetSeconds: 0,
    })
    await entered
    f.setManual(false)
    release()
    const started = await starting
    assert.equal(started.status, 200)
    assert.ok(started.body.attempt.id)
    assert.equal(started.body.enabled, false)
    assert.equal(
      (await f.call('/auth-remote/account/cancel', { id: started.body.attempt.id })).status,
      200,
    )
  } finally {
    release()
    await f.close()
  }
})

test('without a manual owner the captured callback delegates to the native flow even while disabled', async () => {
  const f = await fixture()
  try {
    f.setManual(false)
    const provider = f.ctx.get('deepseekAccount') as any
    await provider.startSignIn(
      { version: '0.2.1-rc.4', locale: 'en', timezoneOffsetSeconds: 0 },
      'http://127.0.0.1:54321',
      'web',
    )
    for (let i = 0; i < 100 && (await provider.getState()).attempt?.phase === 'initializing'; i++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    // A wrong state reaches native validation rather than a fixed bridge 403.
    assert.equal((await f.call('/oauth/callback?code=wrong&state=wrong')).status, 400)
    assert.equal(f.platform.exchanges.length, 0)
    assert.equal(
      (await f.call('/oauth/callback?' + new URL(f.platform.callback()).searchParams)).status,
      302,
    )
    assert.equal((await provider.getState()).status, 'credential-stored')
    assert.equal(f.platform.exchanges.length, 1)
  } finally {
    await f.close()
  }
})

test('revocation during native initialization retains manual callback ownership until cancellation settles', async () => {
  const f = await fixture()
  const provider = f.ctx.get('deepseekAccount') as any
  const start = provider.startSignIn.bind(provider)
  let release!: () => void
  let entered!: () => void
  const pending = new Promise<void>((resolve) => {
    entered = resolve
  })
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  provider.startSignIn = async (...args: unknown[]) => {
    const value = await start(...args)
    entered()
    await held
    return value
  }
  try {
    const other = await f.server.authentication.login('alice', 'manual account test password')
    if (other.kind !== 'session') throw new Error('Expected session')
    const starting = f.call('/auth-remote/account/start', {
      locale: 'en',
      timezoneOffsetSeconds: 0,
    })
    await pending
    for (let i = 0; i < 100 && (await provider.getState()).attempt?.phase === 'initializing'; i++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    await f.server.authentication.logout(f.token)
    assert.equal(
      (
        await f.call(
          '/oauth/callback?' + new URL(f.platform.callback()).searchParams,
          undefined,
          other.token,
        )
      ).status,
      403,
    )
    assert.equal(f.platform.exchanges.length, 0)
    release()
    assert.equal((await starting).status, 401)
    assert.equal((await provider.getState()).attempt.phase, 'cancelled')
  } finally {
    release()
    await f.close()
  }
})

test('a provider that fails to install its native callback reports unavailable without disabling authentication', async () => {
  const f = await fixture()
  const register = f.server.register.bind(f.server)
  f.server.register = (route) =>
    route.kind === 'exact' && route.path === '/oauth/callback' ? () => {} : register(route)
  try {
    const started = await f.call('/auth-remote/account/start', {
      locale: 'en',
      timezoneOffsetSeconds: 0,
    })
    let view = started
    for (let i = 0; i < 100 && view.status === 200; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      view = await f.call('/auth-remote/account/state')
    }
    assert.equal(view.status, 503)
    assert.equal(view.body.error, 'account_unavailable')
    assert.equal((await f.call('/auth-remote/me')).status, 200)
  } finally {
    await f.close()
  }
})

test('native cancellation followed by authorization regains its callback without a plugin state poll', async () => {
  const f = await fixture()
  try {
    const manual = await f.start()
    const oldCallback = f.platform.callback()
    f.setManual(false)
    const provider = f.ctx.get('deepseekAccount') as any
    await provider.cancelSignIn(manual.id)
    await provider.startSignIn(
      { version: '0.2.1-rc.4', locale: 'en', timezoneOffsetSeconds: 0 },
      'http://127.0.0.1:54321',
      'web',
    )
    for (let i = 0; i < 100 && (await provider.getState()).attempt?.phase === 'initializing'; i++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(
      (await f.call('/oauth/callback?' + new URL(f.platform.callback()).searchParams)).status,
      302,
    )
    assert.equal((await provider.getState()).status, 'credential-stored')
    assert.equal(f.platform.exchanges.length, 1)
    assert.equal(
      (await f.call('/auth-remote/account/submit', { id: manual.id, callbackUrl: oldCallback }))
        .status,
      409,
    )
  } finally {
    await f.close()
  }
})

test('failed native cancellation retains the manual callback boundary until native state proves release', async () => {
  const f = await fixture()
  const provider = f.ctx.get('deepseekAccount') as any
  const cancel = provider.cancelSignIn.bind(provider)
  let attemptId: string | undefined
  try {
    const attempt = await f.start()
    attemptId = attempt.id
    const callback = f.platform.callback()
    const other = await f.server.authentication.login('alice', 'manual account test password')
    if (other.kind !== 'session') throw new Error('Expected another session')
    provider.cancelSignIn = async () => {
      throw new Error('isolated cancellation rejection before native execution')
    }
    assert.ok((await f.call('/auth-remote/account/cancel', { id: attempt.id })).status >= 500)
    const native = await provider.getState()
    assert.equal(native.attempt.id, attempt.id)
    assert.equal(native.attempt.phase, 'waiting-browser')
    f.setManual(false)
    assert.equal(
      (await f.call('/oauth/callback?' + new URL(callback).searchParams, undefined, other.token))
        .status,
      403,
    )
    assert.equal(f.platform.exchanges.length, 0)
    provider.cancelSignIn = cancel
    await cancel(attempt.id)
    await provider.startSignIn(
      { version: '0.2.1-rc.4', locale: 'en', timezoneOffsetSeconds: 0 },
      'http://127.0.0.1:54321',
      'web',
    )
    for (let i = 0; i < 100 && (await provider.getState()).attempt?.phase === 'initializing'; i++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(
      (await f.call('/oauth/callback?' + new URL(f.platform.callback()).searchParams)).status,
      302,
    )
    assert.equal(f.platform.exchanges.length, 1)
  } finally {
    provider.cancelSignIn = cancel
    if (attemptId) await cancel(attemptId)
    await f.close()
  }
})

test('shutdown releases the admin socket and state lock when native cancellation rejects', async () => {
  const f = await fixture()
  const provider = f.ctx.get('deepseekAccount') as any
  const cancel = provider.cancelSignIn.bind(provider)
  try {
    await f.start()
    const port = f.server.port
    assert.ok(port)
    provider.cancelSignIn = async () => {
      throw new Error('isolated cancellation rejection during shutdown')
    }
    await f.ctx.fiber.dispose()
    const socket = connect(port, '127.0.0.1')
    try {
      await assert.rejects(once(socket, 'connect'), { code: 'ECONNREFUSED' })
    } finally {
      socket.destroy()
    }
    await assert.rejects(lstat(join(f.profile, 'auth-remote', 'admin.sock')), { code: 'ENOENT' })
    const reopened = await AuthStateStore.open(f.profile)
    await reopened.close()
  } finally {
    provider.cancelSignIn = cancel
    await f.close()
  }
})
