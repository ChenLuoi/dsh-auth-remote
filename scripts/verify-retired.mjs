import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { createConnection, createServer } from 'node:net'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { checkPackedArtifact } from './packed-artifact.mjs'
import {
  isolatedDshEnv,
  packageManifest,
  prepareDshRuntime,
  project,
  requireRealDirectory,
  testedDshVersions,
} from './runtime.mjs'
import { sha256, unpackFiles, validateArchive } from './verify-packed.mjs'

export const retiredDshVersions = [
  '0.1.7-rc.1',
  '0.1.7-rc.2',
  '0.2.0-rc.1',
  '0.2.0-rc.2',
  '0.2.1-alpha.1',
  '0.2.1-alpha.2',
]
const baselineVersion = '0.2.0'
const baselineHash = '7b4156a75398daef079435af85ff1387a26e94055e17871000e945299fc66efc'
const reportDirectory = join(project, '.cache/verify-retired')
const fixturePassword = 'retired verification password 123'
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const activeCommands = new Set()

export function parseArguments(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    assert(
      ['--archive', '--sha256', '--retired-dsh-version'].includes(flag),
      `Unknown option: ${flag}`,
    )
    assert(value && !value.startsWith('--'), `Missing value for ${flag}`)
    const key = flag.slice(2)
    assert(!Object.hasOwn(options, key), `Duplicate option: ${flag}`)
    options[key] = value
  }
  assert(
    options.archive &&
      options.sha256 &&
      retiredDshVersions.includes(options['retired-dsh-version']),
    'Require archive, sha256 and an exact retired-dsh-version',
  )
  assert.match(options.sha256, /^[a-f0-9]{64}$/u, 'Expected a lowercase SHA-256')
  return options
}

/** Match native skip and peer facts without fixing their layout or process exit. */
export function nativePeerRefusal(output, version) {
  return (
    retiredDshVersions.includes(version) &&
    /\bskip(?:ping|ped)?\s+(?:profile\s+)?bundle\s+["']?dsh-auth-remote(?:["'\s:@]|$)|\bbundle\s+["']?dsh-auth-remote["']?\s+(?:was\s+)?skip(?:ping|ped)?\b/imu.test(
      output,
    ) &&
    output.includes(`${packageManifest.name}@${packageManifest.version}`) &&
    /incompatible/iu.test(output) &&
    output.includes(version) &&
    output.includes('peerDependencies') &&
    output.includes('@deepseek-ai/dsh-host-webserver') &&
    output.includes('>=0.2.1-alpha.3')
  )
}

/** Own package files exclude the installer's peer/dependency links. */
export async function installedFiles(directory, assertPrivate = false) {
  const files = new Map()
  async function visit(relative = '') {
    for (const name of await readdir(join(directory, relative))) {
      if (!relative && name === 'node_modules') continue
      const path = relative ? `${relative}/${name}` : name
      const entry = await lstat(join(directory, path))
      assert(!entry.isSymbolicLink(), `Unexpected package-owned symlink: ${path}`)
      if (entry.isDirectory()) await visit(path)
      else {
        assert(entry.isFile(), `Unexpected package-owned entry: ${path}`)
        if (assertPrivate) assert.equal(entry.nlink, 1, `Shared package hardlink: ${path}`)
        files.set(path, await readFile(join(directory, path)))
      }
    }
  }
  await visit()
  return files
}

export async function replaceInstalledPackage(directory, home, files) {
  const ownedHome = await realpath(home)
  const target = await realpath(directory)
  assert.equal(target, directory, 'Replacement requires the real installed package path')
  assert(target.startsWith(ownedHome + '/'), 'Installed package must belong to this isolated home')
  await installedFiles(target, true)
  for (const path of files.keys())
    assert(
      path &&
        !isAbsolute(path) &&
        !path.split('/').some((part) => ['..', 'node_modules', ''].includes(part)),
      'Unsafe package replacement path',
    )
  for (const name of await readdir(target))
    if (name !== 'node_modules') await rm(join(target, name), { recursive: true })
  for (const [path, bytes] of files) {
    await mkdir(dirname(join(target, path)), { recursive: true })
    await writeFile(join(target, path), bytes, { mode: path === 'dist/cli.js' ? 0o755 : 0o644 })
  }
  assert.deepEqual(
    await installedFiles(target, true),
    files,
    'Installed candidate differs in file set or bytes',
  )
}

