import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { access, lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const project = resolve(fileURLToPath(new URL('..', import.meta.url)))
export const testedDshVersions = [
  '0.1.7-rc.1',
  '0.1.7-rc.2',
  '0.2.0-rc.1',
  '0.2.0-rc.2',
  '0.2.1-alpha.1',
  '0.2.1-alpha.2',
  '0.2.1-alpha.3',
  '0.2.1-alpha.4',
  '0.2.1-alpha.5',
  '0.2.1-rc.1',
  '0.2.1-rc.2',
]
export const dshVersion = process.env.DSH_TEST_VERSION || '0.2.1-rc.2'
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

export function checkDshVersion(bin, version = dshVersion) {
  const result = spawnSync(bin, ['--version'], { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0 || result.stdout.trim() !== version) {
    const actual = result.stdout.trim().split('\n', 1)[0] || `exit ${result.status}`
    throw new Error(`Expected DSH ${version} at ${bin}; received ${actual}`)
  }
}

export async function prepareDshRuntime(directory, name, version = dshVersion, signal) {
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
      dependencies: { '@deepseek-ai/dsh': version },
    }
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
  }
  if (manifest.dependencies?.['@deepseek-ai/dsh'] !== version) {
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
  signal?.throwIfAborted()
  const install = spawn('pnpm', ['install', ...(lockExists ? ['--frozen-lockfile'] : [])], {
    cwd: directory,
    stdio: 'inherit',
    detached: Boolean(signal),
  })
  const abort = () => {
    try {
      process.kill(-install.pid, 'SIGTERM')
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
  }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    const [code] = await once(install, 'close')
    signal?.throwIfAborted()
    if (code !== 0) throw new Error(`Runtime install failed: ${directory}`)
  } finally {
    signal?.removeEventListener('abort', abort)
  }
  const bin = join(directory, 'node_modules/.bin/dsh')
  checkDshVersion(bin, version)
  return bin
}

const verificationRootParent = join(project, '.cache')
export const verificationParent = join(verificationRootParent, 'verify-packed')
const verificationMarker = 'dsh-auth-remote packed verification root v1\n'

export async function requireRealDirectory(path) {
  const entry = await lstat(path)
  if (!entry.isDirectory() || entry.isSymbolicLink() || (await realpath(path)) !== path)
    throw new Error(`Expected a real local directory: ${path}`)
}

export async function assertVerificationRoot(root) {
  if (dirname(root) !== verificationRootParent || !/^v-[A-Za-z0-9]{6}$/u.test(basename(root)))
    throw new Error(`Invalid packed verification root: ${root}`)
  for (const directory of [project, verificationRootParent, verificationParent, root])
    await requireRealDirectory(directory)
  if ((await readFile(join(root, '.verify-root'), 'utf8')) !== verificationMarker)
    throw new Error(`Unmarked packed verification root: ${root}`)
}

export async function createVerificationRoot() {
  await requireRealDirectory(project)
  for (const directory of [verificationRootParent, verificationParent]) {
    await mkdir(directory, { recursive: true })
    await requireRealDirectory(directory)
  }
  // Keep the profile's Unix socket within Linux's limit in the default CI checkout.
  const root = await mkdtemp(join(verificationRootParent, 'v-'))
  await writeFile(join(root, '.verify-root'), verificationMarker, { flag: 'wx', mode: 0o600 })
  await assertVerificationRoot(root)
  return root
}

export function isolatedDshEnv(home) {
  return {
    PATH: process.env.PATH,
    HOME: home,
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
    // Keep isolated profiles from sharing writable inode metadata with HMR.
    pnpm_config_package_import_method: 'copy',
    LANG: 'C.UTF-8',
  }
}
