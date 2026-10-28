/** Read-only observation of the native shell registry in an isolated profile. */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

export const inject = ['webServer', 'shellEnv', 'systemPrompt']

export function apply(ctx) {
  ctx.effect(() => {
    let assembling = false
    const timer = setInterval(async () => {
      const shellUrl = ctx.shellEnv.collect({}).DSH_WEB_URL
      if (typeof shellUrl !== 'string' || assembling) return
      assembling = true
      try {
        const assembly = await ctx.systemPrompt.assemble()
        const webPrompt = assembly.sections.find(
          (section) => section.name === 'app:web-surface',
        )?.text
        const webContext = assembly.contexts?.find(
          (context) => context.name === 'app:web-surface',
        )?.text
        if (typeof webPrompt !== 'string' || typeof webContext !== 'string') return
        writeFileSync(
          join(ctx.get('profileContext').dir, 'entry-observation.json'),
          JSON.stringify({
            version: createRequire(
              join(ctx.get('profileContext').dir, 'node_modules/dsh-auth-remote/package.json'),
            )('@deepseek-ai/dsh-host-webserver/package.json').version,
            publicUrl: ctx.webServer.publicUrl,
            shellUrl,
            webPrompt,
            webContext,
            sectionsHavePublicUrl: assembly.sections.some((section) =>
              section.text.includes(ctx.webServer.publicUrl.replace(/\/$/u, '')),
            ),
            sectionsHaveToken: assembly.sections.some((section) =>
              section.text.includes('?token='),
            ),
          }),
          { mode: 0o600 },
        )
        clearInterval(timer)
      } finally {
        assembling = false
      }
    }, 25)
    return () => clearInterval(timer)
  })
}
