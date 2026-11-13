import assert from 'node:assert/strict'
import { once } from 'node:events'
import { appendFile, copyFile, cp, readFile, realpath, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { checkDshVersion } from '../../scripts/runtime.mjs'
import { sha256 } from '../../scripts/verify-packed.mjs'
import { assertNoListener } from '../../scripts/verify-retired.mjs'
import {
  assertInstalledCandidate,
  maintenanceRetiredDshVersions,
  requiredTestNames,
  validateMaintenanceArchive,
} from '../../scripts/verify-maintenance-retired.mjs'
import { packedAdmin, packedCommand, packedProfile } from '../helpers/packed-runtime.js'
import { nativeHttp } from '../helpers/native-http.js'

const version = process.env.DSH_MAINTENANCE_VERSION!
const binary = process.env.DSH_MAINTENANCE_BINARY!
const archive = process.env.DSH_MAINTENANCE_ARCHIVE!
const digest = process.env.DSH_MAINTENANCE_SHA256!
assert(
  maintenanceRetiredDshVersions.includes(version),
  'Explicit maintenance-retired target required',
)
assert(binary && archive && digest, 'Explicit binary/archive/digest required')
checkDshVersion(binary, version)
const candidate = validateMaintenanceArchive(await readFile(archive), digest, version)
const names = requiredTestNames(version)
const password = 'isolated maintenance retirement password 123'
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until<T>(
  read: () => Promise<T> | T,
  accept: (value: T) => boolean,
  timeout = 30_000,
) {
  const deadline = Date.now() + timeout
  let value: T
  do {
    value = await read()
    if (accept(value)) return value
    await delay(100)
  } while (Date.now() < deadline)
  assert.fail('Maintenance observation timed out: ' + JSON.stringify(value!))
}

async function fixture() {
  const listener = createServer().listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const address = listener.address()
  assert(address && typeof address !== 'string')
  const port = address.port
  await new Promise<void>((resolve) => listener.close(() => resolve()))
  const f = await packedProfile({ port, requireTotp: false }, false, { binary, archive })
  try {
    await appendFile(join(f.profile, 'cordis.patch.yml'), '- id: webserver\n  disabled: true\n')
    const directory = await realpath(join(f.profile, 'node_modules/dsh-auth-remote'))
    await assertInstalledCandidate(directory, f.home, candidate.files)
    return {
      ...f,
      port,
      directory,
      entry: join(directory, 'dist/index.js'),
      origin: `http://127.0.0.1:${port}`,
    }
  } catch (error) {
    await f.cleanup()
    throw error
  }
}

function start(f: Awaited<ReturnType<typeof fixture>>) {
  return packedCommand(
    f.home,
    ['web', '--no-open', '--host', '127.0.0.1', '--port', String(f.port)],
    f.cwd,
    {},
    binary,
  )
}

test(names[0]!, { timeout: 120_000 }, async (t) => {
  const f = await fixture()
  let server: ReturnType<typeof packedCommand> | undefined
  try {
    await packedAdmin(
      f.home,
      'init',
      [
        ['Username: ', 'alice'],
        ['Password: ', password],
        ['Enter password again: ', password],
      ],
      binary,
    )
    const probe = join(f.profile, 'hmr-config-probe.mjs')
    await copyFile(new URL('../fixtures/hmr-config-probe.mjs', import.meta.url), probe)
    const patch = join(f.profile, 'cordis.patch.yml')
    await appendFile(
      patch,
      `- insert:\n    - id: maintenance-hmr-probe\n      name: ${JSON.stringify(probe)}\n      inject: [webServer, hmr]\n`,
    )
    server = start(f)
    const active = server
    const warning = `auth-remote: DSH ${version} retired on 2026-11-13 in plugin 0.3.6; last supported plugin 0.3.5.`
    await until(
      async () => {
        if (active.child.exitCode !== null) assert.fail(active.output().combined)
        return nativeHttp(f.origin, '/auth-remote/ready')
          .then((r) => r.status)
          .catch(() => 0)
      },
      (status) => status === 200,
    )
    const initial = server.output().combined
    assert(initial.includes(warning), initial)
    assert(initial.includes('Upgrade to DSH 0.2.2-rc.2'))
    assert(
      initial.indexOf(warning) < initial.indexOf('dsh web start at'),
      'retirement warning must precede startup readiness output',
    )
    assert.equal(
      (await nativeHttp(f.origin, '/api/settings/describe', { method: 'POST', body: '{}' })).status,
      401,
    )
    const login = await nativeHttp(f.origin, '/auth-remote/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'alice', password }),
    })
    assert.equal(login.status, 200, login.body)
    const cookie = login.headers['set-cookie']![0]!.split(';')[0]!
    const state = async () => {
      const response = await nativeHttp(f.origin, '/plugins/hmr-config/state', { cookie })
      assert.equal(response.status, 200, response.body)
      return JSON.parse(response.body) as { generation: number }
    }
    const before = await state()
    const saved = await readFile(patch, 'utf8')
    const changed = saved.replace(/^( +)requireTotp: false$/mu, '$&\n$1sessionHours: 169')
    assert.notEqual(saved, changed)
    await writeFile(patch, changed)
    const configured = await until(
      () => state().catch(() => ({ generation: before.generation })),
      (value) => value.generation > before.generation,
    )
    assert.equal((await nativeHttp(f.origin, '/auth-remote/me', { cookie })).status, 200)
    // Native source HMR is opt-in and excludes node_modules; use the same
    // watchable installed-package copy as the existing account lifecycle tests.
    const watchable = join(f.profile, 'maintenance-source-package')
    await cp(f.directory, watchable, {
      recursive: true,
      filter: (path) => path !== join(f.directory, 'node_modules'),
    })
    await assertInstalledCandidate(watchable, f.home, candidate.files)
    const sourceEntry = join(watchable, 'dist/index.js')
    const sourcePatch =
      changed.replace(
        '- id: auth-remote\n  config:',
        `- id: auth-remote\n  disabled: true\n- insert:\n    - id: maintenance-source-probe\n      name: ${JSON.stringify(pathToFileURL(sourceEntry).href)}\n      inject: [webStartup]\n- id: maintenance-source-probe\n  config:`,
      ) +
      `- id: hmr\n  config:\n    base: ${JSON.stringify(f.profile)}\n    root: [maintenance-source-package/dist]\n`
    assert.notEqual(sourcePatch, changed)
    await writeFile(patch, sourcePatch)
    const prepared = await until(
      () => state().catch(() => ({ generation: configured.generation })),
      (value) => value.generation > configured.generation,
    )
    assert.equal((await nativeHttp(f.origin, '/auth-remote/me', { cookie })).status, 200)
    const marker = 'maintenance retirement real source HMR ' + version
    await appendFile(sourceEntry, '\nconsole.info(' + JSON.stringify(marker) + ');\n')
    await until(
      () => server!.output().combined,
      (output) => output.includes(marker),
    )
    const reloaded = await until(
      () => state().catch(() => ({ generation: prepared.generation })),
      (value) => value.generation > prepared.generation,
    )
    assert.equal((await nativeHttp(f.origin, '/auth-remote/me', { cookie })).status, 200)
    assert.equal(
      server.output().combined.split(warning).length - 1,
      1,
      'configuration/source HMR must not repeat the retirement warning',
    )
    await packedAdmin(
      f.home,
      'revoke-sessions',
      [['Enter web to confirm revoke-sessions: ', 'web']],
      binary,
    )
    assert.equal((await nativeHttp(f.origin, '/auth-remote/me', { cookie })).status, 401)
    assert.equal(
      (await nativeHttp(f.origin, '/api/settings/describe', { cookie, method: 'POST', body: '{}' }))
        .status,
      401,
    )
    t.diagnostic(
      JSON.stringify({
        dsh: version,
        installedFiles: candidate.files.size,
        copy: true,
        warningBeforeReady: true,
        warningCount: 1,
        generations: [
          before.generation,
          configured.generation,
          prepared.generation,
          reloaded.generation,
        ],
        archiveSha256: digest,
      }),
    )
  } finally {
    await server?.stop()
    await f.cleanup()
    assert.equal(sha256(await readFile(archive)), digest)
  }
})

