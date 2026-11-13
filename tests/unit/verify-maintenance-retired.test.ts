import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { packageManifest, prepareDshRuntime, testedDshVersions } from '../../scripts/runtime.mjs'
import { sha256 } from '../../scripts/verify-packed.mjs'
import {
  assertInstalledCandidate,
  assertMaintenanceCounts,
  maintenanceRetiredDshVersions,
  parseArguments,
  requiredTestNames,
  validateMaintenanceArchive,
  verifyMaintenanceRetired,
} from '../../scripts/verify-maintenance-retired.mjs'

test('maintenance retirement accepts only the three exact targets and explicit archive identity', () => {
  assert.deepEqual(maintenanceRetiredDshVersions, [
    '0.2.1-alpha.3',
    '0.2.1-alpha.4',
    '0.2.1-alpha.5',
  ])
  const args = [
    '--archive',
    '/tmp/dsh-auth-remote-0.3.6.tgz',
    '--sha256',
    'a'.repeat(64),
    '--dsh-version',
    '0.2.1-alpha.3',
  ]
  for (const version of maintenanceRetiredDshVersions)
    assert.equal(parseArguments([...args.slice(0, -1), version])['dsh-version'], version)
  for (const version of [...testedDshVersions, '0.2.1-alpha.2', '0.2.2-alpha.2', 'invalid'])
    assert.throws(
      () => parseArguments([...args.slice(0, -1), version]),
      /exact maintenance-retired/u,
    )
  assert.throws(() => parseArguments([...args, '--suite', 'browser']), /Unknown option/u)
  assert.throws(() => parseArguments([...args, '--sha256', 'b'.repeat(64)]), /Duplicate/u)
  assert.throws(() => parseArguments(args.slice(0, -1)), /Missing value/u)
  assert.throws(
    () => parseArguments(args.map((v) => (v === 'a'.repeat(64) ? 'WRONG' : v))),
    /lowercase SHA-256/u,
  )
})

test('maintenance retirement rejects bad archives and declarations before preparing any old runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maintenance-archive-'))
  try {
    const packageRoot = join(root, 'package')
    await mkdir(join(packageRoot, 'dist/types'), { recursive: true })
    for (const path of [
      'index.js',
      'cli.js',
      'client.js',
      'login.js',
      'login.css',
      'types/index.d.ts',
    ])
      await writeFile(join(packageRoot, 'dist', path), 'fixture')
    const archive = join(root, 'dsh-auth-remote-0.3.6.tgz')
    const pack = async (manifest: unknown) => {
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify(manifest))
      const run = spawnSync('tar', ['-czf', archive, '-C', root, 'package'], { encoding: 'utf8' })
      assert.equal(run.status, 0, run.stderr)
      const bytes = await readFile(archive)
      await writeFile(join(root, 'SHA256SUMS'), sha256(bytes) + '  dsh-auth-remote-0.3.6.tgz\n')
      return bytes
    }
    const valid = await pack(packageManifest)
    if (packageManifest.version !== '0.3.6') {
      for (const version of maintenanceRetiredDshVersions)
        assert.throws(
          () => validateMaintenanceArchive(valid, sha256(valid), version),
          /only to plugin 0.3.6/u,
        )
      return
    }
    for (const version of maintenanceRetiredDshVersions)
      assert.equal(
        validateMaintenanceArchive(valid, sha256(valid), version).manifest.version,
        '0.3.6',
      )
    const options = { archive, sha256: '0'.repeat(64), 'dsh-version': '0.2.1-alpha.3' }
    await assert.rejects(verifyMaintenanceRetired(options), /SHA-256 mismatch/u)
    await writeFile(join(root, 'SHA256SUMS'), 'wrong\n')
    await assert.rejects(
      verifyMaintenanceRetired({ ...options, sha256: sha256(valid) }),
      /Checksum file/u,
    )
    const narrowed = structuredClone(packageManifest)
    delete narrowed.dsh.compatibility.dshReleases['0.2.1-rc.1']
    const partial = await pack(narrowed)
    assert.throws(
      () => validateMaintenanceArchive(partial, sha256(partial), '0.2.1-alpha.3'),
      /declarations and verification targets differ/u,
    )
    const declared = structuredClone(packageManifest)
    Object.assign(declared.dsh.compatibility.dshReleases, { '0.2.1-alpha.3': 'untested' })
    const unexpected = await pack(declared)
    assert.throws(
      () => validateMaintenanceArchive(unexpected, sha256(unexpected), '0.2.1-alpha.3'),
      /must not be declared/u,
    )
    const wrongVersion = await pack({ ...packageManifest, version: '0.3.7' })
    assert.throws(
      () => validateMaintenanceArchive(wrongVersion, sha256(wrongVersion), '0.2.1-alpha.3'),
      /Wrong archive package version|only to plugin 0.3.6/u,
    )
    const hostile = spawnSync(
      'tar',
      ['-czf', archive, '--transform=s,package,package/../../escape,', '-C', root, 'package'],
      { encoding: 'utf8' },
    )
    assert.equal(hostile.status, 0, hostile.stderr)
    const bytes = await readFile(archive)
    assert.throws(
      () => validateMaintenanceArchive(bytes, sha256(bytes), '0.2.1-alpha.3'),
      /canonical|Escaping/u,
    )
    await pack(packageManifest)
    const checkout = join(root, 'checkout')
    const outside = join(root, 'outside')
    await mkdir(join(checkout, 'scripts'), { recursive: true })
    await mkdir(outside)
    await symlink(outside, join(checkout, '.cache'))
    await writeFile(join(checkout, 'package.json'), JSON.stringify(packageManifest))
    for (const script of [
      'runtime.mjs',
      'packed-artifact.mjs',
      'verify-packed.mjs',
      'verify-retired.mjs',
      'verify-maintenance-retired.mjs',
    ])
      await copyFile(join('scripts', script), join(checkout, 'scripts', script))
    const unsafeParent = spawnSync(
      process.execPath,
      [
        'scripts/verify-maintenance-retired.mjs',
        '--archive',
        archive,
        '--sha256',
        sha256(await readFile(archive)),
        '--dsh-version',
        '0.2.1-alpha.3',
      ],
      { cwd: checkout, encoding: 'utf8' },
    )
    assert.notEqual(unsafeParent.status, 0)
    assert.match(unsafeParent.stderr, /real local directory/u)
    assert.deepEqual(await readdir(outside), [], 'unsafe parent was written before rejection')
    await rm(join(checkout, '.cache'))
    const consumerDirectory = join(checkout, '.cache/verify-maintenance-retired')
    await mkdir(consumerDirectory, { recursive: true })
    await symlink(outside, join(consumerDirectory, 'runtime'))
    const unsafeRuntime = spawnSync(
      process.execPath,
      [
        'scripts/verify-maintenance-retired.mjs',
        '--archive',
        archive,
        '--sha256',
        sha256(await readFile(archive)),
        '--dsh-version',
        '0.2.1-alpha.3',
      ],
      { cwd: checkout, encoding: 'utf8' },
    )
    assert.notEqual(unsafeRuntime.status, 0)
    assert.match(unsafeRuntime.stderr, /real local directory/u)
    assert.deepEqual(
      await readdir(outside),
      [],
      'unsafe runtime parent was written before rejection',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test(
  'runtime preparation cancellation kills an uncooperative detached process group',
  { timeout: 20_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'maintenance-cancel-'))
    const previousPath = process.env.PATH
    const cancellation = new AbortController()
    let preparing: Promise<string> | undefined
    try {
      const bin = join(root, 'bin')
      const pidPath = join(root, 'pid')
      await mkdir(bin)
      await writeFile(
        join(bin, 'pnpm'),
        `#!${process.execPath}\nprocess.on('SIGTERM', () => {});\nrequire('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`,
        { mode: 0o755 },
      )
      process.env.PATH = bin + ':' + previousPath
      preparing = prepareDshRuntime(
        join(root, 'runtime'),
        'cancelled-preparation',
        '0.2.1-alpha.3',
        cancellation.signal,
      )
      void preparing.catch(() => {})
      let pid = 0
      for (let attempt = 0; attempt < 100 && !pid; attempt++) {
        pid = Number(await readFile(pidPath, 'utf8').catch(() => '0'))
        if (!pid) await new Promise((resolve) => setTimeout(resolve, 20))
      }
      assert(pid > 0, 'preparation probe did not start')
      cancellation.abort(new Error('intentional preparation cancellation'))
      await assert.rejects(preparing, /intentional preparation cancellation/u)
      assert.throws(() => process.kill(-pid, 0), { code: 'ESRCH' })
    } finally {
      cancellation.abort()
      await preparing?.catch(() => {})
      process.env.PATH = previousPath
      await rm(root, { recursive: true, force: true })
    }
  },
)

