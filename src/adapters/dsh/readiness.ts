import type { Context } from '@deepseek-ai/cordis'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import type { ResolvedAuthConfig } from '../../config.js'
import { NativeBrowserAuth } from './browser-auth.js'
import { assertConnectionCompatibility, CONNECTION_PROVIDER_DSH } from './compatibility.js'
import type { GuardedWebServer } from './webserver.js'

/** Connection availability and the native authorities used by the bridge. */
export class DshReadiness {
  private readonly native: NativeBrowserAuth
  private connection: HostConnectionHandle | undefined
  private restoreProvider: (() => void) | undefined
  private isReady = false

  constructor(
    _server: GuardedWebServer,
    private readonly config: ResolvedAuthConfig,
    private readonly onUnavailable: () => void = () => {},
    private readonly mountProvider?: (connection: HostConnectionHandle, ctx: Context) => () => void,
  ) {
    this.native = new NativeBrowserAuth(config.protocol)
  }

  ready(): boolean {
    return this.isReady
  }

  currentConnection(): HostConnectionHandle | undefined {
    return this.connection
  }

  usesProvider(): boolean {
    return this.config.version === CONNECTION_PROVIDER_DSH
  }

  attach(connection: HostConnectionHandle, profileAnchor?: string, ctx?: Context): void {
    this.detach()
    const version = assertConnectionCompatibility(connection, profileAnchor)
    if (this.usesProvider()) {
      if (version !== CONNECTION_PROVIDER_DSH || !this.mountProvider || !ctx)
        throw new Error('auth-remote: alpha.2 Connection provider is unavailable')
      this.restoreProvider = this.mountProvider(connection, ctx)
    } else {
      try {
        this.native.cookieFor(connection, this.config.nativeAuthority, this.config.nativeOrigin)
        if (this.config.preserveOriginPaths.length > 0)
          for (const entry of this.config.originPolicy.registeredOrigins)
            this.native.cookieFor(connection, entry.host, entry.origin)
      } catch (error) {
        this.native.clear(connection)
        throw error
      }
    }
    this.connection = connection
    this.isReady = true
  }

  nativeCookie(authority: string, origin: string): string {
    if (!this.isReady || this.connection === undefined)
      throw new Error('auth-remote: Connection is not ready')
    return this.native.cookieFor(this.connection, authority, origin)
  }

  detach(connection?: HostConnectionHandle): void {
    if (connection !== undefined && this.connection !== connection) return
    const old = this.connection
    this.connection = undefined
    const restore = this.restoreProvider
    this.restoreProvider = undefined
    if (this.isReady) {
      this.isReady = false
      this.onUnavailable()
    }
    restore?.()
    if (old !== undefined) this.native.clear(old)
  }
}

/** Dynamic injection avoids waiting for Connection before supplying WebServer. */
export function watchConnection(
  ctx: Context,
  readiness: DshReadiness,
  onReady: () => void = () => {},
  onFailure: (error: unknown) => Promise<void> = async () => {},
): void {
  const dependencies = readiness.usesProvider()
    ? ['connection', 'connection.authentication', 'remoteConnection', 'typertGateway']
    : ['connection']
  ctx.inject(dependencies, (connectionCtx) => {
    const connection = connectionCtx.get('connection') as HostConnectionHandle
    const profile = ctx.get('profileContext') as { installAnchor?: string } | undefined
    connectionCtx.effect(() => {
      try {
        readiness.attach(connection, profile?.installAnchor, connectionCtx)
      } catch (error) {
        void onFailure(error).catch((reason: unknown) => connectionCtx.logger.error(reason))
        throw error
      }
      onReady()
      return () => {
        readiness.detach(connection)
      }
    }, 'auth-remote: native Connection readiness')
  })
}
