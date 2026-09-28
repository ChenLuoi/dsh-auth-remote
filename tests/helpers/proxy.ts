import { request as httpRequest, createServer as createHttpServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect as netConnect, type Socket } from 'node:net'

export interface Forwarder {
  close(): Promise<void>
}

interface ForwarderOptions {
  listenPort: number
  upstreamPort: number
  tls?: { key: Buffer; cert: Buffer }
}

export async function startForwarder(options: ForwarderOptions): Promise<Forwarder> {
  const sockets = new Set<Socket>()
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const upstream = httpRequest(
      {
        hostname: '127.0.0.1',
        port: options.upstreamPort,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers)
        answer.on('aborted', () => res.destroy())
        answer.on('close', () => {
          if (!answer.complete) res.destroy()
        })
        answer.pipe(res)
      },
    )
    upstream.on('error', () => {
      if (res.headersSent) res.destroy()
      else {
        res.writeHead(502)
        res.end()
      }
    })
    req.on('aborted', () => upstream.destroy())
    res.on('close', () => {
      if (!res.writableEnded) upstream.destroy()
    })
    req.pipe(upstream)
  }
  const server = options.tls ? createHttpsServer(options.tls, handler) : createHttpServer(handler)
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  server.on('upgrade', (req, socket, head) => {
    const upstream = netConnect(options.upstreamPort, '127.0.0.1', () => {
      const headers: string[] = []
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        headers.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
      }
      upstream.write(
        `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${headers.join('\r\n')}\r\n\r\n`,
      )
      if (head.length) upstream.write(head)
      socket.pipe(upstream).pipe(socket)
    })
    sockets.add(upstream)
    upstream.on('close', () => sockets.delete(upstream))
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
    socket.on('close', () => upstream.destroy())
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.listenPort, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  let closing: Promise<void> | undefined
  return {
    close() {
      closing ??= new Promise<void>((resolve, reject) => {
        for (const socket of sockets) socket.destroy()
        server.close((error) => (error ? reject(error) : resolve()))
      })
      return closing
    },
  }
}
