import type { ResolvedAuthConfig } from '../../config.js'

/** The listener and one distinct public root, with no native token or login path. */
export function startupLines(profile: string, config: ResolvedAuthConfig): string[] {
  const lines = [`dsh ${profile} start at`, `  ${config.listenerUrl.replace(/\/$/u, '')}`]
  if (config.publicUrl !== config.listenerUrl)
    lines.push('', 'public access at', `  ${config.publicUrl.replace(/\/$/u, '')}`)
  return lines
}
