import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { dshVersion, isolatedDshEnv, project } from './runtime.mjs'

export { project, dshVersion }
export const devRoot = join(project, '.dev')
export const runtime = join(devRoot, 'runtime')
export const home = join(devRoot, 'dsh-home')
export const profile = join(home, 'profiles/web')
export const dsh = join(runtime, 'node_modules/.bin/dsh')
export const port = 13090
const marker = join(home, '.dsh-auth-remote-dev-home')
const markerText = 'dsh-auth-remote isolated development home v1\n'

async function requireRealDirectory(path) {
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(path)) !== path) {
    throw new Error(`Development path must be a real local directory: ${path}`)
  }
}

export async function assertRuntimeDirectory() {
  await requireRealDirectory(runtime)
}

function requireAmbientHome() {
  if (process.env.DSH_HOME && resolve(process.env.DSH_HOME) !== home) {
    throw new Error(
      `Refusing ambient DSH_HOME outside isolated development home: ${process.env.DSH_HOME}`,
    )
  }
}

export async function ensureDevHome() {
  requireAmbientHome()
  await mkdir(devRoot, { recursive: true })
  await requireRealDirectory(devRoot)
  let exists = true
  try {
    await lstat(home)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    exists = false
  }
  if (!exists) {
    await mkdir(home)
    await writeFile(marker, markerText, { flag: 'wx', mode: 0o600 })
  }
  await assertDevHome()
}

export async function assertDevHome() {
  requireAmbientHome()
  await requireRealDirectory(devRoot)
  await requireRealDirectory(home)
  if ((await readFile(marker, 'utf8')) !== markerText) {
    throw new Error(`Refusing unmarked DSH_HOME: ${home}`)
  }
  for (const path of [join(home, 'profiles'), profile]) {
    try {
      await requireRealDirectory(path)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
}

export function dshEnv() {
  return isolatedDshEnv(home)
}
