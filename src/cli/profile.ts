import { lstat, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { CliDiagnostic } from './language.js'

export interface ProfileTarget {
  name: string
  dir: string
  home: string
  statePath: string
  socketPath: string
}

function dshHome(env: NodeJS.ProcessEnv): string {
  const supplied = env.DSH_HOME
  const candidate =
    supplied !== undefined && supplied.trim().length > 0 ? supplied : join(homedir(), '.dsh')
  const expanded =
    candidate === '~'
      ? homedir()
      : candidate.startsWith('~/') || candidate.startsWith('~\\')
        ? join(homedir(), candidate.slice(2))
        : candidate
  return resolve(expanded)
}

/** `dsh plugin --profile NAME exec` runs pnpm in the selected profile directory. */
export async function resolveProfileTarget(
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProfileTarget> {
  const dir = await realpath(cwd)
  const home = await realpath(dshHome(env))
  const profiles = await realpath(join(home, 'profiles'))
  const name = basename(dir)
  const info = await lstat(dir)
  if (
    !info.isDirectory() ||
    info.uid !== process.getuid?.() ||
    dirname(dir) !== profiles ||
    name === 'node_modules' ||
    name === '.' ||
    name === '..'
  )
    throw new CliDiagnostic(
      'cliErrorProfileDirectory',
      'dsh-auth-remote: current directory is not the selected DSH profile under DSH_HOME',
    )
  let manifest
  try {
    manifest = await lstat(join(dir, 'package.json'))
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
      throw new CliDiagnostic(
        'cliErrorProfileManifest',
        'dsh-auth-remote: profile package.json is missing',
      )
    throw error
  }
  if (!manifest.isFile())
    throw new CliDiagnostic(
      'cliErrorProfileManifest',
      'dsh-auth-remote: profile package.json is missing',
    )
  return {
    name,
    dir,
    home,
    statePath: join(dir, 'auth-remote', 'auth-state.json'),
    socketPath: join(dir, 'auth-remote', 'admin.sock'),
  }
}
