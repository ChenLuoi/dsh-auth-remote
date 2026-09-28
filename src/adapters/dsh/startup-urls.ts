import type { ResolvedAuthConfig } from '../../config.js'

/** Startup URLs for the listener and configured public browser entries. */
export function startupLines(profile: string, config: ResolvedAuthConfig, port: number): string[] {
  const lines = [`dsh ${profile} start at`, `  http://${config.host}:${String(port)}`]
  if (config.allowedOrigins.length > 0) {
    lines.push('', 'public access at')
    for (const origin of config.allowedOrigins) lines.push(`  ${origin}`)
  }
  return lines
}
