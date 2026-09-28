/** Host entry: storage is preflighted before the guarded listener opens. */
import { Service, type Context } from '@deepseek-ai/cordis'
import { basename } from 'node:path'
import { assertWebServerCompatibility } from './adapters/dsh/compatibility.js'
import { installAuthenticatedHostCapability } from './adapters/dsh/browser-capability.js'
import { DshReadiness, watchConnection } from './adapters/dsh/readiness.js'
import { startupLines } from './adapters/dsh/startup-urls.js'
import { DenyGate, GuardedWebServer, SwitchGate } from './adapters/dsh/webserver.js'
import { AuthService } from './auth/service.js'
import {
  resolveAuthConfig,
  Config,
  DEFAULT_WEB_HOST,
  DEFAULT_WEB_PORT,
  type AuthConfig,
  type ResolvedAuthConfig,
} from './config.js'
import { AuthConnections } from './http/connections.js'
import { AdminSocket } from './http/admin-socket.js'
import { AuthGate } from './http/gate.js'
import { AuthRoutes } from './http/routes.js'
import { AuthStateStore } from './storage/store.js'

export type { AuthConfig } from './config.js'
export { Config, DEFAULT_REQUIRE_TOTP, DEFAULT_SESSION_HOURS } from './config.js'
export { resolveAuthConfig } from './config.js'
export { installAuthenticatedHostCapability } from './adapters/dsh/browser-capability.js'
export { GuardedWebServer, READY_PATH, READY_PROTOCOL_VERSION } from './adapters/dsh/webserver.js'
export { DshReadiness, watchConnection } from './adapters/dsh/readiness.js'
export { AuthService, AuthError } from './auth/service.js'
export type { AuthPolicy, AuthErrorCode, LoginResult } from './auth/service.js'
export { AuthStateStore } from './storage/store.js'
export { AuthGate } from './http/gate.js'
export { AuthConnections } from './http/connections.js'

export const name = 'auth-remote'

export class AuthRemoteWebServer extends GuardedWebServer {
  static override Config = Config as unknown as typeof GuardedWebServer.Config
  private stateStore: AuthStateStore | undefined
  private authService: AuthService | undefined
  private readonly resolved: ResolvedAuthConfig
  private readonly switchGate: SwitchGate

  constructor(ctx: Context, input: AuthConfig) {
    const startup = ctx.get('webStartup') as { host?: string; port?: number } | undefined
    if (!startup) throw new Error('auth-remote: webStartup service is required')
    const config = resolveAuthConfig(input, {
      host: startup.host ?? DEFAULT_WEB_HOST,
      port: startup.port ?? DEFAULT_WEB_PORT,
      compression: 'none',
    })
    assertWebServerCompatibility(ctx)
    const gate = new SwitchGate()
    super(ctx, config, gate)
    this.resolved = config
    this.switchGate = gate
    installAuthenticatedHostCapability(ctx)
  }

  override async [Service.init](): Promise<void> {
    const profile = this.ctx.get('profileContext') as { dir?: string; name?: string } | undefined
    if (!profile?.dir) throw new Error('dsh-auth-remote: profileContext is required for storage')
    const profileName = profile.name ?? basename(profile.dir)
    let readiness: DshReadiness | undefined
    let connections: AuthConnections | undefined
    let admin: AdminSocket | undefined
    const store = await AuthStateStore.open(profile.dir, {
      onUnavailable: () => {
        this.switchGate.set(new DenyGate())
        readiness?.detach()
        if (connections) void connections.closeAll()
      },
    })
    try {
      const auth = new AuthService(store, {
        requireTotp: this.resolved.requireTotp,
        sessionHours: this.resolved.sessionHours,
      })
      await auth.enforceCurrentPolicy()
      this.stateStore = store
      this.authService = auth
      connections = new AuthConnections(store, auth)
      readiness = new DshReadiness(this, this.resolved, () => {
        if (connections) void connections.closeAll()
      })
      this.switchGate.set(
        new AuthGate(() => this.port, this.resolved, store, auth, readiness, connections),
      )
      new AuthRoutes(auth, profileName).install(this)
      admin = new AdminSocket(
        profile.dir,
        auth,
        () => this.switchGate.ready(),
        () => {
          this.switchGate.set(new DenyGate())
          readiness?.detach()
          if (connections) void connections.closeAll()
        },
      )
      await admin.start()
      const activeConnections = connections
      const activeReadiness = readiness
      const activeAdmin = admin
      this.ctx.effect(
        () => async () => {
          this.switchGate.set(new DenyGate())
          activeReadiness.detach()
          await activeAdmin.dispose()
          await activeConnections.dispose()
          auth.dispose()
          await store.close()
        },
        'auth-remote.storage-and-gate',
      )
      await super[Service.init]()
      let announced = false
      watchConnection(this.ctx, readiness, () => {
        const loader = this.ctx.get('loader') as { await(): Promise<unknown> } | undefined
        const settled = loader?.await() ?? Promise.resolve()
        void settled
          .then(() => {
            if (announced || !activeReadiness.ready()) return
            announced = true
            console.log(startupLines(profileName, this.resolved, this.port).join('\n'))
          })
          .catch(() => {})
      })
    } catch (error) {
      this.switchGate.set(new DenyGate())
      await admin?.dispose()
      await connections?.dispose()
      this.authService?.dispose()
      await store.close()
      throw error
    }
  }

  get storage(): AuthStateStore {
    if (!this.stateStore) throw new Error('dsh-auth-remote: storage is not initialized')
    return this.stateStore
  }

  get authentication(): AuthService {
    if (!this.authService) throw new Error('dsh-auth-remote: authentication is not initialized')
    return this.authService
  }

  /** Public authorities needed by native Connection for preserved routes. */
  get connectionTrustedHosts(): readonly string[] {
    if (this.resolved.preserveOriginPaths.length === 0) return []
    return this.resolved.originPolicy.registeredOrigins.map((entry) => entry.host)
  }
}

export default AuthRemoteWebServer