function diagnostic(text) {
  return text
    .replaceAll(fixturePassword, '[redacted]')
    .replace(/\?token=[^\s"']+/gu, '?token=[redacted]')
    .replace(/(dsh_auth_remote=)[A-Za-z0-9_-]+/gu, '$1[redacted]')
}

function command(binary, args, home, report, signal, interactive = false, onData) {
  signal.throwIfAborted()
  report.commands.push({ command: binary, args, cwd: home })
  const child = spawn(binary, args, {
    cwd: home,
    env: isolatedDshEnv(home),
    detached: true,
    stdio: [interactive ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  })
  let stdout = '',
    stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk
    onData?.(stdout, child)
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  const done = once(child, 'close').then(([code, signal]) => ({ code, signal, stdout, stderr }))
  done.catch(() => {})
  const groupAlive = () => {
    if (!child.pid) return false
    try {
      process.kill(-child.pid, 0)
      return true
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
      return false
    }
  }
  const stop = async () => {
    const kill = (signal) => {
      try {
        process.kill(-child.pid, signal)
      } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    }
    if (groupAlive()) kill('SIGTERM')
    for (let index = 0; index < 50 && groupAlive(); index++) await delay(100)
    if (groupAlive()) kill('SIGKILL')
    await done
    for (let index = 0; index < 50 && groupAlive(); index++) await delay(100)
    assert(!groupAlive(), `Verification process group remains: ${child.pid}`)
    activeCommands.delete(running)
  }
  const running = { child, done, stop, output: () => ({ stdout, stderr }) }
  activeCommands.add(running)
  return running
}

async function terminal(
  binary,
  args,
  home,
  report,
  signal,
  timeout = 180_000,
  interactive = false,
  onData,
) {
  const running = command(binary, args, home, report, signal, interactive, onData)
  let timer
  try {
    const result = await Promise.race([
      running.done,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Verification command timed out')), timeout)
      }),
    ])
    assert(Number.isInteger(result.code), 'Command did not exit naturally')
    return result
  } finally {
    clearTimeout(timer)
    await running.stop()
  }
}

async function baselineArchive(signal) {
  const response = await fetch(`https://registry.npmjs.org/dsh-auth-remote/${baselineVersion}`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  })
  assert(response.ok, 'Cannot verify the published baseline manifest')
  const manifest = await response.json()
  assert.equal(manifest.name, packageManifest.name)
  assert.equal(manifest.version, baselineVersion)
  const path = join(reportDirectory, `dsh-auth-remote-${baselineVersion}.tgz`)
  let bytes
  try {
    const entry = await lstat(path)
    assert(
      entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1,
      'Baseline cache must be a private regular file',
    )
    bytes = await readFile(path)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (!bytes) {
    assert.equal(
      manifest.dist.tarball,
      `https://registry.npmjs.org/dsh-auth-remote/-/dsh-auth-remote-${baselineVersion}.tgz`,
    )
    const archive = await fetch(manifest.dist.tarball, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    })
    assert(archive.ok, 'Cannot fetch the published baseline archive')
    bytes = Buffer.from(await archive.arrayBuffer())
  }
  assert.equal(sha256(bytes), baselineHash, 'Published baseline SHA-256 changed')
  const [algorithm, expected] = manifest.dist.integrity.split('-')
  assert.equal(algorithm, 'sha512')
  assert.equal(
    createHash(algorithm).update(bytes).digest('base64'),
    expected,
    'Published baseline integrity changed',
  )
  const files = unpackFiles(bytes)
  const packed = JSON.parse(files.get('package.json'))
  assert.equal(packed.name, packageManifest.name)
  assert.equal(packed.version, baselineVersion)
  for (const version of retiredDshVersions)
    assert.equal(packed.dsh.compatibility.dshReleases[version], 'compatible')
  await writeFile(path, bytes)
  return {
    path,
    files,
    identity: {
      package: `${packed.name}@${packed.version}`,
      sha256: baselineHash,
      integrity: manifest.dist.integrity,
      source: `https://registry.npmjs.org/dsh-auth-remote/${baselineVersion}`,
    },
  }
}

