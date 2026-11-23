import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

export const inject = ['webServer']

export function apply(ctx) {
  ctx.webServer.register({
    kind: 'exact',
    path: '/__provider/session-near-expiry',
    async handler(req, res) {
      if (req.method !== 'POST') return res.writeHead(405).end()
      const token = req.headers.cookie?.match(
        /(?:^|;\s*)dsh_auth_remote=([A-Za-z0-9_-]{43})(?:;|$)/u,
      )?.[1]
      if (!token) return res.writeHead(401).end()
      const key = createHash('sha256').update(token).digest('hex')
      const changed = await ctx.webServer.storage.transact((state) => {
        const session = state.sessions[key]
        if (!session || session.expiresAt <= Date.now()) return false
        const target = Date.now() + (session.source === 'password' ? 2800 : 500)
        // Preserve the issued lifetime while moving the isolated test record near expiry.
        session.createdAt -= session.expiresAt - target
        session.expiresAt = target
        return true
      })
      res.writeHead(changed ? 204 : 401).end()
    },
  })
  ctx.webServer.register({
    kind: 'exact',
    path: '/__provider/fail-next-state-write',
    handler(req, res) {
      if (req.method !== 'POST') return res.writeHead(405).end()
      const { options } = ctx.webServer.storage
      const previous = options.onStage
      options.onStage = async (stage) => {
        if (stage === 'beforeRename') {
          options.onStage = previous
          throw new Error('isolated pre-rename failure')
        }
        await previous?.(stage)
      }
      res.writeHead(204).end()
    },
  })
  ctx.webServer.register({
    kind: 'exact',
    path: '/__provider/stream',
    async resource(request, peer) {
      if (peer === undefined) return new Response(null, { status: 500 })
      const end = () => writeFile(join(process.env.DSH_HOME, 'resource-aborted'), 'yes')
      request.signal.addEventListener(
        'abort',
        () => {
          void end()
        },
        { once: true },
      )
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: ready\n\n'))
        },
      })
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    },
  })
}
