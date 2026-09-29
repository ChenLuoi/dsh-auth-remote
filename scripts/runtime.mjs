import { spawnSync } from 'node:child_process'
import { access, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const project = fileURLToPath(new URL('..', import.meta.url))
export const testedDshVersions = ['0.1.7-rc.1', '0.1.7-rc.2', '0.2.0-rc.1']
export const dshVersion = process.env.DSH_TEST_VERSION || '0.2.0-rc.1'
if (!testedDshVersions.includes(dshVersion)) {
  throw new Error(`DSH_TEST_VERSION must be one of: ${testedDshVersions.join(', ')}`)
}
export const testRuntime = join(project, '.cache/test-runtime', dshVersion)
export const testDsh = join(testRuntime, 'node_modules/.bin/dsh')
export const packageManifest = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'))
export const packageName = packageManifest.name
export const archive = join(project, 'artifacts', `${packageName}-${packageManifest.version}.tgz`)

export function selectedTestDsh() {
  return process.env.DSH_TEST_BIN ? resolve(process.env.DSH_TEST_BIN) : testDsh
}

export function checkDshVersion(bin) {
  const result = spawnSync(bin, ['--version'], { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0 || result.stdout.trim() !== dshVersion) {
    const actual = result.stdout.trim().split('\n', 1)[0] || `exit ${result.status}`
    throw new Error(`Expected DSH ${dshVersion} at ${bin}; received ${actual}`)
  }
}

export async function prepareDshRuntime(directory, name) {
  await mkdir(directory, { recursive: true })
  const stat = await lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(directory)) !== directory) {
    throw new Error(`Runtime must be a real local directory: ${directory}`)
  }
  const manifestPath = join(directory, 'package.json')
  let manifest
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    manifest = {
      name,
      private: true,
      version: '0.0.0',
      dependencies: { '@deepseek-ai/dsh': dshVersion },
    }
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
  }
  if (manifest.dependencies?.['@deepseek-ai/dsh'] !== dshVersion) {
    throw new Error(`Runtime has the wrong DSH dependency: ${manifestPath}`)
  }
  const workspacePath = join(directory, 'pnpm-workspace.yaml')
  try {
    await access(workspacePath)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    await writeFile(
      workspacePath,
      [
        'packages:',
        '  - .',
        'allowBuilds:',
        "  '@deepseek-ai/dsh-subprocess-local': true",
        "  '@google/genai': true",
        '  koffi: true',
        '  node-pty: true',
        '  protobufjs: true',
        '',
      ].join('\n'),
      { flag: 'wx' },
    )
  }
  const lockExists = await access(join(directory, 'pnpm-lock.yaml')).then(
    () => true,
    () => false,
  )
  const install = spawnSync('pnpm', ['install', ...(lockExists ? ['--frozen-lockfile'] : [])], {
    cwd: directory,
    stdio: 'inherit',
  })
  if (install.error) throw install.error
  if (install.status !== 0) throw new Error(`Runtime install failed: ${directory}`)
  const bin = join(directory, 'node_modules/.bin/dsh')
  checkDshVersion(bin)
  return bin
}

export function isolatedDshEnv(home) {
  return {
    PATH: process.env.PATH,
    HOME: home,
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
    LANG: 'C.UTF-8',
  }
}
