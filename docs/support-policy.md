# DSH support lifecycle

[简体中文](support-policy.zh-CN.md)

Last updated: 2026-11-05. This policy separates maintenance commitments, exact-version verification and technical admission. Version **`0.3.4`** adds DSH `0.2.2-alpha.3` and withdraws `0.2.2-alpha.2`, retaining nine exact declarations; published `0.3.2` retains eight. Publication requires one final archive to pass on all nine exact targets. Declarations do not establish verification, GitHub Actions success or publication; actual availability is confirmed by the release workflow and npm registry.

## Support states and runtime admission

| State                                                                                  | Maintenance and verification                                                                               | Runtime behavior                                                                                  |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Supported                                                                              | Maintain promised features and block release on failed exact-version verification                          | Run after necessary technical checks                                                              |
| Legacy, including an elapsed window without actual retirement                          | Continue promised features, compatibility regression and security fixes; verification still blocks release | Run after technical checks, with maintenance dates and migration guidance                         |
| Explicitly retired in a plugin release                                                 | Remove that release's current support commitment and continuing matrix; retain historical evidence         | May run with a warning if all necessary contracts remain; admission is not verified compatibility |
| Necessary API/behavior missing, necessary adaptation removed, or security check failed | Do not claim support                                                                                       | Refuse protected business service and provide an upgrade or last-compatible-plugin path           |
| Unassessed old or future release                                                       | No exact support commitment                                                                                | Apply technical checks; successful startup does not add support                                   |

`dsh.compatibility.dshReleases` records exact support declarations. `engines.dsh`, the WebServer peer and runtime checks express technical admission: `>=0.2.1-alpha.3`, including prereleases, together with package identity and required API checks. Calendar dates and maintenance-only retirement must not mechanically raise that floor. The six DSH releases retired in `0.3.1` have last supporting plugin `0.2.0`; the [support history](support-history.md) preserves their exact records.

Diagnostics belong in startup logs, before protected service is offered: legacy dates and migration guidance, or the absence of a current support commitment for an admitted unverified/retired release. A process should emit each exact-version/state warning at most once, including across HMR. Diagnostics do not change authentication, login dialogs, request authorization or CLI JSON.

## Current maintenance schedule

Plugin `0.3.4` retains the explicit 2026-10-28 legacy announcement for `0.2.1-alpha.3`, `0.2.1-alpha.4` and `0.2.1-alpha.5`. Adding `0.2.2-alpha.3` changes none of those dates. All nine supported releases remain in release-blocking verification. Dates use Asia/Shanghai at local 00:00; eligibility never automatically ends support.

| Exact DSH release | Maintenance state                                   | Legacy since | Window in calendar days | Earliest eligible retirement |
| ----------------- | --------------------------------------------------- | ------------ | ----------------------- | ---------------------------- |
| `0.2.1-alpha.3`   | Legacy; supported                                   | 2026-10-28   | 14                      | 2026-11-11                   |
| `0.2.1-alpha.4`   | Legacy; supported                                   | 2026-10-28   | 14                      | 2026-11-11                   |
| `0.2.1-alpha.5`   | Legacy; supported                                   | 2026-10-28   | 14                      | 2026-11-11                   |
| `0.2.1-rc.1`      | Supported                                           | —            | —                       | Not announced                |
| `0.2.1-rc.2`      | Supported                                           | —            | —                       | Not announced                |
| `0.2.1-rc.3`      | Supported                                           | —            | —                       | Not announced                |
| `0.2.1-rc.4`      | Supported                                           | —            | —                       | Not announced                |
| `0.2.1-rc.5`      | Supported; added in `0.3.3`                         | —            | —                       | Not announced                |
| `0.2.2-alpha.2`   | Retired in `0.3.4`; upstream failure exception      | 2026-11-05   | 0                       | 2026-11-05                   |
| `0.2.2-alpha.3`   | Supported; development default and recommended host | —            | —                       | Not announced                |

The migration recommendation is DSH `0.2.2-alpha.3` with plugin `0.3.4`; the host is still an upstream Alpha. Install the npm version after successful publication, or use the absolute path to its verified release archive. Published `0.3.3` retains its nine historical declarations; it does not repair the broken host SDK combination. Forward-admitted unknown releases retain no exact support commitment.

<a id="upstream-failure-exception"></a>

## Upstream failure exception: DSH `0.2.2-alpha.2`

On 2026-11-05 (Asia/Shanghai), development explicitly approved withdrawing support for this exact host in plugin `0.3.4`, with a **zero-calendar-day exception** to the normal 14-day window. The announcement and eligibility date are both 2026-11-05; the withdrawal takes effect only in `0.3.4`, never from a timer. No other legacy date or Alpha/RC rule changes.

