import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { checkDshVersion, dshVersion, isolatedDshEnv } from '../../scripts/runtime.mjs'
import { archive, dsh } from '../helpers/runtime.js'
import { packedCommand, packedProfile } from '../helpers/packed-runtime.js'
import { nativeHttp } from '../helpers/native-http.js'
import { getRuntimeCapabilities } from '../../src/adapters/dsh/runtime-capabilities.js'

const port = 13130

function get(
  path: string,
  accept?: string,
  options: { hostname?: string; port?: number; host?: string } = {},
) {
  return new Promise<{ status: number; body: string; location?: string }>((resolve, reject) => {
    const req = request(
      {
        hostname: options.hostname ?? '127.0.0.1',
        port: options.port ?? port,
        path,
        headers: { ...(accept ? { accept } : {}), ...(options.host ? { host: options.host } : {}) },
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
        res.on('error', reject)
      },
    )
    req.setTimeout(1000, () => req.destroy(new Error('startup request timed out')))
    req.on('error', reject)
    req.end()
  })
}

for (const [name, config, cliUrl, message] of [
  [
    'multiple legacy origins',
    { allowedOrigins: ['https://a.example', 'https://b.example'] },
    false,
    /one|unique/u,
  ],
  [
    'duplicate legacy origins',
    { allowedOrigins: ['https://a.example', 'https://a.example'] },
    false,
    /one|unique/u,
  ],
  [
    'empty legacy plus public URL',
    { allowedOrigins: [], publicUrl: 'https://file.example' },
    false,
    /publicUrl.*allowedOrigins/u,
  ],
  [
    'same legacy plus public URL',
    { allowedOrigins: ['https://file.example'], publicUrl: 'https://file.example' },
    false,
    /publicUrl.*allowedOrigins/u,
  ],
  ['null legacy input', { allowedOrigins: null }, false, /allowedOrigins/u],
  ['child public URL', { publicUrl: 'https://file.example/child' }, false, /publicUrl/u],
  ['CLI public URL plus legacy', { allowedOrigins: [] }, true, /publicUrl.*allowedOrigins/u],
] as const)
  test(`DSH ${dshVersion} real Loader rejects ${name} without rewriting the profile or opening a listener`, async () => {
    const f = await packedProfile(config)
    try {
      const patch = await readFile(join(f.profile, 'cordis.patch.yml'), 'utf8')
      const args = [
        'web',
        '--no-open',
        '--port',
        '13139',
        ...(cliUrl ? ['--public-url', 'https://cli.example/'] : []),
      ]
      const result = await packedCommand(f.home, args, f.cwd).done
      assert.notEqual(result.code, 0)
      assert.match(
        result.stderr,
        cliUrl && !getRuntimeCapabilities(dshVersion).publicUrl
          ? /unknown option.*--public-url/u
          : message,
      )
      await assert.rejects(nativeHttp('http://127.0.0.1:13139/', '/auth-remote/ready'))
      assert.equal(await readFile(join(f.profile, 'cordis.patch.yml'), 'utf8'), patch)
    } finally {
      await f.cleanup()
    }
  })

