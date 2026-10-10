import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { assertRemoteHostCapability } from '../../src/client/adapters/dsh.js'

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
