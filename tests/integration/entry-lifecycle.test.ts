import assert from 'node:assert/strict'
import { mkdtemp, rm, access } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import { AuthRemoteWebServer } from '../../src/index.js'
import type { AuthConfig, WebStartupConfig } from '../../src/config.js'

function request(port: number, host: string, path = '/auth-remote/ready') {
  return new Promise<number>((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, headers: { host } }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode ?? 0))
    })
    req.on('error', reject)
    req.end()
  })
}

async function fixture(input: AuthConfig, startup: WebStartupConfig = { port: 0 }) {
  const profile = await mkdtemp(join(tmpdir(), 'auth-remote-entry-'))
  const ctx = new Context()
  ctx.provide('profileContext', { dir: profile, name: 'web' } as never)
  ctx.provide('webStartup', startup as never)
  let record: unknown
  ctx.provide('credentials', {
    readRecord: async () => record,
    modifyRecord: async (_key: unknown, mutate: (value: unknown) => Promise<unknown>) => {
      record = (await mutate(record)) ?? record
      return record
    },
    deleteRecord: async () => {
      record = undefined
    },
  } as never)
  try {
    await ctx.plugin(AuthRemoteWebServer, input)
    await ctx.fiber.await()
    const server = ctx.webServer as AuthRemoteWebServer
    const connection = await ctx.plugin(Connection, {
      trustedHosts: [...server.connectionTrustedHosts],
    })
    await ctx.fiber.await()
    return {
      ctx,
      server,
      connection,
      async cleanup() {
        await ctx.fiber.dispose()
        await rm(profile, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await ctx.fiber.dispose()
    await rm(profile, { recursive: true, force: true })
    throw error
  }
}

test('CLI public URL replaces file authority everywhere while retaining authenticated loopback', async () => {
  const f = await fixture(
    { publicUrl: 'https://old.example', preserveOriginPaths: ['/api'] },
    { port: 0, publicUrl: 'http://final.example:8080/' },
  )
  try {
    assert.equal(f.server.publicUrl, 'http://final.example:8080/')
    assert.deepEqual(f.server.connectionTrustedHosts, [
      `127.0.0.1:${f.server.port}`,
      'final.example:8080',
    ])
    assert.equal(await request(f.server.port, 'final.example:8080'), 200)
    assert.equal(await request(f.server.port, 'old.example'), 403)
    assert.equal(await request(f.server.port, `127.0.0.1:${f.server.port}`), 200)
    assert.equal(await request(f.server.port, 'final.example:8080', '/api/private'), 401)
    await f.connection.dispose()
    assert.equal(await request(f.server.port, 'final.example:8080'), 503)
    await f.ctx.plugin(Connection, { trustedHosts: ['final.example:8080'] })
    await f.ctx.fiber.await()
    assert.equal(await request(f.server.port, 'final.example:8080'), 200)
  } finally {
    await f.cleanup()
  }
})

test('omitted entry derives an admitted root from the actual ephemeral IPv4 port', async () => {
  const f = await fixture({ host: '127.0.0.2', port: 0, preserveOriginPaths: ['/api'] }, {})
  try {
    assert.ok(f.server.port > 0)
    assert.equal(f.server.publicUrl, `http://127.0.0.2:${f.server.port}/`)
    assert.deepEqual(f.server.connectionTrustedHosts, [`127.0.0.2:${f.server.port}`])
    const response = await fetch(f.server.publicUrl + 'auth-remote/ready')
    assert.equal(response.status, 200)
    assert.equal((await response.json()).ready, true)
  } finally {
    await f.cleanup()
  }
})

test('legacy single/empty input migrates once in memory and explicit coexistence fails', async () => {
  for (const allowedOrigins of [[], ['https://legacy.example/']]) {
    const input = { allowedOrigins }
    const snapshot = JSON.stringify(input)
    const f = await fixture(input)
    try {
      assert.equal(JSON.stringify(input), snapshot)
      assert.equal(
        f.server.publicUrl,
        allowedOrigins.length ? 'https://legacy.example/' : `http://127.0.0.1:${f.server.port}/`,
      )
    } finally {
      await f.cleanup()
    }
  }
  for (const allowedOrigins of [[], ['https://same.example']])
    await assert.rejects(
      fixture({ publicUrl: 'https://same.example', allowedOrigins }),
      /publicUrl.*allowedOrigins/u,
    )
  await assert.rejects(
    fixture({ allowedOrigins: ['https://a.example', 'https://a.example'] }),
    /one.*unique/u,
  )
})

test('failure after native listening releases listener, admin socket and storage lock', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'auth-remote-finalize-fail-'))
  const ctx = new Context()
  const port = 13133
  ctx.provide('profileContext', { dir: profile, name: 'web' } as never)
  ctx.provide('webStartup', { host: '127.0.0.1', port } as never)
  class InvalidNativePort extends AuthRemoteWebServer {
    override get port() {
      return 0
    }
  }
  try {
    const fiber = ctx.plugin(InvalidNativePort, {})
    await assert.rejects(fiber.await(), /listener|port|publicUrl/u)
    await assert.rejects(request(port, `127.0.0.1:${port}`))
    await assert.rejects(access(join(profile, 'auth-remote', 'admin.sock')))
    const { AuthStateStore } = await import('../../src/storage/store.js')
    const reopened = await AuthStateStore.open(profile)
    await reopened.close()
  } finally {
    await ctx.fiber.dispose()
    await rm(profile, { recursive: true, force: true })
  }
})

test('native bridge preflight failure closes an already listening entry and its admin socket', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'auth-remote-bridge-fail-'))
  const ctx = new Context()
  ctx.provide('profileContext', { dir: profile, name: 'web' } as never)
  ctx.provide('webStartup', { port: 0 } as never)
  let record: unknown
  ctx.provide('credentials', {
    readRecord: async () => record,
    modifyRecord: async (_key: unknown, mutate: (value: unknown) => Promise<unknown>) => {
      record = (await mutate(record)) ?? record
      return record
    },
    deleteRecord: async () => {
      record = undefined
    },
  } as never)
  try {
    await ctx.plugin(AuthRemoteWebServer, {
      publicUrl: 'http://needs-trust.example',
      preserveOriginPaths: ['/api'],
    })
    await ctx.fiber.await()
    const server = ctx.webServer as AuthRemoteWebServer
    const port = server.port
    assert.equal(await request(port, 'needs-trust.example'), 503)
    await access(join(profile, 'auth-remote', 'admin.sock'))
    await ctx.plugin(Connection, { trustedHosts: [] })
    await ctx.fiber.await().catch(() => {})
    await assert.rejects(request(port, 'needs-trust.example'))
    await assert.rejects(access(join(profile, 'auth-remote', 'admin.sock')))
    const { AuthStateStore } = await import('../../src/storage/store.js')
    const reopened = await AuthStateStore.open(profile)
    await reopened.close()
  } finally {
    await ctx.fiber.dispose()
    await rm(profile, { recursive: true, force: true })
  }
})
