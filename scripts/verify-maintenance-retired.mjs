import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  checkPackedArtifact,
  createRuntimeReceipts,
  recordRuntimeIdentity,
  writeConsumerEvidence,
} from './packed-artifact.mjs'
import {
  checkDshVersion,
  packageManifest,
  prepareDshRuntime,
  project,
  requireRealDirectory,
  testedDshVersions,
  stopProcessGroup,
} from './runtime.mjs'
import { sha256, testCounts, validateArchive } from './verify-packed.mjs'
import { installedFiles } from './verify-retired.mjs'

export const maintenanceRetiredDshVersions = ['0.2.1-alpha.3', '0.2.1-alpha.4', '0.2.1-alpha.5']

export function parseArguments(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    assert(['--archive', '--sha256', '--dsh-version'].includes(flag), `Unknown option: ${flag}`)
    assert(value && !value.startsWith('--'), `Missing value for ${flag}`)
    const key = flag.slice(2)
    assert(!Object.hasOwn(options, key), `Duplicate option: ${flag}`)
    options[key] = value
  }
  assert(
    options.archive &&
      options.sha256 &&
      maintenanceRetiredDshVersions.includes(options['dsh-version']),
    'Require archive, sha256 and an exact maintenance-retired dsh-version',
  )
  assert.match(options.sha256, /^[a-f0-9]{64}$/u, 'Expected a lowercase SHA-256')
  return options
}

export function requiredTestNames(version) {
  assert(maintenanceRetiredDshVersions.includes(version), 'Unknown maintenance-retired target')
  return [
    `maintenance-retired DSH ${version} warns before readiness and preserves authenticated HMR`,
    `maintenance-retired DSH ${version} Loader refusal leaves no listener`,
    `maintenance-retired DSH ${version} runtime admission refusal leaves no listener`,
  ]
}

export function assertMaintenanceCounts(output, version) {
  const counts = testCounts(output, ['tests/retirement/maintenance-retirement.test.ts'])
  assert.equal(counts.actualTests, 3, 'Expected exactly three maintenance-retirement scenarios')
  for (const name of requiredTestNames(version))
    assert(
      counts.testNames.includes(name),
      `Required maintenance-retirement test did not register: ${name}`,
    )
  return counts
}

export function validateMaintenanceArchive(bytes, digest, version) {
  assert.equal(
    packageManifest.version,
    '0.3.6',
    'Maintenance retirement applies only to plugin 0.3.6',
  )
  assert(maintenanceRetiredDshVersions.includes(version), 'Unknown maintenance-retired target')
  const candidate = validateArchive(bytes, digest, '0.2.2-rc.2')
  assert.equal(
    candidate.manifest.version,
    '0.3.6',
    'Maintenance retirement applies only to plugin 0.3.6',
  )
  assert.deepEqual(
    Object.entries(candidate.manifest.dsh.compatibility.dshReleases)
      .filter(([, state]) => state === 'compatible')
      .map(([release]) => release),
    testedDshVersions,
    'Archive declarations and verification targets differ',
  )
  assert(
    !Object.hasOwn(candidate.manifest.dsh.compatibility.dshReleases, version),
    'Maintenance-retired target must not be declared',
  )
  return candidate
}

export async function assertInstalledCandidate(directory, home, files) {
  assert.equal(await realpath(directory), directory, 'Installed candidate must use its real path')
  assert(
    directory.startsWith((await realpath(home)) + '/'),
    'Installed candidate must belong to its isolated home',
  )
  assert.deepEqual(
    await installedFiles(directory, true),
    files,
    'Installed candidate differs in file set or bytes',
  )
}

