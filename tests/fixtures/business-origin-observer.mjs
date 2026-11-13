import { randomUUID } from 'node:crypto'

export const inject = ['webServer', 'connection']

/** Observe the real admission, waterfall and Request conversion without a sharing Host. */
export function apply(ctx) {
  const generation = randomUUID()
  const paths = ['/api/liveshare.ownerLoginStart', '/api/liveshare.ownerLoginRedeem']
  const observations = []
  let calls = 0
  const observe = (req, res) => {
    const path = req.url?.split('?', 1)[0]
    if (req.method !== 'POST' || !paths.includes(path)) return
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
      setImmediate(() =>
        observations.push({ path, writes, finalOrigin: origin, status: res.statusCode }),
      ),
    )
  }
  const listener = ctx.webServer.server
  ctx.effect(() => {
    listener.prependListener('request', observe)
    return () => listener.off('request', observe)
  })
  for (const path of paths)
    ctx.connection.fetch.register({
      path,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        calls++
        return Response.json({
          generation,
          calls,
          nativeRequest: request instanceof Request,
          path: new URL(request.url).pathname,
          method: request.method,
          origin: request.headers.get('origin'),
          body: await request.text(),
        })
      },
    })
  ctx.connection.fetch.register({
    path: '/api/auth-remote-origin-observation',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: () => Response.json({ generation, calls, observations }),
  })
}
