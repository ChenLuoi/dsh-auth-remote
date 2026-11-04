/** Observation only: real Loader identities and listeners remain owned by DSH. */
import { statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

export const inject = ['webServer', 'loader', 'profileContext']

export function apply(ctx) {
  const runtime = createRequire(ctx.profileContext.installAnchor)
  const webApp = createRequire(runtime.resolve('@deepseek-ai/dsh-web-app/package.json'))
  const packages = Object.fromEntries(
    [
      'dsh-web-app',
      'dsh-host-webserver',
      'dsh-client-connection',
      'dsh-deepseek-account-platform',
    ].map((name) => [name, webApp(`@deepseek-ai/${name}/package.json`).version]),
  )
  const entry = [...ctx.loader.entries()].find((entry) => entry.options.id === 'auth-remote')
  if (!entry?.fiber) throw new Error('auth-remote Loader entry is missing')
  const canonicalFiber = () => entry.fiber.ctx.fiber
  const effectiveConfig = (fiber) => {
    // FiberState is a const enum and has no JavaScript export on either SDK.
    if (fiber.state !== 2) throw new Error('Observed Loader fiber is not active')
    const config = 'effectiveConfig' in fiber ? fiber.effectiveConfig : fiber.config
    if (typeof config?.manualAccountLogin?.get !== 'function')
      throw new Error('Active Loader volatile manualAccountLogin reference is missing')
    return config
  }
  const fiber = canonicalFiber()
  const reference = effectiveConfig(fiber).manualAccountLogin
  const authentication = ctx.webServer.authentication
  const storage = ctx.webServer.storage
  const server = ctx.webServer.server
  if (!server?.listening) throw new Error('Actual native listener is missing')
  const lockPath = join(ctx.profileContext.dir, 'auth-remote/auth-state.lock')
  const lock = statSync(lockPath)
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/plugins/live-config/observation',
      handler(_req, res) {
        const current = statSync(lockPath)
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(
          JSON.stringify({
            packages,
            fiberUid: canonicalFiber().uid,
            sameFiber: canonicalFiber() === fiber,
            sameReference: effectiveConfig(canonicalFiber()).manualAccountLogin === reference,
            sameAuthentication: ctx.webServer.authentication === authentication,
            sameStorage: ctx.webServer.storage === storage,
            enabled: reference.get(),
            sameListener: ctx.webServer.server === server,
            sameLock: current.ino === lock.ino && current.dev === lock.dev,
            port: ctx.webServer.port,
          }),
        )
      },
    }),
  )
}
