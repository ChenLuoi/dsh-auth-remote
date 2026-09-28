import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { archive, dsh, project } from '../helpers/runtime.js'

const port = 13120

function env(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: home,
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
    LANG: 'C.UTF-8',
  }
}

async function requestLocal(
  path: string,
  accept?: string,
  hostname = '127.0.0.1',
  authority = hostname,
) {
  return new Promise<{ status: number; body: string; location?: string }>((resolve, reject) => {
    const req = request(
      {
        hostname,
        port,
        path,
        headers: {
          host: authority === hostname ? `${hostname}:${port}` : authority,
          ...(accept ? { accept } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            location: res.headers.location,
          }),
        )
      },
    )
    req.on('error', reject)
    req.end()
  })
}

for (const scenario of [
  {
    name: 'minimal default loopback without a profile patch',
    host: '127.0.0.1',
    full: false,
    preserve: false,
  },
  {
    name: 'full profile with a specific IPv4 via --host',
    host: '127.0.0.2',
    full: true,
    preserve: false,
  },
  {
    name: 'preserved API path and two public origins without a Connection row',
    host: '127.0.0.2',
    full: true,
    preserve: true,
  },
])
  test(`production profile binds ${scenario.name} in an isolated DSH profile`, async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-auth-remote-deploy-'))
    let server: ReturnType<typeof spawn> | undefined
    try {
      const install = spawn(dsh, ['plugin', '--profile', 'web', 'add', archive], {
        cwd: home,
        env: env(home),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let installError = ''
      install.stderr.on('data', (chunk: Buffer) => {
        installError += chunk.toString('utf8')
      })
      const [installCode] = (await once(install, 'close')) as [number]
      assert.equal(installCode, 0, installError.slice(0, 1500))
      if (scenario.full) {
        const template = await readFile(
          join(project, 'examples/web-profile-auth-remote.patch.yml'),
          'utf8',
        )
        let isolated = template
          .replaceAll('dsh.example.com', `${scenario.host}:${port}`)
          .replace(`https://${scenario.host}:${port}`, `http://${scenario.host}:${port}`)
          .replaceAll('13090', String(port))
        if (scenario.preserve)
          isolated = isolated
            .replace(
              `allowedOrigins: [http://${scenario.host}:${port}]`,
              `allowedOrigins: [http://${scenario.host}:${port}, https://second.example]`,
            )
            .replace('preserveOriginPaths: []', 'preserveOriginPaths: [/api]')
        await writeFile(join(home, 'profiles/web/cordis.patch.yml'), isolated)
      }
      server = spawn(
        dsh,
        [
          'web',
          '--no-open',
          '--port',
          String(port),
          ...(scenario.host !== '127.0.0.1' ? ['--host', scenario.host] : []),
        ],
        {
          cwd: home,
          env: env(home),
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      let stderr = ''
      let stdout = ''
      server.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
      })
      server.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })
      let ready = false
      for (let attempt = 0; attempt < 150; attempt++) {
        if (server.exitCode !== null) throw new Error(`DSH exited: ${stderr.slice(0, 1500)}`)
        try {
          const response = await requestLocal('/auth-remote/ready', undefined, scenario.host)
          if (response.status === 200 && JSON.parse(response.body).ready === true) {
            ready = true
            break
          }
        } catch {
          // Wait for the exact target runtime to compose the copied profile.
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      assert.equal(ready, true, stderr.slice(0, 1500))
      if (scenario.preserve) {
        const second = await requestLocal(
          '/auth-remote/ready',
          undefined,
          scenario.host,
          'second.example',
        )
        assert.equal(second.status, 200, second.body)
        assert.equal(JSON.parse(second.body).ready, true)
      }
      for (let attempt = 0; attempt < 50 && !stdout.includes('dsh web start at'); attempt++)
        await new Promise((resolve) => setTimeout(resolve, 100))
      assert.ok(stdout.includes(`dsh web start at\n  http://${scenario.host}:${port}`))
      if (scenario.full)
        assert.ok(stdout.includes(`public access at\n  http://${scenario.host}:${port}`))
      else assert.equal(stdout.includes('public access at'), false)
      assert.equal(stdout.includes('/auth-remote/login'), false, 'startup prints root URLs')
      assert.equal(stdout.includes('dsh web:'), false, 'native DSH URL must be suppressed')
      assert.equal(stdout.includes('?token='), false, 'native token must not appear in output')
      assert.deepEqual(
        JSON.parse((await requestLocal('/auth-remote/state', undefined, scenario.host)).body),
        {
          initialized: false,
          requireTotp: true,
          profileName: 'web',
        },
      )
      const index = await requestLocal('/', 'text/html', scenario.host)
      assert.equal(index.status, 302)
      assert.match(index.location ?? '', /auth-remote\/login/u)
      assert.equal((await requestLocal('/api/settings', undefined, scenario.host)).status, 401)
    } finally {
      if (server && server.exitCode === null && server.signalCode === null) {
        server.kill('SIGTERM')
        await once(server, 'exit').catch(() => {})
      }
      await rm(home, { recursive: true, force: true })
    }
  })
