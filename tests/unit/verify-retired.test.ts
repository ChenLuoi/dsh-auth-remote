import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { link, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { RETIRED_DSH_RELEASES } from '../../src/shared/dsh-support.js'
import { packageManifest, testedDshVersions } from '../../scripts/runtime.mjs'
import { sha256 } from '../../scripts/verify-packed.mjs'
import {
  assertNoListener,
  installedFiles,
  nativePeerRefusal,
  parseArguments,
  replaceInstalledPackage,
  retiredDshVersions,
  verifyRetired,
} from '../../scripts/verify-retired.mjs'

test('retired selection is independent, exact and rejects malformed inputs before any execution', () => {
  assert.deepEqual(
    retiredDshVersions,
    RETIRED_DSH_RELEASES.map(({ version }) => version),
  )
  assert(retiredDshVersions.every((version) => !testedDshVersions.includes(version)))
  const valid = [
    '--archive',
    '/tmp/dsh-auth-remote-0.3.1.tgz',
    '--sha256',
    'a'.repeat(64),
    '--retired-dsh-version',
    '0.2.1-alpha.2',
  ]
  for (const version of retiredDshVersions)
    assert.equal(
      parseArguments(valid.map((value) => (value === '0.2.1-alpha.2' ? version : value)))[
        'retired-dsh-version'
      ],
      version,
    )
  for (const version of [...testedDshVersions, 'invalid', '0.1.6'])
    assert.throws(
      () => parseArguments(valid.map((value) => (value === '0.2.1-alpha.2' ? version : value))),
      /exact retired-dsh-version/u,
    )
  assert.throws(() => parseArguments([...valid, '--suite', 'browser']), /Unknown option/u)
  assert.throws(() => parseArguments([...valid, '--sha256', 'b'.repeat(64)]), /Duplicate/u)
  assert.throws(() => parseArguments(valid.slice(0, -1)), /Missing value/u)
  assert.throws(
    () => parseArguments(valid.map((value) => (value === 'a'.repeat(64) ? 'wrong' : value))),
    /lowercase SHA-256/u,
  )
})

test('retired consumer reuses digest, checksum and complete nine-version archive checks before runtime work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retired-archive-'))
  try {
    const packageRoot = join(root, 'package')
    await mkdir(join(packageRoot, 'dist/types'), { recursive: true })
    for (const file of [
      'index.js',
      'cli.js',
      'client.js',
      'login.js',
      'login.css',
      'types/index.d.ts',
    ])
      await writeFile(join(packageRoot, 'dist', file), 'fixture')
    const archive = join(root, `dsh-auth-remote-${packageManifest.version}.tgz`)
    const pack = async (manifest: unknown) => {
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify(manifest))
      const result = spawnSync('tar', ['-czf', archive, '-C', root, 'package'], {
        encoding: 'utf8',
      })
      assert.equal(result.status, 0, result.stderr)
      const bytes = await readFile(archive)
      await writeFile(
        join(root, 'SHA256SUMS'),
        `${sha256(bytes)}  dsh-auth-remote-${packageManifest.version}.tgz\n`,
      )
      return sha256(bytes)
    }
    const digest = await pack(packageManifest)
    const options = { archive, sha256: '0'.repeat(64), 'retired-dsh-version': '0.2.1-alpha.2' }
    await assert.rejects(verifyRetired(options), /SHA-256 mismatch/u)
    await writeFile(join(root, 'SHA256SUMS'), 'wrong\n')
    await assert.rejects(verifyRetired({ ...options, sha256: digest }), /Checksum file/u)
    const narrowed = structuredClone(packageManifest)
    delete narrowed.dsh.compatibility.dshReleases['0.2.1-alpha.3']
    const partial = await pack(narrowed)
    await assert.rejects(
      verifyRetired({ ...options, sha256: partial }),
      /declarations and verification targets differ/u,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('whole-package replacement refuses shared files and external targets while preserving actual dependency links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retired-private-'))
  const home = join(root, 'home')
  const target = join(home, 'profile/node_modules/plugin')
  const outside = join(root, 'outside')
  try {
    await mkdir(join(target, 'node_modules'), { recursive: true })
    await mkdir(outside)
    await writeFile(join(target, 'package.json'), 'old manifest')
    await writeFile(join(target, 'obsolete.txt'), 'old exclusive file')
    await symlink(outside, join(target, 'node_modules/real-peer'))
    const candidate = new Map([
      ['package.json', Buffer.from('whole new manifest')],
      ['dist/index.js', Buffer.from('new implementation')],
      ['docs/guide.md', Buffer.from('new guide')],
    ])
    await writeFile(join(outside, 'shared'), 'must remain untouched')
    await link(join(outside, 'shared'), join(target, 'shared'))
    await assert.rejects(
      replaceInstalledPackage(target, home, candidate),
      /Shared package hardlink/u,
    )
    assert.equal(await readFile(join(outside, 'shared'), 'utf8'), 'must remain untouched')
    await rm(join(target, 'shared'))
    await assert.rejects(replaceInstalledPackage(outside, home, candidate), /must belong/u)
    await assert.rejects(
      replaceInstalledPackage(target, home, new Map([['../escape', Buffer.from('bad')]])),
      /Unsafe package/u,
    )
    assert.equal(await readFile(join(target, 'obsolete.txt'), 'utf8'), 'old exclusive file')
    await replaceInstalledPackage(target, home, candidate)
    assert.deepEqual(await installedFiles(target, true), candidate)
    assert.equal(await readlink(join(target, 'node_modules/real-peer')), outside)
    await assert.rejects(readFile(join(target, 'obsolete.txt')), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('native refusal requires actual bundle skip and complete peer facts without imposing one log layout', () => {
  const issue = `Plugin dsh-auth-remote@${packageManifest.version} is incompatible with dsh 0.2.1-alpha.2: peerDependencies {"@deepseek-ai/dsh-host-webserver":">=0.2.1-alpha.3"}`
  for (const output of [
    `skipping profile bundle "dsh-auth-remote": ${issue}`,
    `${issue}\nBundle dsh-auth-remote skipped.`,
  ])
    assert.equal(nativePeerRefusal(output, '0.2.1-alpha.2'), true)
  for (const output of [
    issue,
    `skipping profile bundle "other": ${issue}`,
    issue.replace('peerDependencies', 'engines.dsh'),
  ])
    assert.equal(nativePeerRefusal(output, '0.2.1-alpha.2'), false)
  assert.equal(nativePeerRefusal(`Bundle dsh-auth-remote skipped.\n${issue}`, '0.2.1-rc.4'), false)
})

test('TCP/HTTP/readiness/WebSocket refusal probes fail on a real listener and accept a closed port', async () => {
  const server = createServer((_request, response) => response.end('exposed')).listen(
    0,
    '127.0.0.1',
  )
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address !== 'string')
  try {
    await assert.rejects(assertNoListener(address.port), { code: 'ERR_ASSERTION' })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  await assertNoListener(address.port)
})
