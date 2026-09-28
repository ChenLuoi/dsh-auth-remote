import type { Context } from '@deepseek-ai/cordis'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import type { ResolvedAuthConfig } from '../../config.js'
import { NativeBrowserAuth } from './browser-auth.js'
import { assertConnectionCompatibility } from './compatibility.js'
import type { GuardedWebServer } from './webserver.js'

/** Connection availability and the native authorities used by the bridge. */
export class DshReadiness {
  private readonly native = new NativeBrowserAuth()
  private connection: HostConnectionHandle | undefined
  private isReady = false

  constructor(
    private readonly server: GuardedWebServer,
    private readonly config: ResolvedAuthConfig,
    private readonly onUnavailable: () => void = () => {},
  ) {}

  ready(): boolean {
    return this.isReady
  }

  currentConnection(): HostConnectionHandle | undefined {
    return this.connection
  }

  attach(connection: HostConnectionHandle, profileAnchor?: string): void {
    this.detach()
    assertConnectionCompatibility(connection, profileAnchor)
    const localAuthority = `127.0.0.1:${String(this.server.port)}`
    try {
      this.native.cookieFor(connection, localAuthority, `http://${localAuthority}`)
      if (this.config.preserveOriginPaths.length > 0)
        for (const entry of this.config.originPolicy.registeredOrigins)
          this.native.cookieFor(connection, entry.host, entry.origin)
    } catch (error) {
      this.native.clear(connection)
      throw error
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
    if (this.isReady) {
      this.isReady = false
      this.onUnavailable()
    }
    if (old !== undefined) this.native.clear(old)
  }
}

/** Dynamic injection avoids waiting for Connection before supplying WebServer. */
export function watchConnection(
  ctx: Context,
  readiness: DshReadiness,
  onReady: () => void = () => {},
): void {
  ctx.inject(['connection'], (connectionCtx) => {
    const connection = connectionCtx.get('connection') as HostConnectionHandle
    const profile = ctx.get('profileContext') as { installAnchor?: string } | undefined
    connectionCtx.effect(() => {
      readiness.attach(connection, profile?.installAnchor)
      onReady()
      return () => {
        readiness.detach(connection)
      }
    }, 'auth-remote: native Connection readiness')
  })
}
