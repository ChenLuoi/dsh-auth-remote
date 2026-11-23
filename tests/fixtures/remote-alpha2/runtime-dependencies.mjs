import assert from 'node:assert/strict'
import { mkdir, readdir, realpath, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { project } from '../../../scripts/runtime.mjs'

/** Resolve the real host services for direct development and rollback probes. */
export async function linkRuntimeDependencies(runtime, profile) {
  const virtualStore = join(runtime, 'node_modules/.pnpm')
  const entries = await readdir(virtualStore)
  const namespace = join(profile, 'node_modules/@deepseek-ai')
  await mkdir(namespace, { recursive: true })
  for (const name of ['cordis', 'schemastery', 'dsh-host-webserver', 'dsh-client-connection']) {
    const matches = entries.filter((entry) => entry.startsWith('@deepseek-ai+' + name + '@'))
    assert.equal(matches.length, 1)
    const dependency = join(virtualStore, matches[0], 'node_modules/@deepseek-ai', name)
    await symlink(await realpath(dependency), join(namespace, name))
  }
  await symlink(
    await realpath(join(project, 'node_modules/semver')),
    join(profile, 'node_modules/semver'),
  )
}
