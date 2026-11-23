import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

export const inject = ['webServer', 'profileContext']

export function apply(ctx) {
  const { dir, installAnchor } = ctx.profileContext
  const fromPlugin = createRequire(join(dir, 'node_modules/dsh-auth-remote/dist/index.js'))
  const fromHost = createRequire(installAnchor)
  const facts = Object.fromEntries(
    ['@deepseek-ai/cordis', '@deepseek-ai/dsh-host-webserver', '@deepseek-ai/schemastery'].map(
      (name) => {
        const manifest = `${name}/package.json`
        const plugin = realpathSync(fromPlugin.resolve(manifest))
        const host = realpathSync(fromHost.resolve(manifest))
        return [
          name,
          { same: plugin === host, version: JSON.parse(readFileSync(host, 'utf8')).version },
        ]
      },
    ),
  )
  writeFileSync(join(dir, 'packed-peer-facts.json'), JSON.stringify(facts))
}