async function dependencies(profile, home, version) {
  const runtime = createRequire(join(reportDirectory, 'runtime', version, 'package.json'))
  const installAnchor = runtime.resolve('@deepseek-ai/dsh/package.json')
  const dsh = createRequire(installAnchor)
  const boot = await import(pathToFileURL(dsh.resolve('@deepseek-ai/dsh-app-boot')).href)
  const loaded = boot.loadProfileDirectory('dsh', profile, installAnchor)
  const resolution = await boot.createRuntimeResolution({ installAnchor, profile: loaded, home })
  const identities = {}
  for (const name of ['@deepseek-ai/dsh-host-webserver', '@deepseek-ai/dsh-client-connection']) {
    const entry = resolution.entries.find(
      (entry) => entry.name === name && entry.scope === 'installation',
    )
    assert(entry, `Native installation resolution is missing ${name}`)
    const path = await realpath(join(entry.packageDir, 'package.json'))
    const manifest = JSON.parse(await readFile(path))
    assert.equal(manifest.name, name)
    assert.equal(manifest.version, version, 'The installed peer must remain the actual old host')
    identities[name] = {
      path,
      version: manifest.version,
      scope: entry.scope,
      declarer: entry.declarer,
    }
  }
  return identities
}

async function snapshot(profile) {
  const files = new Map()
  for (const path of ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml'])
    files.set(path, await readFile(join(profile, path)))
  for (const name of await readdir(join(profile, 'auth-remote')))
    if (name.startsWith('auth-state.json'))
      files.set(`auth-remote/${name}`, await readFile(join(profile, 'auth-remote', name)))
  assert(files.has('auth-remote/auth-state.json'), 'Synthetic authentication state is missing')
  return files
}

async function prepareProfile(home, binary, baseline, report, version, signal) {
  signal.throwIfAborted()
  await mkdir(home)
  const installed = await terminal(
    binary,
    ['plugin', '--profile', 'web', 'add', baseline.path],
    home,
    report,
    signal,
  )
  assert.equal(installed.code, 0, diagnostic(installed.stderr))
  const profile = join(home, 'profiles/web')
  await writeFile(
    join(profile, 'cordis.patch.yml'),
    '# retained user patch\n- id: webserver\n  disabled: true\n- id: auth-remote\n  config:\n    requireTotp: false\n',
  )
  const prompts = [
    ['用户名: ', 'alice'],
    ['密码: ', fixturePassword],
    ['再次输入密码: ', fixturePassword],
  ]
  let cursor = 0,
    index = 0
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
  const cli = [
    binary,
    'plugin',
    '--profile',
    'web',
    'exec',
    packageManifest.name,
    'init',
    '--lang',
    'zh',
  ]
    .map(quote)
    .join(' ')
  const initialized = await terminal(
    'script',
    ['-q', '-e', '-f', '-c', cli, '/dev/null'],
    home,
    report,
    signal,
    30_000,
    true,
    (output, child) => {
      while (index < prompts.length) {
        const [label, answer] = prompts[index]
        const found = output.indexOf(label, cursor)
        if (found < 0) break
        cursor = found + label.length
        index++
        child.stdin.write(answer + '\n')
      }
    },
  )
  assert.equal(initialized.code, 0, diagnostic(initialized.stdout + initialized.stderr))
  assert.equal(index, prompts.length, 'Baseline init did not complete its real credential flow')
  const packageDirectory = await realpath(join(profile, 'node_modules', packageManifest.name))
  assert.deepEqual(
    await installedFiles(packageDirectory, true),
    baseline.files,
    'Installed baseline bytes differ from the published archive',
  )
  return {
    profile,
    packageDirectory,
    peers: await dependencies(profile, home, version),
    saved: await snapshot(profile),
  }
}

async function vacantPort() {
  const server = createServer().listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

export async function assertNoListener(port) {
  await assert.rejects(
    new Promise((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port })
      socket.setTimeout(1000, () => socket.destroy(new Error('TCP probe timed out')))
      socket.once('connect', () => {
        socket.destroy()
        resolve()
      })
      socket.once('error', reject)
    }),
    { code: 'ECONNREFUSED' },
  )
  for (const [path, headers] of [
    ['/', {}],
    ['/auth-remote/ready', {}],
    ['/api/settings/describe', {}],
    [
      '/api',
      {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    ],
  ]) {
    await assert.rejects(
      new Promise((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path, headers }, (response) => {
          response.resume()
          resolve()
        })
        req.setTimeout(1000, () => req.destroy(new Error('HTTP probe timed out')))
        req.once('upgrade', (_response, socket) => {
          socket.destroy()
          resolve()
        })
        req.once('error', reject)
        req.end()
      }),
      { code: 'ECONNREFUSED' },
    )
  }
}

