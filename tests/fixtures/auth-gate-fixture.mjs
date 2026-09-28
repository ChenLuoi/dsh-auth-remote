/** Isolated DSH profile only: a fixed test cookie stands in for the account gate. */
import {
  Config,
  DshReadiness,
  GuardedWebServer,
  installAuthenticatedHostCapability,
  resolveAuthConfig,
  watchConnection,
} from 'dsh-auth-remote'

export const inject = ['webStartup']

export default class AuthGateFixtureServer extends GuardedWebServer {
  static Config = Config

  constructor(ctx, input) {
    const startup = ctx.get('webStartup')
    const config = resolveAuthConfig(input, {
      host: startup.host ?? '127.0.0.1',
      port: startup.port ?? 3080,
      compression: 'gzip',
      compressionLevel: 1,
      compressionThresholdBytes: 1024,
    })
    const entry = config.originPolicy.registeredOrigins[0]
    if (!entry) throw new Error('auth gate fixture requires one registered origin')
    const expectedHost = entry.host
    const testCookie = process.env.DSH_GATE_TEST_COOKIE
    if (typeof testCookie !== 'string' || testCookie.length < 32) {
      throw new Error('auth gate fixture requires a random test cookie')
    }
    let readiness
    const admit = (req) => {
      if (req.headers.host !== expectedHost || !readiness?.ready()) return false
      const pairs = (req.headers.cookie ?? '').split(';').map((value) => value.trim())
      if (!pairs.includes(`auth-gate-test=${testCookie}`)) return false
      const native = readiness.nativeCookie(expectedHost, entry.origin)
      const nativeName = native.slice(0, native.indexOf('='))
      req.headers.cookie = [
        ...pairs.filter((pair) => pair !== '' && !pair.startsWith(`${nativeName}=`)),
        native,
      ].join('; ')
      return true
    }
    const gate = {
      ready: () => readiness?.ready() ?? false,
      async http(req, res, next) {
        if (!admit(req)) {
          res.writeHead(readiness?.ready() ? 401 : 503, { 'cache-control': 'no-store' })
          res.end()
          return
        }
        await next()
      },
      async upgrade(req, socket, _head, next) {
        if (!admit(req)) {
          socket.end(
            `HTTP/1.1 ${readiness?.ready() ? '401 Unauthorized' : '503 Service Unavailable'}\r\nConnection: close\r\n\r\n`,
          )
          return
        }
        await next()
      },
    }
    super(ctx, config, gate)
    readiness = new DshReadiness(this, config)
    watchConnection(ctx, readiness)
    installAuthenticatedHostCapability(ctx)
  }
}
