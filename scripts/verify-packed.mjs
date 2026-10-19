import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import {
  archive as consumerArchive,
  assertVerificationRoot,
  createVerificationRoot,
  packageManifest,
  prepareDshRuntime,
  project,
  requireRealDirectory,
  testedDshVersions,
  verificationParent,
} from './runtime.mjs'

export const suites = {
  cli: { directory: 'tests/cli', suffix: '.test.ts' },
  browser: { directory: 'tests/browser', suffix: '.spec.ts' },
  smoke: {},
  theme: {
    files: ['tests/browser/login.spec.ts'],
    pattern: '^login and security settings follow DSH themes and fit narrow screens$',
    count: 1,
  },
  'startup-transport': {
    versions: ['0.2.1-alpha.1', '0.2.1-alpha.2'],
    files: [
      'tests/browser/startup-compatibility.spec.ts',
      'tests/browser/native-transport.spec.ts',
    ],
  },
  account: {
    versions: ['0.2.1-alpha.3'],
    files: [
      'tests/browser/startup-compatibility.spec.ts',
      'tests/browser/account-login.spec.ts',
      'tests/browser/live-config.spec.ts',
    ],
  },
  'host-release': {
    files: ['tests/browser/host-release.spec.ts'],
    versions: ['0.2.1-alpha.4', '0.2.1-alpha.5', '0.2.1-rc.1', '0.2.1-rc.2'],
    count: 1,
  },
  'rc-bootstrap': {
    versions: ['0.2.1-rc.1'],
    count: 2,
    files: ['tests/browser/host-release.spec.ts', 'tests/browser/dsh-bootstrap.spec.ts'],
  },
}

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** Accept only ordinary npm tar files; never extract links, devices or extensions. */
export function unpackFiles(bytes) {
  const tar = gunzipSync(bytes, { maxOutputLength: 128 * 1024 * 1024 })
  const files = new Map()
  const names = new Set()
  const string = (header, start, length) =>
    header
      .subarray(start, start + length)
      .toString('utf8')
      .split('\0', 1)[0]
  const octal = (field) => {
    const text = field.toString('ascii').replace(/\0.*$/su, '').trim()
    assert.match(text, /^[0-7]+$/u, 'Invalid tar numeric field')
    return parseInt(text, 8)
  }
  let ended = false
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) {
      assert(
        tar.subarray(offset).every((byte) => byte === 0),
        'Unexpected data after tar end',
      )
      ended = true
      break
    }
    const checksum = header.reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
      0,
    )
    assert.equal(octal(header.subarray(148, 156)), checksum, 'Invalid tar checksum')
    const prefix = string(header, 345, 155)
    const name = `${prefix ? prefix + '/' : ''}${string(header, 0, 100)}`.replace(/\/$/u, '')
    const type = header[156]
    assert(
      name.startsWith('package/') || (name === 'package' && type === 53),
      'Tar entry must be inside package/',
    )
    assert(!/[\\\x00-\x1f\x7f\ufffd]/u.test(name), 'Unsafe tar filename')
    assert.equal(posix.normalize(name), name, 'Non-canonical tar filename')
    assert(!name.split('/').includes('..'), 'Escaping tar filename')
    assert(!names.has(name), `Duplicate tar entry: ${name}`)
    names.add(name)
    assert([0, 48, 53].includes(type), `Unsupported tar entry type: ${type}`)
    const size = octal(header.subarray(124, 136))
    assert(offset + 512 + size <= tar.length, 'Truncated tar entry')
    if (type === 53) assert.equal(size, 0, 'Directory with tar contents')
    else files.set(name.slice('package/'.length), tar.subarray(offset + 512, offset + 512 + size))
    offset += 512 + Math.ceil(size / 512) * 512
  }
  assert(ended, 'Missing tar end')
  return files
}

export function validateArchive(bytes, expectedHash, version) {
  assert.match(expectedHash, /^[a-f0-9]{64}$/u, 'Expected a lowercase SHA-256')
  assert.equal(sha256(bytes), expectedHash, 'Archive SHA-256 mismatch')
  const files = unpackFiles(bytes)
  assert(files.has('package.json'), 'Archive lacks package.json')
  const manifest = JSON.parse(files.get('package.json').toString('utf8'))
  assert.equal(manifest.name, packageManifest.name, 'Wrong archive package name')
  assert.equal(manifest.version, packageManifest.version, 'Wrong archive package version')
  assert.equal(
    manifest.dsh?.compatibility?.dshReleases?.[version],
    'compatible',
    'Archive does not declare the selected DSH release',
  )
  for (const path of [
    'dist/index.js',
    'dist/cli.js',
    'dist/client.js',
    'dist/login.js',
    'dist/login.css',
    'dist/types/index.d.ts',
  ])
    assert(files.has(path), `Archive lacks ${path}`)
  return { files, manifest }
}

