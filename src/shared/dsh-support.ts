/** Maintenance records never replace package identity, API or security checks. */
export interface LegacyDshRecord {
  state: 'legacy'
  version: string
  legacySince: string
  windowDays: number
  eligibleRetirement: string
  migrationTarget: string
}

export interface RetiredDshRecord {
  state: 'retired'
  version: string
  retiredOn: string
  effectivePlugin: string
  lastSupportedPlugin: string
  migrationTarget: string
}

export type DshLifecycleRecord = LegacyDshRecord | RetiredDshRecord
export type DshSupport =
  | { state: 'supported' | 'unverified'; version: string }
  | { state: 'legacy'; version: string; record: LegacyDshRecord }
  | { state: 'retired'; version: string; record: RetiredDshRecord }

function legacy(version: string, windowDays: number, eligibleRetirement: string): LegacyDshRecord {
  return {
    state: 'legacy',
    version,
    legacySince: '2026-10-28',
    windowDays,
    eligibleRetirement,
    migrationTarget: '0.2.1-rc.4',
  }
}

export const LEGACY_DSH_RELEASES: readonly LegacyDshRecord[] = [
  legacy('0.2.1-alpha.3', 14, '2026-11-11'),
  legacy('0.2.1-alpha.4', 14, '2026-11-11'),
  legacy('0.2.1-alpha.5', 14, '2026-11-11'),
]

// Preparation date, not the registry publication time or an admission input.
export const RETIRED_DSH_RELEASES: readonly RetiredDshRecord[] = [
  '0.1.7-rc.1',
  '0.1.7-rc.2',
  '0.2.0-rc.1',
  '0.2.0-rc.2',
  '0.2.1-alpha.1',
  '0.2.1-alpha.2',
].map((version) => ({
  state: 'retired',
  version,
  retiredOn: '2026-10-28',
  effectivePlugin: '0.3.1',
  lastSupportedPlugin: '0.2.0',
  migrationTarget: '0.2.1-rc.4',
}))
const lifecycle: readonly DshLifecycleRecord[] = [...LEGACY_DSH_RELEASES, ...RETIRED_DSH_RELEASES]

/** Exact declarations take precedence. Calendar time is deliberately not an input. */
export function classifyDshSupport(
  version: string,
  declared: ReadonlySet<string>,
  records: readonly DshLifecycleRecord[] = lifecycle,
): DshSupport {
  if (declared.has(version)) {
    const record = records.find(
      (item): item is LegacyDshRecord => item.version === version && item.state === 'legacy',
    )
    return record ? { state: 'legacy', version, record } : { state: 'supported', version }
  }
  const record = records.find(
    (item): item is RetiredDshRecord => item.version === version && item.state === 'retired',
  )
  return record ? { state: 'retired', version, record } : { state: 'unverified', version }
}

export function dshSupportWarning(support: DshSupport): string | undefined {
  const guides = 'See README.md and docs/support-history.md.'
  if (support.state === 'supported') return
  if (support.state === 'legacy') {
    const record = support.record
    return `auth-remote: DSH ${support.version} is legacy since ${record.legacySince}; earliest eligible retirement ${record.eligibleRetirement} (Asia/Shanghai, ${record.windowDays} calendar days). Support continues until an explicit retirement release. Migrate to DSH ${record.migrationTarget} with a supporting plugin release. ${guides}`
  }
  if (support.state === 'retired') {
    const record = support.record
    return `auth-remote: DSH ${support.version} retired on ${record.retiredOn} in plugin ${record.effectivePlugin}; last supported plugin ${record.lastSupportedPlugin}. No current compatibility commitment; technical checks still apply. Upgrade to DSH ${record.migrationTarget} with a supporting plugin release, or consult the historical installation guidance. ${guides}`
  }
  return `auth-remote: DSH ${support.version} has no current exact-version support commitment. Technical admission does not establish verified compatibility. Select a declared DSH release and a supporting plugin release. ${guides}`
}

const warningKey = Symbol.for('dsh-auth-remote.support-warnings')

/** Keep this process-wide across native module replacement, without changing readiness. */
export function warnDshSupport(
  support: DshSupport,
  write: (message: string) => void = console.warn,
): boolean {
  const message = dshSupportWarning(support)
  if (!message) return false
  const processState = globalThis as unknown as { [key: symbol]: Set<string> | undefined }
  const warned = (processState[warningKey] ??= new Set<string>())
  const key = `${support.version}:${support.state}`
  if (warned.has(key)) return false
  warned.add(key)
  write(message)
  return true
}
