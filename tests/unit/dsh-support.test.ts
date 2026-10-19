import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import {
  classifyDshSupport,
  dshSupportWarning,
  LEGACY_DSH_RELEASES,
  RETIRED_DSH_RELEASES,
  warnDshSupport,
  type RetiredDshRecord,
} from '../../src/shared/dsh-support.js'

const manifest = createRequire(import.meta.url)('../../package.json')
const declared = new Set<string>(Object.keys(manifest.dsh.compatibility.dshReleases))

test('the six announced legacy records remain declared with exact dates and no actual retirement', () => {
  assert.deepEqual(
    LEGACY_DSH_RELEASES.map(({ version, legacySince, windowDays, eligibleRetirement }) => [
      version,
      legacySince,
      windowDays,
      eligibleRetirement,
    ]),
    [
      ['0.1.7-rc.1', '2026-10-19', 14, '2026-11-02'],
      ['0.1.7-rc.2', '2026-10-19', 14, '2026-11-02'],
      ['0.2.0-rc.1', '2026-10-19', 21, '2026-11-09'],
      ['0.2.0-rc.2', '2026-10-19', 21, '2026-11-09'],
      ['0.2.1-alpha.1', '2026-10-19', 21, '2026-11-09'],
      ['0.2.1-alpha.2', '2026-10-19', 21, '2026-11-09'],
    ],
  )
  assert.deepEqual(RETIRED_DSH_RELEASES, [])
  for (const record of LEGACY_DSH_RELEASES) {
    assert(declared.has(record.version))
    const status = classifyDshSupport(record.version, declared)
    assert.equal(status.state, 'legacy')
    const warning = dshSupportWarning(status)!
    for (const fact of [
      record.legacySince,
      record.eligibleRetirement,
      record.migrationTarget,
      'Asia/Shanghai',
      'docs/support-history.md',
    ])
      assert(warning.includes(fact), fact)
  }
})

test('crossing either eligibility date or a future year never retires a declared legacy version', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-18T16:00:00Z') })
  for (const date of ['2026-11-01T16:00:00Z', '2026-11-08T16:00:00Z', '2050-01-01T00:00:00Z']) {
    t.mock.timers.setTime(Date.parse(date))
    assert.equal(new Date().toISOString(), date.replace('Z', '.000Z'))
    for (const { version } of LEGACY_DSH_RELEASES)
      assert.equal(classifyDshSupport(version, declared).state, 'legacy')
  }
})

test('normal declarations stay supported while absent exact versions remain unverified', () => {
  for (const version of [
    '0.2.1-alpha.3',
    '0.2.1-alpha.4',
    '0.2.1-alpha.5',
    '0.2.1-rc.1',
    '0.2.1-rc.2',
  ]) {
    const status = classifyDshSupport(version, declared)
    assert.equal(status.state, 'supported')
    assert.equal(dshSupportWarning(status), undefined)
  }
  for (const version of ['0.1.6', '0.2.1-rc.2+unassessed', '9.0.0-test.1', 'invalid'])
    assert.equal(classifyDshSupport(version, declared).state, 'unverified')
  assert.equal(classifyDshSupport('0.1.7-rc.1', new Set()).state, 'unverified')
})

test('explicit fictional retirement is advisory and cannot override a current declaration', () => {
  const record: RetiredDshRecord = {
    state: 'retired',
    version: '9.0.0-test.1',
    retiredOn: '2050-01-01',
    effectivePlugin: '9.0.0-test.2',
    lastSupportedPlugin: '9.0.0-test.1',
    migrationTarget: '9.0.0-test.3',
  }
  const status = classifyDshSupport(record.version, new Set(), [record])
  assert.equal(status.state, 'retired')
  assert.match(dshSupportWarning(status)!, /last supported plugin 9\.0\.0-test\.1/u)
  assert.equal(
    classifyDshSupport(record.version, new Set([record.version]), [record]).state,
    'supported',
  )
})

test('one exact-version/state warning survives separately imported module instances', async () => {
  const messages: string[] = []
  const write = (message: string) => {
    messages.push(message)
  }
  const status = classifyDshSupport('9.0.0-test.hmr', new Set())
  assert.equal(warnDshSupport(status, write), true)
  assert.equal(warnDshSupport(status, write), false)
  const reloaded = await import(
    new URL('../../src/shared/dsh-support.ts?reload=second', import.meta.url).href
  )
  assert.equal(reloaded.warnDshSupport(status, write), false)
  assert.equal(messages.length, 1)
  assert.equal(warnDshSupport({ version: '0.2.1-rc.2', state: 'supported' }, write), false)
  const retired: RetiredDshRecord = {
    state: 'retired',
    version: status.version,
    retiredOn: '2050-01-01',
    effectivePlugin: '9.0.0-test.2',
    lastSupportedPlugin: '9.0.0-test.1',
    migrationTarget: '9.0.0-test.3',
  }
  assert.equal(
    reloaded.warnDshSupport(classifyDshSupport(status.version, new Set(), [retired]), write),
    true,
  )
  assert.equal(messages.length, 2)
})
