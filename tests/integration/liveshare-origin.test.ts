import assert from 'node:assert/strict'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { installLiveShareOrigin } from '../../src/adapters/dsh/liveshare.js'
import { evaluateRequestOrigin, createOriginPolicy } from '../../src/http/origin-policy.js'
import { setRequestContext } from '../../src/http/request-context.js'

// The business origin comes from the real raw-header validator, never the rewritten header.
function request(
  path: string,
  method = 'POST',
  original: string | undefined = 'http://127.0.0.1:13090',
  trusted = true,
) {
  const req = new IncomingMessage(new Socket())
  req.url = path
  req.method = method
  req.headers.origin = original
  if (trusted) {
    const policy = createOriginPolicy(['https://public.example', 'http://127.0.0.1:13090'])
    const context = evaluateRequestOrigin(policy, {
      rawHeaders: ['Host', 'public.example', 'Origin', 'https://public.example'],
      method,
      target: path,
    })
    assert(context)
    setRequestContext(req, context)
  }
  return req
}

test('LiveShare exact owner POSTs use validated business origin then restore native headers on every settlement', async () => {
  const ctx = new Context()
  try {
    installLiveShareOrigin(ctx)
    for (const path of [
      '/api/liveshare.ownerLoginStart',
      '/api/liveshare.ownerLoginRedeem?local=1',
    ]) {
      for (const outcome of ['success', 'throw', 'cancel']) {
        const req = request(path)
        const res = new ServerResponse(req)
        const operation = ctx.waterfall('connection/request', req, res, async () => {
          assert.equal(req.headers.origin, 'https://public.example')
          await Promise.resolve()
          if (outcome === 'cancel') throw new DOMException('cancelled', 'AbortError')
          if (outcome === 'throw') throw new Error('business failure')
        })
        if (outcome === 'success') await operation
        else
          await assert.rejects(operation, outcome === 'cancel' ? /cancelled/u : /business failure/u)
        assert.equal(req.headers.origin, 'http://127.0.0.1:13090')
        req.destroy()
      }
    }
  } finally {
    await ctx.fiber.dispose()
  }
})

test('LiveShare missing Origin is not fabricated, missing trusted context rejects and nearby APIs remain unchanged', async () => {
  const ctx = new Context()
  try {
    installLiveShareOrigin(ctx)
    const missing = request('/api/liveshare.ownerLoginStart', 'POST', undefined)
    // A missing Origin stays absent, even though the raw context names a public authority.
    delete missing.headers.origin
    await ctx.waterfall('connection/request', missing, new ServerResponse(missing), async () => {
      assert.equal(missing.headers.origin, undefined)
    })
    const untrusted = request(
      '/api/liveshare.ownerLoginRedeem',
      'POST',
      'https://forged.example',
      false,
    )
    await assert.rejects(
      ctx.waterfall('connection/request', untrusted, new ServerResponse(untrusted), async () => {
        assert.fail('missing context admitted')
      }),
      /missing validated request context/u,
    )
    for (const [path, method] of [
      ['/api/liveshare.ownerLoginStart', 'GET'],
      ['/api/liveshare.ownerLoginRedeem', 'HEAD'],
      ['/api/liveshare.ownerLoginStart/extra', 'POST'],
      ['/api/liveshare.ownerLoginStartMore', 'POST'],
      ['/api/liveshare.ownerLoginCancel', 'POST'],
      ['/api/liveshare.ownerCredential', 'POST'],
      ['/api/other', 'POST'],
    ]) {
      const req = request(path!, method!, 'http://127.0.0.1:13090', false)
      await ctx.waterfall('connection/request', req, new ServerResponse(req), async () => {
        assert.equal(req.headers.origin, 'http://127.0.0.1:13090')
      })
      req.destroy()
    }
    missing.destroy()
    untrusted.destroy()
  } finally {
    await ctx.fiber.dispose()
  }
})

test('LiveShare public hook belongs to its fiber and is installed only once after reload', async () => {
  const ctx = new Context()
  const plugin = { name: 'origin-lifecycle-probe', apply: installLiveShareOrigin }
  try {
    let fiber = ctx.plugin(plugin)
    await fiber.await()
    for (let generation = 0; generation < 2; generation++) {
      const req = request('/api/liveshare.ownerLoginStart')
      let origin = req.headers.origin
      let writes = 0
      Object.defineProperty(req.headers, 'origin', {
        get: () => origin,
        set(value) {
          origin = value
          writes++
        },
      })
      await ctx.waterfall('connection/request', req, new ServerResponse(req), async () => {
        assert.equal(req.headers.origin, 'https://public.example')
      })
      assert.equal(writes, 2, 'one restoration pair per fiber generation')
      await fiber.dispose()
      const detached = request('/api/liveshare.ownerLoginStart')
      await ctx.waterfall(
        'connection/request',
        detached,
        new ServerResponse(detached),
        async () => {
          assert.equal(detached.headers.origin, 'http://127.0.0.1:13090')
        },
      )
      req.destroy()
      detached.destroy()
      fiber = ctx.plugin(plugin)
      await fiber.await()
    }
  } finally {
    await ctx.fiber.dispose()
  }
})