export function testCounts(output, selectedFiles = []) {
  const counts = {}
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = [...output.matchAll(new RegExp(`^# ${key} ([0-9]+)$`, 'gmu'))]
    assert.equal(matches.length, 1, `Missing or ambiguous TAP ${key} summary`)
    counts[key] = Number(matches[0][1])
  }
  assert(counts.tests > 0, 'Verification selected zero tests')
  const selected = new Set(selectedFiles.map((file) => resolve(project, file)))
  counts.placeholderFiles = [...output.matchAll(/^# Subtest: (.+)$/gmu)]
    .map(([, title]) => resolve(project, title))
    .filter((path) => selected.has(path))
  counts.actualTests = counts.tests - counts.placeholderFiles.length
  assert(counts.actualTests > 0, 'Verification selected zero tests (only file placeholders ran)')
  assert.equal(counts.pass, counts.tests, 'Not every selected test passed')
  for (const key of ['fail', 'cancelled', 'skipped', 'todo'])
    assert.equal(counts[key], 0, `Unexpected ${key} tests`)
  return counts
}

export function parseArguments(argv) {
  const options = { suites: [] }
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    assert(
      ['--archive', '--sha256', '--dsh-version', '--suite', '--test-name-pattern'].includes(flag),
      `Unknown option: ${flag}`,
    )
    assert(value && !value.startsWith('--'), `Missing value for ${flag}`)
    if (flag === '--suite') options.suites.push(value)
    else {
      const key = flag.slice(2)
      assert(!Object.hasOwn(options, key), `Duplicate option: ${flag}`)
      options[key] = value
    }
  }
  assert(
    options.archive && options.sha256 && testedDshVersions.includes(options['dsh-version']),
    'Require archive, sha256 and a declared exact dsh-version',
  )
  assert(
    options.suites.length > 0 && new Set(options.suites).size === options.suites.length,
    'Require unique suite selections',
  )
  for (const suite of options.suites) {
    assert(Object.hasOwn(suites, suite), `Unknown suite: ${suite}`)
    assert(
      !suites[suite].versions || suites[suite].versions.includes(options['dsh-version']),
      `Suite ${suite} has no registered coverage on ${options['dsh-version']}`,
    )
  }
  if (options['test-name-pattern']) {
    assert(
      options.suites.length === 1 && ['cli', 'browser'].includes(options.suites[0]),
      'A test-name-pattern requires one cli or browser suite',
    )
    new RegExp(options['test-name-pattern'], 'u')
  }
  return options
}

