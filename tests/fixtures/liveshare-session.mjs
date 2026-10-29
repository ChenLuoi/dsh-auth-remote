/** Create an empty genuine Session, without invoking an Agent/model or replacing any service. */
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
export const inject = ['webServer', 'sessions', 'profileContext', 'liveshareShares']
export function apply(ctx) {
  const generation = randomUUID()
  let observation
  const observe = (req, res) => {
    if (req.method !== 'POST' || req.url !== '/api/liveshare.ownerLoginStart') return
    let origin = req.headers.origin
    const writes = []
    Object.defineProperty(req.headers, 'origin', {
      configurable: true,
      get: () => origin,
      set(value) {
        origin = value
        writes.push(value)
      },
    })
    res.once('finish', () =>
      setImmediate(() => {
        observation = { writes, status: res.statusCode }
      }),
    )
  }
  const listener = ctx.webServer.server
  ctx.effect(() => {
    listener.prependListener('request', observe)
    return () => listener.off('request', observe)
  })
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/plugins/liveshare-fixture/origin-observation',
      handler(_req, res) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ generation, observation }))
      },
    }),
  )
  const runtime = createRequire(ctx.profileContext.installAnchor)
  const liveshare = createRequire(
    runtime.resolve('@deepseek-ai/dsh-experimental-liveshare/package.json'),
  )
  const { viewerCarrierScript } = liveshare('@deepseek-ai/dsh-experimental-liveshare-protocol')
  // Generate in the plain Node Host: tsx would alter function.toString() with naming helpers.
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/plugins/liveshare-fixture/carrier',
      handler(req, res) {
        if (req.method !== 'GET') {
          res.writeHead(405).end()
          return
        }
        const url = new URL(req.url, 'http://x')
        res.writeHead(200, { 'content-type': 'application/javascript' })
        res.end(
          viewerCarrierScript({
            basePath: '',
            shareId: url.searchParams.get('shareId'),
            sessionId: url.searchParams.get('sessionId'),
            readTimeoutMs: 20000,
          }),
        )
      },
    }),
  )
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/plugins/liveshare-fixture/session',
      async handler(req, res) {
        if (req.method !== 'POST') {
          res.writeHead(405).end()
          return
        }
        const session = ctx.sessions.create(undefined, { meta: { cwd: ctx.profileContext.dir } })
        await ctx.sessions.flush(session)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ sessionId: session.id }))
      },
    }),
  )
}
