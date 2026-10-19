import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  ordinaryPaths,
  parseNameStatus,
  planFromGit,
  selectCiPlan,
} from '../../scripts/ci-plan.mjs'
import {
  ordinaryVerificationPlan,
  validateVerificationPlan,
} from '../../scripts/packed-artifact.mjs'

test('only the six exact low-risk paths select ordinary verification on PR and push', () => {
  assert.equal(ordinaryPaths.size, 6)
  for (const event of ['pull_request', 'push'])
    for (const path of ordinaryPaths)
      assert.equal(
        selectCiPlan({ event, changes: [{ status: 'M', path }], complete: true }).kind,
        'ordinary',
      )
  for (const path of [
    'src/index.ts',
    'scripts/ci-plan.mjs',
    '.github/workflows/ci.yml',
    'package.json',
    'pnpm-lock.yaml',
    'README.md',
    'docs/support-policy.md',
    'docs/legacy-compatibility.zh-CN.md',
    'tests/helpers/runtime.ts',
    'tests/browser/login.spec.ts',
    'tests/unit/config.test.ts',
    'unknown',
    './LICENSE',
    'LICENSE/extra',
  ])
    assert.equal(
      selectCiPlan({
        event: 'pull_request',
        changes: [
          { status: 'M', path: 'LICENSE' },
          { status: 'M', path },
        ],
        complete: true,
      }).kind,
      'full',
      path,
    )
})

test('unknown events, manual and weekly events, incomplete/empty input and renames always select full', () => {
  for (const event of ['schedule', 'workflow_dispatch', 'release', 'unknown'])
    assert.equal(
      selectCiPlan({ event, changes: [{ status: 'M', path: 'LICENSE' }], complete: true }).kind,
      'full',
    )
  assert.equal(selectCiPlan({ event: 'push', changes: [], complete: true }).kind, 'full')
  assert.equal(
    selectCiPlan({ event: 'push', changes: [{ status: 'M', path: 'LICENSE' }] }).kind,
    'full',
  )
  for (const status of ['R100', 'C100', 'T', 'U'])
    assert.equal(
      selectCiPlan({ event: 'push', changes: [{ status, path: 'LICENSE' }], complete: true }).kind,
      'full',
    )
  assert.deepEqual(parseNameStatus('R100\0old file\0LICENSE\0M\0CHANGELOG.md\0'), [
    { status: 'R100', path: 'LICENSE', previousPath: 'old file' },
    { status: 'M', path: 'CHANGELOG.md' },
  ])
  assert.throws(() => parseNameStatus('M\0LICENSE'), /Truncated/u)
})

test('ordinary matrices retain all CLI targets and every fixed capability boundary', () => {
  const ordinary = ordinaryVerificationPlan()
  assert.equal(ordinary.versions.length, 11)
  assert.equal(ordinary.browser.include.length, 10)
  validateVerificationPlan(ordinary.kind, ordinary.versions, ordinary.browser)
  assert.deepEqual(
    ordinary.browser.include
      .filter(({ suite }: { suite: string }) => suite === 'browser')
      .map(({ dsh }: { dsh: string }) => dsh),
    ['0.1.7-rc.1', '0.2.0-rc.2', '0.2.1-rc.2'],
  )
  const missing = structuredClone(ordinary.browser)
  missing.include.pop()
  assert.throws(
    () => validateVerificationPlan('ordinary', ordinary.versions, missing),
    /fixed boundary selection/u,
  )
})

test('git event planning compares actual base/head and falls back for unavailable refs or dirty source', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ci-plan-git-'))
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  try {
    git('init', '-q')
    git('config', 'user.name', 'CI fixture')
    git('config', 'user.email', 'fixture@example.test')
    await writeFile(join(cwd, 'LICENSE'), 'first\n')
    git('add', '.')
    git('commit', '-qm', 'base')
    const base = git('rev-parse', 'HEAD')
    await writeFile(join(cwd, 'LICENSE'), 'second\n')
    git('commit', '-qam', 'low risk')
    const head = git('rev-parse', 'HEAD')
    assert.equal(planFromGit('push', { before: base, after: head }, cwd).kind, 'ordinary')
    assert.equal(
      planFromGit(
        'pull_request',
        { pull_request: { base: { sha: base }, head: { sha: head } } },
        cwd,
      ).kind,
      'ordinary',
    )
    assert.equal(planFromGit('push', { before: '0'.repeat(40), after: head }, cwd).kind, 'full')
    assert.equal(planFromGit('push', { before: 'a'.repeat(40), after: head }, cwd).kind, 'full')
    git('switch', '-qc', 'base-update', base)
    await writeFile(join(cwd, 'CONTRIBUTING.md'), 'base branch documentation\n')
    git('add', '.')
    git('commit', '-qm', 'base update')
    const updatedBase = git('rev-parse', 'HEAD')
    git('merge', '--no-ff', '-m', 'PR merge fixture', head)
    assert.equal(
      planFromGit(
        'pull_request',
        { pull_request: { base: { sha: updatedBase }, head: { sha: head } } },
        cwd,
      ).kind,
      'ordinary',
    )
    assert.equal(
      planFromGit(
        'pull_request',
        { pull_request: { base: { sha: base }, head: { sha: head } } },
        cwd,
      ).kind,
      'full',
    )
    git('switch', '--detach', '-q', head)
    await writeFile(join(cwd, 'LICENSE'), 'uncommitted\n')
    assert.equal(planFromGit('push', { before: base, after: head }, cwd).kind, 'full')
    git('restore', 'LICENSE')
    await rename(join(cwd, 'LICENSE'), join(cwd, 'CONTRIBUTING.md'))
    git('add', '.')
    git('commit', '-qm', 'rename')
    assert.equal(
      planFromGit('push', { before: head, after: git('rev-parse', 'HEAD') }, cwd).kind,
      'full',
    )
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
