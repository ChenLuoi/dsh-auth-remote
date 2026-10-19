import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { parseDocument } from 'yaml'
import { fullVerificationPlan, validateVerificationPlan } from '../../scripts/packed-artifact.mjs'
import { testedDshVersions } from '../../scripts/runtime.mjs'

async function workflow(name: string) {
  const document = parseDocument(
    await readFile(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8'),
    { uniqueKeys: true },
  )
  assert.deepEqual(document.errors, [])
  return document.toJS()
}

test('release producer builds and packs once and publication consumes only the verified artifact', async () => {
  const release = await workflow('release')
  const producer = release.jobs.package
  const commands = producer.steps.map((step: any) => step.run).filter(Boolean)
  assert.equal(commands.filter((command: string) => command === 'node scripts/pack.mjs').length, 1)
  assert(commands.includes('pnpm check:static'))
  assert(commands.includes('pnpm exec tsx --test tests/integration/*.test.ts'))
  assert(
    !commands.includes('pnpm test:integration'),
    'producer must not rebuild through the integration wrapper',
  )
  assert.equal(producer.needs, 'tag')
  assert.equal(release.jobs.verify.needs, 'package')
  assert.equal(release.jobs.verify.uses, './.github/workflows/verify-packed.yml')
  assert.equal(release.jobs.verify.with.plan, 'full')
  assert.deepEqual(release.jobs.publish.needs, ['tag', 'package', 'verify'])
  assert.equal(
    release.jobs.publish.if,
    undefined,
    'default success dependency must not be overridden',
  )
  const publish = release.jobs.publish.steps.map((step: any) => step.run ?? '').join('\n')
  assert.match(publish, /packed-artifact\.mjs check/u)
  assert.match(publish, /check-npm-publication\.mjs/u)
  assert.doesNotMatch(publish, /scripts\/pack\.mjs|pnpm (?:build|release:pack|test:)/u)
  assert.equal(release.jobs.publish.permissions['id-token'], 'write')
  assert.match(release.jobs.tag.steps.at(-1).run, /merge-base --is-ancestor/u)
})

test('complete artifact matrices are exact and missing, duplicate or narrowed targets fail', () => {
  const full = fullVerificationPlan()
  assert.equal(full.versions.length, 11)
  assert.deepEqual(full.versions, testedDshVersions)
  assert.deepEqual(
    full.browser.include.map(({ dsh }: { dsh: string }) => dsh),
    full.versions,
  )
  validateVerificationPlan(full.kind, full.versions, full.browser)
  for (const versions of [[], full.versions.slice(1), [...full.versions, full.versions[0]]])
    assert.throws(
      () => validateVerificationPlan('full', versions, full.browser),
      /every exact target once/u,
    )
  const partial = structuredClone(full.browser)
  partial.include[0].suite = 'theme'
  assert.throws(
    () => validateVerificationPlan('full', full.versions, partial),
    /Full browser matrix/u,
  )
})

test('shared workflow consumers never repack and its real aggregate rejects failed, cancelled and skipped dependencies', async () => {
  const shared = await workflow('verify-packed')
  assert(shared.on.workflow_call)
  assert.deepEqual(shared.jobs.verified.needs, ['validate', 'cli-smoke', 'browser'])
  for (const name of ['cli-smoke', 'browser']) {
    const job = shared.jobs[name]
    assert.equal(job.needs, 'validate')
    assert.equal(job.strategy['fail-fast'], false)
    const commands = job.steps.map((step: any) => step.run ?? '').join('\n')
    assert.match(commands, /scripts\/verify-packed\.mjs/u)
    assert.doesNotMatch(commands, /scripts\/pack\.mjs|pnpm (?:build|release:pack|test:)/u)
    assert(job.steps.some((step: any) => step.uses === 'actions/download-artifact@v8'))
  }
  const shell = shared.jobs.verified.steps[0].run
  for (const result of ['success', 'failure', 'cancelled', 'skipped']) {
    for (const changed of ['validate', 'cli-smoke', 'browser']) {
      const needs = Object.fromEntries(
        ['validate', 'cli-smoke', 'browser'].map((name) => [
          name,
          { result: name === changed ? result : 'success' },
        ]),
      )
      const execution = spawnSync('bash', ['-e', '-c', shell], {
        encoding: 'utf8',
        env: { ...process.env, DSH_JOB_RESULTS: JSON.stringify(needs) },
      })
      if (result === 'success') assert.equal(execution.status, 0, execution.stderr)
      else assert.notEqual(execution.status, 0, `${changed}/${result} must fail the aggregate`)
    }
  }
})
