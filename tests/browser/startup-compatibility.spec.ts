import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { appendFile, copyFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import semver from 'semver'
import { checkDshVersion, dshVersion, isolatedDshEnv } from '../../scripts/runtime.mjs'
import { archive, dsh } from '../helpers/runtime.js'
import { packedCommand, packedProfile } from '../helpers/packed-runtime.js'
import { nativeHttp } from '../helpers/native-http.js'
import { getRuntimeCapabilities } from '../../src/adapters/dsh/runtime-capabilities.js'

const port = 13130

async function vacantPort() {
  const listener = createServer().listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const address = listener.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>((resolve) => listener.close(() => resolve()))
  return address.port
}

async function assertNoListener(port: number) {
  await assert.rejects(
    new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port })
      socket.setTimeout(1000, () => socket.destroy(new Error('listener probe timed out')))
      socket.once('connect', () => {
        socket.destroy()
        resolve()
      })
      socket.once('error', reject)
    }),
    { code: 'ECONNREFUSED' },
  )
  for (const path of ['/auth-remote/ready', '/', '/api/settings/describe'])
    await assert.rejects(nativeHttp(`http://127.0.0.1:${port}`, path), { code: 'ECONNREFUSED' })
  await assert.rejects(
    nativeHttp(`http://127.0.0.1:${port}`, '/api', {
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    }),
    { code: 'ECONNREFUSED' },
  )
}

// These deliberately damaged plugin copies exercise rejection, not compatibility.
// The upstream packages, their versions and the Loader audit remain unchanged.
if (['0.2.1-rc.1', '0.2.1-rc.2'].includes(dshVersion))
  for (const fault of ['loader-requirement', 'runtime-admission'] as const)
    test(`DSH ${dshVersion} keeps the native listener disabled after ${fault} rejection`, async () => {
      const f = await packedProfile({})
      const port = await vacantPort()
      let command: ReturnType<typeof packedCommand> | undefined
      try {
        const patchPath = join(f.profile, 'cordis.patch.yml')
        await appendFile(patchPath, '- id: webserver\n  disabled: true\n')
        const patch = await readFile(patchPath, 'utf8')
        const plugin = join(f.profile, 'node_modules/dsh-auth-remote')
        const entry = join(plugin, 'dist/index.js')
        const manifestPath = join(plugin, 'package.json')
        assert.equal((await stat(entry)).nlink, 1)
        assert.equal((await stat(manifestPath)).nlink, 1)
        const marker = 'auth-remote rejection probe module imported'
        await appendFile(entry, '\nconsole.info(' + JSON.stringify(marker) + ');\n')
        if (fault === 'loader-requirement') {
          const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
          manifest.engines.dsh = '>=99.0.0'
          await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
        } else {
          const source = await readFile(entry, 'utf8')
          const range = /\bvar SUPPORTED_DSH_RANGE = ">=0\.1\.7-rc\.1";/gu
          assert.equal([...source.matchAll(range)].length, 1)
          await writeFile(entry, source.replace(range, 'var SUPPORTED_DSH_RANGE = ">=99.0.0";'))
        }
        await assertNoListener(port)
        command = packedCommand(f.home, ['web', '--no-open', '--port', String(port)], f.cwd)
        const diagnostic =
          fault === 'loader-requirement'
            ? /skipping profile bundle "dsh-auth-remote":.*incompatible with dsh/u
            : /auth-remote: unsupported @deepseek-ai\/dsh-host-webserver version/u
        for (let attempt = 0; attempt < 150; attempt++) {
          const { stdout, stderr } = command.output()
          if (diagnostic.test(stdout + stderr)) break
          if (command.child.exitCode !== null) break
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        const { stdout, stderr } = command.output()
        assert.match(stdout + stderr, diagnostic)
        if (fault === 'loader-requirement') {
          assert.match(stderr, /"engines.dsh":">=99\.0\.0"/u)
          assert.doesNotMatch(stdout, new RegExp(marker, 'u'))
        } else {
          assert.ok(stdout.includes(marker), stdout + stderr)
          assert.ok(stderr.includes(`version ${dshVersion}`), stderr)
        }
        // Recheck over time: a skipped bundle must not permit delayed fallback.
        for (let attempt = 0; attempt < 5; attempt++) {
          await assertNoListener(port)
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          const result = await Promise.race([
            command.done,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error('Rejected DSH startup did not settle')),
                20_000,
              )
            }),
          ])
          assert.notEqual(result.code, 0, result.stdout + result.stderr)
          assert.notEqual(result.code, null, 'startup must fail before the fixture terminates it')
        } finally {
          clearTimeout(timer)
        }
        await assertNoListener(port)
        assert.doesNotMatch(command.output().stdout, /dsh web start at|public access at/u)
        assert.equal(await readFile(patchPath, 'utf8'), patch)
      } finally {
        await command?.stop()
        await f.cleanup()
      }
    })

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
        | {
            version: string
            publicUrl: string
            shellUrl: string
            webPrompt: string
            webContext?: string
          }
        | undefined
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
      const runtimeContext = semver.gte(dshVersion, '0.2.1-alpha.3')
      const modelUrlText = runtimeContext ? observation.webContext : observation.webPrompt
      assert.ok(
        modelUrlText?.includes(observation.shellUrl),
        'native model-facing Web address must match DSH_WEB_URL',
      )
      if (runtimeContext) assert.equal(observation.webPrompt.includes(observation.shellUrl), false)
      assert.equal(observation.webPrompt.includes('?token='), false)
      assert.equal(observation.webContext?.includes('?token=') ?? false, false)
      if (scenario === 'cli-public-url')
        assert.equal(modelUrlText.includes('https://file.example'), false)
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
