import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { parseDocument } from 'yaml'

async function ciWorkflow() {
  const document = parseDocument(
    await readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
    { uniqueKeys: true },
  )
  assert.deepEqual(document.errors, [])
  return document.toJS()
}

test('CI plans before installation, produces one artifact, and passes the selected plan to shared verification', async () => {
  const ci = await ciWorkflow()
  assert.deepEqual(ci.on.pull_request.branches, ['master'])
  assert.deepEqual(ci.on.push.branches, ['master'])
  assert(Object.hasOwn(ci.on, 'workflow_dispatch'))
  assert.deepEqual(ci.on.schedule, [{ cron: '0 0 * * 1' }])
  const plan = ci.jobs.plan
  assert.equal(plan.steps[0].with['fetch-depth'], 0)
  assert.equal(plan.steps.at(-1).run, 'node scripts/ci-plan.mjs')
  assert(!plan.steps.some((step: any) => step.uses?.startsWith('pnpm/')))
  const producer = ci.jobs.package
  assert.equal(producer.needs, 'plan')
  const commands = producer.steps.map((step: any) => step.run).filter(Boolean)
  assert.deepEqual(commands, [
    'pnpm check:static',
    'pnpm test:unit',
    'pnpm exec tsx --test tests/integration/*.test.ts',
    'node scripts/pack.mjs',
    'node scripts/packed-artifact.mjs record',
  ])
  const upload = producer.steps.at(-1)
  assert.equal(upload.uses, 'actions/upload-artifact@v7')
  assert.equal(upload.with.name, 'ci-package')
  assert.match(upload.with.path, /SHA256SUMS/u)
  assert.deepEqual(ci.jobs.runtimes.needs, ['plan', 'package'])
  assert.equal(ci.jobs.runtimes.uses, './.github/workflows/verify-packed.yml')
  assert.deepEqual(ci.jobs.runtimes.with, {
    artifact: 'ci-package',
    archive: '${{ needs.package.outputs.archive }}',
    sha256: '${{ needs.package.outputs.sha256 }}',
    plan: '${{ needs.plan.outputs.kind }}',
    versions: '${{ needs.package.outputs.versions }}',
    'browser-matrix': '${{ needs.plan.outputs.browser-matrix }}',
  })
})

test('CI Verify executes its real aggregate and rejects every failed, cancelled, skipped or missing dependency', async () => {
  const { jobs } = await ciWorkflow()
  assert.equal(jobs.verify.name, 'CI Verify')
  assert.equal(jobs.verify.if, 'always()')
  assert.deepEqual(jobs.verify.needs, ['plan', 'package', 'runtimes'])
  const shell = jobs.verify.steps[0].run
  const run = (needs: Record<string, { result: string }>) =>
    spawnSync('bash', ['-e', '-c', shell], {
      encoding: 'utf8',
      env: { ...process.env, DSH_JOB_RESULTS: JSON.stringify(needs) },
    })
  for (const result of ['success', 'failure', 'cancelled', 'skipped'])
    for (const changed of jobs.verify.needs) {
      const needs = Object.fromEntries(
        jobs.verify.needs.map((name: string) => [
          name,
          { result: name === changed ? result : 'success' },
        ]),
      )
      const executed = run(needs)
      if (result === 'success') assert.equal(executed.status, 0, executed.stderr)
      else assert.notEqual(executed.status, 0, `${changed}/${result} must fail`)
    }
  assert.notEqual(run({}).status, 0)
  assert.notEqual(run({ plan: { result: 'success' } }).status, 0)
})
