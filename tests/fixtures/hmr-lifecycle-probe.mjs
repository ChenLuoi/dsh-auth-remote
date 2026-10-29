/** Observation only; all listeners, state stores and fibers are genuine plugin instances. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const inject = ['profileContext']
export function apply(ctx) {
  const key = Symbol.for('dsh-auth-remote.test.hmr-lifecycle')
  const state = (globalThis[key] ??= { entries: [], sequence: 0, diagnostics: [] })
  // The default buffer omits warnings. This public exporter remains active while
  // the genuine webServer provider is disposed and restored by native HMR.
  ctx.logger.exporter({
    levels: { default: 3 },
    export(message) {
      const text = message.args
        .map((arg) => (arg instanceof Error ? arg.message : String(arg)))
        .join(' ')
      if (/task9|failed to reload plugin at/u.test(text)) state.diagnostics.push(text)
    },
  })
  const lockPath = join(ctx.profileContext.dir, 'auth-remote/auth-state.lock')
  state.record = (service, kind) => {
    // A traced service exposes the caller's ctx. Observe the real provider fiber.
    const raw = service[Symbol.for('cordis.original')] ?? service
    const entry = {
      id: ++state.sequence,
      kind,
      service: raw,
      server: raw.server,
      storage: raw.storage,
      fiber: raw.ctx.fiber,
      nonce: JSON.parse(readFileSync(lockPath, 'utf8')).nonce,
      closed: false,
    }
    entry.server.once('close', () => {
      entry.closed = true
    })
    state.entries.push(entry)
    return entry
  }
  ctx.inject(['webServer'], (ctx) => {
    const current = state.record(ctx.webServer, 'ready')
    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/plugins/hmr-lifecycle/observation',
        handler(_req, res) {
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end(
            JSON.stringify({
              current: current.id,
              port: ctx.webServer.port,
              nonce: JSON.parse(readFileSync(lockPath, 'utf8')).nonce,
              diagnostics: state.diagnostics,
              entries: state.entries.map((entry) => ({
                id: entry.id,
                kind: entry.kind,
                listening: entry.server.listening,
                healthy: entry.storage.healthy(),
                fiberUid: entry.fiber.uid,
                closed: entry.closed,
                nonce: entry.nonce,
              })),
            }),
          )
        },
      }),
    )
  })
}
