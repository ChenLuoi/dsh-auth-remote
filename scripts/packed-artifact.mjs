import assert from 'node:assert/strict'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { archive, packageManifest, testedDshVersions } from './runtime.mjs'
import { sha256, validateArchive } from './verify-packed.mjs'

export function fullVerificationPlan() {
  return {
    kind: 'full',
    versions: [...testedDshVersions],
    browser: { include: testedDshVersions.map((dsh) => ({ dsh, suite: 'browser' })) },
  }
}

export function ordinaryVerificationPlan() {
  return {
    kind: 'ordinary',
    versions: [...testedDshVersions],
    browser: {
      include: [
        { dsh: '0.2.1-alpha.3', suite: 'browser' },
        { dsh: '0.2.1-alpha.4', suite: 'host-release' },
        { dsh: '0.2.1-alpha.5', suite: 'host-release' },
        { dsh: '0.2.1-rc.1', suite: 'rc-bootstrap' },
        { dsh: '0.2.1-rc.2', suite: 'browser' },
        { dsh: '0.2.1-rc.3', suite: 'browser' },
        { dsh: '0.2.1-rc.4', suite: 'browser' },
        { dsh: '0.2.2-alpha.2', suite: 'browser' },
      ],
    },
  }
}

export function validateVerificationPlan(kind, versions, browser) {
  assert(['full', 'ordinary'].includes(kind), 'Unknown verification plan')
  const expected = kind === 'full' ? fullVerificationPlan() : ordinaryVerificationPlan()
  assert.deepEqual(
    versions,
    expected.versions,
    'CLI/smoke matrix must include every exact target once',
  )
  assert.deepEqual(
    browser,
    expected.browser,
    kind === 'full'
      ? 'Full browser matrix must include every exact target once'
      : 'Ordinary browser matrix must match every fixed boundary selection',
  )
  return expected
}

export async function checkPackedArtifact(path, expectedHash) {
  const expectedName = `${packageManifest.name}-${packageManifest.version}.tgz`
  assert.equal(basename(path), expectedName, 'Unexpected artifact filename')
  const bytes = await readFile(path)
  const { manifest } = validateArchive(bytes, expectedHash, testedDshVersions.at(-1))
  const declared = Object.entries(manifest.dsh.compatibility.dshReleases)
    .filter(([, state]) => state === 'compatible')
    .map(([version]) => version)
  assert.deepEqual(
    declared,
    testedDshVersions,
    'Archive declarations and verification targets differ',
  )
  assert.equal(
    await readFile(join(dirname(path), 'SHA256SUMS'), 'utf8'),
    `${expectedHash}  ${expectedName}\n`,
    'Checksum file differs from the producer identity',
  )
  return { archive: expectedName, sha256: expectedHash }
}

export async function recordPackedArtifact() {
  const digest = sha256(await readFile(archive))
  await writeFile(join(dirname(archive), 'SHA256SUMS'), `${digest}  ${basename(archive)}\n`)
  const identity = await checkPackedArtifact(archive, digest)
  const plan = fullVerificationPlan()
  const outputs = {
    ...identity,
    versions: JSON.stringify(plan.versions),
    'browser-matrix': JSON.stringify(plan.browser),
  }
  if (process.env.GITHUB_OUTPUT)
    await appendFile(
      process.env.GITHUB_OUTPUT,
      Object.entries(outputs)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(''),
    )
  console.log(JSON.stringify(outputs))
  return outputs
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'record' && args.length === 0) await recordPackedArtifact()
  else if (command === 'check' && args.length === 2) await checkPackedArtifact(args[0], args[1])
  else if (command === 'plan' && args.length === 0)
    validateVerificationPlan(
      process.env.DSH_VERIFY_PLAN,
      JSON.parse(process.env.DSH_VERSIONS_JSON),
      JSON.parse(process.env.DSH_BROWSER_MATRIX),
    )
  else
    throw new Error(
      'Usage: packed-artifact.mjs record | check ARCHIVE SHA256 | plan (workflow environment)',
    )
}
