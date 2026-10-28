/** Seed a completed empty turn through the real Session store; never start an Agent or LLM. */
export const inject = ['webServer', 'sessions', 'sessionProjections']

export function apply(ctx) {
  ctx.webServer.register({
    kind: 'exact',
    path: '/plugins/rc-navigation/seed',
    async handler(req, res) {
      if (req.method !== 'POST') {
        res.writeHead(405).end()
        return
      }
      const chunks = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > 1024) {
          res.writeHead(413).end()
          return
        }
        chunks.push(chunk)
      }
      let body
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        res.writeHead(400).end()
        return
      }
      const session = typeof body?.sessionId === 'string' && ctx.sessions.get(body.sessionId)
      if (!session) {
        res.writeHead(404).end()
        return
      }
      const boundary = ctx.sessionProjections.stateOf(session, 'turnBoundary')
      if (boundary && (boundary.openTurnStartSeq !== null || boundary.lastTurn !== 0)) {
        res.writeHead(409).end()
        return
      }
      session.append('turn/start', { turn: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await ctx.sessions.flush(session)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ seeded: true, sessionId: session.id }))
    },
  })
}
