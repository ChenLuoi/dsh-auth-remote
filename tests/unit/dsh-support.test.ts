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
  type LegacyDshRecord,
} from '../../src/shared/dsh-support.js'

const manifest = createRequire(import.meta.url)('../../package.json')
const declared = new Set<string>(Object.keys(manifest.dsh.compatibility.dshReleases))

const maintenanceRetired = RETIRED_DSH_RELEASES.filter(
  ({ effectivePlugin }) => effectivePlugin === '0.3.6',
)

test('three maintenance retirements preserve their announcement window and the six technical retirements', () => {
  assert.deepEqual(LEGACY_DSH_RELEASES, [])
  assert.deepEqual(
    maintenanceRetired.map(
      ({
        version,
        legacySince,
        windowDays,
        eligibleRetirement,
        retiredOn,
        effectivePlugin,
        lastSupportedPlugin,
        migrationTarget,
      }) => [
        version,
        legacySince,
        windowDays,
        eligibleRetirement,
        retiredOn,
        effectivePlugin,
        lastSupportedPlugin,
        migrationTarget,
      ],
    ),
    [
      [
        '0.2.1-alpha.3',
        '2026-10-28',
        14,
        '2026-11-11',
        '2026-11-13',
        '0.3.6',
        '0.3.5',
        '0.2.2-rc.2',
      ],
      [
        '0.2.1-alpha.4',
        '2026-10-28',
        14,
        '2026-11-11',
        '2026-11-13',
        '0.3.6',
        '0.3.5',
        '0.2.2-rc.2',
      ],
      [
        '0.2.1-alpha.5',
        '2026-10-28',
        14,
        '2026-11-11',
        '2026-11-13',
        '0.3.6',
        '0.3.5',
        '0.2.2-rc.2',
      ],
    ],
  )
  assert.deepEqual(
    RETIRED_DSH_RELEASES.slice(0, 6).map(({ version }) => version),
    ['0.1.7-rc.1', '0.1.7-rc.2', '0.2.0-rc.1', '0.2.0-rc.2', '0.2.1-alpha.1', '0.2.1-alpha.2'],
  )
  for (const record of RETIRED_DSH_RELEASES) {
    assert(!declared.has(record.version))
    const status = classifyDshSupport(record.version, declared)
    assert.equal(status.state, 'retired')
    const warning = dshSupportWarning(status)!
    for (const fact of [
      record.version,
      record.retiredOn,
      record.effectivePlugin,
      record.lastSupportedPlugin,
      record.migrationTarget,
      'technical checks still apply',
      'docs/support-history.md',
    ])
      assert(warning.includes(fact), fact)
  }
  for (const record of RETIRED_DSH_RELEASES.slice(0, 6)) {
    assert.equal(record.retiredOn, '2026-10-28')
    assert.equal(record.effectivePlugin, '0.3.1')
    assert.equal(record.lastSupportedPlugin, '0.2.0')
  }
})

test('calendar changes never rewrite historical legacy behavior or current explicit maintenance retirement', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-18T16:00:00Z') })
  for (const date of ['2026-11-10T15:59:59Z', '2026-11-10T16:00:00Z', '2050-01-01T00:00:00Z']) {
    t.mock.timers.setTime(Date.parse(date))
    for (const record of maintenanceRetired) {
      const old: LegacyDshRecord = {
        state: 'legacy',
        version: record.version,
        legacySince: record.legacySince!,
        windowDays: record.windowDays!,
        eligibleRetirement: record.eligibleRetirement!,
        migrationTarget: '0.2.2-rc.1',
      }
      assert.equal(classifyDshSupport(old.version, new Set([old.version]), [old]).state, 'legacy')
      assert.equal(classifyDshSupport(old.version, declared).state, 'retired')
    }
  }
})

test('legacy warning contract remains explicit and process-wide across repeated activation', () => {
  const record: LegacyDshRecord = {
    state: 'legacy',
    version: '9.0.0-test.legacy-hmr',
    legacySince: '2026-10-28',
    windowDays: 14,
    eligibleRetirement: '2026-11-11',
    migrationTarget: '0.2.2-rc.2',
  }
  const support = classifyDshSupport(record.version, new Set([record.version]), [record])
  const messages: string[] = []
  assert.equal(
    warnDshSupport(support, (message) => messages.push(message)),
    true,
  )
  assert.equal(
    warnDshSupport(support, (message) => messages.push(message)),
    false,
  )
  assert.equal(messages.length, 1)
  for (const fact of [
    'legacy since 2026-10-28',
    '2026-11-11',
    '14 calendar days',
    'Asia/Shanghai',
    '0.2.2-rc.2',
  ])
    assert(messages[0]!.includes(fact))
})

test('normal declarations stay supported while absent exact versions remain unverified', () => {
  for (const version of [
    '0.2.1-rc.1',
    '0.2.1-rc.2',
    '0.2.1-rc.3',
    '0.2.1-rc.4',
    '0.2.1-rc.5',
    '0.2.2-alpha.3',
    '0.2.2-rc.1',
    '0.2.2-rc.2',
  ]) {
    const status = classifyDshSupport(version, declared)
    assert.equal(status.state, 'supported')
    assert.equal(dshSupportWarning(status), undefined)
  }
  for (const version of [
    '0.1.6',
    '0.2.1-rc.2+unassessed',
    '0.2.1-rc.6',
    '0.2.2-alpha.4',
    '9.0.0-test.1',
    'invalid',
  ])
    assert.equal(classifyDshSupport(version, declared).state, 'unverified')
  assert.equal(classifyDshSupport('0.1.7-rc.1', new Set()).state, 'retired')
})

test('the upstream-broken Alpha is explicitly retired without changing calendar or admission rules', () => {
  assert.equal(RETIRED_DSH_RELEASES.length, 10)
  const status = classifyDshSupport('0.2.2-alpha.2', declared)
  assert.equal(status.state, 'retired')
  if (status.state !== 'retired') throw new Error('Expected explicit retirement')
  assert.deepEqual(status.record, {
    state: 'retired',
    version: '0.2.2-alpha.2',
    retiredOn: '2026-11-05',
    effectivePlugin: '0.3.4',
    lastSupportedPlugin: '0.3.3',
    migrationTarget: '0.2.2-rc.2',
  })
  const warning = dshSupportWarning(status)!
  for (const fact of ['0.2.2-alpha.2', '2026-11-05', '0.3.4', '0.3.3', '0.2.2-rc.2'])
    assert(warning.includes(fact), fact)
  assert(warning.includes('technical checks still apply'))
  const messages: string[] = []
  assert.equal(
    warnDshSupport(status, (message) => messages.push(message)),
    true,
  )
  assert.equal(
    warnDshSupport(status, (message) => messages.push(message)),
    false,
  )
  assert.equal(messages.length, 1)
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
