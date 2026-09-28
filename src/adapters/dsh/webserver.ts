import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import WebServer, {
  type Config as WebServerConfig,
  type WebRoute,
  type WebUpgradeRoute,
} from '@deepseek-ai/dsh-host-webserver'
import type { ResolvedAuthConfig } from '../../config.js'
import { evaluateRequestOrigin } from '../../http/origin-policy.js'

export const READY_PATH = '/auth-remote/ready'
export const READY_PROTOCOL_VERSION = 1

/** A gate owns admission and then calls the official route exactly once. */
export interface WebGate {
  ready(): boolean
  http(req: IncomingMessage, res: ServerResponse, next: () => Promise<void>): Promise<void>
  upgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    next: () => Promise<void>,
  ): Promise<void>
}

/** Safe production baseline until the account and HTTP gate are installed. */
export class DenyGate implements WebGate {
  ready(): boolean {
    return false
  }

  async http(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.writeHead(503, { 'cache-control': 'no-store' })
    res.end()
  }

  async upgrade(_req: IncomingMessage, socket: Duplex): Promise<void> {
    socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
  }
}

/** Keeps the public listener closed while asynchronous preflight completes. */
export class SwitchGate implements WebGate {
  private delegate: WebGate = new DenyGate()

  set(delegate: WebGate): void {
    this.delegate = delegate
  }

  ready(): boolean {
    return this.delegate.ready()
  }

  http(req: IncomingMessage, res: ServerResponse, next: () => Promise<void>): Promise<void> {
    return this.delegate.http(req, res, next)
  }

  upgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    next: () => Promise<void>,
  ): Promise<void> {
    return this.delegate.upgrade(req, socket, head, next)
  }
}

/** Wrap only public WebServer registration methods; its routing and IO stay official. */
export class GuardedWebServer extends WebServer {
  constructor(
    ctx: Context,
    config: ResolvedAuthConfig,
    private readonly gate: WebGate = new DenyGate(),
  ) {
    // The native runtime passes host directly to server.listen(); its public
    // config type lists only two literals. The auth plugin validates IPv4 first.
    super(ctx, config as WebServerConfig)
    super.register({
      kind: 'exact',
      path: READY_PATH,
      handler: (req, res) => {
        if (
          !evaluateRequestOrigin(config.originPolicy, {
            rawHeaders: req.rawHeaders,
            method: req.method,
            target: req.url,
          })
        ) {
          res.writeHead(403, { 'cache-control': 'no-store' })
          res.end()
          return
        }
        if (req.method !== 'GET') {
          res.writeHead(405, { 'cache-control': 'no-store', allow: 'GET' })
          res.end()
          return
        }
        const ready = this.gate.ready()
        res.writeHead(ready ? 200 : 503, {
          'cache-control': 'no-store',
          'content-type': 'application/json; charset=utf-8',
        })
        res.end(
          JSON.stringify({
            plugin: 'dsh-auth-remote',
            protocolVersion: READY_PROTOCOL_VERSION,
            ready,
          }),
        )
      },
    })
  }

  override register(route: WebRoute): () => void {
    return super.register({
      ...route,
      handler: (req, res) =>
        this.gate.http(req, res, () => Promise.resolve(route.handler(req, res))),
    })
  }

  override registerFallback(handler: WebRoute['handler']): () => void {
    return super.registerFallback((req, res) =>
      this.gate.http(req, res, () => Promise.resolve(handler(req, res))),
    )
  }

  override registerUpgrade(route: WebUpgradeRoute): () => void {
    return super.registerUpgrade({
      ...route,
      handler: (req, socket, head) =>
        this.gate.upgrade(req, socket, head, () =>
          Promise.resolve(route.handler(req, socket, head)),
        ),
    })
  }
}
