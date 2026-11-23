import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { project } from './runtime.mjs'

const sdk = join(project, 'tests/sdk/alpha2')
const { dependencies } = JSON.parse(await readFile(join(sdk, 'package.json'), 'utf8'))
const isolated = await mkdtemp(join(tmpdir(), 'dsh-auth-remote-sdk-'))
try {
  for (const entry of [
    'src',
    'package.json',
    'tsconfig.json',
    'tsconfig.host.json',
    'tsconfig.client.json',
  ])
    await cp(join(project, entry), join(isolated, entry), { recursive: true })
  const modules = join(isolated, 'node_modules')
  await mkdir(join(modules, '@deepseek-ai'), { recursive: true })
  for (const [name, version] of Object.entries(dependencies)) {
    const installed = join(sdk, 'node_modules', name)
    const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
    assert.equal(manifest.name, name)
    assert.equal(manifest.version, version, name)
    await symlink(installed, join(modules, name))
  }
  for (const name of ['@types', 'semver', 'qrcode', 'react'])
    await symlink(join(project, 'node_modules', name), join(modules, name))
  for (const surface of ['host', 'client']) {
    // Published frontend modules reference sibling SDK declarations through
    // development dependencies. Resolve these against the exact SDK above.
    const checked = spawnSync(
      process.execPath,
      [
        join(project, 'node_modules/typescript/bin/tsc'),
        '-p',
        `tsconfig.${surface}.json`,
        '--noEmit',
        ...(surface === 'client' ? ['--preserveSymlinks'] : []),
      ],
      { cwd: isolated, stdio: 'inherit' },
    )
    if (checked.error) throw checked.error
    assert.equal(checked.status, 0, `DSH 0.2.3-alpha.2 ${surface} SDK type check failed`)
    console.log(`DSH 0.2.3-alpha.2 ${surface} SDK types verified`)
  }
} finally {
  await rm(isolated, { recursive: true, force: true })
}