Fresh installation resolves the host's `~4.0.6-alpha.1` Cordis range to `4.0.6-alpha.2`. The shipped `@deepseek-ai/dsh-app-boot@0.2.2-alpha.2` global `internal/update` callback expects `(config, noSave, next)`, while the new Core supplies `(config, next)`. Native settings writes fail with `next is not a function`, including welcome-notice acknowledgement without this plugin installed. The original SDK combination succeeds. The CI run `41807651546` / browser job `126499190719` and isolated native reproduction establish the failure; old passing reports apply only to their original dependency composition. This exception reflects a reproduced native failure, not the Alpha label or test duration.

Upgrade DSH to `0.2.2-alpha.3`, which uses the matching callback contract, following the independent-profile backup and rollback procedure in the [deployment guide](deployment.md). Plugin `0.3.3` is the last historically supporting release; its registry archive/integrity was rechecked on 2026-11-05. Downgrading the plugin does not repair the host, so that old declaration is not a fresh-install recommendation. The upgrade host's exact registry archive/integrity was checked on the same date; final `0.3.4` artifact acceptance remains separate.

Remove `0.2.2-alpha.2` from current exact declarations and positive CI targets; retain the other nine targets, all shared adaptations/security checks and independent retired `0.2.1-alpha.2` refusal verification. Technical admission remains `>=0.2.1-alpha.3` with identity/API checks and an explicit retired-version warning. This change makes no new blanket startup refusal or native settings repair claim. The profile must still independently disable the native webserver.

## Historical `0.2.0` maintenance announcement

The following table preserves the 2026-10-19 announcement for plugin `0.2.0`, including its independent 21-day exceptions. It is historical evidence, superseded by the explicit `0.3.1` migration and current schedule above; it is not the current positive matrix.

| Exact DSH release | Maintenance state                                      | Legacy since | Window in calendar days | Earliest eligible retirement |
| ----------------- | ------------------------------------------------------ | ------------ | ----------------------- | ---------------------------- |
| `0.1.7-rc.1`      | Legacy                                                 | 2026-10-19   | 14                      | 2026-11-02                   |
| `0.1.7-rc.2`      | Legacy                                                 | 2026-10-19   | 14                      | 2026-11-02                   |
| `0.2.0-rc.1`      | Legacy                                                 | 2026-10-19   | 21                      | 2026-11-09                   |
| `0.2.0-rc.2`      | Legacy                                                 | 2026-10-19   | 21                      | 2026-11-09                   |
| `0.2.1-alpha.1`   | Legacy; independent capability-boundary exception      | 2026-10-19   | 21                      | 2026-11-09                   |
| `0.2.1-alpha.2`   | Legacy; independent capability-boundary exception      | 2026-10-19   | 21                      | 2026-11-09                   |
| `0.2.1-alpha.3`   | Supported                                              | Not entered  | Not applicable          | Not specified                |
| `0.2.1-alpha.4`   | Supported                                              | Not entered  | Not applicable          | Not specified                |
| `0.2.1-alpha.5`   | Supported                                              | Not entered  | Not applicable          | Not specified                |
| `0.2.1-rc.1`      | Supported; new target                                  | Not entered  | Not applicable          | Not specified                |
| `0.2.1-rc.2`      | Supported; new development/verification default target | Not entered  | Not applicable          | Not specified                |

The historical migration target was DSH `0.2.1-rc.2` with plugin `0.2.0`. Published `0.1.10` retains its historical declarations; it must not be republished to add the RCs.

## Dates and the Alpha/RC relationship

The general legacy window is **14 calendar days**. Development must explicitly announce any exception, its reason and duration. Do not derive the window from an alpha, RC or stable label; there is no general alpha seven-day or stable thirty-day policy.

Dates use `Asia/Shanghai`. Eligibility starts at local 00:00 on `legacySince + windowDays`: 2026-10-19 + 14 days = 2026-11-02; + 21 days = 2026-11-09. These are announced dates, not elapsed time since a user's installation, upstream release or plugin publication. An elapsed window grants eligibility for a later retirement release; it neither retires the version automatically nor requires retirement in the immediately following plugin release. Installed behavior never changes because the date passes.

Alpha releases of a base version follow its **entire RC release line**. While any RC remains normally supported, associated alphas do not automatically become legacy. When the last normally supported RC enters legacy, associated alphas without an independent announcement enter together and share its deadline. The independent 2026-10-28 announcement above overrides this default for `0.2.1-alpha.3`, `0.2.1-alpha.4` and `0.2.1-alpha.5`. Historical independent capability-boundary exceptions for `0.2.1-alpha.1` and `0.2.1-alpha.2` keep the announced 21-day dates; a later RC does not reset them.

## Add exact-version support

