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
  assert.equal(full.versions.length, 7)
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
  assert.deepEqual(shared.jobs.verified.needs, [
    'validate',
    'cli-smoke',
    'browser',
    'retired-rejection',
  ])
  for (const name of ['cli-smoke', 'browser']) {
    const job = shared.jobs[name]
    assert.equal(job.needs, 'validate')
    assert.equal(job.strategy['fail-fast'], false)
    const commands = job.steps.map((step: any) => step.run ?? '').join('\n')
    assert.match(commands, /scripts\/verify-packed\.mjs/u)
    assert.doesNotMatch(commands, /scripts\/pack\.mjs|pnpm (?:build|release:pack|test:)/u)
    assert(job.steps.some((step: any) => step.uses === 'actions/download-artifact@v8'))
  }
  const retired = shared.jobs['retired-rejection']
  assert.equal(retired.needs, 'validate')
  assert.equal(retired.if, "${{ inputs.plan == 'full' }}")
  const retiredCommands = retired.steps.map((step: any) => step.run ?? '').join('\n')
  assert.match(retiredCommands, /verify-retired\.mjs.*--retired-dsh-version 0\.2\.1-alpha\.2/u)
  assert.match(retiredCommands, /packed-artifact\.mjs check/u)
  assert.doesNotMatch(retiredCommands, /scripts\/pack\.mjs|pnpm (?:build|release:pack|test:)/u)
  assert(retired.steps.some((step: any) => step.uses === 'actions/download-artifact@v8'))
  assert.equal(shared.jobs.verified.steps[0].env.DSH_VERIFY_PLAN, '${{ inputs.plan }}')
  const shell = shared.jobs.verified.steps[0].run
  const names = ['validate', 'cli-smoke', 'browser', 'retired-rejection']
  const execute = (plan: string, jobs: Record<string, { result: string }>) =>
    spawnSync('bash', ['-e', '-c', shell], {
      encoding: 'utf8',
      env: { ...process.env, DSH_VERIFY_PLAN: plan, DSH_JOB_RESULTS: JSON.stringify(jobs) },
    })
  for (const plan of ['full', 'ordinary']) {
    const expected = Object.fromEntries(
      names.map((name) => [
        name,
        { result: plan === 'ordinary' && name === 'retired-rejection' ? 'skipped' : 'success' },
      ]),
    )
    assert.equal(execute(plan, expected).status, 0)
    for (const changed of names)
      for (const result of ['success', 'failure', 'cancelled', 'skipped']) {
        const jobs = structuredClone(expected)
        jobs[changed]!.result = result
        const execution = execute(plan, jobs)
        if (result === expected[changed]!.result)
          assert.equal(execution.status, 0, execution.stderr)
        else
          assert.notEqual(
            execution.status,
            0,
            `${plan}/${changed}/${result} must fail the aggregate`,
          )
      }
    for (const missing of names) {
      const jobs = structuredClone(expected)
      delete jobs[missing]
      assert.notEqual(execute(plan, jobs).status, 0)
    }
    assert.notEqual(execute('unknown', expected).status, 0)
  }
})
