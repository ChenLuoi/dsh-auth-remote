# Development

[简体中文](development.zh-CN.md)

This guide describes published `0.3.6` and eight exact targets, defaulting to recommended RC prerelease `0.2.2-rc.2`. Its tag archive passed full acceptance and public distribution checks; see [support history](support-history.md#plugin-0.3.6). Later source or documentation builds have their own producer and do not replace the immutable released archive or its evidence.

Development and the full test suite use Linux (`/proc` is required for the profile lock), Node.js 24, pnpm 12.5.1, and DSH `0.2.2-rc.2`. DSH `0.2.2-rc.2` requires Node.js `>=24.9.0`; the plugin engine stays `>=24`. Browser tests use Playwright-managed Chromium and a Node HTTP/HTTPS forwarder.

## Set up and check a checkout

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm check
pnpm pack:local
pnpm smoke
```

`pnpm check` runs type checking, formatting, build, package/deployment/document checks, then unit, integration, CLI, and browser tests. `pnpm pack:local` writes `artifacts/dsh-auth-remote-0.3.6.tgz` after static checks; it does not publish. `pnpm smoke` first runs `pack:local` again to prepare a new candidate, then installs it into an isolated DSH home, briefly starts the pinned runtime, checks readiness, anonymous redirection/denial and online CLI status, then stops it. It does not consume a previously frozen digest; use `verify:packed --suite smoke` for that.

## Use the isolated development profile

```sh
pnpm dev:prepare
pnpm dev:install
pnpm dev:start
```

The scripts manage only `.dev/runtime-<version>` and `.dev/dsh-home` under this checkout; the default listener is `127.0.0.1:13090`. They reject an ambient `DSH_HOME` pointing elsewhere and symlinked development paths. `dev:install` rebuilds and installs the current archive even when the version stays the same. `dev:start` runs DSH in the foreground; Ctrl+C stops it. A source watcher can run in another terminal with `pnpm dev`, but rebuilds still need `dev:install` and a `dev:start` restart to load the new package.

For direct inspection, use the same isolated home explicitly:

```sh
DSH_HOME="$PWD/.dev/dsh-home" "$PWD/.dev/runtime-0.2.2-rc.2/node_modules/.bin/dsh" plugin --profile web exec dsh-auth-remote status --json
```

The development home contains test account data. Keep it private and do not commit or copy it into a deployment profile.

## Test boundaries

`pnpm test:unit` covers the auth state machine, TOTP, backup codes, origin policy, translations, storage durability and lock recovery. `pnpm test:integration` exercises real HTTP/WebSocket sockets, native readiness, cookies, origin decisions and revocation. `pnpm test:cli` builds the real archive and tests interactive and noninteractive commands against isolated profiles and Unix sockets. `pnpm test:browser` boots the selected DSH version with temporary profiles and verifies the login and Security & sign-in UI, native settings, workspace, upload/preview, SSE, WebSocket and an HTTPS forwarding chain.

Browser network traffic uses a Node HTTP/HTTPS forwarder. The dedicated self-signed certificate and key under `tests/fixtures/tls/` are test fixtures only; they are never packaged or deployment credentials. Chat uses a local model stub. No real third-party authorization or paid model request is exercised. The default browser is Playwright Chromium; `DSH_TEST_BROWSER` can select a local browser executable, and `DSH_TEST_BIN` can select another binary only if it reports the exact selected version (default `0.2.2-rc.2`).

Shared Host environments are allowlisted without real model credentials/endpoints; browser launch removes ambient proxy variables. Before first key entry, `localModelEndpoint` points native llm-deepseek baseURL at a local HTTP stub, without preseeded keys or disabled onboarding. UI cases require zero model calls; proxy chat allows only local chat and native session-title POSTs. Counts are checked at fixture close and unexpected requests fail.

The DSH test runtime lives in `.cache/test-runtime/<version>` and is pinned separately from the source dependencies. Host services and React remain external to the client bundle. The [deployment guide](deployment.md) describes profile and backup rules.

Before changing compatibility declarations or adaptations, read the [legacy compatibility inventory](legacy-compatibility.md). Check runtime admission, test targets, CI and user claims together; remove exclusive runtime code and tests in the same change when its applicable versions leave support. Old plugin configuration follows its own migration policy. Keep shared security checks and update both inventory languages and both matrix views with exact-version evidence.

Isolated verification installs use pnpm file copies so shared package hardlink metadata changes cannot trigger client hot reloads in another profile.

Current support is in [README](../README.md#dsh-compatibility) and the [support policy](support-policy.md), release facts in the [bidirectional history](support-history.md), and adaptation evidence in the inventory. Never derive old release claims from the current manifest.

## Cross-version verification

The default is DSH `0.2.2-rc.2`; `DSH_TEST_VERSION` accepts only `0.2.1-rc.1`, `0.2.1-rc.2`, `0.2.1-rc.3`, `0.2.1-rc.4`, `0.2.1-rc.5`, `0.2.2-alpha.3`, `0.2.2-rc.1`, `0.2.2-rc.2`. The retired Alphas are not positive selections. Test runtimes live under `.cache/test-runtime/<version>` and development runtimes under `.dev/runtime-<version>`; `DSH_TEST_BIN` must report the exact selection. Ordinary/full both run complete eight-host CLI/browser/smoke coverage. Types and integration use locked `0.2.2-rc.2` development packages. All eight check the real Loader, model runtime context/`DSH_WEB_URL` and IPv4/IPv6 HTTP/HTTPS security boundaries; missing transport fails instead of skipping.

```sh
DSH_TEST_VERSION=0.2.1-rc.1 pnpm test:cli
DSH_TEST_VERSION=0.2.1-rc.1 pnpm test:browser
DSH_TEST_VERSION=0.2.1-rc.2 pnpm test:cli
DSH_TEST_VERSION=0.2.1-rc.2 pnpm test:browser
DSH_TEST_VERSION=0.2.1-rc.3 pnpm test:cli
DSH_TEST_VERSION=0.2.1-rc.3 pnpm test:browser
DSH_TEST_VERSION=0.2.1-rc.4 pnpm test:cli
DSH_TEST_VERSION=0.2.1-rc.4 pnpm test:browser
DSH_TEST_VERSION=0.2.1-rc.5 pnpm test:cli
DSH_TEST_VERSION=0.2.1-rc.5 pnpm test:browser
DSH_TEST_VERSION=0.2.2-alpha.3 pnpm test:cli
DSH_TEST_VERSION=0.2.2-rc.1 pnpm test:cli
DSH_TEST_VERSION=0.2.2-alpha.3 pnpm test:browser
DSH_TEST_VERSION=0.2.2-rc.1 pnpm test:browser
DSH_TEST_VERSION=0.2.2-rc.2 pnpm test:cli
DSH_TEST_VERSION=0.2.2-rc.2 pnpm test:browser
```

Browser tests save light/dark, desktop/narrow-screen screenshots under `.cache/ui-review/<version>` for visual review. Security CSS is installed and removed with the plugin, scopes its selectors to the plugin page, and reads the host's live `--dsw-*` tokens. The standalone login uses a subset of DSH 0.2.0-rc.1 theme tokens and the system color scheme without reading host preferences before authentication.

Official-account tests use a local Platform stand-in with the actual merged DSH `0.2.2-rc.2` account provider. They check the original redirect URI and PKCE verifier during exchange, rejected state/URL/session combinations, duplicate submissions, cancellation, expiry and retries. Browser coverage checks the instruction-first menu and onboarding dialog, failed loopback navigation followed by paste/confirm, blocked popups, live locale and responsive light/dark layout. These tests do not establish a real official-account authorization session.

Core account tests load the exact provider from locked development dependencies, so they do not require a pre-existing CLI runtime cache. Browser tests still exercise the provider installed into each isolated DSH profile.

The account adapter retains capability/live-configuration checks and full manual-sign-in coverage on all eight hosts; admitted unknown versions inherit no verification. On `0.2.2-rc.2`, private in-place component decoration preserves entry/children/inject/options and native disposal. Its own provideRoot contribution redraws installation/removal; inactive wrappers delegate, and restoration only overwrites its own component. Older entries without children retain public registration. Two independent private runtimes exercise client/native-source HMR, child ownership, notifications, later-writer protection, pending describe and in-flight cancellation. PKCE/notifications use only local Platform/notification stand-ins. Eight-language visit sets are asserted, but cross-product notification localization mapping is not fully verified. See `DSH-ACCOUNT-001` and `DSH-ACCOUNT-SLOT-001`.

`live-config.spec.ts` observes the real Loader reference/fiber, auth/store identity, lock, listener and SSE/WebSocket continuity, checks the loaded dependency chain and restarts to verify the profile override. It does not fabricate services. Dialog regression covers cancellation/errors, focus/keyboard, optional/enforced TOTP, one-time code copying and redirect holds after revocation. Task documents, test credentials, profiles, screenshots and generated directories must remain outside the npm archive.

`account-login.spec.ts` uses ordinary `sessionHours` changes for genuine configuration HMR on all eight hosts, checking listener replacement, queued independent Settings writes and rejected genuine nesting. Replacing isolated plugin code must allow manual sign-in again. The probe calls real HMR, replaces no service and is unpackaged; see `DSH-HMR-001`. On all eight, `startup-compatibility.spec.ts` damages only the plugin copy’s `engines.dsh` for Loader refusal without import, then separately injects the plugin admission range for post-import refusal. Both exit naturally nonzero without TCP/HTTP/readiness/WebSocket listeners. Profiles independently disable native webserver; upstream packages and Loader auditing are unchanged.

The account preference binding recovers an initial failed read through the native describe mirror’s `ensure()` API. Recovery of an already held namespace uses the explicitly injected `remote.settings` transport and folds the accepted namespace back into that mirror. A sign-in click while the preference is loading waits for the shared read, then uses the latest accepted true/false value; loading does not select the native flow. Browser regression covers initial failure, a temporarily missing namespace and delayed reads for both routing choices.

Native Search/Fetch settings regression on `0.2.1-rc.2`, `0.2.1-rc.3`, `0.2.1-rc.4`, `0.2.1-rc.5`, `0.2.2-alpha.3`, `0.2.2-rc.1` covers real settings/credentials selection, failed saves, refresh/restart persistence and anonymous/revoked-session refusal. Endpoints are local and request counts must stay zero. On `0.2.1-rc.3`, `0.2.1-rc.4`, `0.2.1-rc.5`, `0.2.2-alpha.3`, `0.2.2-rc.1`, `0.2.2-rc.2`, `rc-navigation.spec.ts` checks global/session/right-sidebar More menus, native settings/model selection and refusal after revocation. Market/Creator entries are inspected without installation or external authorization. Public sessions/sessionProjections APIs create a real session empty completed turn to expose native menus; no chat is sent and no snapshot is replaced. Official dynamic `/models` internal semantics are outside the verification claim.

On `0.2.2-rc.2`, Search/Fetch independently cover auto/account/api-key billing, refused saves, refresh/restart persistence, test credential save/replace/remove and no secret echo; anonymous/revoked calls return 401. Endpoints are local, with zero model, Search/Fetch or outside requests.

Startup diagnostics read installed declarations and explicit lifecycle records, warning once per process/version/state across configuration/module HMR. The three Alphas retire from maintenance in published `0.3.6` after their original 2026-10-28/14-day/2026-11-11 window, with last support `0.3.5`; retiredOn=2026-11-13 is a preparation date. Alpha-only positive legacy-module-HMR branches are removed; generic warning/date unit contracts remain, and real warning/source-HMR checks move to this release’s maintenance-retirement suite. The six technical retirements retain release `0.3.1`/last `0.2.0` history. Dates never stop service; necessary API/identity/security failures still refuse it.

`browser/host-release.spec.ts` fixes seven real round trips: `0.2.1-rc.2` ↔ `0.2.1-rc.1`, `0.2.1-rc.3` ↔ `0.2.1-rc.2`, `0.2.1-rc.4` ↔ `0.2.1-rc.3`, `0.2.1-rc.5` ↔ `0.2.1-rc.4`, `0.2.2-alpha.3` ↔ `0.2.1-rc.5`, `0.2.2-rc.1` ↔ `0.2.2-alpha.3`, `0.2.2-rc.2` ↔ `0.2.2-rc.1`. Each retains the page in one temporary profile/port, checks the actual full release prompt, reloads to verify authentication/the original session/settings, then restores the starting host. Minimum `0.2.1-rc.1` registers no round trip. No upstream source, version or dependency graph is changed.

## Consume a fixed archive

`pnpm verify:packed` consumes an existing tgz without building or packing. Record its SHA-256 first, then pass the archive, that digest, an exact declared DSH release and one or more suites:

```sh
sha256sum artifacts/dsh-auth-remote-0.3.6.tgz
pnpm verify:packed --archive artifacts/dsh-auth-remote-0.3.6.tgz --sha256 <recorded-sha256> --dsh-version 0.2.2-rc.2 --suite cli --suite browser --suite smoke
```

The consumer validates the package name/version and selected release declaration, stages those exact bytes at the fixed artifact path and restores only the archive's dist. CLI execution and installation comparisons therefore use that dist. It rejects unsafe tar entries, a changed digest, unknown selections, zero actual tests and skipped/cancelled/todo tests. Node's passing placeholder for a test file with no matching cases does not count as a real test. `--test-name-pattern` optionally filters one `cli` or `browser` suite; its report is explicitly partial and includes the files, pattern and actual commands. Fixed specialized suites cannot override their filter/count requirements; every required file must register tests.

| Suite          | Selection                                                                                                                  |
| -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `cli`          | All CLI test files                                                                                                         |
| `browser`      | All browser test files                                                                                                     |
| `smoke`        | Install and briefly boot the archive in a new marked home                                                                  |
| `theme`        | The exact login/security theme and narrow-screen case (one real test)                                                      |
| `account`      | startup-compatibility, account-login and live-config on `0.2.1-rc.1`                                                       |
| `host-release` | One real round trip on `0.2.1-rc.2`, `0.2.1-rc.3`, `0.2.1-rc.4`, `0.2.1-rc.5`, `0.2.2-alpha.3`, `0.2.2-rc.1`, `0.2.2-rc.2` |

Consumption is serial within a checkout, enforced by a consumer lock. Each suite checks the input archive, fixed consumer archive and restored dist again. JSON reports and test logs remain under `.cache/verify-packed/`. Smoke creates its marked temporary root directly under `.cache/v-*` to keep the management socket within Linux's pathname limit in the default GitHub checkout. It uses its own runtime/home and `--port 0`; it reads only that child process's announced actual loopback address and checks online CLI status in the same profile. Existing `.dev/dsh-home` and services on 13090 are independent. Only the newly created verification root is removed. `DSH_VERIFY_ROOT` is internal and rejects unmarked, symlinked or external paths; ordinary development commands retain their existing profile and port.

## Independent retired-host refusal verification

`verify-retired.mjs` does not extend `DSH_TEST_VERSION` or the positive matrix. It checks the same candidate/SHA256SUMS and published `0.2.0` integrity, then uses two private old profiles for real CLI rejection/complete rollback and native peer skip of a whole incompatible package. The latter preserves actual old peer resolution, repeatedly confirms no TCP/HTTP/readiness/WebSocket listener, and cleans up processes. The six-host one-time acceptance belongs to the `0.3.1` migration history. Current full/release plans run only `0.2.1-alpha.2`, and ordinary runs none.

```sh
node scripts/verify-retired.mjs --archive artifacts/dsh-auth-remote-0.3.6.tgz --sha256 <recorded-sha256> --retired-dsh-version 0.2.1-alpha.2
```

The six independent negative targets are `0.1.7-rc.1`, `0.1.7-rc.2`, `0.2.0-rc.1`, `0.2.0-rc.2`, `0.2.1-alpha.1` and `0.2.1-alpha.2`. Reports stay separate from positive evidence under `.cache/verify-retired/`.

## This release’s maintenance-retirement checks

Only plugin `0.3.6` full/releases run the three exact targets against the same archive. They do not extend DSH_TEST_VERSION, start Chromium or restore full support:

```sh
node scripts/verify-maintenance-retired.mjs --archive artifacts/dsh-auth-remote-0.3.6.tgz --sha256 <recorded-sha256> --dsh-version 0.2.1-alpha.3
node scripts/verify-maintenance-retired.mjs --archive artifacts/dsh-auth-remote-0.3.6.tgz --sha256 <recorded-sha256> --dsh-version 0.2.1-alpha.4
node scripts/verify-maintenance-retired.mjs --archive artifacts/dsh-auth-remote-0.3.6.tgz --sha256 <recorded-sha256> --dsh-version 0.2.1-alpha.5
```

Each host has three scenarios: actual install/init, exact warning before ready, anonymous denial/login, continuous session and one warning through genuine config/source HMR, then revocation; Loader refusal without listeners (`0.2.1-alpha.3` uses a Host peer fault, the other two engines); and post-import plugin admission refusal with no TCP/HTTP/readiness/WebSocket listener. Only temporary plugin copies change. Profiles independently disable native webserver; upstream identity/dependency graphs and candidate bytes remain unchanged. Old native watchers exclude node_modules, so after checking actual installed bytes, the candidate’s own files are copied into a profile watch root with public HMR root/file-URL configuration for real source replacement. Reports live in `.cache/verify-maintenance-retired/`; TAP must contain exactly three real named cases and all processes must stop. Other plugin versions explicitly refuse this suite.

## Producer and unpackaged acceptance index

After core checks, run `node scripts/pack.mjs` once, then `node scripts/packed-artifact.mjs record` to write adjacent `SHA256SUMS` and unique `producer.json`, binding HEAD/full diff/untracked bytes and modes, archive and Node/pnpm identity. Even identical tgz bytes receive distinct producer identity. Consumer report schemas remain; `report-*-evidence.json` links the raw report/logs and every `report-*-runtimes/` receipt. Actual preparation within the acceptance context records CLI/lock/DSH→WebApp→eight SDK packages and complete-tree nlink=1 checks, including smoke, previous-host and private-account runtimes.

Using each printed report path, copy this producer’s original JSON, adjacent sidecar, receipt directory and every sidecar-listed raw log into a new ignored unpackaged directory, retaining basenames. Smoke has three actual log suffixes: dev-prepare.mjs, dev-install.mjs, smoke.mjs; do not copy an absent synthetic smoke log. Do not mix historical producers or partial results. After consumption, use `packed-artifact.mjs index ARCHIVE SHA256 REPORT_ROOT OUTPUT`; see the [release guide](releasing.md) for the command. The index checks all eight CLI/complete-browser/smoke targets, full technical refusal and the three maintenance targets only for `0.3.6` full, plus raw hashes and required runtime roles. Missing/mismatched/mixed/partial evidence fails and replaces a stale passed index with failed status. Empty-file placeholders never count as real cases.

## Ordinary and full CI plans

`scripts/ci-plan.mjs` selects ordinary verification only when every changed path is one of `CHANGELOG.md`, `CHANGELOG.zh-CN.md`, `CONTRIBUTING.md`, `CONTRIBUTING.zh-CN.md`, `LICENSE` or `tests/unit/i18n.test.ts`. Any other path selects full verification, including source, shared tests/helpers, package/lock/build scripts, workflows, README, support policies and compatibility inventories. Renames/copies, unknown statuses, empty or incomplete differences and an unexpected/dirty checkout also select full. PR comparison uses the actual event base/head and verifies merge parents; push comparison uses before/after. Missing commit evidence falls back to full.

Manual dispatch, unknown events, releases and the Monday 00:00 UTC schedule use full. Ordinary/full both run complete eight-host CLI/browser/smoke; the low-risk whitelist only selects extra retirement work, not a smaller browser matrix. Full requires independent `0.2.1-alpha.2` technical refusal. Only a validated plugin `0.3.6` full archive requires the three-target maintenance-retirement matrix. Ordinary expects both retirement jobs to skip; other plugin versions’ full plans expect only maintenance-retirement to skip, retaining technical refusal. Aggregation requires all five results—validate, cli-smoke, browser, retired-rejection, maintenance-retirement—and explicit true/false required output. Missing/unknown values, failures, cancellations and other skips fail. Releases use full and consume the same producer without repacking.

Keep fixed-port cases serial per checkout. Local parallelism requires independent source/dist/artifacts/runtime/profile trees, writable node_modules copies and network namespaces; pnpm copy installation and nlink=1 checks prevent shared HMR inode changes.

On exact DSH `0.2.2-alpha.3`, `0.2.2-rc.1` and `0.2.2-rc.2`, `native-transport.spec.ts` compares genuine native asset/fallback bytes and ETags for GET/HEAD/304, rejects anonymous/revoked correct-tag requests, and retains immutable 200 semantics for real bundle/map/chunk artifacts and nonimmutable index behavior. Four real `/api/remote.mux` cases cover native HTTPS/proxy, default/none compression, whole-frame threshold/RSV1, successful ready frames and actual expiry/revocation. The installed native Gateway/ws owns transport and compression.

The new-host `account-login.spec.ts` source-HMR fault case preserves the initial instance on import failure, then throws after genuine replacement initialization to prove old/failed resource cleanup and native automatic rollback. It checks real provider fibers, listeners, state-lock nonces, mux closure, persisted authentication, the first restored Settings save and final lock reacquisition. The copied entry uses one canonical file URL and explicit native watch roots; public log export observes warnings without replacing HMR.

Browser language tests cover all eight plugin dictionaries, login fallback/memory, native accepted preference vs optimistic edits, delayed/unavailable/failed reads and saves, storage failures and sign-out/revocation persistence. DSH's native language catalog is unchanged. CLI tests require fixed English across environment languages and reject every `--lang` form before profile access; the published `0.2.0` retired fixture keeps its historical Chinese contract.

`liveshare.spec.ts` retains only real native viewer/index, carrier and administrator isolation on exact `0.2.2-alpha.3`, `0.2.2-rc.1`, `0.2.2-rc.2`. Owner/Relay product flows and exclusive stand-ins are removed. `business-origin-observer.mjs` registers the two exact Owner POST paths through real Connection.fetch, observing native Requests and one restoration pair across HTTP/HTTPS/proxy, real configuration HMR and anonymous/revoked/bad-Origin rejection. It loads no Host/Relay and does not fabricate waterfall results. Production adaptation remains; product flows are unverified, and historical reports certify only their original archive.

Published `0.3.6` completed final tag-archive acceptance and public distribution verification. Published `0.3.5` retains ten original declarations; `0.2.2-rc.2` support is not retroactive. Acceptance uses one final archive and Linux/Node.js 24 (at least `24.9.0` for the default host)/Chromium; other Node majors do not substitute. Real proxy products, external authorization, non-loopback IPv6 interfaces and other platforms/browsers remain unverified.

Direct development dependencies use DSH `0.2.2-rc.2`, Cordis `4.1.0` and Schemastery `3.19.0`; the actual new host chain uses Loader `1.1.0` and Include `1.1.0`. These are distribution package versions. Keep `autoInstallPeers: false` and only verified, installer-required exact release-age exceptions. Configuration observation reads canonical `entry.fiber.ctx.fiber.effectiveConfig`, falling back to `config` only when the old host has no accessor; inactive fibers, absent values and non-`.get()` references fail. Production retains the constructor's native Volatile reference.

`settings-icon.spec.ts` registers on all eight hosts: `0.2.2-alpha.3`, `0.2.2-rc.1` and `0.2.2-rc.2` check the native shield, size/currentColor/selection, light/dark narrow layouts, contribution release/default restoration, genuine declaration withdrawal/recreation without duplicates and disposal; the other five check the default icon. Observation/release controls live only in fixtures, and native Loader resolves the modules. Viewers install no administrator effects. Complete browser verification checks mandatory mux/resource/HMR/icon TAP names as well as nonempty files; name-filtered runs are partial. Language cases assert the actual visited sets rather than relying on their titles.

LiveShare is an officially published, experimental optional plugin, disabled by default (`listedByDefault: false`); this plugin never enables it automatically. Necessary compatibility applies to exact `0.2.2-alpha.3`, `0.2.2-rc.1` and `0.2.2-rc.2`. Local protocol stand-ins do not establish production Relay/OAuth, real visitor model operations or file writing. Private-interface dependencies and unknown-host limits remain in the inventory.

Source, prototypes, stage checks, complete candidates, PR/master/tag producers and post-publication byte checks are separate evidence. See bidirectional inventory entries `DSH-ACCOUNT-SLOT-001`, `DSH-RESOURCE-001` and `DSH-LIVESHARE-001` for private dependencies, exact applicability and retirement conditions.
