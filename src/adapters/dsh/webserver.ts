import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import WebServer, {
  type Config as WebServerConfig,
  type WebRoute,
  type WebUpgradeRoute,
} from '@deepseek-ai/dsh-host-webserver'
import type { NativeListenerConfig } from './runtime-capabilities.js'
import { evaluateRequestOrigin, type OriginPolicy } from '../../http/origin-policy.js'
import type { AccountCallbackBridge } from './account-callback.js'

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
  private originPolicy: OriginPolicy | undefined
  private accountCallbackBridge: AccountCallbackBridge | undefined

  constructor(
    ctx: Context,
    config: NativeListenerConfig & { originPolicy?: OriginPolicy },
    private readonly gate: WebGate = new DenyGate(),
  ) {
    // Production resolves capabilities and explicitly validates the native
    // schema before calling this constructor, including on old IPv4 runtimes.
    super(ctx, config as WebServerConfig)
    this.originPolicy = config.originPolicy
    super.register({
      kind: 'exact',
      path: READY_PATH,
      handler: (req, res) => {
        if (!this.originPolicy) {
          res.writeHead(503, { 'cache-control': 'no-store' })
          res.end()
          return
        }
        if (
          !evaluateRequestOrigin(this.originPolicy, {
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

  /** Ready and the authenticated gate consume the same listener-finalized policy. */
  protected setOriginPolicy(policy: OriginPolicy): void {
    this.originPolicy = policy
  }

  installAccountCallbackBridge(bridge: AccountCallbackBridge): void {
    this.accountCallbackBridge = bridge
  }

  override register(route: WebRoute): () => void {
    const callback = this.accountCallbackBridge?.capture(route)
    const handler = callback?.handler ?? route.handler
    try {
      const dispose = super.register({
        ...route,
        handler: (req, res) => this.gate.http(req, res, () => Promise.resolve(handler(req, res))),
      })
      return () => {
        dispose()
        callback?.dispose()
      }
    } catch (error) {
      callback?.dispose()
      throw error
    }
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
