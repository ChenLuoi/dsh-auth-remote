import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import semver from 'semver'

const WEB_SERVER_PACKAGE = '@deepseek-ai/dsh-host-webserver'
const CONNECTION_PACKAGE = '@deepseek-ai/dsh-client-connection'
const SUPPORTED_DSH_RANGE = '>=0.1.7-rc.1 <0.2.0-0'

interface PackageManifest {
  name: string
  version: string
}

function packageManifest(
  packageName: string,
  anchor: string,
): { path: string; manifest: PackageManifest } {
  const path = realpathSync(createRequire(anchor).resolve(`${packageName}/package.json`))
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as PackageManifest
  if (
    manifest.name !== packageName ||
    !semver.satisfies(manifest.version, SUPPORTED_DSH_RANGE, { includePrerelease: true })
  ) {
    throw new Error(`auth-remote: unsupported ${packageName} version ${manifest.version}`)
  }
  return { path, manifest }
}

/** Verify the loaded module and the profile's host resolve to one DSH copy. */
export function assertWebServerCompatibility(ctx: Context): string {
  const own = packageManifest(WEB_SERVER_PACKAGE, import.meta.url)
  const profile = ctx.get('profileContext') as { installAnchor?: string } | undefined
  if (profile?.installAnchor !== undefined) {
    const host = packageManifest(WEB_SERVER_PACKAGE, profile.installAnchor)
    if (own.path !== host.path) {
      throw new Error(
        `auth-remote: duplicate WebServer package copies: ${own.path} and ${host.path}`,
      )
    }
  }
  for (const method of [
    'register',
    'registerUpgrade',
    'registerFallback',
    'renderIndex',
  ] as const) {
    if (typeof WebServer.prototype[method] !== 'function') {
      throw new Error(`auth-remote: WebServer lacks ${method}`)
    }
  }
  return own.manifest.version
}

/** Check Connection after it appears; readiness must be withdrawn on its loss. */
export function assertConnectionCompatibility(
  connection: HostConnectionHandle,
  anchor?: string,
): string {
  const own = packageManifest(CONNECTION_PACKAGE, import.meta.url)
  if (anchor !== undefined) {
    const host = packageManifest(CONNECTION_PACKAGE, anchor)
    if (own.path !== host.path) {
      throw new Error(
        `auth-remote: duplicate Connection package copies: ${own.path} and ${host.path}`,
      )
    }
  }
  for (const method of ['authenticatedUrl', 'authorizeIndex', 'requestRejection'] as const) {
    if (typeof connection[method] !== 'function') {
      throw new Error(`auth-remote: Connection lacks ${method}`)
    }
  }
  return own.manifest.version
}
