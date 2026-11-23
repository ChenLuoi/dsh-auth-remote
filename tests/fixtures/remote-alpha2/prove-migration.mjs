// Exercise migration and a full isolated-profile rollback using the published v1 writer.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isolatedDshEnv, project } from '../../../scripts/runtime.mjs'
import { AuthService } from '../../../src/auth/service.ts'
import { sessionHash } from '../../../src/auth/sessions.ts'
import { TOTP_PERIOD_MS, totpCode } from '../../../src/auth/totp.ts'
import { AuthStateStore } from '../../../src/storage/store.ts'
import { nativeHttp } from '../../helpers/native-http.ts'
import { linkRuntimeDependencies } from './runtime-dependencies.mjs'

const [runtime, archive, alphaRuntime] = process.argv.slice(2).map((path) => resolve(path))
const binary = join(runtime, 'node_modules/.bin/dsh')
const directory = await mkdtemp('/tmp/dsh-state-migration-')
const home = join(directory, 'home')
const profile = join(home, 'profiles/web')
const backup = join(directory, 'backup')
const packageDir = join(profile, 'node_modules/dsh-auth-remote')
const entry = join(packageDir, 'dist/index.js')
const statePath = join(profile, 'auth-remote/auth-state.json')
const configPath = join(profile, 'cordis.patch.yml')
const policyPatch = '\n- id: auth-remote\n  config:\n    sessionHours: 12\n'
const env = isolatedDshEnv(home)
const password = randomBytes(24).toString('base64url')
let dsh
let phase = 'published v1 package and baseline identity'

