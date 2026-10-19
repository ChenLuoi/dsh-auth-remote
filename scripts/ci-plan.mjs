import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFile, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fullVerificationPlan, ordinaryVerificationPlan } from './packed-artifact.mjs'
import { project } from './runtime.mjs'

export const ordinaryPaths = new Set([
  'CHANGELOG.md',
  'CHANGELOG.zh-CN.md',
  'CONTRIBUTING.md',
  'CONTRIBUTING.zh-CN.md',
  'LICENSE',
  'tests/unit/i18n.test.ts',
])

export function selectCiPlan({ event, changes = [], complete = false }) {
  const full = (reason) => ({ ...fullVerificationPlan(), reason })
  if (!['pull_request', 'push'].includes(event))
    return full(`Full verification for ${event || 'unknown event'}`)
  if (!complete || changes.length === 0) return full('Changed paths are incomplete or empty')
  for (const change of changes) {
    if (!['A', 'M', 'D'].includes(change.status))
      return full('Rename, copy or uncertain file status')
    if (!ordinaryPaths.has(change.path)) return full(`Full verification for ${change.path}`)
  }
  return {
    ...ordinaryVerificationPlan(),
    reason: 'Every changed path is in the exact low-risk allowlist',
  }
}

export function parseNameStatus(output) {
  const fields = output.split('\0')
  assert.equal(fields.pop(), '', 'Truncated git name-status output')
  const changes = []
  for (let index = 0; index < fields.length;) {
    const status = fields[index++]
    assert.match(status, /^[ACDMRTUXB][0-9]*$/u, 'Unknown git change status')
    const path = fields[index++]
    assert(path, 'Missing git change path')
    if (/^[RC]/u.test(status)) {
      const destination = fields[index++]
      assert(destination, 'Missing git rename/copy destination')
      changes.push({ status, path: destination, previousPath: path })
    } else changes.push({ status, path })
  }
  return changes
}

export function planFromGit(event, payload, cwd = project) {
  if (!['pull_request', 'push'].includes(event)) return selectCiPlan({ event })
  const base = event === 'pull_request' ? payload.pull_request?.base?.sha : payload.before
  const head = event === 'pull_request' ? payload.pull_request?.head?.sha : payload.after
  const valid = (value) =>
    typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value) && !/^0+$/u.test(value)
  if (!valid(base) || !valid(head)) return selectCiPlan({ event })
  const git = (args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    assert(!result.error && result.status === 0, 'Cannot obtain a complete git comparison')
    return result.stdout.trimEnd()
  }
  try {
    const checkout = git(['rev-parse', 'HEAD'])
    assert.equal(
      git(['status', '--porcelain', '--untracked-files=all']),
      '',
      'Dirty checkout cannot select reduced verification',
    )
    if (event === 'push') assert.equal(checkout, head, 'Checkout differs from the push head')
    else if (checkout !== head) {
      const parents = git(['rev-list', '--parents', '-n', '1', checkout]).split(' ').slice(1)
      assert.equal(parents.length, 2, 'PR checkout is not the expected merge commit')
      assert(
        parents.includes(base) && parents.includes(head),
        'PR merge parents differ from the event',
      )
    }
    git(['cat-file', '-e', `${base}^{commit}`])
    git(['cat-file', '-e', `${head}^{commit}`])
    const result = spawnSync(
      'git',
      ['diff', '--name-status', '-z', '--find-renames', base, head, '--'],
      { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    )
    assert(!result.error && result.status === 0, 'Cannot read complete git paths')
    const changes = parseNameStatus(result.stdout)
    return { ...selectCiPlan({ event, changes, complete: true }), base, head, changes }
  } catch (error) {
    return {
      ...selectCiPlan({ event }),
      reason: `Conservative full verification: ${error.message}`,
      base,
      head,
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const event = process.env.GITHUB_EVENT_NAME || 'workflow_dispatch'
  let plan
  try {
    const payload = process.env.GITHUB_EVENT_PATH
      ? JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'))
      : {}
    plan = planFromGit(event, payload)
  } catch {
    plan = selectCiPlan({ event })
  }
  if (process.env.GITHUB_OUTPUT)
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `kind=${plan.kind}\nversions=${JSON.stringify(plan.versions)}\nbrowser-matrix=${JSON.stringify(plan.browser)}\n`,
    )
  console.log(JSON.stringify(plan, null, 2))
}