export async function verifyRetired(options) {
  const version = options['retired-dsh-version']
  assert(retiredDshVersions.includes(version), 'Unknown retired target')
  const archive = resolve(options.archive)
  const identity = await checkPackedArtifact(archive, options.sha256)
  const candidate = validateArchive(
    await readFile(archive),
    options.sha256,
    testedDshVersions.at(-1),
  )
  await mkdir(join(project, '.cache'), { recursive: true })
  await requireRealDirectory(project)
  await requireRealDirectory(join(project, '.cache'))
  await mkdir(reportDirectory, { recursive: true, mode: 0o700 })
  await requireRealDirectory(reportDirectory)
  const path = join(reportDirectory, `report-${randomUUID()}.json`)
  const report = {
    kind: 'retired-rejection',
    package: `${packageManifest.name}@${packageManifest.version}`,
    dsh: version,
    ...identity,
    node: process.version,
    status: 'failed',
    startedAt: new Date().toISOString(),
    commands: [],
    paths: [],
  }
  let root
  const cancellation = new AbortController()
  const cancel = () => {
    cancellation.abort(new Error('Retired verification interrupted'))
    for (const running of activeCommands) void running.stop().catch(() => {})
  }
  process.once('SIGINT', cancel)
  process.once('SIGTERM', cancel)
  const check = async () => checkPackedArtifact(archive, options.sha256)
  try {
    const baseline = await baselineArchive(cancellation.signal)
    report.baseline = baseline.identity
    root = await mkdtemp(join(project, '.cache/r-'))
    const binary = await prepareDshRuntime(
      join(reportDirectory, 'runtime', version),
      `retired-rejection-${version}`,
      version,
      cancellation.signal,
    )
    const installPath = { name: 'install-rollback', status: 'running' }
    report.paths.push(installPath)
    try {
      const home = join(root, 'i')
      const before = await prepareProfile(
        home,
        binary,
        baseline,
        report,
        version,
        cancellation.signal,
      )
      const denied = await terminal(
        binary,
        ['plugin', '--profile', 'web', 'add', archive],
        home,
        report,
        cancellation.signal,
      )
      assert.notEqual(denied.code, 0, 'Retired host installed the incompatible candidate')
      assert.match(denied.stdout + denied.stderr, /installation rejected:.*incompatible with dsh/su)
      assert((denied.stdout + denied.stderr).includes(`dsh-auth-remote@${packageManifest.version}`))
      assert.deepEqual(
        await snapshot(before.profile),
        before.saved,
        'Install rejection changed package, lock, patch or authentication data',
      )
      const restored = await realpath(join(before.profile, 'node_modules', packageManifest.name))
      assert.deepEqual(
        await installedFiles(restored),
        baseline.files,
        'The original dependency was not restored',
      )
      assert.deepEqual(
        await dependencies(before.profile, home, version),
        before.peers,
        'Old peer resolution changed',
      )
      const status = await terminal(
        binary,
        ['plugin', '--profile', 'web', 'exec', packageManifest.name, 'status', '--json'],
        home,
        report,
        cancellation.signal,
      )
      assert.equal(status.code, 0, diagnostic(status.stderr))
      assert.equal(JSON.parse(status.stdout).initialized, true)
      assert.deepEqual(await snapshot(before.profile), before.saved)
      Object.assign(installPath, {
        nativeExitCode: denied.code,
        processesStopped: true,
        rollback: {
          package: true,
          lock: true,
          patch: true,
          authentication: true,
          dependency: true,
          peers: true,
        },
        diagnostic: diagnostic(denied.stderr).slice(-6000),
      })
    } finally {
      await check()
    }
    cancellation.signal.throwIfAborted()
    installPath.status = 'passed'

    const loaderPath = { name: 'existing-incompatible-bundle', status: 'running', probes: [] }
    report.paths.push(loaderPath)
    let running
    try {
      const home = join(root, 'l')
      const before = await prepareProfile(
        home,
        binary,
        baseline,
        report,
        version,
        cancellation.signal,
      )
      await replaceInstalledPackage(before.packageDirectory, home, candidate.files)
      assert.deepEqual(
        await dependencies(before.profile, home, version),
        before.peers,
        'Replacing own files changed real old peer links',
      )
      const port = await vacantPort()
      await assertNoListener(port)
      running = command(
        binary,
        ['web', '--no-open', '--host', '127.0.0.1', '--port', String(port)],
        home,
        report,
        cancellation.signal,
      )
      let confirmed = false
      for (let attempt = 0; attempt < 300; attempt++) {
        const { stdout, stderr } = running.output()
        const output = stdout + stderr
        if (nativePeerRefusal(output, version)) {
          confirmed = true
          break
        }
        if (running.child.exitCode !== null || running.child.signalCode !== null) break
        await delay(100)
      }
      assert(
        confirmed,
        `Native peer rejection was not confirmed: ${diagnostic(running.output().stdout + running.output().stderr).slice(-6000)}`,
      )
      for (let attempt = 0; attempt < 10; attempt++) {
        await assertNoListener(port)
        loaderPath.probes.push({
          port,
          tcp: 'refused',
          http: 'refused',
          readiness: 'refused',
          websocket: 'refused',
        })
        await delay(200)
      }
      const output = running.output()
      assert.doesNotMatch(
        output.stdout + output.stderr,
        /dsh web(?: start at|:)|public access at|\?token=/u,
      )
      assert.deepEqual(
        await snapshot(before.profile),
        before.saved,
        'Loader refusal changed saved data',
      )
      Object.assign(loaderPath, {
        nativeExitCode: running.child.exitCode,
        nativeSignal: running.child.signalCode,
        stoppedByFixture: running.child.exitCode === null && running.child.signalCode === null,
        wholePackageFiles: candidate.files.size,
        byteIdentical: true,
        peers: before.peers,
        diagnostic: diagnostic(output.stderr).slice(-6000),
      })
    } finally {
      await running?.stop()
      loaderPath.processesStopped = true
      await check()
    }
    cancellation.signal.throwIfAborted()
    loaderPath.status = 'passed'
    report.status = 'passed'
  } catch (error) {
    for (const result of report.paths) if (result.status === 'running') result.status = 'failed'
    report.error = diagnostic(String(error))
    throw error
  } finally {
    process.removeListener('SIGINT', cancel)
    process.removeListener('SIGTERM', cancel)
    try {
      for (const running of activeCommands) await running.stop()
      if (root) await rm(root, { recursive: true, force: true })
    } catch (error) {
      report.status = 'failed'
      report.cleanupError = diagnostic(String(error))
      throw error
    } finally {
      report.finishedAt = new Date().toISOString()
      await writeFile(path, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
      console.log(`Retired rejection report: ${path}`)
    }
  }
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  try {
    await verifyRetired(parseArguments(process.argv.slice(2)))
  } catch (error) {
    console.error(diagnostic(String(error)))
    process.exitCode = 1
  }