test(`packed plugin composes protected WebServer and Connection on DSH ${dshVersion}`, async () => {
  checkDshVersion(dsh)
  const home = await mkdtemp(join(tmpdir(), 'dsh-auth-remote-startup-'))
  let server: ReturnType<typeof spawn> | undefined
  try {
    const install = spawn(dsh, ['plugin', '--profile', 'web', 'add', archive], {
      cwd: home,
      env: isolatedDshEnv(home),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let installError = ''
    install.stderr.on('data', (chunk: Buffer) => (installError += chunk.toString('utf8')))
    const [installCode] = await once(install, 'close')
    assert.equal(installCode, 0, installError.slice(0, 1500))
    server = spawn(dsh, ['web', '--no-open', '--port', String(port)], {
      cwd: home,
      env: isolatedDshEnv(home),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    server.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
    server.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
    let ready = false
    let lastStatus: number | undefined
    for (let attempt = 0; attempt < 150; attempt++) {
      if (server.exitCode !== null) break
      try {
        const response = await get('/auth-remote/ready')
        lastStatus = response.status
        if (response.status === 200 && JSON.parse(response.body).ready === true) {
          ready = true
          break
        }
      } catch {
        // Wait for the real isolated Loader and listener to initialize.
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const redact = (text: string) => text.replace(/\?token=[^\s"<>]+/gu, '?token=[redacted]')
    assert.equal(
      ready,
      true,
      `DSH ${dshVersion}: ready=${lastStatus}; ${redact(stderr).slice(0, 2500)}`,
    )
    const index = await get('/', 'text/html')
    assert.equal(index.status, 302)
    assert.match(index.location ?? '', /^\/auth-remote\/login(?:\?|$)/u)
    assert.equal((await get('/api/settings')).status, 401)
    for (let attempt = 0; attempt < 50 && !stdout.includes('dsh web start at'); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 100))
    assert.ok(stdout.includes(`dsh web start at\n  http://127.0.0.1:${port}`))
    assert.equal(stdout.includes('?token='), false, 'native credentials must stay server-side')
    assert.equal(stderr.includes('?token='), false, 'diagnostics must not expose native tokens')
    assert.equal(stderr.includes('allowedOrigins is deprecated'), false)
    assert.doesNotMatch(stderr, /webRuntime|pending dependencies/u)
  } finally {
    if (server && server.exitCode === null && server.signalCode === null) {
      server.kill('SIGTERM')
      await once(server, 'close')
    }
    await rm(home, { recursive: true, force: true })
  }
})

for (const scenario of [
  'file-public-url',
  'cli-public-url',
  'derived-port-zero',
  'legacy-single',
  'legacy-empty',
] as const)
  test(`DSH ${dshVersion} finalizes ${scenario} through the real Loader and native projection`, async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-auth-remote-entry-packed-'))
    const profile = join(home, 'profiles/web')
    let server: ReturnType<typeof spawn> | undefined
    try {
      const install = spawn(dsh, ['plugin', '--profile', 'web', 'add', archive], {
        cwd: home,
        env: isolatedDshEnv(home),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let installError = ''
      install.stderr.on('data', (chunk: Buffer) => (installError += chunk.toString('utf8')))
      assert.equal((await once(install, 'close'))[0], 0, installError.slice(0, 1500))
      const observer = join(profile, 'startup-observer.mjs')
      await copyFile(new URL('../fixtures/startup-observer.mjs', import.meta.url), observer)
      const patch = [
        '- id: auth-remote',
        '  config:',
        ...(scenario === 'derived-port-zero'
          ? ['    host: 127.0.0.2', '    port: 0']
          : scenario === 'legacy-single'
            ? ['    allowedOrigins: [https://file.example/]']
            : scenario === 'legacy-empty'
              ? ['    allowedOrigins: []']
              : ['    publicUrl: https://file.example/', '    preserveOriginPaths: [/api]']),
        '- insert:',
        '    - id: startup-observer',
        `      name: ${observer}`,
        '',
      ].join('\n')
      await writeFile(join(profile, 'cordis.patch.yml'), patch)
      const { getRuntimeCapabilities } =
        await import('../../src/adapters/dsh/runtime-capabilities.js')
      const nativePublicUrl = getRuntimeCapabilities(dshVersion).publicUrl
      if (scenario === 'cli-public-url' && !nativePublicUrl) {
        const unsupported = spawn(
          dsh,
          ['web', '--no-open', '--public-url', 'http://final.example:8080'],
          { cwd: home, env: isolatedDshEnv(home), stdio: ['ignore', 'pipe', 'pipe'] },
        )
        let error = ''
        unsupported.stderr.on('data', (chunk: Buffer) => (error += chunk.toString('utf8')))
        assert.notEqual((await once(unsupported, 'close'))[0], 0)
        assert.match(error, /unknown option.*--public-url/u)
        return
      }
      server = spawn(
        dsh,
        [
          'web',
          '--no-open',
          ...(scenario === 'derived-port-zero' ? [] : ['--port', String(port)]),
          ...(scenario === 'cli-public-url' ? ['--public-url', 'http://final.example:8080/'] : []),
        ],
        { cwd: home, env: isolatedDshEnv(home), stdio: ['ignore', 'pipe', 'pipe'] },
      )
      let stdout = ''
      let stderr = ''
      server.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
      server.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
      let address: RegExpMatchArray | null = null
      for (let attempt = 0; attempt < 150; attempt++) {
        if (server.exitCode !== null) break
        address = stdout.match(/dsh web start at\n  (http:\/\/(127\.0\.0\.[12]):([0-9]+))/u)
        if (address) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      assert.ok(address, stderr.replace(/\?token=[^\s]+/gu, '?token=[redacted]').slice(0, 2500))
      const backend = { hostname: address[2]!, port: Number(address[3]) }
      assert.ok(backend.port > 0)
      const publicUrl =
        scenario === 'file-public-url' || scenario === 'legacy-single'
          ? 'https://file.example/'
          : scenario === 'cli-public-url'
            ? 'http://final.example:8080/'
            : `${address[1]}/`
      assert.equal(
        (await get('/auth-remote/ready', undefined, { ...backend, host: new URL(publicUrl).host }))
          .status,
        200,
      )
      if (scenario === 'cli-public-url')
        assert.equal(
          (await get('/auth-remote/ready', undefined, { ...backend, host: 'file.example' })).status,
          403,
        )
      assert.equal(
        (await get('/api/settings', undefined, { ...backend, host: new URL(publicUrl).host }))
          .status,
        401,
      )
      let observation:
        { version: string; publicUrl: string; shellUrl: string; webPrompt?: string } | undefined
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          observation = JSON.parse(await readFile(join(profile, 'entry-observation.json'), 'utf8'))
          break
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
      }
      assert.ok(observation, 'native shell registry must be observed')
      assert.equal(observation.version, dshVersion)
      assert.equal(observation.publicUrl, publicUrl)
      assert.equal(
        observation.shellUrl,
        nativePublicUrl ? publicUrl : `http://127.0.0.1:${backend.port}`,
      )
      assert.ok(
        observation.webPrompt?.includes(observation.shellUrl),
        'native model-facing Web section must use the same final address as DSH_WEB_URL',
      )
      assert.equal(observation.webPrompt.includes('?token='), false)
      if (scenario === 'cli-public-url')
        assert.equal(observation.webPrompt.includes('https://file.example'), false)
      assert.equal(stdout.includes('?token='), false)
      assert.equal(stderr.includes('?token='), false)
      assert.equal(
        (stderr.match(/allowedOrigins is deprecated/gu) ?? []).length,
        scenario.startsWith('legacy-') ? 1 : 0,
      )
      assert.equal(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'), patch)
    } finally {
      if (server && server.exitCode === null && server.signalCode === null) {
        server.kill('SIGTERM')
        await once(server, 'close')
      }
      await rm(home, { recursive: true, force: true })
    }
  })
