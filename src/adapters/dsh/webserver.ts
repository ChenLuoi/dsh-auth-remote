import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import WebServer, {
  type Config as WebServerConfig,
  type WebResource,
  type WebResourceRoute,
  type WebRoute,
  type WebUpgradeRoute,
} from '@deepseek-ai/dsh-host-webserver'
import type { NativeListenerConfig } from './runtime-capabilities.js'
import { evaluateRequestOrigin, type OriginPolicy } from '../../http/origin-policy.js'
import type { AccountCallbackBridge } from './account-callback.js'
import { CONNECTION_PROVIDER_DSH } from './compatibility.js'
import { routePermission } from '../../http/routes.js'
import { ACCOUNT_CALLBACK_PATH } from '../../shared/account-login.js'

declare module '@deepseek-ai/cordis' {
  interface Events {
    'webserver/request'(
      req: IncomingMessage,
      res: ServerResponse,
      next: () => Promise<void>,
    ): Promise<void>
    'webserver/upgrade'(
      req: IncomingMessage,
      socket: Duplex,
      head: Buffer,
      peer: unknown,
      next: () => Promise<void>,
    ): Promise<void>
  }
}

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

type ServeResource = (
  req: IncomingMessage,
  res: ServerResponse,
  target: URL,
  resource: WebResource,
) => Promise<void>

/** Gate native handler registration and the instance's resource HTTP boundary. */
export class GuardedWebServer extends WebServer {
  private originPolicy: OriginPolicy | undefined
  private accountCallbackBridge: AccountCallbackBridge | undefined
  private readonly manualCallbacks = new WeakSet<IncomingMessage>()
  private readonly resourceBoundaryInstalled: boolean
  private readonly hasProvider: boolean

  constructor(
    ctx: Context,
    config: NativeListenerConfig & { originPolicy?: OriginPolicy; version?: string },
    private readonly gate: WebGate = new DenyGate(),
  ) {
    // Production verifies the host version and explicitly validates the native
    // schema before calling this constructor, including on old IPv4 runtimes.
    super(ctx, config as WebServerConfig)
    this.hasProvider = config.version === CONNECTION_PROVIDER_DSH
    this.resourceBoundaryInstalled = this.hasProvider || this.installResourceBoundary()
    if (this.hasProvider) {
      ctx.on(
        'webserver/request',
        (req, res, next) => {
          const path = req.url?.split('?', 1)[0]
          if (path === READY_PATH || this.manualCallbacks.has(req)) return next()
          return this.gate.http(req, res, async () => {
            if (path === ACCOUNT_CALLBACK_PATH && (await this.accountCallbackBridge?.reserved())) {
              res.writeHead(403, { 'cache-control': 'no-store' }).end()
              return
            }
            await next()
          })
        },
        true,
      )
      ctx.on(
        'webserver/upgrade',
        (req, socket, head, _peer, next) => this.gate.upgrade(req, socket, head, next),
        true,
      )
    }
    this.originPolicy = config.originPolicy
    const readyRoute = {
      kind: 'exact' as const,
      path: READY_PATH,
      auth: 'anonymous' as const,
      handler: (req: IncomingMessage, res: ServerResponse) => {
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
    }
    super.register(readyRoute)
  }

  /** DSH-RESOURCE-001: private native boundary; never replace its routing or stream bridge. */
  private installResourceBoundary(): boolean {
    const native: unknown = Reflect.get(this, 'serveResource')
    if (typeof native !== 'function') {
      if (typeof Reflect.get(this, 'readResource') === 'function') {
        throw new Error(
          'auth-remote: WebServer resource HTTP boundary serveResource is unavailable',
        )
      }
      return false
    }
    const serve = native as ServeResource
    Object.defineProperty(this, 'serveResource', {
      value: (req: IncomingMessage, res: ServerResponse, _target: URL, resource: WebResource) =>
        this.gate.http(req, res, () =>
          serve.call(this, req, res, new URL(req.url ?? '/', 'http://x'), resource),
        ),
    })
    return true
  }

  private requireResourceBoundary(): void {
    if (!this.resourceBoundaryInstalled) {
      throw new Error(
        'auth-remote: WebServer resource registration requires a guarded serveResource',
      )
    }
  }

  /** Ready and the authenticated gate consume the same listener-finalized policy. */
  protected setOriginPolicy(policy: OriginPolicy): void {
    this.originPolicy = policy
  }

  installAccountCallbackBridge(bridge: AccountCallbackBridge): void {
    this.accountCallbackBridge = bridge
    if (this.hasProvider)
      bridge.useRequestEvent(async (req, res) => {
        this.manualCallbacks.add(req)
        try {
          await this.ctx.waterfall(this, 'webserver/request', req, res, async () => {
            res.writeHead(410, { 'cache-control': 'no-store' }).end()
          })
        } finally {
          this.manualCallbacks.delete(req)
        }
      })
  }

  override register(route: WebRoute | WebResourceRoute): () => void {
    if (this.hasProvider) {
      // The outer gate limits methods and source before the native match.
      if ('handler' in route && route.kind === 'exact') {
        const permission = routePermission('GET', route.path) ?? routePermission('POST', route.path)
        if (permission === 'public' || permission === 'logout') {
          const anonymous = { ...route, auth: 'anonymous' as const }
          return super.register(anonymous)
        }
      }
      return super.register(route)
    }
    if ('resource' in route) {
      this.requireResourceBoundary()
      return super.register(route)
    }
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

  override registerFallback(
    fallback: WebRoute['handler'] | Pick<WebResourceRoute, 'resource'>,
  ): () => void {
    if (this.hasProvider) return super.registerFallback(fallback)
    if (typeof fallback !== 'function') {
      this.requireResourceBoundary()
      return super.registerFallback(fallback)
    }
    return super.registerFallback((req, res) =>
      this.gate.http(req, res, () => Promise.resolve(fallback(req, res))),
    )
  }

  override registerUpgrade(route: WebUpgradeRoute): () => void {
    if (this.hasProvider) return super.registerUpgrade(route)
    return super.registerUpgrade({
      ...route,
      handler: (req, socket, head) =>
        this.gate.upgrade(req, socket, head, () =>
          Promise.resolve(route.handler(req, socket, head)),
        ),
    })
  }
}