async function start(binary) {
  const reservation = createServer().listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const { port } = reservation.address()
  await new Promise((resolve) => reservation.close(resolve))
  const address = 'http://127.0.0.1:' + port
  const child = spawn(binary, ['web', '--no-open', '--port', String(port)], {
    cwd: home,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  dsh = { child, done: once(child, 'close'), sensitive: false }
  for (const output of [child.stdout, child.stderr])
    output.on('data', (chunk) => {
      if (/[?&]token=|[?&]code=|dsh_auth_remote=/u.test(String(chunk))) dsh.sensitive = true
    })
  let ready
  for (let attempt = 0; attempt < 100 && child.exitCode === null; attempt++) {
    ready = await nativeHttp(address, '/auth-remote/ready').catch(() => undefined)
    if (ready?.status === 200) break
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  assert.equal(ready?.status, 200)
  return address
}

async function stop() {
  if (!dsh) return
  dsh.child.kill()
  await dsh.done
  assert.equal(dsh.sensitive, false)
  dsh = undefined
}

try {
  const digest = createHash('sha256')
    .update(await readFile(archive))
    .digest('hex')
  assert.equal(digest, '9a1a29d1e306b98ba73192cf96716b035c3f29e1cd9352092bc9cf00500fd716')
  await mkdir(packageDir, { recursive: true })
  assert.equal(
    execFileSync(binary, ['--version'], { cwd: home, env, encoding: 'utf8' }).trim(),
    '0.2.2-rc.5',
  )
  await linkRuntimeDependencies(runtime, profile)
  execFileSync('tar', ['-xf', archive, '-C', packageDir, '--strip-components=1'])
  const released = await import(pathToFileURL(entry).href)
  const originalPatch = (await readFile(join(packageDir, 'cordis.patch.yml'), 'utf8')).replace(
    'name: dsh-auth-remote',
    'name: ' + entry,
  )
  await writeFile(configPath, originalPatch + policyPatch)

  phase = 'produce real v1 account, factors and signed-in session'
  const policy = { sessionHours: 12, requireTotp: false }
  const oldStore = await released.AuthStateStore.open(profile)
  const oldAuth = new released.AuthService(oldStore, policy)
  let active
  let originalAccount
  const expired = randomBytes(32).toString('base64url')
  const revoked = randomBytes(32).toString('base64url')
  try {
    await oldAuth.initialize('owner', password)
    const first = await oldAuth.login('owner', password)
    const binding = await oldAuth.startBinding(first.token, password)
    const factor = totpCode(binding.secret, Math.floor(Date.now() / TOTP_PERIOD_MS))
    const bound = await oldAuth.confirmBinding(binding.challenge, factor)
    const challenge = await oldAuth.login('owner', password)
    active = await oldAuth.verifyMfa(challenge.challenge, bound.backupCodes[0])
    originalAccount = oldStore.current().account
    assert.equal(originalAccount.totp.backupCodeHashes.length, 9)
    const session = oldAuth.session(active.token)
    await oldStore.transact((draft) => {
      draft.sessions[sessionHash(expired)] = { ...session, createdAt: 1, expiresAt: 2 }
      draft.sessions[sessionHash(revoked)] = { ...session, securityVersion: 1 }
    })
  } finally {
    oldAuth.dispose()
    await oldStore.close()
  }

  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).schemaVersion, 1)
  await cp(home, backup, { recursive: true, verbatimSymlinks: true })

  phase = 'migrate in place without extending or resurrecting sessions'
  const oldBytes = await readFile(statePath)
  const oldConfig = await readFile(configPath)
  const nextStore = await AuthStateStore.open(profile)
  const nextAuth = new AuthService(nextStore, policy)
  try {
    assert.equal(nextStore.current().schemaVersion, 2)
    assert(JSON.stringify(nextStore.current().account) === JSON.stringify(originalAccount))
    assert.equal(nextAuth.session(active.token)?.source, 'password')
    assert.equal(nextAuth.session(active.token)?.expiresAt, active.expiresAt)
    assert.equal(nextAuth.session(expired), null)
    assert.equal(nextAuth.session(revoked), null)
    assert((await readFile(join(profile, 'auth-remote/auth-state.v1.json'))).equals(oldBytes))
    assert((await readFile(configPath)).equals(oldConfig))
  } finally {
    nextAuth.dispose()
    await nextStore.close()
  }

  if (alphaRuntime) {
    phase = 'upgrade the archived v1 profile with the exact provider Loader'
    const alphaBinary = join(alphaRuntime, 'node_modules/.bin/dsh')
    assert.equal(
      execFileSync(alphaBinary, ['--version'], { cwd: home, env, encoding: 'utf8' }).trim(),
      '0.2.3-alpha.2',
    )
    await rename(home, join(directory, 'schema-proof'))
    await cp(backup, home, { recursive: true, verbatimSymlinks: true })
    assert.equal(JSON.parse(await readFile(statePath, 'utf8')).schemaVersion, 1)
    await rm(join(profile, 'node_modules/@deepseek-ai'), { recursive: true })
    await rm(join(profile, 'node_modules/semver'))
    await linkRuntimeDependencies(alphaRuntime, profile)
    for (const item of ['dist', 'package.json'])
      await cp(join(project, item), join(packageDir, item), { recursive: true })
    const candidatePatch = (await readFile(join(project, 'cordis.patch.yml'), 'utf8')).replace(
      'name: dsh-auth-remote',
      'name: ' + entry,
    )
    await writeFile(configPath, candidatePatch + policyPatch)
    const upgraded = await start(alphaBinary)
    const promoted = await nativeHttp(upgraded, '/auth-remote/me', {
      cookie: 'dsh_auth_remote=' + active.token,
    })
    assert.equal(promoted.status, 200)
    assert.equal(JSON.parse(promoted.body).expiresAt, active.expiresAt)
    for (const token of [expired, revoked]) {
      assert.equal(
        (await nativeHttp(upgraded, '/index.html', { cookie: 'dsh_auth_remote=' + token })).status,
        401,
      )
    }
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    assert.equal(state.schemaVersion, 2)
    assert(JSON.stringify(state.account) === JSON.stringify(originalAccount))
    assert((await readFile(join(profile, 'auth-remote/auth-state.v1.json'))).equals(oldBytes))
    await stop()
  }

  phase = 'restore the pre-upgrade profile and run its actual Loader'
  await rename(home, join(directory, 'migrated'))
  await cp(backup, home, { recursive: true, verbatimSymlinks: true })
  assert((await readFile(statePath)).equals(oldBytes))
  assert((await readFile(configPath)).equals(oldConfig))
  const address = await start(binary)
  const restored = await nativeHttp(address, '/auth-remote/me', {
    cookie: 'dsh_auth_remote=' + active.token,
  })
  assert.equal(restored.status, 200)
  assert.equal(JSON.parse(restored.body).expiresAt, active.expiresAt)
  assert.equal(
    (await nativeHttp(address, '/index.html', { cookie: 'dsh_auth_remote=' + revoked })).status,
    401,
  )
  await stop()
  console.log(
    `PASS v1 migration${alphaRuntime ? ' in exact 0.2.3-alpha.2' : ''} and full-profile restore with published 0.3.7 on DSH 0.2.2-rc.5`,
  )
} catch (error) {
  const location = error.stack?.match(/prove-migration\.mjs:\d+:\d+/u)?.[0]
  console.error(`FAIL ${phase} (${location ?? error.name})`)
  process.exitCode = 1
} finally {
  if (dsh) {
    dsh.child.kill()
    await dsh.done
  }
  await rm(directory, { recursive: true, force: true })
}
