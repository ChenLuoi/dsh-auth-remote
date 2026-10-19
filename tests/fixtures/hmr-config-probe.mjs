/** Real native transaction probe; owns no substitute services or configuration. */
export const inject = ['webServer', 'hmr']
let generations = 0

export function apply(ctx) {
  const generation = ++generations
  let release
  let held = false
  let nestedRejected = false
  let failure
  ctx.effect(() => () => release?.())
  for (const action of ['hold', 'state', 'release']) {
    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/plugins/hmr-config/' + action,
        handler(_req, res) {
          if (action === 'hold') {
            void ctx.hmr
              .runExclusive(async () => {
                held = true
                try {
                  await ctx.hmr.runExclusive(async () => {})
                } catch (error) {
                  nestedRejected = error.message === 'HMR transactions cannot be nested'
                }
                await new Promise((resolve) => {
                  release = resolve
                })
                held = false
              })
              .catch((error) => {
                failure = error.message
              })
          } else if (action === 'release') release?.()
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ generation, held, nestedRejected, failure }))
        },
      }),
    )
  }
}
