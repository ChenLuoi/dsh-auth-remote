/** Installed only in a temporary DSH profile. Exercises a generic downstream route. */
import { createHash } from 'node:crypto'

export const inject = ['webServer']

function cookies(req) {
  const parts = String(req.headers.cookie ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
  return {
    hasNative: parts.some((part) => !part.startsWith('dsh_auth_remote=')),
    hasPlugin: parts.some((part) => part.startsWith('dsh_auth_remote=')),
  }
}

function handler(expectPublic) {
  return async (req, res) => {
    const origin = String(req.headers.origin ?? '')
    const host = String(req.headers.host ?? '')
    const expected = expectPublic ? String(process.env.STRICT_PUBLIC_ORIGIN) : `http://${host}`
    if (origin !== expected) {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'downstream_origin_mismatch' }))
      return
    }
    const digest = createHash('sha256')
    let bytes = 0
    for await (const chunk of req) {
      digest.update(chunk)
      bytes += chunk.length
    }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(
      JSON.stringify({
        host,
        origin,
        bytes,
        sha256: digest.digest('hex'),
        ...cookies(req),
      }),
    )
  }
}

export function apply(ctx) {
  ctx.effect(() => {
    const remove = [
      ctx.webServer.register({
        kind: 'exact',
        path: '/plugins/strict/echo',
        handler: handler(false),
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: '/plugins/public/echo',
        handler: handler(true),
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: '/plugins/strict/stream',
        handler(req, res) {
          const host = String(req.headers.host ?? '')
          if (req.headers.origin !== `http://${host}`) {
            res.writeHead(403)
            res.end()
            return
          }
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-store',
          })
          res.write('data: ready\n\n')
          const timer = setInterval(() => res.write(': heartbeat\n\n'), 1000)
          res.on('close', () => clearInterval(timer))
        },
      }),
      ctx.webServer.registerUpgrade({
        path: '/plugins/strict/socket',
        handler(req, socket) {
          const host = String(req.headers.host ?? '')
          if (req.headers.origin !== `http://${host}` || !cookies(req).hasNative) {
            socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
            return
          }
          const key = req.headers['sec-websocket-key']
          if (typeof key !== 'string') {
            socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
            return
          }
          const accept = createHash('sha1')
            .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
            .digest('base64')
          socket.write(
            `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
          )
          const message = Buffer.from('strict-ready')
          socket.write(Buffer.concat([Buffer.from([0x81, message.length]), message]))
        },
      }),
    ]
    return () => {
      for (const dispose of remove) dispose()
    }
  })
}
