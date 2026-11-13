import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { parseDocument } from 'yaml'
import {
  fullVerificationPlan,
  maintenanceRetirementRequired,
  validateVerificationPlan,
} from '../../scripts/packed-artifact.mjs'
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
  assert.match(publish, /packed-artifact\.mjs producer-check/u)
  assert.match(publish, /check-npm-publication\.mjs/u)
  assert.doesNotMatch(publish, /scripts\/pack\.mjs|pnpm (?:build|release:pack|test:)/u)
  assert.equal(release.jobs.publish.permissions['id-token'], 'write')
  assert.match(release.jobs.tag.steps.at(-1).run, /merge-base --is-ancestor/u)
  assert.match(
    producer.steps.find((step: any) => step.uses === 'actions/upload-artifact@v7').with.path,
    /producer\.json/u,
  )
})

test('complete artifact matrices are exact and missing, duplicate or narrowed targets fail', () => {
  const full = fullVerificationPlan()
  assert.equal(full.versions.length, 8)
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
    'maintenance-retirement',
  ])
  for (const name of ['cli-smoke', 'browser', 'maintenance-retirement']) {
    const job = shared.jobs[name]
    assert.equal(job.needs, 'validate')
    assert.equal(job.strategy['fail-fast'], false)
    const commands = job.steps.map((step: any) => step.run ?? '').join('\n')
    assert.match(
      commands,
      name === 'maintenance-retirement'
        ? /scripts\/verify-maintenance-retired\.mjs/u
        : /scripts\/verify-packed\.mjs/u,
    )
    assert.match(commands, /producer-check/u)
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
  const maintenance = shared.jobs['maintenance-retirement']
  assert.equal(
    maintenance.if,
    "${{ needs.validate.outputs.maintenance-retirement-required == 'true' }}",
  )
  assert.deepEqual(maintenance.strategy.matrix.dsh, [
    '0.2.1-alpha.3',
    '0.2.1-alpha.4',
    '0.2.1-alpha.5',
  ])
  assert.equal(
    shared.jobs.validate.outputs['maintenance-retirement-required'],
    '${{ steps.identity.outputs.maintenance-retirement-required }}',
  )
  const validate = shared.jobs.validate.steps.find((step: any) => step.id === 'identity')
  assert.match(validate.run, /packed-artifact\.mjs gate/u)
  assert.match(validate.run, /packed-artifact\.mjs producer-check/u)
  const aggregate = shared.jobs.verified.steps.find(
    (step: any) => step.name === 'Require every planned job to succeed',
  )
  assert.equal(aggregate.env.DSH_VERIFY_PLAN, '${{ inputs.plan }}')
  const shell = aggregate.run
  const names = ['validate', 'cli-smoke', 'browser', 'retired-rejection', 'maintenance-retirement']
  const execute = (plan: string, jobs: Record<string, { result: string }>) =>
    spawnSync('bash', ['-e', '-c', shell], {
      encoding: 'utf8',
      env: { ...process.env, DSH_VERIFY_PLAN: plan, DSH_JOB_RESULTS: JSON.stringify(jobs) },
    })
  for (const [plan, required] of [
    ['full', 'true'],
    ['full', 'false'],
    ['ordinary', 'false'],
  ]) {
    const expected = Object.fromEntries(
      names.map((name) => [
        name,
        {
          result:
            (plan === 'ordinary' && name === 'retired-rejection') ||
            (required === 'false' && name === 'maintenance-retirement')
              ? 'skipped'
              : 'success',
        },
      ]),
    )
    Object.assign(expected.validate!, { outputs: { 'maintenance-retirement-required': required } })
    assert.equal(execute(plan, expected).status, 0)
    for (const changed of names)
      for (const result of ['success', 'failure', 'cancelled', 'skipped', 'unknown']) {
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
    for (const invalid of [undefined, '', 'unknown', 'TRUE']) {
      const jobs = structuredClone(expected)
      Object.assign(jobs.validate!, {
        outputs: invalid === undefined ? {} : { 'maintenance-retirement-required': invalid },
      })
      assert.notEqual(execute(plan, jobs).status, 0, 'missing/unknown requirement must fail')
    }
  }
  const index = shared.jobs.verified.steps.find(
    (step: any) => step.name === 'Bind complete raw evidence to this producer',
  )
  assert.match(index.run, /packed-artifact\.mjs index/u)
  assert.match(index.run, /\.cache\/acceptance-evidence artifacts\/acceptance-index\.json/u)
  assert(
    shared.jobs.verified.steps.some(
      (step: any) =>
        step.uses === 'actions/upload-artifact@v7' &&
        step.with.path === 'artifacts/acceptance-index.json',
    ),
  )
})

test('maintenance CI requirement is derived only from validated plugin0.3.6 and full plan', () => {
  for (const version of ['0.3.5', '0.3.6', '0.3.7', '0.4.0'])
    for (const plan of ['full', 'ordinary'])
      assert.equal(
        maintenanceRetirementRequired(version, plan),
        version === '0.3.6' && plan === 'full',
      )
  assert.throws(
    () => maintenanceRetirementRequired('0.3.6', 'unknown'),
    /Unknown verification plan/u,
  )
  assert.throws(
    () => maintenanceRetirementRequired(undefined, 'full'),
    /Missing validated package version/u,
  )
})