test('maintenance retirement requires three real named scenarios and rejects failed, cancelled, skipped or empty TAP', () => {
  const version = '0.2.1-alpha.3'
  const names = requiredTestNames(version)
  const tap =
    names.map((name, index) => `# Subtest: ${name}\nok ${index + 1} - ${name}\n`).join('') +
    '# tests 3\n# pass 3\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n'
  assert.equal(assertMaintenanceCounts(tap, version).actualTests, 3)
  for (const key of ['fail', 'cancelled', 'skipped', 'todo'])
    assert.throws(
      () => assertMaintenanceCounts(tap.replace(`# ${key} 0`, `# ${key} 1`), version),
      /Unexpected/u,
    )
  for (const name of names)
    assert.throws(
      () => assertMaintenanceCounts(tap.replaceAll(name, 'other test'), version),
      /did not register/u,
    )
  assert.throws(
    () => assertMaintenanceCounts(tap.replace('# tests 3', '# tests 0'), version),
    /zero tests/u,
  )
  assert.throws(
    () => assertMaintenanceCounts(tap.replace('# pass 3', '# pass 2'), version),
    /Not every/u,
  )
  assert.throws(
    () =>
      assertMaintenanceCounts(
        tap.replace('# tests 3', '# tests 4').replace('# pass 3', '# pass 4'),
        version,
      ),
    /exactly three/u,
  )
  assert.throws(() => assertMaintenanceCounts(tap, '0.2.1-alpha.2'), /Unknown maintenance-retired/u)
})

test('maintenance installed-candidate checks reject altered bytes, extra files and shared hardlinks', async () => {
  const home = await mkdtemp(join(tmpdir(), 'maintenance-installed-'))
  const directory = join(home, 'installed')
  try {
    await mkdir(directory)
    const files = new Map([['package.json', Buffer.from('candidate')]])
    await writeFile(join(directory, 'package.json'), 'candidate')
    await assertInstalledCandidate(directory, home, files)
    await writeFile(join(directory, 'package.json'), 'changed')
    await assert.rejects(assertInstalledCandidate(directory, home, files), /differs/u)
    await writeFile(join(directory, 'package.json'), 'candidate')
    await writeFile(join(directory, 'extra'), 'unexpected')
    await assert.rejects(assertInstalledCandidate(directory, home, files), /differs/u)
    await rm(join(directory, 'extra'))
    await link(join(directory, 'package.json'), join(home, 'shared'))
    await assert.rejects(
      assertInstalledCandidate(directory, home, files),
      /Shared package hardlink/u,
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
