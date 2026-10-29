# Development

[简体中文](development.zh-CN.md)

This guide describes eight exact verification targets for unpublished plugin candidate `0.3.2`, defaulting to DSH `0.2.2-alpha.2`. Final same-archive evidence belongs to separate, unpackaged execution records; declarations and reports are distinct.

Development and the full test suite use Linux (`/proc` is required for the profile lock), Node.js 24+, pnpm 12.5.1, and DSH `0.2.2-alpha.2`. DSH `0.2.2-alpha.2` itself requires Node.js `>=24.9.0`; the plugin engine stays `>=24`. Browser tests use Playwright-managed Chromium and a Node HTTP/HTTPS forwarder.

## Set up and check a checkout

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm check
pnpm pack:local
pnpm smoke
```

`pnpm check` runs type checking, formatting, build, package/deployment/document checks, then unit, integration, CLI, and browser tests. `pnpm pack:local` writes `artifacts/dsh-auth-remote-0.3.2.tgz` after static checks; it does not publish. `pnpm smoke` installs that archive into an isolated DSH home, starts the pinned DSH runtime briefly, checks readiness, anonymous redirection/denial and an online CLI status, then stops it.

## Use the isolated development profile

```sh
pnpm dev:prepare
pnpm dev:install
pnpm dev:start
```

The scripts manage only `.dev/runtime-<version>` and `.dev/dsh-home` under this checkout; the default listener is `127.0.0.1:13090`. They reject an ambient `DSH_HOME` pointing elsewhere and symlinked development paths. `dev:install` rebuilds and installs the current archive even when the version stays the same. `dev:start` runs DSH in the foreground; Ctrl+C stops it. A source watcher can run in another terminal with `pnpm dev`, but rebuilds still need `dev:install` and a `dev:start` restart to load the new package.

For direct inspection, use the same isolated home explicitly:

```sh
DSH_HOME="$PWD/.dev/dsh-home" "$PWD/.dev/runtime-0.2.2-alpha.2/node_modules/.bin/dsh" plugin --profile web exec dsh-auth-remote status --json
```

The development home contains test account data. Keep it private and do not commit or copy it into a deployment profile.

## Test boundaries

`pnpm test:unit` covers the auth state machine, TOTP, backup codes, origin policy, translations, storage durability and lock recovery. `pnpm test:integration` exercises real HTTP/WebSocket sockets, native readiness, cookies, origin decisions and revocation. `pnpm test:cli` builds the real archive and tests interactive and noninteractive commands against isolated profiles and Unix sockets. `pnpm test:browser` boots the selected DSH version with temporary profiles and verifies the login and Security & sign-in UI, native settings, workspace, upload/preview, SSE, WebSocket and an HTTPS forwarding chain.

Browser network traffic uses a Node HTTP/HTTPS forwarder. The dedicated self-signed certificate and key under `tests/fixtures/tls/` are test fixtures only; they are never packaged or deployment credentials. Chat uses a local model stub. No real third-party authorization or paid model request is exercised. The default browser is Playwright Chromium; `DSH_TEST_BROWSER` can select a local browser executable, and `DSH_TEST_BIN` can select another binary only if it reports the exact selected version (default `0.2.2-alpha.2`).

Shared Host environments are allowlisted without real model credentials/endpoints; browser launch removes ambient proxy variables. Before first key entry, `localModelEndpoint` points native llm-deepseek baseURL at a local HTTP stub, without preseeded keys or disabled onboarding. UI cases require zero model calls; proxy chat allows only local chat and native session-title POSTs. Counts are checked at fixture close and unexpected requests fail.

The DSH test runtime lives in `.cache/test-runtime/<version>` and is pinned separately from the source dependencies. Host services and React remain external to the client bundle. The [deployment guide](deployment.md) describes profile and backup rules.

Before changing compatibility declarations or adaptations, read the [legacy compatibility inventory](legacy-compatibility.md). Check runtime admission, test targets, CI and user claims together; remove exclusive runtime code and tests in the same change when its applicable versions leave support. Old plugin configuration follows its own migration policy. Keep shared security checks and update both inventory languages and both matrix views with exact-version evidence.

Isolated verification installs use pnpm file copies so shared package hardlink metadata changes cannot trigger client hot reloads in another profile.

Current candidate support is in [README](../README.md#dsh-compatibility), release facts in the [bidirectional history](support-history.md), and adaptation evidence in the inventory. Both support policies retain the previous release record and remain unchanged for this `0.3.2` work; never derive old release claims from the current candidate manifest.

## Cross-version verification

The default target is DSH `0.2.2-alpha.2`; `DSH_TEST_VERSION` accepts only `0.2.1-alpha.3`, `0.2.1-alpha.4`, `0.2.1-alpha.5`, `0.2.1-rc.1`, `0.2.1-rc.2`, `0.2.1-rc.3`, `0.2.1-rc.4`, `0.2.2-alpha.2`. Test runtimes live under `.cache/test-runtime/<version>` and development runtimes under `.dev/runtime-<version>`. `DSH_TEST_BIN` must report that exact version. CI keeps eight-version CLI/installation smoke; full runs eight complete browser targets and ordinary uses the selection below. Development types and integration use locked `0.2.2-alpha.2` packages. All eight targets check the real Loader, model runtime context/`DSH_WEB_URL`, and positive IPv4/IPv6 HTTP/HTTPS security boundaries. Missing native transport support fails instead of skipping.

```sh
DSH_TEST_VERSION=0.2.1-alpha.3 pnpm test:cli
DSH_TEST_VERSION=0.2.1-alpha.3 pnpm test:browser
DSH_TEST_VERSION=0.2.1-alpha.4 pnpm test:cli
DSH_TEST_VERSION=0.2.1-alpha.4 pnpm test:browser
DSH_TEST_VERSION=0.2.1-alpha.5 pnpm test:cli
DSH_TEST_VERSION=0.2.1-alpha.5 pnpm test:browser
DSH_TEST_VERSION=0.2.1-rc.1 pnpm test:cli
DSH_TEST_VERSION=0.2.1-rc.1 pnpm test:browser
DSH_TEST_VERSION=0.2.1-rc.2 pnpm test:cli
DSH_TEST_VERSION=0.2.1-rc.2 pnpm test:browser
DSH_TEST_VERSION=0.2.1-rc.3 pnpm test:cli
DSH_TEST_VERSION=0.2.1-rc.3 pnpm test:browser
DSH_TEST_VERSION=0.2.2-alpha.2 pnpm test:cli
DSH_TEST_VERSION=0.2.2-alpha.2 pnpm test:browser
DSH_TEST_VERSION=0.2.2-alpha.2 pnpm test:cli
DSH_TEST_VERSION=0.2.2-alpha.2 pnpm test:browser
```

Browser tests save light/dark, desktop/narrow-screen screenshots under `.cache/ui-review/<version>` for visual review. Security CSS is installed and removed with the plugin, scopes its selectors to the plugin page, and reads the host's live `--dsw-*` tokens. The standalone login uses a subset of DSH 0.2.0-rc.1 theme tokens and the system color scheme without reading host preferences before authentication.

Official-account tests use a local Platform stand-in with the actual DSH `0.2.2-alpha.2` account provider. They check the original redirect URI and PKCE verifier during exchange, rejected state/URL/session combinations, duplicate submissions, cancellation, expiry and retries. Browser coverage checks the instruction-first menu and onboarding dialog, failed loopback navigation followed by paste/confirm, blocked popups, live locale and responsive light/dark layout. These tests do not establish a real official-account authorization session.

Core account tests load the exact provider from locked development dependencies, so they do not require a pre-existing CLI runtime cache. Browser tests still exercise the provider installed into each isolated DSH profile.

The temporary account adapter retains capability and live-configuration checks; complete manual-feature regression targets `0.2.1-alpha.3`, `0.2.1-alpha.4`, `0.2.1-alpha.5`, `0.2.1-rc.1`, `0.2.1-rc.2`, `0.2.1-rc.3`, `0.2.1-rc.4`, `0.2.2-alpha.2`. After global minimum admission the server no longer branches for older hosts; the separately exported helper still checks omitted, invalid and older inputs. Forward admission is not verification. Support or shared host-adapter changes require the same final tgz across all eight CLI, complete browser and smoke runs with `--suite cli --suite browser --suite smoke` per release. Never call rebuilding/repacking wrappers in the consumer loop. The runner restores archive dist, checks SHA-256 per suite and isolates smoke from development profiles. See `DSH-ACCOUNT-001` for public-callback evidence and migration/retirement conditions.

`live-config.spec.ts` observes the real Loader reference/fiber, auth/store identity, lock, listener and SSE/WebSocket continuity, checks the loaded dependency chain and restarts to verify the profile override. It does not fabricate services. Dialog regression covers cancellation/errors, focus/keyboard, optional/enforced TOTP, one-time code copying and redirect holds after revocation. Task documents, test credentials, profiles, screenshots and generated directories must remain outside the npm archive.

`account-login.spec.ts` exercises real configuration HMR on all eight: an ordinary `sessionHours` change rebuilds the listener, independent Settings writes wait for the native transaction queue, and genuine nesting remains rejected. Isolated plugin code replacement must allow manual sign-in to be enabled again. The transaction probe calls real HMR, replaces no service and is never packaged; see `DSH-HMR-001`. Protected remote profiles independently disable native webserver. On all eight, `startup-compatibility.spec.ts` damages only isolated plugin copies: `0.2.1-alpha.3` uses an incompatible Host peer for Loader skip, the other seven an incompatible `engines.dsh`; every version also gets an injected plugin admission range for post-import runtime rejection. Both paths must fail naturally without TCP/HTTP/readiness/WebSocket fallback; upstream and Loader auditing are unchanged.

The account preference binding recovers an initial failed read through the native describe mirror’s `ensure()` API. Recovery of an already held namespace uses the explicitly injected `remote.settings` transport and folds the accepted namespace back into that mirror. A sign-in click while the preference is loading waits for the shared read, then uses the latest accepted true/false value; loading does not select the native flow. Browser regression covers initial failure, a temporarily missing namespace and delayed reads for both routing choices.

Native Search/Fetch settings regression on `0.2.1-rc.2`, `0.2.1-rc.3`, `0.2.1-rc.4` and `0.2.2-alpha.2` covers real settings/credentials selection, failed saves, refresh/restart persistence and anonymous/revoked-session refusal. Endpoints are local and request counts must stay zero. On `0.2.1-rc.3`, `0.2.1-rc.4` and `0.2.2-alpha.2`, `rc-navigation.spec.ts` checks global/session/right-sidebar More menus, native settings/model selection and refusal after revocation. Market/Creator entries are inspected without installation or external authorization. Public sessions/sessionProjections APIs create a real session empty completed turn to expose native menus; no chat is sent and no snapshot is replaced. Official dynamic `/models` internal semantics are outside the verification claim.

Startup diagnostics use installed exact declarations and explicit lifecycle records, warning once per process/version/state even across configuration/module HMR. The three Alpha releases are legacy from 2026-10-28 with a 14-day window and earliest eligibility 2026-11-11 (Asia/Shanghai); dates never stop service. The six retired versions record last plugin `0.2.0`, retirement release `0.3.1` and preparation date `retiredOn: 2026-10-28`, which is not an actual npm publication timestamp. Mock-clock tests preserve classification after eligibility; real legacy HMR checks process-wide deduplication. API, package identity and security failures still refuse service.

`browser/host-release.spec.ts` fixes seven real round trips: `0.2.1-alpha.4` ↔ `0.2.1-alpha.3`, `0.2.1-alpha.5` ↔ `0.2.1-alpha.4`, `0.2.1-rc.1` ↔ `0.2.1-alpha.5`, `0.2.1-rc.2` ↔ `0.2.1-rc.1`, `0.2.1-rc.3` ↔ `0.2.1-rc.2`, `0.2.1-rc.4` ↔ `0.2.1-rc.3`, and `0.2.2-alpha.2` ↔ `0.2.1-rc.4`. Each keeps the page in one temporary profile/port, checks the native release prompt, reloads to verify authentication, the original session and persisted settings, then restores the starting release. Only `0.2.1-alpha.3` lacks release metadata and reads unknown; every other destination must show its actual full version. No upstream source, version or dependency-graph metadata is changed.

## Consume a fixed archive

`pnpm verify:packed` consumes an existing tgz without building or packing. Record its SHA-256 first, then pass the archive, that digest, an exact declared DSH release and one or more suites:

```sh
sha256sum artifacts/dsh-auth-remote-0.3.2.tgz
pnpm verify:packed --archive artifacts/dsh-auth-remote-0.3.2.tgz --sha256 <recorded-sha256> --dsh-version 0.2.2-alpha.2 --suite cli --suite browser --suite smoke
```

The consumer validates the package name/version and selected release declaration, stages those exact bytes at the fixed artifact path and restores only the archive's dist. CLI execution and installation comparisons therefore use that dist. It rejects unsafe tar entries, a changed digest, unknown selections, zero actual tests and skipped/cancelled/todo tests. Node's passing placeholder for a test file with no matching cases does not count as a real test. `--test-name-pattern` optionally filters one `cli` or `browser` suite; its report is explicitly partial and includes the files, pattern and actual commands. Fixed specialized suites cannot override their filter/count requirements; every required file must register tests.

| Suite          | Selection                                                                                                                        |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `cli`          | All CLI test files                                                                                                               |
| `browser`      | All browser test files                                                                                                           |
| `smoke`        | Install and briefly boot the archive in a new marked home                                                                        |
| `theme`        | The exact login/security theme and narrow-screen case (one real test)                                                            |
| `account`      | startup-compatibility, account-login and live-config on `0.2.1-alpha.3`                                                          |
| `host-release` | One real round trip on `0.2.1-alpha.4`, `0.2.1-alpha.5`, `0.2.1-rc.1`, `0.2.1-rc.2`, `0.2.1-rc.3`, `0.2.1-rc.4`, `0.2.2-alpha.2` |
| `rc-bootstrap` | host-release and dsh-bootstrap on `0.2.1-rc.1` (two real tests)                                                                  |

Consumption is serial within a checkout, enforced by a consumer lock. Each suite checks the input archive, fixed consumer archive and restored dist again. JSON reports and test logs remain under `.cache/verify-packed/`. Smoke creates its marked temporary root directly under `.cache/v-*` to keep the management socket within Linux's pathname limit in the default GitHub checkout. It uses its own runtime/home and `--port 0`; it reads only that child process's announced actual loopback address and checks online CLI status in the same profile. Existing `.dev/dsh-home` and services on 13090 are independent. Only the newly created verification root is removed. `DSH_VERIFY_ROOT` is internal and rejects unmarked, symlinked or external paths; ordinary development commands retain their existing profile and port.

## Independent retired-host refusal verification

`verify-retired.mjs` does not extend `DSH_TEST_VERSION` or the positive matrix. It checks the same candidate/SHA256SUMS and published `0.2.0` integrity, then uses two private old profiles for real CLI rejection/complete rollback and native peer skip of a whole incompatible package. The latter preserves actual old peer resolution, repeatedly confirms no TCP/HTTP/readiness/WebSocket listener, and cleans up processes. The six-host one-time acceptance belongs to the `0.3.1` migration history. Current full/release plans run only `0.2.1-alpha.2`, and ordinary runs none.

```sh
node scripts/verify-retired.mjs --archive artifacts/dsh-auth-remote-0.3.2.tgz --sha256 <recorded-sha256> --retired-dsh-version 0.2.1-alpha.2
```

The six independent negative targets are `0.1.7-rc.1`, `0.1.7-rc.2`, `0.2.0-rc.1`, `0.2.0-rc.2`, `0.2.1-alpha.1` and `0.2.1-alpha.2`. Reports stay separate from positive evidence under `.cache/verify-retired/`.

## Ordinary and full CI plans

`scripts/ci-plan.mjs` selects ordinary verification only when every changed path is one of `CHANGELOG.md`, `CHANGELOG.zh-CN.md`, `CONTRIBUTING.md`, `CONTRIBUTING.zh-CN.md`, `LICENSE` or `tests/unit/i18n.test.ts`. Any other path selects full verification, including source, shared tests/helpers, package/lock/build scripts, workflows, README, support policies and compatibility inventories. Renames/copies, unknown statuses, empty or incomplete differences and an unexpected/dirty checkout also select full. PR comparison uses the actual event base/head and verifies merge parents; push comparison uses before/after. Missing commit evidence falls back to full.

Manual dispatch, unknown events, every release and the Monday 00:00 UTC schedule use full verification. Every plan keeps eight-version CLI/smoke. Full runs eight complete browser targets plus the independent real negative job on `0.2.1-alpha.2`; ordinary runs no real retired-host negative job. Its browser matrix is fixed:

| Exact DSH release | Ordinary browser selection |
| ----------------- | -------------------------- |
| `0.2.1-alpha.3`   | `browser`                  |
| `0.2.1-alpha.4`   | `host-release`             |
| `0.2.1-alpha.5`   | `host-release`             |
| `0.2.1-rc.1`      | `rc-bootstrap`             |
| `0.2.1-rc.2`      | `browser`                  |
| `0.2.1-rc.3`      | `browser`                  |
| `0.2.1-rc.4`      | `browser`                  |
| `0.2.2-alpha.2`   | `browser`                  |

The shared workflow validates the exact matrix. Full requires validate, cli-smoke, browser and retired-rejection to succeed; ordinary accepts only the predetermined retired-rejection skip and requires the other three successes. Unknown plans, missing results, failures, cancellations and other skips fail. `CI Verify` also requires plan/producer success; releases use full and inherit the negative gate. Keep fixed-port tests serial per checkout; local parallel jobs require independent source/dist/artifacts/runtime/profile trees, writable node_modules copies and network namespaces. Copy-mode installation avoids shared HMR inode changes.

On exact DSH `0.2.2-alpha.2`, `native-transport.spec.ts` compares genuine native asset/fallback bytes and ETags for GET/HEAD/304, rejects anonymous/revoked correct-tag requests, and retains immutable 200 semantics for real bundle/map/chunk artifacts and nonimmutable index behavior. Four real `/api/remote.mux` cases cover native HTTPS/proxy, default/none compression, whole-frame threshold/RSV1, successful ready frames and actual expiry/revocation. The installed native Gateway/ws owns transport and compression.

The new-host `account-login.spec.ts` source-HMR fault case preserves the initial instance on import failure, then throws after genuine replacement initialization to prove old/failed resource cleanup and native automatic rollback. It checks real provider fibers, listeners, state-lock nonces, mux closure, persisted authentication, the first restored Settings save and final lock reacquisition. The copied entry uses one canonical file URL and explicit native watch roots; public log export observes warnings without replacing HMR.

Browser language tests cover all eight plugin dictionaries, login fallback/memory, native accepted preference vs optimistic edits, delayed/unavailable/failed reads and saves, storage failures and sign-out/revocation persistence. DSH's native language catalog is unchanged. CLI tests require fixed English across environment languages and reject every `--lang` form before profile access; the published `0.2.0` retired fixture keeps its historical Chinese contract.

`liveshare.spec.ts` registers only on exact `0.2.2-alpha.2`: real native Host/Owner PKCE/share worker/viewer carriers and stop operations use a local Relay identity/transport stand-in. Viewer clients remain inert for administrator features. Tests do not establish real Relay/OAuth, visitor models or file writes. Partial filtered reports and file placeholders never certify the final eight-host archive.