for (const [index, fault] of ['loader', 'runtime'].entries())
  test(names[index + 1]!, { timeout: 90_000 }, async (t) => {
    const f = await fixture()
    let server: ReturnType<typeof packedCommand> | undefined
    try {
      const patch = await readFile(join(f.profile, 'cordis.patch.yml'), 'utf8')
      const marker = 'maintenance rejection module imported ' + version
      await appendFile(f.entry, '\nconsole.info(' + JSON.stringify(marker) + ');\n')
      if (fault === 'loader') {
        const path = join(f.directory, 'package.json')
        const manifest = JSON.parse(await readFile(path, 'utf8'))
        if (version === '0.2.1-alpha.3')
          manifest.peerDependencies['@deepseek-ai/dsh-host-webserver'] = '>=99.0.0'
        else manifest.engines.dsh = '>=99.0.0'
        await writeFile(path, JSON.stringify(manifest, null, 2) + '\n')
      } else {
        const source = await readFile(f.entry, 'utf8')
        const range = /\bvar SUPPORTED_DSH_RANGE = ">=0\.2\.1-alpha\.3";/gu
        assert.equal([...source.matchAll(range)].length, 1)
        await writeFile(f.entry, source.replace(range, 'var SUPPORTED_DSH_RANGE = ">=99.0.0";'))
      }
      await assertNoListener(f.port)
      server = start(f)
      const active = server
      const expected =
        fault === 'loader'
          ? /skipping profile bundle "dsh-auth-remote":.*incompatible with dsh/u
          : /auth-remote: unsupported @deepseek-ai\/dsh-host-webserver version/u
      await until(
        () => active.output().combined,
        (output) => expected.test(output),
      )
      const output = server.output().combined
      if (fault === 'loader') {
        assert(output.includes('>=99.0.0'), output)
        assert(output.includes(version), output)
        assert(
          output.includes(version === '0.2.1-alpha.3' ? 'peerDependencies' : 'engines.dsh'),
          output,
        )
        assert(!output.includes(marker), 'Loader imported the rejected candidate')
      } else {
        assert(output.includes(marker), output)
        assert(output.includes(`version ${version}`), output)
      }
      for (let attempt = 0; attempt < 10; attempt++) {
        await assertNoListener(f.port)
        await delay(100)
      }
      assert.doesNotMatch(
        server.output().combined,
        /dsh web(?: start at|:)|public access at|\?token=/u,
      )
      assert.equal(await readFile(join(f.profile, 'cordis.patch.yml'), 'utf8'), patch)
      t.diagnostic(
        JSON.stringify({
          dsh: version,
          fault,
          installedFiles: candidate.files.size,
          copy: true,
          noTcpHttpReadinessWebSocket: true,
          nativeExitCode: server.child.exitCode,
          archiveSha256: digest,
        }),
      )
    } finally {
      await server?.stop()
      await f.cleanup()
      assert.equal(sha256(await readFile(archive)), digest)
    }
  })