1. Development selects exact DSH releases. Check the actual registry packages, availability, integrity, matching tags, APIs and the installed DSH → WebApp → dependency chain. A Git tag, broad SemVer range, adjacent release or identical source is insufficient evidence of installation or compatibility.
2. Read the [compatibility inventory](legacy-compatibility.md). Update candidate dependencies, declarations, test targets, both inventory matrices and affected entries together. Preserve adaptations whose applicable releases still intersect support, and shared security checks.
3. Correct exact-version test branches and verify expected cases really register. Freeze one candidate tgz and record source identity, archive SHA-256, runtime composition, commands, test counts and reports. All current supported releases, including legacy, must pass CLI, full browser and isolated installation smoke against that same archive. An archive-affecting edit creates a new candidate and invalidates the previous final matrix.
4. Update bilingual user and development documents and the Unreleased changelog. Only publishing a newly versioned, verified plugin creates that released plugin's formal historical support record. Forward admission alone never adds a supported version.

## Announce entry into legacy

Development explicitly announces the exact release set, reason, legacy start, 14-day default or justified exception, eligibility date, migration target, feature limits and runtime-admission policy. Update declarations, history, README, inventory and operational guides together as applicable. A legacy announcement keeps the release supported and in release-blocking CI.

Maintain the promised authentication and feature boundaries, compatibility regression and security fixes throughout legacy, including after the eligibility date when retirement has not been scheduled. Record that continued legacy status rather than deleting verification jobs. Do not select dates from upstream publication or silently reset an earlier announcement.

## Execute actual retirement in a future release

Plugin `0.2.0` performed no actual retirement. Plugin `0.3.1` retired DSH `0.1.7-rc.1`, `0.1.7-rc.2`, `0.2.0-rc.1`, `0.2.0-rc.2`, `0.2.1-alpha.1` and `0.2.1-alpha.2`; `0.3.4` additionally retires `0.2.2-alpha.2` under the explicit exception above. A future retirement change must satisfy every item below in the same change:

1. Obtain development's explicit decision naming the exact releases and effective new plugin version, on or after each eligibility date. Record effective date, last supporting plugin version and verified distribution availability.
2. Provide migration and installation guidance. Separate maintenance withdrawal from technical refusal: visual/test-only adaptation removal does not by itself require blocking startup; missing necessary runtime or security contracts must refuse service.
3. Review each `dsh-runtime` entry's applicable versions against the resulting supported set. Keep it while the intersection is nonempty. When empty, remove its exclusive implementation and tests and update both inventory languages, both matrix directions and guides. Missing evidence requires obtaining exact-version evidence before retiring an adaptation. Keep shared authentication, origin, session, storage and transport checks.
4. Treat `plugin-contract` entries under their own migration policy. DSH retirement does not remove old plugin configuration such as `allowedOrigins`.
5. Update support declarations, CI, README, history, inventory and any necessary admission changes together. Record the effective retirement, last compatible plugin, upgrade path and actual runtime result; preserve historical rows.
6. Verify the final archive against every remaining supported release, and verify refusal cannot restore an unprotected native listener. Keep the independent profile safeguard and readiness checks in the [deployment guide](deployment.md).

An installed plugin must not retire versions by calendar timer. A scheduled CI run must not delete support or verification. Missing approval, dates, availability, adaptation evidence, deployment safeguards or final verification means retirement is not complete.

## Verification and delivery rules

Every pull request and main-branch check retains static, unit, integration and all-supported-release CLI/install smoke. The ordinary browser plan is permitted only for the explicit low-risk whitelist; source, shared behavior, dependencies, support documents, build/package/consumer mechanisms, unknown paths and uncertain diffs require full verification. Weekly verification at Monday 00:00 UTC (08:00 Asia/Shanghai), manual runs and releases use the full exact-version matrix. Representative ordinary checks do not replace another release's evidence.

Release verification must consume one immutable archive produced once after static/core checks. Independent jobs validate the same archive identity and SHA-256, restore its own `dist`, and run serial test files against isolated profiles. Reject failures, cancellations, unexpected skips and empty targeted suites. Publish depends on all required jobs and consumes the verified artifact without rebuilding or repacking. Real GitHub Actions results must be recorded separately from local workflow-equivalent checks.

See the [development guide](development.md) for verification commands and isolation, and the [release guide](releasing.md) for the publishing operation. Final production and same-archive verification use Node.js 24. Test credentials, task documents, profiles, screenshots and generated evidence stay outside the npm archive.

## Documentation and evidence responsibilities

The support policy defines decisions and operations. [Support history](support-history.md) provides [DSH → plugin](support-history.md#by-dsh) and [plugin → exact DSH](support-history.md#by-plugin) queries for all verifiable releases, availability, evidence grades, dates and installation guidance. The [compatibility inventory](legacy-compatibility.md) maintains feature → version and version → feature views, stable IDs, code/tests and adaptation retirement evidence. README lists current normal/legacy support and links to detailed queries; history survives removal from README.

Maintain these layers in English and Chinese for support additions, legacy announcements and actual retirement. Distinguish explicit historical declaration, real verification, technical admission only and unknown. Recommend only a verified available distribution; an old obtainable package is not thereby maintained or covered by current security verification. Record unavailable or missing evidence instead of inventing compatibility. Historical support must not be rewritten from a new candidate's manifest.
