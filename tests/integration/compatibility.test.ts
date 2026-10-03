import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import semver from 'semver'
import { testedDshVersions } from '../../scripts/runtime.mjs'
import {
  assertConnectionCompatibility,
  assertWebServerCompatibility,
  SUPPORTED_DSH_RANGE,
} from '../../src/adapters/dsh/compatibility.js'

const require = createRequire(import.meta.url)

test('declared compatible DSH releases match the verified runtime targets', () => {
  const manifest = require('../../package.json')
  assert.deepEqual(
    manifest.dsh.compatibility.dshReleases,
    Object.fromEntries(testedDshVersions.map((version) => [version, 'compatible'])),
  )
})

test('DSH loader peer range and runtime gate admit upgrades, including prereleases', () => {
  const manifest = require('../../package.json')
  const peers = Object.entries(manifest.peerDependencies).filter(([name]) =>
    name.startsWith('@deepseek-ai/dsh-'),
  )
  assert.ok(peers.length > 0)
  for (const [, range] of peers) assert.equal(range, SUPPORTED_DSH_RANGE)
  // DSH preflight explicitly includes prereleases. These future examples test
  // version admission only, not the compatibility of unreleased host APIs.
  for (const version of [
    '0.1.7-rc.1',
    '0.1.7-rc.2',
    '0.2.0-rc.1',
    '0.2.0-rc.2',
    '0.2.0',
    '0.2.1-alpha.1',
    '0.2.1-rc.1',
    '0.3.0-rc.1',
    '1.0.0',
  ]) {
    assert.equal(semver.satisfies(version, SUPPORTED_DSH_RANGE, { includePrerelease: true }), true)
  }
  for (const version of ['0.1.6', '0.1.7-alpha.1', 'invalid']) {
    assert.equal(semver.satisfies(version, SUPPORTED_DSH_RANGE, { includePrerelease: true }), false)
  }
})

test('forward version admission still rejects missing native authentication capabilities', () => {
  const methods = ['authenticatedUrl', 'authorizeIndex', 'requestRejection']
  for (const missing of methods) {
    const connection = Object.fromEntries(
      methods.filter((method) => method !== missing).map((method) => [method, () => {}]),
    ) as unknown as HostConnectionHandle
    assert.throws(() => assertConnectionCompatibility(connection), {
      message: `auth-remote: Connection lacks ${missing}`,
    })
  }
})

test('forward version admission still rejects duplicate host package copies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'auth-remote-compatibility-'))
  const ctx = new Context()
  const anchor = join(directory, 'package.json')
  try {
    for (const name of ['dsh-host-webserver', 'dsh-client-connection']) {
      const packageName = `@deepseek-ai/${name}`
      const path = join(directory, 'node_modules', packageName)
      await mkdir(path, { recursive: true })
      await writeFile(
        join(path, 'package.json'),
        JSON.stringify(require(`${packageName}/package.json`)),
      )
    }
    ctx.provide('profileContext', { installAnchor: anchor } as never)
    assert.throws(() => assertWebServerCompatibility(ctx), /duplicate WebServer package copies/u)
    assert.throws(
      () => assertConnectionCompatibility({} as HostConnectionHandle, anchor),
      /duplicate Connection package copies/u,
    )
  } finally {
    await ctx.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
