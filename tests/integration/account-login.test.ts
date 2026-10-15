import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { request } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import PlatformAccount from '@deepseek-ai/dsh-deepseek-account-platform'
import Authorization from '@deepseek-ai/dsh-authorization'
import { AuthRemoteWebServer } from '../../src/index.js'
import { accountPlatform } from '../helpers/account-platform.js'
import type { AccountLoginState } from '../../src/shared/account-login.js'
import { AUTH_COOKIE } from '../../src/shared/auth-contract.js'

const require = createRequire(import.meta.url)
assert.equal(
  require('@deepseek-ai/dsh-deepseek-account-platform/package.json').version,
  '0.2.1-alpha.3',
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
    await ctx.plugin(AuthRemoteWebServer, { publicUrl: origin, requireTotp: false })
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
      server,
      platform,
      records,
      call,
      accountFiber,
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

test('manual callback completes the actual alpha.3 provider with the original PKCE and redirect URI', async () => {
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
