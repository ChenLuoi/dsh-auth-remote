import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { sourceIdentity, writeAcceptanceIndex } from '../../scripts/packed-artifact.mjs'
import { packageManifest, project, testedDshVersions } from '../../scripts/runtime.mjs'
import {
  requiredBrowserTestNames,
  sha256,
  suites,
  testCounts,
} from '../../scripts/verify-packed.mjs'
import {
  assertMaintenanceCounts,
  requiredTestNames,
} from '../../scripts/verify-maintenance-retired.mjs'

const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n'
const tap = (names: string[]) =>
  'TAP version 13\n' +
  names.map((name, index) => `# Subtest: ${name}\nok ${index + 1} - ${name}\n`).join('') +
  `# tests ${names.length}\n# pass ${names.length}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`

test('source identities include untracked bytes, executable modes, symlink targets and tracked deletions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'packed-source-'))
  const git = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
  try {
    git(['init', '-q'])
    await writeFile(join(root, 'tracked.txt'), 'tracked')
    git(['add', 'tracked.txt'])
    git([
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'fixture',
    ])
    const original = await sourceIdentity(root)
    await writeFile(join(root, 'untracked.js'), 'first')
    await symlink('../unreadable-target', join(root, 'link'))
    const added = await sourceIdentity(root)
    assert.deepEqual(added.untracked, ['link', 'untracked.js'])
    assert.equal(added.files.link.type, 'symlink')
    assert.equal(added.files.link.sha256, sha256(Buffer.from('../unreadable-target')))
    await writeFile(join(root, 'untracked.js'), 'second')
    await chmod(join(root, 'tracked.txt'), 0o755)
    const changed = await sourceIdentity(root)
    assert.notEqual(changed.files['untracked.js'].sha256, added.files['untracked.js'].sha256)
    assert.equal(changed.files['tracked.txt'].mode, 0o755)
    assert.notEqual(changed.diffSha256, original.diffSha256)
    await rm(join(root, 'tracked.txt'))
    assert.deepEqual((await sourceIdentity(root)).deleted, ['tracked.txt'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function evidenceFixture(plan: string) {
  const root = await mkdtemp(join(tmpdir(), 'packed-evidence-'))
  const packageRoot = join(root, 'package')
  await mkdir(join(packageRoot, 'dist/types'), { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), json(packageManifest))
  for (const file of [
    'index.js',
    'cli.js',
    'client.js',
    'login.js',
    'login.css',
    'types/index.d.ts',
  ])
    await writeFile(join(packageRoot, 'dist', file), 'archive fixture')
  const archive = join(root, `dsh-auth-remote-${packageManifest.version}.tgz`)
  const packed = spawnSync('tar', ['-czf', archive, '-C', root, 'package'], { encoding: 'utf8' })
  assert.equal(packed.status, 0, packed.stderr)
  const digest = sha256(await readFile(archive))
  await writeFile(join(root, 'SHA256SUMS'), `${digest}  ${basename(archive)}\n`)
  const producer = {
    kind: 'packed-producer',
    id: randomUUID(),
    archive: basename(archive),
    sha256: digest,
    package: `${packageManifest.name}@${packageManifest.version}`,
    source: await sourceIdentity(),
    node: process.version,
    pnpm: packageManifest.packageManager.split('@').at(-1),
  }
  const producerPath = join(root, 'producer.json')
  await writeFile(producerPath, json(producer))
  const producerSha = sha256(await readFile(producerPath))
  const reports = join(root, 'reports')
  await mkdir(reports)
  const primary: string[] = []
  const emit = async (version: string, report: any) => {
    const path = join(reports, `report-${randomUUID()}.json`)
    Object.assign(report, {
      package: producer.package,
      sha256: digest,
      dsh: version,
      node: process.version,
      status: 'passed',
      commands: [{ command: 'fixture', args: [version] }],
    })
    await writeFile(path, json(report))
    const directory = path.replace(/\.json$/u, '-runtimes')
    await mkdir(directory)
    const roles = [{ role: 'primary', dsh: version }]
    if (report.suites?.some((suite: any) => suite.name === 'smoke'))
      roles.push({ role: 'smoke', dsh: version })
    if (report.suites?.some((suite: any) => suite.name === 'browser')) {
      const previous = testedDshVersions[testedDshVersions.indexOf(version) - 1]
      if (previous) roles.push({ role: 'previous-host', dsh: previous })
      if (version === '0.2.2-rc.2')
        roles.push(...Array.from({ length: 2 }, () => ({ role: 'private-account', dsh: version })))
    }
    const runtimes = []
    for (const { role, dsh } of roles) {
      const receiptName = `runtime-${randomUUID()}.json`
      const packages = Object.fromEntries(
        [
          'dsh',
          'dsh-web-app',
          'dsh-host-webserver',
          'dsh-client-connection',
          'cordis',
          'schemastery',
          'cordis-plugin-loader',
          'cordis-plugin-include',
        ].map((name) => [
          '@deepseek-ai/' + name,
          {
            path: '/fixture/' + name,
            version: name.startsWith('dsh') ? dsh : '4.0.5',
            sha256: '1'.repeat(64),
            nlink: 1,
          },
        ]),
      )
      const receipt = {
        kind: 'packed-runtime-identity',
        archiveSha256: digest,
        producerSha256: producerSha,
        primaryDsh: version,
        role,
        dsh,
        binary: '/fixture/' + randomUUID() + '/node_modules/.bin/dsh',
        node: process.version,
        pnpm: producer.pnpm,
        lockSha256: '2'.repeat(64),
        copy: true,
        privateFiles: 1,
        packages,
      }
      await writeFile(join(directory, receiptName), json(receipt))
      runtimes.push({
        file: receiptName,
        sha256: sha256(await readFile(join(directory, receiptName))),
      })
    }
    const logPaths =
      report.kind === 'maintenance-retirement'
        ? [report.log]
        : (report.suites ?? []).flatMap((suite: any) =>
            suite.name === 'smoke'
              ? ['dev-prepare.mjs', 'dev-install.mjs', 'smoke.mjs'].map(
                  (script) => suite.log + '-' + script,
                )
              : [suite.log],
          )
    const logs = await Promise.all(
      logPaths.map(async (path: string) => ({
        file: basename(path),
        sha256: sha256(await readFile(path)),
      })),
    )
    await writeFile(
      path.replace(/\.json$/u, '-evidence.json'),
      json({
        kind: 'packed-consumer-evidence',
        archiveSha256: digest,
        producerSha256: producerSha,
        primaryDsh: version,
        report: { file: basename(path), sha256: sha256(await readFile(path)) },
        runtimes,
        logs,
      }),
    )
    primary.push(path)
  }
  for (const version of testedDshVersions) {
    const selected = []
    for (const name of ['cli', 'browser'] as const) {
      const files = (await readdir(join(project, suites[name].directory)))
        .filter((file) => file.endsWith(suites[name].suffix))
        .sort()
        .map((file) => `${suites[name].directory}/${file}`)
      const text = tap(name === 'browser' ? requiredBrowserTestNames(version) : ['one CLI fixture'])
      const log = join(reports, `${randomUUID()}-${name}.log`)
      await writeFile(log, text)
      selected.push({
        name,
        status: 'passed',
        partial: false,
        pattern: null,
        files,
        log,
        counts: testCounts(text, files),
      })
    }
    const log = join(reports, `${randomUUID()}-smoke.log`)
    for (const script of ['dev-prepare.mjs', 'dev-install.mjs', 'smoke.mjs'])
      await writeFile(log + '-' + script, 'smoke fixture')
    selected.push({ name: 'smoke', status: 'passed', partial: false, log } as any)
    await emit(version, { suites: selected })
  }
  if (plan === 'full') {
    await emit('0.2.1-alpha.2', {
      kind: 'retired-rejection',
      paths: ['install-rollback', 'existing-incompatible-bundle'].map((name) => ({
        name,
        status: 'passed',
        processesStopped: true,
      })),
    })
    if (packageManifest.version === '0.3.6')
      for (const version of ['0.2.1-alpha.3', '0.2.1-alpha.4', '0.2.1-alpha.5']) {
        const log = join(reports, `${randomUUID()}.tap`)
        const text = tap(requiredTestNames(version))
        await writeFile(log, text)
        await emit(version, {
          kind: 'maintenance-retirement',
          log,
          counts: assertMaintenanceCounts(text, version),
          processesStopped: true,
        })
      }
  }
  return {
    root,
    archive,
    digest,
    producerPath,
    reports,
    primary,
    output: join(root, 'acceptance-index.json'),
  }
}

for (const plan of ['ordinary', 'full'])
  test(`acceptance index binds ${plan} producer/runtime/raw reports and refuses missing or mismatched evidence`, async () => {
    const f = await evidenceFixture(plan)
    const run = () => writeAcceptanceIndex(f.archive, f.digest, f.reports, f.output, plan)
    const originals = new Map<string, Buffer>()
    const snapshot = async (directory: string) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) await snapshot(path)
        else originals.set(path, await readFile(path))
      }
    }
    const rewriteReport = async (mutate: (report: any) => void) => {
      const path = f.primary[0]!
      const report = JSON.parse(await readFile(path, 'utf8'))
      mutate(report)
      await writeFile(path, json(report))
      const sidecarPath = path.replace(/\.json$/u, '-evidence.json')
      const sidecar = JSON.parse(await readFile(sidecarPath, 'utf8'))
      sidecar.report.sha256 = sha256(await readFile(path))
      await writeFile(sidecarPath, json(sidecar))
    }
    const omitRuntime = async (role: string, version: string) => {
      const path = f.primary[testedDshVersions.indexOf(version)]!
      const sidecarPath = path.replace(/\.json$/u, '-evidence.json')
      const sidecar = JSON.parse(await readFile(sidecarPath, 'utf8'))
      const directory = path.replace(/\.json$/u, '-runtimes')
      for (const item of sidecar.runtimes) {
        const receiptPath = join(directory, item.file)
        if (JSON.parse(await readFile(receiptPath, 'utf8')).role !== role) continue
        await rm(receiptPath)
        sidecar.runtimes = sidecar.runtimes.filter((runtime: any) => runtime.file !== item.file)
        await writeFile(sidecarPath, json(sidecar))
        return
      }
      assert.fail('fixture is missing the requested runtime role')
    }
    try {
      await snapshot(f.reports)
      originals.set(f.producerPath, await readFile(f.producerPath))
      assert.equal((await run()).status, 'passed')
      const cli = spawnSync(
        process.execPath,
        ['scripts/packed-artifact.mjs', 'index', f.archive, f.digest, f.reports, f.output],
        { cwd: project, encoding: 'utf8', env: { ...process.env, DSH_VERIFY_PLAN: plan } },
      )
      assert.equal(cli.status, 0, cli.stderr)
      assert.doesNotMatch(cli.stderr, /unsettled top-level await/u)
      const mutations = [
        async () => omitRuntime('primary', '0.2.1-rc.1'),
        async () => omitRuntime('smoke', '0.2.1-rc.1'),
        async () => omitRuntime('previous-host', '0.2.2-rc.1'),
        async () => omitRuntime('private-account', '0.2.2-rc.2'),
        async () => rm(f.primary[0]!),
        async () =>
          rewriteReport((report) => {
            report.sha256 = '0'.repeat(64)
          }),
        async () =>
          rewriteReport((report) => {
            report.status = 'cancelled'
          }),
        async () =>
          rewriteReport((report) => {
            report.suites[0].partial = true
          }),
        async () =>
          rewriteReport((report) => {
            report.suites[0].files.pop()
          }),
        async () => {
          const sidecar = f.primary[0]!.replace(/\.json$/u, '-evidence.json')
          const value = JSON.parse(await readFile(sidecar, 'utf8'))
          value.producerSha256 = '0'.repeat(64)
          await writeFile(sidecar, json(value))
        },
        async () => {
          const report = JSON.parse(await readFile(f.primary[0]!, 'utf8'))
          await rm(report.suites[2].log + '-smoke.mjs')
        },
        async () => {
          const report = JSON.parse(await readFile(f.primary[0]!, 'utf8'))
          await appendBad(report.suites[0].log)
        },
        async () => {
          const producer = JSON.parse(await readFile(f.producerPath, 'utf8'))
          producer.source.head = '0'.repeat(40)
          await writeFile(f.producerPath, json(producer))
        },
        async () => {
          const directory = f.primary[0]!.replace(/\.json$/u, '-runtimes')
          await rm(join(directory, (await readdir(directory))[0]!))
        },
        async () => {
          const directory = f.primary[0]!.replace(/\.json$/u, '-runtimes')
          const path = join(directory, (await readdir(directory))[0]!)
          await writeFile(path, (await readFile(path, 'utf8')) + '\n')
        },
      ]
      for (const mutate of mutations) {
        for (const [path, bytes] of originals) await writeFile(path, bytes)
        await mutate()
        await assert.rejects(run())
        assert.equal(
          JSON.parse(await readFile(f.output, 'utf8')).status,
          'failed',
          'an old passed index survived failed validation',
        )
      }
      for (const [path, bytes] of originals) await writeFile(path, bytes)
      if (plan === 'full')
        await assert.rejects(
          writeAcceptanceIndex(f.archive, f.digest, f.reports, f.output, 'ordinary'),
          /Unexpected acceptance target/u,
        )
      const victim = join(f.root, 'victim')
      await writeFile(victim, 'must survive')
      await rm(f.output)
      await symlink(victim, f.output)
      assert.equal((await run()).status, 'passed')
      assert.equal(await readFile(victim, 'utf8'), 'must survive')
      assert.equal((await lstat(f.output)).isSymbolicLink(), false)
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  })

async function appendBad(path: string) {
  await writeFile(path, (await readFile(path, 'utf8')) + '\n# changed raw evidence\n')
}

test('a validated plugin0.3.7 archive disables full-plan maintenance retirement without preparing a runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'packed-future-gate-'))
  try {
    const checkout = join(root, 'checkout')
    const packageRoot = join(root, 'package')
    await mkdir(join(checkout, 'scripts'), { recursive: true })
    await mkdir(join(packageRoot, 'dist/types'), { recursive: true })
    const manifest = { ...packageManifest, version: '0.3.7' }
    await writeFile(join(checkout, 'package.json'), json(manifest))
    await writeFile(join(packageRoot, 'package.json'), json(manifest))
    for (const file of [
      'index.js',
      'cli.js',
      'client.js',
      'login.js',
      'login.css',
      'types/index.d.ts',
    ])
      await writeFile(join(packageRoot, 'dist', file), 'fixture')
    for (const file of ['runtime.mjs', 'packed-artifact.mjs', 'verify-packed.mjs'])
      await copyFile(join('scripts', file), join(checkout, 'scripts', file))
    const archive = join(root, 'dsh-auth-remote-0.3.7.tgz')
    const packed = spawnSync('tar', ['-czf', archive, '-C', root, 'package'], { encoding: 'utf8' })
    assert.equal(packed.status, 0, packed.stderr)
    const digest = sha256(await readFile(archive))
    await writeFile(join(root, 'SHA256SUMS'), `${digest}  dsh-auth-remote-0.3.7.tgz\n`)
    const outputs = join(root, 'outputs')
    const gate = spawnSync(
      process.execPath,
      ['scripts/packed-artifact.mjs', 'gate', archive, digest],
      {
        cwd: checkout,
        encoding: 'utf8',
        env: { ...process.env, DSH_VERIFY_PLAN: 'full', GITHUB_OUTPUT: outputs },
      },
    )
    assert.equal(gate.status, 0, gate.stderr)
    assert.equal(await readFile(outputs, 'utf8'), 'maintenance-retirement-required=false\n')
    await assert.rejects(lstat(join(checkout, '.cache')), { code: 'ENOENT' })
    await writeFile(join(checkout, '.cache'), 'blocked preparation')
    const consumer = spawnSync(
      process.execPath,
      [
        'scripts/verify-packed.mjs',
        '--archive',
        archive,
        '--sha256',
        digest,
        '--dsh-version',
        '0.2.2-rc.2',
        '--suite',
        'cli',
      ],
      { cwd: checkout, encoding: 'utf8' },
    )
    assert.equal(consumer.status, 1, consumer.stderr)
    assert.match(consumer.stderr, /ENOTDIR|EEXIST|real local directory/u)
    assert.doesNotMatch(consumer.stderr, /unsettled top-level await/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
