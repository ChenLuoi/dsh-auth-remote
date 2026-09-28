import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { assertDevHome, dsh, dshEnv, home, port } from './dev-common.mjs'
import { packageName } from './runtime.mjs'

await assertDevHome()
const base = `http://127.0.0.1:${port}`
const child = spawn(dsh, ['web', '--no-open', '--port', String(port)], {
  cwd: home,
  env: dshEnv(),
  stdio: ['ignore', 'pipe', 'pipe'],
})
let stderr = ''
child.stderr.on('data', (chunk) => {
  stderr += chunk.toString('utf8')
})
try {
  let ready = false
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null) throw new Error(`DSH exited: ${stderr.slice(0, 2000)}`)
    try {
      const response = await fetch(`${base}/auth-remote/ready`)
      if (response.status === 200 && (await response.json()).ready === true) {
        ready = true
        break
      }
    } catch {
      // Wait for the fixed local runtime, profile and Connection to activate.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.equal(ready, true, `isolated DSH never became ready: ${stderr.slice(0, 2000)}`)
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
  assert.match(loginHtml, /Sign in to DSH/u)
  const state = await fetch(`${base}/auth-remote/state`)
  assert.equal(state.status, 200)
  const stateBody = await state.json()
  assert.equal(typeof stateBody.initialized, 'boolean')
  assert.equal(stateBody.requireTotp, true)
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
  console.info('DSH_HOME: .dev/dsh-home')
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM')
    await once(child, 'exit').catch(() => {})
  }
}
