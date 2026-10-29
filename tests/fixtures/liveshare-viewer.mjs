/** Read the real native index as a real non-owner Peer; use the shipped carrier verbatim. */
import { createRequire } from 'node:module'

export const inject = ['webServer', 'connection', 'profileContext']

export function apply(ctx) {
  const runtime = createRequire(ctx.profileContext.installAnchor)
  const liveshare = createRequire(
    runtime.resolve('@deepseek-ai/dsh-experimental-liveshare/package.json'),
  )
  const { viewerCarrierScript } = liveshare('@deepseek-ai/dsh-experimental-liveshare-protocol')
  const viewer = ctx.connection.createPeer({
    principal: {
      kind: 'share-viewer',
      shareId: 'local-viewer-fixture',
      actor: { providerId: 'local', tenantId: 'test', subjectId: 'viewer' },
    },
  })
  ctx.on('dispose', () => viewer.dispose())
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/liveshare-fixture',
      resource: async () => {
        const index = await ctx.webServer.readResource(new Request('http://x/'), viewer)
        if (index.status !== 200) throw new Error(`Native viewer index failed: ${index.status}`)
        const carrier = viewerCarrierScript({
          basePath: '',
          shareId: 'local-viewer-fixture',
          sessionId: 'local-session',
          readTimeoutMs: 1000,
        })
        const html = (await index.text()).replace(
          /<head(?:\s[^>]*)?>/i,
          (open) =>
            `${open}<script>${carrier}\nwindow.__viewerTransportBefore = window.__DSH_TRANSPORT__;<\/script>`,
        )
        return new Response(html, {
          headers: { 'content-type': 'text/html', 'cache-control': 'no-store' },
        })
      },
    }),
  )
}
