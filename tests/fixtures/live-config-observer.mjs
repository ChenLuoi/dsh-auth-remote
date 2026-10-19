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
  const fiber = entry.fiber
  const reference = fiber.config.manualAccountLogin
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
            fiberUid: entry.fiber.uid,
            sameFiber: entry.fiber === fiber,
            sameReference: entry.fiber.config.manualAccountLogin === reference,
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
