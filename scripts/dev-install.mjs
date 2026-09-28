import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  assertDevHome,
  assertRuntimeDirectory,
  dsh,
  dshEnv,
  home,
  port,
  profile,
} from './dev-common.mjs'
import { archive, checkDshVersion, dshVersion, packageManifest, project } from './runtime.mjs'

await assertDevHome()
await assertRuntimeDirectory()
const archiveBytes = await readFile(archive)
const digest = createHash('sha256').update(archiveBytes).digest('hex')
const stage = join(project, '.cache/dev-install')
await mkdir(stage, { recursive: true })
const stageStat = await lstat(stage)
if (!stageStat.isDirectory() || stageStat.isSymbolicLink() || (await realpath(stage)) !== stage)
  throw new Error(`Unsafe local package staging directory: ${stage}`)
const stagedArchive = join(
  stage,
  `${packageManifest.name}-${packageManifest.version}-${digest}.tgz`,
)
try {
  await writeFile(stagedArchive, archiveBytes, { flag: 'wx', mode: 0o600 })
} catch (error) {
  if (error?.code !== 'EEXIST') throw error
  const stagedStat = await lstat(stagedArchive)
  if (!stagedStat.isFile() || stagedStat.isSymbolicLink())
    throw new Error(`Unsafe staged package: ${stagedArchive}`)
  if (!(await readFile(stagedArchive)).equals(archiveBytes))
    throw new Error(`Staged package content mismatch: ${stagedArchive}`)
}
checkDshVersion(dsh)
const install = spawnSync(dsh, ['plugin', '--profile', 'web', 'add', stagedArchive], {
  cwd: home,
  env: dshEnv(),
  stdio: 'inherit',
})
if (install.error) throw install.error
if (install.status !== 0) process.exit(install.status ?? 1)
const installedEntry = await readFile(
  join(profile, 'node_modules', packageManifest.name, 'dist/index.js'),
)
const builtEntry = await readFile(join(project, 'dist/index.js'))
if (!installedEntry.equals(builtEntry))
  throw new Error('Installed DSH profile did not materialize the current package archive')
await assertDevHome()
await mkdir(profile, { recursive: true })
const patch = join(profile, 'cordis.patch.yml')
try {
  const stat = await lstat(patch)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Unsafe profile patch: ${patch}`)
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}
await writeFile(patch, '- id: webserver\n  disabled: true\n', { mode: 0o600 })
console.info(
  `Installed ${packageManifest.name}@${packageManifest.version} into isolated DSH ${dshVersion}`,
)
console.info('DSH_HOME: .dev/dsh-home')
console.info('Profile patch: .dev/dsh-home/profiles/web/cordis.patch.yml')
console.info(`Local listener: http://127.0.0.1:${port}`)
