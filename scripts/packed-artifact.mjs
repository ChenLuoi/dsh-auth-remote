import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  appendFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  archive,
  checkDshVersion,
  packageManifest,
  project,
  requireRealDirectory,
  testedDshVersions,
} from './runtime.mjs'
import {
  assertRegisteredCoverage,
  sha256,
  suites,
  testCounts,
  validateArchive,
} from './verify-packed.mjs'

async function writeJsonArtifact(path, value) {
  await requireRealDirectory(dirname(resolve(path)))
  const temporary = join(dirname(path), `.${basename(path)}-${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

export function maintenanceRetirementRequired(version, plan) {
  assert(['full', 'ordinary'].includes(plan), 'Unknown verification plan')
  assert.equal(typeof version, 'string', 'Missing validated package version')
  return version === '0.3.6' && plan === 'full'
}

function git(directory, args) {
  const result = spawnSync('git', args, { cwd: directory, maxBuffer: 32 * 1024 * 1024 })
  if (result.error) throw result.error
  assert.equal(result.status, 0, result.stderr.toString())
  return result.stdout
}

export async function sourceIdentity(directory = project) {
  await requireRealDirectory(directory)
  const tracked = git(directory, ['ls-files', '-c', '-z']).toString().split('\0').filter(Boolean)
  const untracked = git(directory, ['ls-files', '-o', '--exclude-standard', '-z'])
    .toString()
    .split('\0')
    .filter(Boolean)
    .sort()
  const files = {}
  const deleted = []
  for (const path of [...new Set([...tracked, ...untracked])].sort()) {
    let entry
    try {
      entry = await lstat(join(directory, path))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      deleted.push(path)
      continue
    }
    assert(entry.isFile() || entry.isSymbolicLink(), `Unsupported source input: ${path}`)
    const bytes = entry.isSymbolicLink()
      ? Buffer.from(await readlink(join(directory, path)))
      : await readFile(join(directory, path))
    files[path] = {
      type: entry.isSymbolicLink() ? 'symlink' : 'file',
      mode: entry.mode & 0o777,
      sha256: sha256(bytes),
    }
  }
  return {
    head: git(directory, ['rev-parse', 'HEAD']).toString().trim(),
    diffSha256: sha256(git(directory, ['diff', '--binary', 'HEAD'])),
    untracked,
    deleted,
    files,
  }
}

export async function checkProducerIdentity(path, digest) {
  const identity = await checkPackedArtifact(path, digest)
  const bytes = await readFile(join(dirname(path), 'producer.json'))
  const producer = JSON.parse(bytes)
  assert.equal(producer.kind, 'packed-producer')
  assert.equal(producer.archive, identity.archive)
  assert.equal(producer.sha256, identity.sha256)
  assert.equal(producer.package, `${packageManifest.name}@${packageManifest.version}`)
  assert.match(producer.node, /^v24\./u, 'Producer must use Node 24')
  assert.equal(producer.pnpm, packageManifest.packageManager.split('@').at(-1))
  assert.deepEqual(
    await sourceIdentity(),
    producer.source,
    'Producer source identity differs from the checkout',
  )
  return { producer, sha256: sha256(bytes) }
}

/** The parent owns this real directory; nested runtime preparation only appends receipts. */
export async function createRuntimeReceipts(reportPath, archivePath, digest, primaryDsh) {
  await requireRealDirectory(dirname(reportPath))
  const directory = reportPath.replace(/\.json$/u, '-runtimes')
  assert.notEqual(directory, reportPath)
  assert(
    directory.startsWith(join(project, '.cache') + '/'),
    'Runtime receipts must stay in verification cache',
  )
  await mkdir(directory)
  await requireRealDirectory(directory)
  let producerSha256 = null
  try {
    producerSha256 = sha256(await readFile(join(dirname(archivePath), 'producer.json')))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  return {
    directory,
    archiveSha256: digest,
    producerSha256,
    primaryDsh,
    env: {
      DSH_ACCEPTANCE_RUNTIME_DIR: directory,
      DSH_ACCEPTANCE_ARCHIVE_SHA256: digest,
      DSH_ACCEPTANCE_PRODUCER_SHA256: producerSha256 ?? 'none',
      DSH_ACCEPTANCE_PRIMARY_DSH: primaryDsh,
    },
  }
}

export async function recordRuntimeIdentity(runtime, version, context, role = 'primary') {
  await requireRealDirectory(runtime)
  await requireRealDirectory(context.directory)
  assert(
    context.directory.startsWith(join(project, '.cache') + '/'),
    'Runtime receipts must stay in verification cache',
  )
  assert.match(basename(context.directory), /^report-[a-f0-9-]{36}-runtimes$/u)
  assert.match(context.archiveSha256, /^[a-f0-9]{64}$/u)
  if (context.producerSha256 !== null) assert.match(context.producerSha256, /^[a-f0-9]{64}$/u)
  assert(['primary', 'prepared', 'smoke', 'private-account', 'previous-host'].includes(role))
  assert.equal(typeof context.primaryDsh, 'string')
  if (role === 'previous-host') assert.notEqual(version, context.primaryDsh)
  else assert.equal(version, context.primaryDsh)
  const binary = join(runtime, 'node_modules/.bin/dsh')
  checkDshVersion(binary, version)
  assert.match(process.version, /^v24\./u)
  const pnpm = spawnSync('pnpm', ['--version'], { encoding: 'utf8' })
  assert.equal(pnpm.status, 0, pnpm.stderr)
  assert.equal(pnpm.stdout.trim(), packageManifest.packageManager.split('@').at(-1))
  const root = createRequire(join(runtime, 'package.json'))
  const hostPath = root.resolve('@deepseek-ai/dsh/package.json')
  const host = createRequire(hostPath)
  const webPath = host.resolve('@deepseek-ai/dsh-web-app/package.json')
  const web = createRequire(webPath)
  const cordisPath = web.resolve('@deepseek-ai/cordis/package.json')
  const cordis = createRequire(cordisPath)
  const paths = {
    '@deepseek-ai/dsh': hostPath,
    '@deepseek-ai/dsh-web-app': webPath,
    '@deepseek-ai/cordis': cordisPath,
    ...Object.fromEntries(
      [
        '@deepseek-ai/dsh-host-webserver',
        '@deepseek-ai/dsh-client-connection',
        '@deepseek-ai/schemastery',
      ].map((name) => [name, web.resolve(name + '/package.json')]),
    ),
    ...Object.fromEntries(
      ['@deepseek-ai/cordis-plugin-loader', '@deepseek-ai/cordis-plugin-include'].map((name) => [
        name,
        cordis.resolve(name + '/package.json'),
      ]),
    ),
  }
  const packages = {}
  for (const [name, path] of Object.entries(paths)) {
    assert(
      path.startsWith(runtime + '/'),
      `Runtime package resolves outside its isolated directory: ${path}`,
    )
    const bytes = await readFile(path)
    const manifest = JSON.parse(bytes)
    assert.equal(manifest.name, name)
    if (name.startsWith('@deepseek-ai/dsh'))
      assert.equal(manifest.version, version, 'Runtime resolved a different native release')
    const entry = await lstat(path)
    assert.equal(entry.nlink, 1, `Runtime package is not a private copy: ${path}`)
    packages[name] = { path, version: manifest.version, sha256: sha256(bytes), nlink: entry.nlink }
  }
  const receipt = {
    kind: 'packed-runtime-identity',
    archiveSha256: context.archiveSha256,
    producerSha256: context.producerSha256,
    primaryDsh: context.primaryDsh,
    role,
    dsh: version,
    binary,
    node: process.version,
    pnpm: pnpm.stdout.trim(),
    lockSha256: sha256(await readFile(join(runtime, 'pnpm-lock.yaml'))),
    packages,
  }
  let privateFiles = 0
  async function checkCopies(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await checkCopies(path)
      else if (entry.isFile()) {
        assert.equal((await lstat(path)).nlink, 1, `Shared runtime file: ${path}`)
        privateFiles++
      }
    }
  }
  await checkCopies(join(runtime, 'node_modules'))
  Object.assign(receipt, { privateFiles, copy: true })
  const path = join(context.directory, `runtime-${randomUUID()}.json`)
  await writeFile(path, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' })
  return receipt
}

export async function writeConsumerEvidence(reportPath, context) {
  const reportBytes = await readFile(reportPath)
  const report = JSON.parse(reportBytes)
  const logPaths =
    report.kind === 'maintenance-retirement'
      ? [report.log]
      : (report.suites ?? []).flatMap((suite) =>
          suite.name === 'smoke'
            ? ['dev-prepare.mjs', 'dev-install.mjs', 'smoke.mjs'].map(
                (script) => suite.log + '-' + script,
              )
            : [suite.log],
        )
  const logs = []
  for (const path of logPaths) {
    assert.equal(
      dirname(resolve(path)),
      dirname(resolve(reportPath)),
      'Raw logs must belong to this report directory',
    )
    try {
      logs.push({ file: basename(path), sha256: sha256(await readFile(path)) })
    } catch (error) {
      if (error.code !== 'ENOENT' || report.status === 'passed') throw error
      logs.push({ file: basename(path), missing: true })
    }
  }
  const runtimes = []
  for (const name of (await readdir(context.directory)).sort()) {
    assert.match(name, /^runtime-[a-f0-9-]{36}\.json$/u)
    const path = join(context.directory, name)
    const entry = await lstat(path)
    assert(entry.isFile() && !entry.isSymbolicLink(), 'Runtime receipt must be a regular file')
    const bytes = await readFile(path)
    const receipt = JSON.parse(bytes)
    assert.equal(receipt.archiveSha256, context.archiveSha256)
    assert.equal(receipt.producerSha256, context.producerSha256)
    assert.equal(receipt.primaryDsh, context.primaryDsh)
    runtimes.push({ file: name, sha256: sha256(bytes) })
  }
  const sidecar = {
    kind: 'packed-consumer-evidence',
    archiveSha256: context.archiveSha256,
    producerSha256: context.producerSha256,
    primaryDsh: context.primaryDsh,
    report: { file: basename(reportPath), sha256: sha256(reportBytes) },
    runtimes,
    logs,
  }
  await writeFile(
    reportPath.replace(/\.json$/u, '-evidence.json'),
    JSON.stringify(sidecar, null, 2) + '\n',
  )
}

export function fullVerificationPlan() {
  return {
    kind: 'full',
    versions: [...testedDshVersions],
    browser: { include: testedDshVersions.map((dsh) => ({ dsh, suite: 'browser' })) },
  }
}

export function ordinaryVerificationPlan() {
  return {
    kind: 'ordinary',
    versions: [...testedDshVersions],
    browser: { include: testedDshVersions.map((dsh) => ({ dsh, suite: 'browser' })) },
  }
}

export function validateVerificationPlan(kind, versions, browser) {
  assert(['full', 'ordinary'].includes(kind), 'Unknown verification plan')
  const expected = kind === 'full' ? fullVerificationPlan() : ordinaryVerificationPlan()
  assert.deepEqual(
    versions,
    expected.versions,
    'CLI/smoke matrix must include every exact target once',
  )
  assert.deepEqual(
    browser,
    expected.browser,
    kind === 'full'
      ? 'Full browser matrix must include every exact target once'
      : 'Ordinary browser matrix must match every fixed boundary selection',
  )
  return expected
}

export async function checkPackedArtifact(path, expectedHash) {
  const expectedName = `${packageManifest.name}-${packageManifest.version}.tgz`
  assert.equal(basename(path), expectedName, 'Unexpected artifact filename')
  const bytes = await readFile(path)
  const { manifest } = validateArchive(bytes, expectedHash, testedDshVersions.at(-1))
  const declared = Object.entries(manifest.dsh.compatibility.dshReleases)
    .filter(([, state]) => state === 'compatible')
    .map(([version]) => version)
  assert.deepEqual(
    declared,
    testedDshVersions,
    'Archive declarations and verification targets differ',
  )
  assert.equal(
    await readFile(join(dirname(path), 'SHA256SUMS'), 'utf8'),
    `${expectedHash}  ${expectedName}\n`,
    'Checksum file differs from the producer identity',
  )
  return { archive: expectedName, sha256: expectedHash }
}

export async function writeAcceptanceIndex(path, digest, reportRoot, output, plan) {
  const outputRelative = relative(project, resolve(output))
  if (!outputRelative.startsWith('../')) {
    const ignored = spawnSync('git', ['check-ignore', '--quiet', outputRelative], { cwd: project })
    assert.equal(ignored.status, 0, 'Acceptance index must stay outside source inputs')
  }
  // A failed rebuild must not leave an older successful index at this output path.
  await writeJsonArtifact(output, {
    kind: 'packed-acceptance-index',
    status: 'failed',
    archive: basename(path),
    sha256: digest,
    plan,
  })
  maintenanceRetirementRequired(packageManifest.version, plan)
  const { producer, sha256: producerSha256 } = await checkProducerIdentity(path, digest)
  await requireRealDirectory(resolve(reportRoot))
  const all = []
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name)
      assert(!entry.isSymbolicLink(), 'Evidence must not contain symlinks')
      if (entry.isDirectory()) await visit(file)
      else {
        assert(entry.isFile(), 'Evidence must contain ordinary files')
        all.push(file)
      }
    }
  }
  await visit(resolve(reportRoot))
  const json = []
  for (const file of all.filter((file) => file.endsWith('.json'))) {
    const bytes = await readFile(file)
    json.push({ file, bytes, value: JSON.parse(bytes) })
  }
  const used = new Set()
  const required = new Set(
    testedDshVersions.flatMap((version) =>
      ['cli', 'browser', 'smoke'].map((suite) => `${version}:${suite}`),
    ),
  )
  if (plan === 'full') required.add('0.2.1-alpha.2:retired-rejection')
  if (maintenanceRetirementRequired(packageManifest.version, plan))
    for (const version of ['0.2.1-alpha.3', '0.2.1-alpha.4', '0.2.1-alpha.5'])
      required.add(`${version}:maintenance-retirement`)
  const covered = new Set()
  const cover = (key) => {
    assert(required.has(key), `Unexpected acceptance target: ${key}`)
    assert(!covered.has(key), `Duplicate acceptance target: ${key}`)
    covered.add(key)
  }
  const local = (parent, name) => {
    const file = basename(name)
    assert(file && !['.', '..'].includes(file), 'Invalid evidence filename')
    return join(dirname(parent), file)
  }
  const raw = async (file) => {
    assert(all.includes(file), `Missing raw evidence: ${file}`)
    used.add(file)
    return readFile(file)
  }
  const records = []
  for (const entry of json) {
    const report = entry.value
    if (['packed-runtime-identity', 'packed-consumer-evidence'].includes(report.kind)) continue
    assert(
      report.kind === 'retired-rejection' ||
        report.kind === 'maintenance-retirement' ||
        (!report.kind && Array.isArray(report.suites)),
      'Unknown consumer report',
    )
    assert.equal(report.status, 'passed', 'Consumer did not pass')
    assert.equal(report.sha256, digest, 'Consumer archive digest differs')
    assert.equal(report.package, `${packageManifest.name}@${packageManifest.version}`)
    assert.match(report.node, /^v24\./u)
    assert(
      Array.isArray(report.commands) && report.commands.length > 0,
      'Consumer command evidence is missing',
    )
    used.add(entry.file)
    const sidecarPath = entry.file.replace(/\.json$/u, '-evidence.json')
    const sidecar = JSON.parse(await raw(sidecarPath))
    assert.equal(sidecar.kind, 'packed-consumer-evidence')
    assert.equal(sidecar.archiveSha256, digest)
    assert.equal(sidecar.producerSha256, producerSha256, 'Consumer belongs to a different producer')
    assert.equal(sidecar.primaryDsh, report.dsh)
    assert.deepEqual(
      sidecar.report,
      { file: basename(entry.file), sha256: sha256(entry.bytes) },
      'Raw report digest differs',
    )
    const logHashes = new Map(sidecar.logs.map((log) => [log.file, log.sha256]))
    assert.equal(logHashes.size, sidecar.logs.length, 'Duplicate raw-log identity')
    const rawLog = async (file) => {
      const bytes = await raw(file)
      assert.equal(sha256(bytes), logHashes.get(basename(file)), 'Raw log digest differs')
      logHashes.delete(basename(file))
      return bytes
    }
    const runtimes = []
    for (const item of sidecar.runtimes) {
      assert.match(item.file, /^runtime-[a-f0-9-]{36}\.json$/u)
      const receiptPath = join(entry.file.replace(/\.json$/u, '-runtimes'), item.file)
      const bytes = await raw(receiptPath)
      assert.equal(sha256(bytes), item.sha256, 'Runtime receipt digest differs')
      const receipt = JSON.parse(bytes)
      assert.equal(receipt.kind, 'packed-runtime-identity')
      assert.equal(receipt.archiveSha256, digest)
      assert.equal(receipt.producerSha256, producerSha256)
      assert.equal(receipt.primaryDsh, report.dsh)
      assert(
        ['primary', 'prepared', 'smoke', 'private-account', 'previous-host'].includes(receipt.role),
      )
      assert.equal(typeof receipt.binary, 'string')
      if (receipt.role === 'previous-host') assert.notEqual(receipt.dsh, report.dsh)
      else assert.equal(receipt.dsh, report.dsh)
      assert.match(receipt.node, /^v24\./u)
      assert.equal(receipt.pnpm, producer.pnpm)
      assert.equal(receipt.copy, true)
      assert(Number.isInteger(receipt.privateFiles) && receipt.privateFiles > 0)
      assert.match(receipt.lockSha256, /^[a-f0-9]{64}$/u)
      for (const name of [
        '@deepseek-ai/dsh',
        '@deepseek-ai/dsh-web-app',
        '@deepseek-ai/dsh-host-webserver',
        '@deepseek-ai/dsh-client-connection',
        '@deepseek-ai/cordis',
        '@deepseek-ai/schemastery',
        '@deepseek-ai/cordis-plugin-loader',
        '@deepseek-ai/cordis-plugin-include',
      ]) {
        const manifest = receipt.packages[name]
        assert(manifest, `Missing actual SDK identity: ${name}`)
        assert.match(manifest.sha256, /^[a-f0-9]{64}$/u)
        assert.equal(manifest.nlink, 1)
        if (name.startsWith('@deepseek-ai/dsh')) assert.equal(manifest.version, receipt.dsh)
      }
      runtimes.push({
        path: relative(resolve(reportRoot), receiptPath),
        sha256: item.sha256,
        ...receipt,
      })
    }
    const primary = runtimes.find((runtime) => runtime.role === 'primary')
    assert(primary, 'Missing primary runtime identity')
    const nested = (role, version) =>
      new Set(
        runtimes
          .filter((runtime) => runtime.role === role && runtime.dsh === version)
          .map((runtime) => runtime.binary)
          .filter((binary) => binary !== primary.binary),
      ).size
    const logs = []
    if (report.kind === 'retired-rejection') {
      assert.deepEqual(
        report.paths.map((result) => result.name),
        ['install-rollback', 'existing-incompatible-bundle'],
      )
      for (const result of report.paths) {
        assert.equal(result.status, 'passed')
        assert.equal(result.processesStopped, true)
      }
      cover(`${report.dsh}:retired-rejection`)
    } else if (report.kind === 'maintenance-retirement') {
      assert.equal(report.processesStopped, true)
      const { assertMaintenanceCounts } = await import('./verify-maintenance-retired.mjs')
      const file = local(entry.file, report.log)
      const bytes = await rawLog(file)
      assert.deepEqual(assertMaintenanceCounts(bytes.toString(), report.dsh), report.counts)
      logs.push({ path: relative(resolve(reportRoot), file), sha256: sha256(bytes) })
      cover(`${report.dsh}:maintenance-retirement`)
    } else {
      for (const suite of report.suites) {
        assert.equal(suite.status, 'passed')
        assert.equal(suite.partial, false, 'Partial suites cannot certify complete acceptance')
        if (suite.name === 'smoke') {
          assert(nested('smoke', report.dsh) >= 1, 'Missing smoke runtime identity')
          for (const script of ['dev-prepare.mjs', 'dev-install.mjs', 'smoke.mjs']) {
            const file = local(entry.file, suite.log + '-' + script)
            const bytes = await rawLog(file)
            logs.push({ path: relative(resolve(reportRoot), file), sha256: sha256(bytes) })
          }
        } else {
          assert(
            ['cli', 'browser'].includes(suite.name),
            'Acceptance requires complete CLI/browser suites',
          )
          const definition = suites[suite.name]
          if (suite.name === 'browser') {
            const previous = testedDshVersions[testedDshVersions.indexOf(report.dsh) - 1]
            if (previous)
              assert(
                nested('previous-host', previous) >= 1,
                'Missing previous-host runtime identity',
              )
            if (report.dsh === '0.2.2-rc.2')
              assert(
                nested('private-account', report.dsh) >= 2,
                'Missing private-account runtime identities',
              )
          }
          const selected = (await readdir(join(project, definition.directory)))
            .filter((file) => file.endsWith(definition.suffix))
            .sort()
            .map((file) => `${definition.directory}/${file}`)
          assert.deepEqual(suite.files, selected, 'Incomplete suite file selection')
          assert.equal(suite.pattern, null, 'Complete suites cannot filter test names')
          const file = local(entry.file, suite.log)
          const bytes = await rawLog(file)
          const counts = testCounts(bytes.toString(), suite.files)
          assertRegisteredCoverage(suite.name, report.dsh, counts)
          assert.deepEqual(counts, suite.counts)
          logs.push({ path: relative(resolve(reportRoot), file), sha256: sha256(bytes) })
        }
        cover(`${report.dsh}:${suite.name}`)
      }
    }
    assert.equal(logHashes.size, 0, 'Unreferenced raw-log identity')
    records.push({
      path: relative(resolve(reportRoot), entry.file),
      sha256: sha256(entry.bytes),
      kind: report.kind ?? 'positive',
      dsh: report.dsh,
      commands: report.commands,
      logs,
      runtimes,
    })
  }
  assert.deepEqual(
    [...covered].sort(),
    [...required].sort(),
    'Acceptance is missing required reports',
  )
  for (const entry of json)
    assert(used.has(entry.file), 'Unlinked evidence cannot certify this producer')
  const index = {
    kind: 'packed-acceptance-index',
    status: 'passed',
    plan,
    package: producer.package,
    archive: producer.archive,
    sha256: digest,
    producerSha256,
    producer,
    coverage: [...covered].sort(),
    reports: records,
  }
  await writeJsonArtifact(output, index)
  console.log(`Acceptance index: ${output}`)
  return index
}

export async function recordPackedArtifact() {
  const digest = sha256(await readFile(archive))
  await writeFile(join(dirname(archive), 'SHA256SUMS'), `${digest}  ${basename(archive)}\n`)
  const identity = await checkPackedArtifact(archive, digest)
  const source = await sourceIdentity()
  const pnpm = spawnSync('pnpm', ['--version'], { encoding: 'utf8' })
  assert.equal(pnpm.status, 0, pnpm.stderr)
  assert.equal(pnpm.stdout.trim(), packageManifest.packageManager.split('@').at(-1))
  assert.match(process.version, /^v24\./u)
  const producer = {
    kind: 'packed-producer',
    id: randomUUID(),
    ...identity,
    package: `${packageManifest.name}@${packageManifest.version}`,
    source,
    node: process.version,
    pnpm: pnpm.stdout.trim(),
    github: Object.fromEntries(
      ['GITHUB_EVENT_NAME', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_REF', 'GITHUB_SHA']
        .filter((key) => process.env[key])
        .map((key) => [key, process.env[key]]),
    ),
  }
  assert.deepEqual(await sourceIdentity(), source, 'Source changed while recording the producer')
  await writeJsonArtifact(join(dirname(archive), 'producer.json'), producer)
  const plan = fullVerificationPlan()
  const outputs = {
    ...identity,
    versions: JSON.stringify(plan.versions),
    'browser-matrix': JSON.stringify(plan.browser),
  }
  if (process.env.GITHUB_OUTPUT)
    await appendFile(
      process.env.GITHUB_OUTPUT,
      Object.entries(outputs)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(''),
    )
  console.log(JSON.stringify(outputs))
  return outputs
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'record' && args.length === 0) await recordPackedArtifact()
  else if (command === 'check' && args.length === 2) await checkPackedArtifact(args[0], args[1])
  else if (command === 'producer-check' && args.length === 2)
    await checkProducerIdentity(args[0], args[1])
  else if (command === 'gate' && args.length === 2) {
    await checkPackedArtifact(args[0], args[1])
    const { manifest } = validateArchive(await readFile(args[0]), args[1], testedDshVersions.at(-1))
    const required = maintenanceRetirementRequired(manifest.version, process.env.DSH_VERIFY_PLAN)
    if (process.env.GITHUB_OUTPUT)
      await appendFile(process.env.GITHUB_OUTPUT, `maintenance-retirement-required=${required}\n`)
    console.log(`maintenance-retirement-required=${required}`)
  } else if (command === 'index' && args.length === 4)
    await writeAcceptanceIndex(args[0], args[1], args[2], args[3], process.env.DSH_VERIFY_PLAN)
  else if (command === 'plan' && args.length === 0)
    validateVerificationPlan(
      process.env.DSH_VERIFY_PLAN,
      JSON.parse(process.env.DSH_VERSIONS_JSON),
      JSON.parse(process.env.DSH_BROWSER_MATRIX),
    )
  else
    throw new Error(
      'Usage: packed-artifact.mjs record | check/producer-check/gate ARCHIVE SHA256 | index ARCHIVE SHA256 REPORT_ROOT OUTPUT | plan (workflow environment)',
    )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  void main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
