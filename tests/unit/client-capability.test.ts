import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { assertRemoteHostCapability } from '../../src/client/adapters/dsh.js'
import { installAuthenticatedHostCapability } from '../../src/adapters/dsh/browser-capability.js'
import {
  ACCOUNT_LOGIN_CAPABILITY,
  supportsManualAccountLogin,
} from '../../src/shared/account-login.js'
import { ManualAccountLogin } from '../../src/http/account-login.js'
import type { AuthService } from '../../src/auth/service.js'
import type { AuthStateStore } from '../../src/storage/store.js'
import type { GuardedWebServer } from '../../src/adapters/dsh/webserver.js'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'

test('IPv6 and mapped loopback locations do not require a remote Host override', async () => {
  const ctx = new Context()
  ctx.provide('connection', { isLoopback: false } as never)
  try {
    for (const hostname of ['[::1]', '[::ffff:7f00:1]', 'localhost', '127.0.0.1']) {
      Object.defineProperty(globalThis, 'location', { configurable: true, value: { hostname } })
      assert.doesNotThrow(() => assertRemoteHostCapability(ctx), hostname)
    }
    for (const hostname of ['[::2]', '[::ffff:7f:1]', 'remote.example', '127.remote.example']) {
      Object.defineProperty(globalThis, 'location', { configurable: true, value: { hostname } })
      assert.throws(() => assertRemoteHostCapability(ctx), /Host settings capability/u)
    }
  } finally {
    Reflect.deleteProperty(globalThis, 'location')
    await ctx.fiber.dispose()
  }
})

test('manual adapter admits the SemVer floor including prereleases without an upper bound', async () => {
  for (const version of [
    undefined,
    'invalid',
    '0.2.1-alpha.2+build',
    '0.2.1-alpha.10',
    '0.3.0-alpha.1',
    '0.1.7-rc.1',
    '0.1.7-rc.2',
    '0.2.0-rc.1',
    '0.2.0-rc.2',
    '0.2.1-alpha.1',
    '0.2.1-alpha.2',
    '0.2.1-alpha.3',
    '0.2.1-alpha.4',
    '0.2.1-alpha.5',
    '0.2.1-rc.1',
    '0.2.1-rc.2',
    '0.2.1',
    '0.3.0',
  ]) {
    const enabled = !!version && supportsManualAccountLogin(version)
    const ctx = new Context()
    let dependencies = 0
    let bridges = 0
    let routes = 0
    let unsubscribed = false
    const adapter = new ManualAccountLogin(
      { inject: () => dependencies++ } as unknown as Context,
      {} as AuthService,
      {
        subscribe: () => () => {
          unsubscribed = true
        },
      } as unknown as AuthStateStore,
      version ?? '',
    )
    try {
      installAuthenticatedHostCapability(ctx, version)
      const table: IndexInjection[] = []
      ctx.emit('webserver/index-inject', table)
      assert.equal(
        table.some((entry) => entry.kind === 'global' && entry.name === ACCOUNT_LOGIN_CAPABILITY),
        enabled,
        String(version),
      )
      adapter.install({
        installAccountCallbackBridge: () => bridges++,
        register: () => routes++,
      } as unknown as GuardedWebServer)
      assert.equal(dependencies, Number(enabled), String(version))
      assert.equal(bridges, Number(enabled), String(version))
      assert.equal(routes, 4)
    } finally {
      await adapter.dispose()
      await ctx.fiber.dispose()
    }
    assert.equal(unsubscribed, true)
  }
})

test('manual admission uses SemVer ordering for prereleases and invalid input', () => {
  for (const version of [
    '0.2.1-alpha.3',
    '0.2.1-alpha.4',
    '0.2.1-alpha.5',
    '0.2.1-rc.1',
    '0.2.1-rc.2',
    '0.2.1-alpha.10',
    '0.2.1',
    '0.3.0-alpha.1',
  ])
    assert.equal(supportsManualAccountLogin(version), true)
  for (const version of ['', 'invalid', '0.2.1-alpha.2', '0.2.1-alpha.2+build', '0.2.0'])
    assert.equal(supportsManualAccountLogin(version), false)
})
