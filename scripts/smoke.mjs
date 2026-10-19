import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { assertDevHome, dsh, dshEnv, home, port, verification } from './dev-common.mjs'
import { packageName } from './runtime.mjs'

await assertDevHome()
let base = verification ? undefined : `http://127.0.0.1:${port}`
const child = spawn(dsh, ['web', '--no-open', '--port', String(port)], {
  cwd: home,
  env: dshEnv(),
  stdio: ['ignore', 'pipe', 'pipe'],
})
let stderr = ''
let stdout = ''
child.stdout.on('data', (chunk) => {
  stdout += chunk.toString('utf8')
  if (verification) {
    const address = stdout.match(
      /^dsh web start at\r?\n +http:\/\/127\.0\.0\.1:([0-9]+)(?:\r?\n|$)/mu,
    )
    if (address && Number(address[1]) > 0) base = `http://127.0.0.1:${address[1]}`
  }
})
child.stderr.on('data', (chunk) => {
  stderr += chunk.toString('utf8')
})
let interrupted
const onInterrupt = (signal) => {
  interrupted = signal
  child.kill(signal)
}
const sigint = () => onInterrupt('SIGINT')
const sigterm = () => onInterrupt('SIGTERM')
process.on('SIGINT', sigint)
process.on('SIGTERM', sigterm)
try {
  let ready = false
  for (let attempt = 0; attempt < 150; attempt++) {
    if (interrupted) throw new Error(`Smoke interrupted by ${interrupted}`)
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`DSH exited: ${stderr.slice(0, 2000)}`)
    try {
      if (!base) throw new Error('Waiting for this child to announce its bound port')
      const response = await fetch(`${base}/auth-remote/ready`, {
        signal: AbortSignal.timeout(1000),
      })
      const state = await response.json()
      if (
        response.status === 200 &&
        state.ready === true &&
        state.plugin === packageName &&
        state.protocolVersion === 1
      ) {
        ready = true
        break
      }
    } catch {
      // Wait for the fixed local runtime, profile and Connection to activate.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.equal(ready, true, `isolated DSH never became ready: ${stderr.slice(0, 2000)}`)
  assert.equal(child.exitCode, null)
  assert.equal(child.signalCode, null)
  assert.equal(interrupted, undefined)
  const page = await fetch(`${base}/`, {
    redirect: 'manual',
    headers: { accept: 'text/html' },
  })
  assert.equal(page.status, 302)
  assert.match(page.headers.get('location') ?? '', /auth-remote\/login/u)
  const login = await fetch(`${base}/auth-remote/login`, { redirect: 'manual' })
  assert.equal(login.status, 200)
  const loginHtml = await login.text()
  assert.match(loginHtml, /<html lang="en">/u)
  assert.match(loginHtml, /<title>Sign in<\/title>/u)
  const state = await fetch(`${base}/auth-remote/state`)
  assert.equal(state.status, 200)
  const stateBody = await state.json()
  assert.equal(typeof stateBody.initialized, 'boolean')
  assert.equal(stateBody.requireTotp, false)
  assert.equal(stateBody.profileName, 'web')
  const business = await fetch(`${base}/api/settings`, { redirect: 'manual' })
  assert.notEqual(business.status, 200)
  const diagnostic = spawnSync(
    dsh,
    ['plugin', '--profile', 'web', 'exec', packageName, 'status', '--json'],
    { cwd: home, env: dshEnv(), encoding: 'utf8' },
  )
  if (diagnostic.error) throw diagnostic.error
  assert.equal(diagnostic.status, 0, diagnostic.stderr)
  assert.equal(JSON.parse(diagnostic.stdout).online, true)
  console.info(`Smoke passed: ${base} redirects anonymous users to the isolated login page`)
  assert.equal(child.exitCode, null)
  assert.equal(child.signalCode, null)
  console.info(`DSH_HOME: ${home}`)
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM')
    await once(child, 'exit').catch(() => {})
  }
  process.off('SIGINT', sigint)
  process.off('SIGTERM', sigterm)
  if (interrupted) throw new Error(`Smoke interrupted by ${interrupted}`)
}