export async function verifyMaintenanceRetired(options) {
  const version = options['dsh-version']
  const archive = resolve(options.archive)
  const entry = await lstat(archive)
  assert(entry.isFile() && !entry.isSymbolicLink(), 'Archive must be a regular local file')
  validateMaintenanceArchive(await readFile(archive), options.sha256, version)
  const identity = await checkPackedArtifact(archive, options.sha256)
  await requireRealDirectory(project)
  await mkdir(join(project, '.cache'), { recursive: true })
  await requireRealDirectory(join(project, '.cache'))
  const directory = join(project, '.cache/verify-maintenance-retired')
  await mkdir(directory, { recursive: true })
  await requireRealDirectory(directory)
  const id = randomUUID()
  const path = join(directory, `report-${id}.json`)
  const log = join(directory, `report-${id}.tap`)
  const report = {
    kind: 'maintenance-retirement',
    ...identity,
    package: 'dsh-auth-remote@0.3.6',
    dsh: version,
    node: process.version,
    status: 'failed',
    startedAt: new Date().toISOString(),
    commands: [],
    log,
  }
  const cancellation = new AbortController()
  const cancel = () =>
    cancellation.abort(new Error('Maintenance-retirement verification interrupted'))
  process.once('SIGINT', cancel)
  process.once('SIGTERM', cancel)
  let child
  let output = ''
  let timer
  let stop
  let receipts
  try {
    timer = setTimeout(
      () => cancellation.abort(new Error('Maintenance-retirement verification timed out')),
      360_000,
    )
    process.env.pnpm_config_package_import_method = 'copy'
    receipts = await createRuntimeReceipts(path, archive, options.sha256, version)
    const runtimeParent = join(directory, 'runtime')
    await mkdir(runtimeParent, { recursive: true })
    await requireRealDirectory(runtimeParent)
    const runtime = join(runtimeParent, version)
    const binary = await prepareDshRuntime(
      runtime,
      `maintenance-retirement-${version}`,
      version,
      cancellation.signal,
    )
    checkDshVersion(binary, version)
    await recordRuntimeIdentity(runtime, version, receipts)
    report.runtime = {
      binary,
      actualDsh: version,
      lockSha256: sha256(await readFile(join(runtime, 'pnpm-lock.yaml'))),
    }
    const args = [
      'exec',
      'tsx',
      '--test',
      '--test-concurrency=1',
      '--test-reporter=tap',
      'tests/retirement/maintenance-retirement.test.ts',
    ]
    report.commands.push({ command: 'pnpm', args })
    cancellation.signal.throwIfAborted()
    child = spawn('pnpm', args, {
      cwd: project,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...receipts.env,
        DSH_MAINTENANCE_VERSION: version,
        DSH_MAINTENANCE_BINARY: binary,
        DSH_MAINTENANCE_ARCHIVE: archive,
        DSH_MAINTENANCE_SHA256: options.sha256,
      },
    })
    report.processGroup = child.pid
    let stopping
    stop = () => (stopping ??= stopProcessGroup(child))
    const abort = () => {
      void stop().catch(() => {})
    }
    cancellation.signal.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (chunk) => {
      output += chunk
      process.stdout.write(chunk)
    })
    child.stderr.on('data', (chunk) => {
      output += chunk
      process.stderr.write(chunk)
    })
    const [code, signal] = await once(child, 'close')
    cancellation.signal.removeEventListener('abort', abort)
    report.exitCode = code
    report.exitSignal = signal
    cancellation.signal.throwIfAborted()
    assert.equal(code, 0, `Maintenance-retirement tests failed (${signal ?? code})`)
    report.counts = assertMaintenanceCounts(output, version)
    await checkPackedArtifact(archive, options.sha256)
    cancellation.signal.throwIfAborted()
    report.status = 'passed'
  } catch (error) {
    report.error = String(error)
    throw error
  } finally {
    clearTimeout(timer)
    report.finishedAt = new Date().toISOString()
    let cleanupError
    try {
      await stop?.()
      report.processesStopped = true
    } catch (error) {
      report.status = 'failed'
      report.cleanupError = String(error)
      cleanupError = error
    }
    let archiveError
    try {
      await checkPackedArtifact(archive, options.sha256)
    } catch (error) {
      report.status = 'failed'
      report.archiveError = String(error)
      archiveError = error
    }
    const markCancelled = () => {
      if (!cancellation.signal.aborted) return
      report.status = 'failed'
      report.error = String(cancellation.signal.reason)
    }
    try {
      markCancelled()
      await writeFile(log, output)
      await writeFile(path, JSON.stringify(report, null, 2) + '\n')
      if (receipts) await writeConsumerEvidence(path, receipts)
      if (cancellation.signal.aborted) {
        markCancelled()
        await writeFile(path, JSON.stringify(report, null, 2) + '\n')
        if (receipts) await writeConsumerEvidence(path, receipts)
      }
      console.log(`Maintenance-retirement report: ${path}`)
      if (archiveError) throw archiveError
      if (cleanupError) throw cleanupError
      cancellation.signal.throwIfAborted()
    } finally {
      process.removeListener('SIGINT', cancel)
      process.removeListener('SIGTERM', cancel)
    }
  }
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  try {
    await verifyMaintenanceRetired(parseArguments(process.argv.slice(2)))
  } catch (error) {
    console.error(String(error))
    process.exitCode = 1
  }