async function run(command, args, env, log, signal) {
  signal.throwIfAborted()
  const child = spawn(command, args, {
    cwd: project,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  let output = ''
  let diagnostic = ''
  child.stdout.on('data', (chunk) => {
    output += chunk
    process.stdout.write(chunk)
  })
  child.stderr.on('data', (chunk) => {
    diagnostic += chunk
    process.stderr.write(chunk)
  })
  const abort = () => {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    const [code, exitSignal] = await once(child, 'close')
    await writeFile(log, output + '\n' + diagnostic)
    signal.throwIfAborted()
    assert.equal(code, 0, `${command} failed (${exitSignal ?? code}); see ${log}`)
    return output
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

export async function verifyPacked(options) {
  const version = options['dsh-version']
  const source = resolve(options.archive)
  const entry = await lstat(source)
  assert(entry.isFile() && !entry.isSymbolicLink(), 'Archive must be a regular local file')
  const bytes = await readFile(source)
  const { files, manifest } = validateArchive(bytes, options.sha256, version)
  let root
  const lock = join(verificationParent, 'consumer.lock')
  let locked = false
  const report = {
    archive: source,
    sha256: options.sha256,
    package: `${manifest.name}@${manifest.version}`,
    dsh: version,
    node: process.version,
    suites: [],
    commands: [],
    status: 'failed',
    startedAt: new Date().toISOString(),
  }
  const reportPath = join(verificationParent, `report-${randomUUID()}.json`)
  const cancellation = new AbortController()
  const sigint = () => cancellation.abort(new Error('Packed verification interrupted by SIGINT'))
  const sigterm = () => cancellation.abort(new Error('Packed verification interrupted by SIGTERM'))
  process.on('SIGINT', sigint)
  process.on('SIGTERM', sigterm)
  try {
    root = await createVerificationRoot()
    cancellation.signal.throwIfAborted()
    await mkdir(lock)
    locked = true
    await writeFile(
      join(lock, 'owner.json'),
      JSON.stringify({ pid: process.pid, root, sha256: options.sha256 }),
    )
    for (const directory of ['artifacts', 'dist']) {
      const path = join(project, directory)
      await mkdir(path, { recursive: true })
      await requireRealDirectory(path)
    }
    if (source !== consumerArchive) {
      const staged = join(project, 'artifacts', `.verified-${randomUUID()}.tgz`)
      await writeFile(staged, bytes, { flag: 'wx', mode: 0o600 })
      await rename(staged, consumerArchive)
    }
    assert.equal(
      sha256(await readFile(consumerArchive)),
      options.sha256,
      'Fixed consumer archive differs',
    )
    const dist = join(project, 'dist')
    await rm(dist, { recursive: true })
    await mkdir(dist)
    for (const [name, contents] of files) {
      if (!name.startsWith('dist/')) continue
      const target = join(project, name)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, contents, { flag: 'wx' })
    }
    const env = { ...process.env, DSH_TEST_VERSION: version, DSH_VERIFY_ROOT: root }
    delete env.DSH_TEST_BIN
    const runtime = join(project, '.cache/test-runtime', version)
    await prepareDshRuntime(
      runtime,
      `${packageManifest.name}-test-runtime`,
      version,
      cancellation.signal,
    )
    for (const name of options.suites) {
      assert.equal(
        sha256(await readFile(consumerArchive)),
        options.sha256,
        'Consumer archive changed before suite',
      )
      const suite = suites[name]
      const log = join(verificationParent, `${basename(reportPath, '.json')}-${name}.log`)
      const start = Date.now()
      const result = {
        name,
        status: 'running',
        log,
        partial: Boolean(options['test-name-pattern']),
      }
      report.suites.push(result)
      let counts
      if (name === 'smoke') {
        for (const script of ['dev-prepare.mjs', 'dev-install.mjs', 'smoke.mjs']) {
          report.commands.push({
            command: process.execPath,
            args: [join(project, 'scripts', script)],
          })
          await run(
            process.execPath,
            [join(project, 'scripts', script)],
            env,
            `${log}-${script}`,
            cancellation.signal,
          )
        }
      } else {
        const selected =
          suite.files ??
          (await readdir(join(project, suite.directory)))
            .filter((file) => file.endsWith(suite.suffix))
            .sort()
            .map((file) => `${suite.directory}/${file}`)
        assert(selected.length > 0, 'Verification selected zero test files')
        const args = ['exec', 'tsx', '--test', '--test-concurrency=1', '--test-reporter=tap']
        const pattern = options['test-name-pattern'] ?? suite.pattern
        if (pattern) args.push(`--test-name-pattern=${pattern}`)
        args.push(...selected)
        result.files = selected
        result.pattern = pattern ?? null
        report.commands.push({ command: 'pnpm', args })
        counts = testCounts(await run('pnpm', args, env, log, cancellation.signal), selected)
        if (!options['test-name-pattern']) {
          const optional =
            name === 'browser'
              ? [
                  ...(!['0.2.1-alpha.4', '0.2.1-alpha.5', '0.2.1-rc.1', '0.2.1-rc.2'].includes(
                    version,
                  )
                    ? ['tests/browser/host-release.spec.ts']
                    : []),
                  ...(version !== '0.2.1-rc.2'
                    ? ['tests/browser/web-search-settings.spec.ts']
                    : []),
                ].map((path) => join(project, path))
              : []
          for (const path of counts.placeholderFiles)
            assert(optional.includes(path), `Required file registered zero tests: ${path}`)
        }
        if (suite.count && !options['test-name-pattern'])
          assert.equal(counts.actualTests, suite.count, 'Wrong specialized test count')
      }
      assert.equal(
        sha256(await readFile(source)),
        options.sha256,
        'Input archive changed during verification',
      )
      assert.equal(
        sha256(await readFile(consumerArchive)),
        options.sha256,
        'Consumer archive changed during verification',
      )
      for (const [path, expected] of files)
        if (path.startsWith('dist/'))
          assert(
            (await readFile(join(project, path))).equals(expected),
            `Restored dist changed: ${path}`,
          )
      Object.assign(result, { counts, elapsedMs: Date.now() - start, status: 'passed' })
    }
    report.status = 'passed'
  } catch (error) {
    for (const suite of report.suites) if (suite.status === 'running') suite.status = 'failed'
    report.error = String(error)
    throw error
  } finally {
    if (locked) await rm(lock, { recursive: true })
    if (root) {
      await assertVerificationRoot(root)
      await rm(root, { recursive: true })
    }
    report.finishedAt = new Date().toISOString()
    const markCancelled = () => {
      if (!cancellation.signal.aborted) return
      report.status = 'failed'
      report.error = String(cancellation.signal.reason)
      for (const suite of report.suites) if (suite.status === 'running') suite.status = 'failed'
    }
    markCancelled()
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
    if (cancellation.signal.aborted) {
      markCancelled()
      await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
    }
    process.off('SIGINT', sigint)
    process.off('SIGTERM', sigterm)
    console.info(`Packed verification report: ${reportPath}`)
    cancellation.signal.throwIfAborted()
  }
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await verifyPacked(parseArguments(process.argv.slice(2)))
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
