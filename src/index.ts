/** Host entry: storage is preflighted before the guarded listener opens. */
import { Service, type Context } from '@deepseek-ai/cordis'
import { basename } from 'node:path'
import { assertWebServerCompatibility } from './adapters/dsh/compatibility.js'
import { installAuthenticatedHostCapability } from './adapters/dsh/browser-capability.js'
import { DshReadiness, watchConnection } from './adapters/dsh/readiness.js'
import { startupLines } from './adapters/dsh/startup-urls.js'
import { listenerProtocol } from './adapters/dsh/runtime-capabilities.js'
import { DenyGate, GuardedWebServer, SwitchGate } from './adapters/dsh/webserver.js'
import { AuthService } from './auth/service.js'
import {
  resolveStartupConfig,
  finalizeAuthConfig,
  Config,
  type AuthConfig,
  type WebStartupConfig,
  type PendingAuthConfig,
  type ResolvedAuthConfig,
} from './config.js'
import { AuthConnections } from './http/connections.js'
import { AdminSocket } from './http/admin-socket.js'
import { AuthGate } from './http/gate.js'
import { AuthRoutes } from './http/routes.js'
import { ManualAccountLogin } from './http/account-login.js'
import { AuthStateStore } from './storage/store.js'

export type { AuthConfig } from './config.js'
export { Config, DEFAULT_REQUIRE_TOTP, DEFAULT_SESSION_HOURS } from './config.js'
export { resolveStartupConfig, finalizeAuthConfig } from './config.js'
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
  private readonly pending: PendingAuthConfig
  private resolvedConfig: ResolvedAuthConfig | undefined
  private readonly switchGate: SwitchGate

  constructor(ctx: Context, input: AuthConfig) {
    const startup = ctx.get('webStartup') as WebStartupConfig | undefined
    if (!startup) throw new Error('auth-remote: webStartup service is required')
    const profile = ctx.get('profileContext') as { dir?: string } | undefined
    if (!profile?.dir) throw new Error('dsh-auth-remote: profileContext is required for storage')
    const config = resolveStartupConfig(input, startup, {
      version: assertWebServerCompatibility(ctx),
      profileDir: profile.dir,
      cwd: process.cwd(),
    })
    const gate = new SwitchGate()
    super(ctx, config, gate)
    this.pending = config
    this.switchGate = gate
    installAuthenticatedHostCapability(ctx, config.capabilities.version)
    if (config.legacyWarning)
      console.warn('auth-remote: allowedOrigins is deprecated; use publicUrl with one root URL')
  }

  override async [Service.init](): Promise<void> {
    const profile = this.ctx.get('profileContext') as { dir?: string; name?: string } | undefined
    if (!profile?.dir) throw new Error('dsh-auth-remote: profileContext is required for storage')
    const profileName = profile.name ?? basename(profile.dir)
    let readiness: DshReadiness | undefined
    let connections: AuthConnections | undefined
    let admin: AdminSocket | undefined
    let accountLogin: ManualAccountLogin | undefined
    const store = await AuthStateStore.open(profile.dir, {
      onUnavailable: () => {
        this.switchGate.set(new DenyGate())
        readiness?.detach()
        void accountLogin?.dispose().catch(() => {})
        if (connections) void connections.closeAll()
      },
    })
    try {
      const auth = new AuthService(store, {
        requireTotp: this.pending.requireTotp,
        sessionHours: this.pending.sessionHours,
      })
      await auth.enforceCurrentPolicy()
      this.stateStore = store
      this.authService = auth
      // Keep the listener behind DenyGate until its actual address has one
      // finalized policy. Its official effect is owned by this service fiber.
      await super[Service.init]()
      const port = this.port
      if (port === undefined) throw new Error('auth-remote: listener has not bound a port')
      this.resolvedConfig = finalizeAuthConfig(this.pending, {
        host: this.host,
        port,
        protocol: listenerProtocol(this, this.pending.capabilities),
      })
      this.setOriginPolicy(this.resolved.originPolicy)
      connections = new AuthConnections(store, auth)
      readiness = new DshReadiness(this, this.resolved, () => {
        if (connections) void connections.closeAll()
      })
      this.switchGate.set(new AuthGate(this.resolved, store, auth, readiness, connections))
      new AuthRoutes(auth, profileName).install(this)
      accountLogin = new ManualAccountLogin(
        this.ctx,
        auth,
        store,
        this.pending.capabilities.version,
      )
      accountLogin.install(this)
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
      const activeAccountLogin = accountLogin
      this.ctx.effect(
        () => async () => {
          this.switchGate.set(new DenyGate())
          activeReadiness.detach()
          await activeAccountLogin.dispose()
          await activeAdmin.dispose()
          await activeConnections.dispose()
          auth.dispose()
          await store.close()
        },
        'auth-remote.storage-and-gate',
      )
      let announced = false
      watchConnection(
        this.ctx,
        readiness,
        () => {
          const loader = this.ctx.get('loader') as { await(): Promise<unknown> } | undefined
          const settled = loader?.await() ?? Promise.resolve()
          void settled
            .then(() => {
              if (announced || !activeReadiness.ready()) return
              announced = true
              console.log(startupLines(profileName, this.resolved).join('\n'))
            })
            .catch(() => {})
        },
        async () => {
          this.switchGate.set(new DenyGate())
          activeReadiness.detach()
          // The failed readiness effect is not awaited by this callback;
          // official parent-fiber disposal owns every listener/admin resource.
          await this.ctx.fiber.dispose()
        },
      )
    } catch (error) {
      this.switchGate.set(new DenyGate())
      await admin?.dispose()
      await accountLogin?.dispose()
      await connections?.dispose()
      this.authService?.dispose()
      await store.close()
      throw error
    }
  }

  private get resolved(): ResolvedAuthConfig {
    if (!this.resolvedConfig) throw new Error('auth-remote: listener entry is not finalized')
    return this.resolvedConfig
  }

  /** Native WebApp evaluates this only after the authenticated service initializes. */
  get publicUrl(): string {
    return this.resolved.publicUrl
  }

  get storage(): AuthStateStore {
    if (!this.stateStore) throw new Error('dsh-auth-remote: storage is not initialized')
    return this.stateStore
  }

  get authentication(): AuthService {
    if (!this.authService) throw new Error('dsh-auth-remote: authentication is not initialized')
    return this.authService
  }

  /** Declare the finalized bridge and any public authorities used by preserved routes. */
  get connectionTrustedHosts(): readonly string[] {
    const hosts = [this.resolved.nativeAuthority]
    if (this.resolved.preserveOriginPaths.length > 0)
      hosts.push(...this.resolved.originPolicy.registeredOrigins.map((entry) => entry.host))
    return [...new Set(hosts)]
  }
}

export default AuthRemoteWebServer
