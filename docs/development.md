# Development

[简体中文](development.zh-CN.md)

This guide describes the eleven exact verification targets for plugin `0.2.0`. RC additions do not extend npm `0.1.10` historical support; final same-archive results are recorded separately.

Development and the full test suite use Linux (`/proc` is required for the profile lock), Node.js 24+, pnpm 12.5.1, and DSH `0.2.1-rc.2`. Browser tests use Playwright-managed Chromium and a Node HTTP/HTTPS forwarder.

## Set up and check a checkout

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm check
pnpm pack:local
pnpm smoke
```

`pnpm check` runs type checking, formatting, build, package/deployment/document checks, then unit, integration, CLI, and browser tests. `pnpm pack:local` writes `artifacts/dsh-auth-remote-0.2.0.tgz` after static checks; it does not publish. `pnpm smoke` installs that archive into an isolated DSH home, starts the pinned DSH runtime briefly, checks readiness, anonymous redirection/denial and an online CLI status, then stops it.

## Use the isolated development profile

```sh
pnpm dev:prepare
pnpm dev:install
pnpm dev:start
```

The scripts manage only `.dev/runtime-<version>` and `.dev/dsh-home` under this checkout; the default listener is `127.0.0.1:13090`. They reject an ambient `DSH_HOME` pointing elsewhere and symlinked development paths. `dev:install` rebuilds and installs the current archive even when the version stays the same. `dev:start` runs DSH in the foreground; Ctrl+C stops it. A source watcher can run in another terminal with `pnpm dev`, but rebuilds still need `dev:install` and a `dev:start` restart to load the new package.

For direct inspection, use the same isolated home explicitly:

```sh
DSH_HOME="$PWD/.dev/dsh-home" "$PWD/.dev/runtime-0.2.1-rc.2/node_modules/.bin/dsh" plugin --profile web exec dsh-auth-remote status --json
```

The development home contains test account data. Keep it private and do not commit or copy it into a deployment profile.

## Test boundaries

`pnpm test:unit` covers the auth state machine, TOTP, backup codes, origin policy, translations, storage durability and lock recovery. `pnpm test:integration` exercises real HTTP/WebSocket sockets, native readiness, cookies, origin decisions and revocation. `pnpm test:cli` builds the real archive and tests interactive and noninteractive commands against isolated profiles and Unix sockets. `pnpm test:browser` boots the selected DSH version with temporary profiles and verifies the login and Security & sign-in UI, native settings, workspace, upload/preview, SSE, WebSocket and an HTTPS forwarding chain.

Browser network traffic uses a Node HTTP/HTTPS forwarder. The dedicated self-signed certificate and key under `tests/fixtures/tls/` are test fixtures only; they are never packaged or deployment credentials. Chat uses a local model stub. No real third-party authorization or paid model request is exercised. The default browser is Playwright Chromium; `DSH_TEST_BROWSER` can select a local browser executable, and `DSH_TEST_BIN` can select another binary only if it reports the exact selected version (default `0.2.1-rc.2`).

The DSH test runtime lives in `.cache/test-runtime/<version>` and is pinned separately from the source dependencies. Host services and React remain external to the client bundle. The [deployment guide](deployment.md) describes profile and backup rules.

Before changing compatibility declarations or adaptations, read the [legacy compatibility inventory](legacy-compatibility.md). Check runtime admission, test targets, CI and user claims together; remove exclusive runtime code and tests in the same change when its applicable versions leave support. Old plugin configuration follows its own migration policy. Keep shared security checks and update both inventory languages and both matrix views with exact-version evidence.

Isolated verification installs use pnpm file copies so shared package hardlink metadata changes cannot trigger client hot reloads in another profile.

Support decisions live in the [policy](support-policy.md), release facts in the [bidirectional history](support-history.md), and adaptation evidence in the inventory. Update all three with README in both languages; do not derive old release claims from the current candidate manifest.

## Cross-version verification

The default test target is DSH `0.2.1-rc.2`. Set `DSH_TEST_VERSION` to `0.1.7-rc.1`, `0.1.7-rc.2`, `0.2.0-rc.1`, `0.2.0-rc.2`, `0.2.1-alpha.1`, `0.2.1-alpha.2`, `0.2.1-alpha.3`, `0.2.1-alpha.4`, `0.2.1-alpha.5`, `0.2.1-rc.1`, or `0.2.1-rc.2`; test runtimes live separately under `.cache/test-runtime/<version>` and development runtimes under `.dev/runtime-<version>`. `DSH_TEST_BIN` must report the exact selected version. CI retains CLI and installation smoke for all eleven releases. Full verification runs every browser target; ordinary verification uses the fixed boundary selection below. Development types and integration tests use the pinned DSH `0.2.1-rc.2` packages. The source checkout test guide (`tests/README.md`) describes real Loader/model URL checks and native IPv6/TLS positive or unsupported-capability assertions; unavailable native test transport fails instead of skipping.

```sh
DSH_TEST_VERSION=0.1.7-rc.1 pnpm test:cli
DSH_TEST_VERSION=0.1.7-rc.1 pnpm test:browser
DSH_TEST_VERSION=0.1.7-rc.2 pnpm test:cli
DSH_TEST_VERSION=0.1.7-rc.2 pnpm test:browser
DSH_TEST_VERSION=0.2.0-rc.1 pnpm test:cli
DSH_TEST_VERSION=0.2.0-rc.1 pnpm test:browser
DSH_TEST_VERSION=0.2.0-rc.2 pnpm test:cli
DSH_TEST_VERSION=0.2.0-rc.2 pnpm test:browser
DSH_TEST_VERSION=0.2.1-alpha.1 pnpm test:cli
DSH_TEST_VERSION=0.2.1-alpha.1 pnpm test:browser
DSH_TEST_VERSION=0.2.1-alpha.2 pnpm test:cli
DSH_TEST_VERSION=0.2.1-alpha.2 pnpm test:browser
DSH_TEST_VERSION=0.2.1-alpha.3 pnpm test:cli
DSH_TEST_VERSION=0.2.1-alpha.3 pnpm test:browser
DSH_TEST_VERSION=0.2.1-alpha.4 pnpm test:cli
DSH_TEST_VERSION=0.2.1-alpha.4 pnpm test:browser
pnpm test:cli
pnpm test:browser
```

Browser tests save light/dark, desktop/narrow-screen screenshots under `.cache/ui-review/<version>` for visual review. Security CSS is installed and removed with the plugin, scopes its selectors to the plugin page, and reads the host's live `--dsw-*` tokens. The standalone login uses a subset of DSH 0.2.0-rc.1 theme tokens and the system color scheme without reading host preferences before authentication.

Official-account tests use a local Platform stand-in with the actual DSH `0.2.1-rc.2` account provider. They check the original redirect URI and PKCE verifier during exchange, rejected state/URL/session combinations, duplicate submissions, cancellation, expiry and retries. Browser coverage checks the instruction-first menu and onboarding dialog, failed loopback navigation followed by paste/confirm, blocked popups, live locale and responsive light/dark layout. These tests do not establish a real official-account authorization session.

Core account tests load the exact provider from locked development dependencies, so they do not require a pre-existing CLI runtime cache. Browser tests still exercise the provider installed into each isolated DSH profile.

This temporary adapter uses `>=0.2.1-alpha.3` including prereleases, required capabilities and live configuration. Full manual-feature regression covers `0.2.1-alpha.3`, `0.2.1-alpha.4`, `0.2.1-alpha.5`, `0.2.1-rc.1` and `0.2.1-rc.2`. DSH `0.1.7-rc.1`, `0.1.7-rc.2`, `0.2.0-rc.1`, `0.2.0-rc.2`, `0.2.1-alpha.1`, `0.2.1-alpha.2` verify base authentication, complete Security & sign-in interactions, live configuration persistence and unavailable manual-feature feedback. Future admission is not verification. Support or shared host-adapter changes require the same final tgz across all eleven CLI, browser and smoke runs. Use the fixed-archive consumer with `--suite cli --suite browser --suite smoke` for each exact release, as shown below and in the release guide. It restores the verified dist, checks SHA-256 per suite and isolates smoke from development profiles; do not use repacking wrappers in the loop. See `DSH-ACCOUNT-001` for public-callback evidence, migration and retirement conditions.

`live-config.spec.ts` observes the real Loader reference/fiber, auth/store identity, lock, listener and SSE/WebSocket continuity, checks the loaded dependency chain and restarts to verify the profile override. It does not fabricate services. Dialog regression covers cancellation/errors, focus/keyboard, optional/enforced TOTP, one-time code copying and redirect holds after revocation. Task documents, test credentials, profiles, screenshots and generated directories must remain outside the npm archive.

`account-login.spec.ts` also exercises real native configuration HMR on every declared release: changing ordinary `sessionHours` rebuilds the listener, then an external Settings write must wait for an existing native transaction while genuine nesting is rejected. On `0.2.1-alpha.3`, `0.2.1-alpha.4`, `0.2.1-alpha.5`, `0.2.1-rc.1` and `0.2.1-rc.2`, modifying the isolated installed plugin additionally verifies native module replacement followed by re-enabling manual sign-in. The test-only transaction probe calls the real HMR service; it replaces no service and never enters the npm archive. The narrow listener-context adaptation is documented in `DSH-HMR-001`. Protected remote deployments require the independent profile-level native-listener disable in the deployment guide. The two RC startup regressions damage only isolated plugin copies: an incompatible `engines.dsh` must make the real Loader skip the bundle, while an injected plugin-side admission range must reach its own runtime rejection. Both must fail startup with no TCP, HTTP, readiness or WebSocket fallback; upstream code, versions and Loader auditing remain unchanged.

The account preference binding recovers an initial failed read through the native describe mirror’s `ensure()` API. Recovery of an already held namespace uses the explicitly injected `remote.settings` transport and folds the accepted namespace back into that mirror. A sign-in click while the preference is loading waits for the shared read, then uses the latest accepted true/false value; loading does not select the native flow. Browser regression covers initial failure, a temporarily missing namespace and delayed reads for both routing choices.

The `0.2.1-rc.2` native Search/Fetch settings regression uses an isolated remote Host and the actual three settings namespaces plus the credentials domain. It covers provider selection, validation/save errors, refresh/restart persistence and anonymous/revoked-session refusal. All configured endpoints are local test endpoints, and their request counter must remain zero; no paid Search/Fetch or official account operation is performed. The source test guide details this boundary.

Startup maintenance diagnostics use the installed plugin's exact declarations and explicit lifecycle records. Each exact-version/state warning appears once per process, including configuration or module HMR; a new process warns again. Legacy logs include announced dates and migration guidance. Unverified or explicitly retired inputs warn about the missing current support commitment, while normal support stays quiet. Dates never stop service, and required API, package identity and security failures still refuse it. `dsh-support.test.ts` crosses both eligibility dates with a mocked clock; the account HMR regression also checks real legacy and normal startup output. A separate legacy module case uses the same candidate's manifest/dist in an isolated, explicitly watchable directory through public Loader insertion and HMR `base/root`; the default node_modules exclusion remains in effect. No real version is recorded as retired.

`browser/host-release.spec.ts` fixes four real round trips: `0.2.1-alpha.4` ↔ `0.2.1-alpha.3`, `0.2.1-alpha.5` ↔ `0.2.1-alpha.4`, `0.2.1-rc.1` ↔ `0.2.1-alpha.5`, and `0.2.1-rc.2` ↔ `0.2.1-rc.1`. Each keeps the page in one temporary profile/port, checks the native release prompt, reloads to verify authentication, the original session and persisted settings, then restores the starting release. Only `0.2.1-alpha.3` lacks release metadata and reads unknown; every other destination must show its actual full version. No upstream source, version or dependency-graph metadata is changed.

## Consume a fixed archive

`pnpm verify:packed` consumes an existing tgz without building or packing. Record its SHA-256 first, then pass the archive, that digest, an exact declared DSH release and one or more suites:

```sh
sha256sum artifacts/dsh-auth-remote-0.2.0.tgz
pnpm verify:packed --archive artifacts/dsh-auth-remote-0.2.0.tgz --sha256 <recorded-sha256> --dsh-version 0.2.1-rc.2 --suite cli --suite browser --suite smoke
```

The consumer validates the package name/version and selected release declaration, stages those exact bytes at the fixed artifact path and restores only the archive's dist. CLI execution and installation comparisons therefore use that dist. It rejects unsafe tar entries, a changed digest, unknown selections, zero actual tests and skipped/cancelled/todo tests. Node's passing placeholder for a test file with no matching cases does not count as a real test. `--test-name-pattern` optionally filters one `cli` or `browser` suite; its report is explicitly partial and includes the files, pattern and actual commands. Fixed specialized suites cannot override their filter/count requirements; every required file must register tests.

| Suite               | Selection                                                                           |
| ------------------- | ----------------------------------------------------------------------------------- |
| `cli`               | All CLI test files                                                                  |
| `browser`           | All browser test files                                                              |
| `smoke`             | Install and briefly boot the archive in a new marked home                           |
| `theme`             | The exact login/security theme and narrow-screen case (one real test)               |
| `startup-transport` | startup-compatibility and native-transport on `0.2.1-alpha.1`, `0.2.1-alpha.2`      |
| `account`           | startup-compatibility, account-login and live-config on `0.2.1-alpha.3`             |
| `host-release`      | One real round trip on `0.2.1-alpha.4`, `0.2.1-alpha.5`, `0.2.1-rc.1`, `0.2.1-rc.2` |
| `rc-bootstrap`      | host-release and dsh-bootstrap on `0.2.1-rc.1` (two real tests)                     |

Consumption is serial within a checkout, enforced by a consumer lock. Each suite checks the input archive, fixed consumer archive and restored dist again. JSON reports and test logs remain under `.cache/verify-packed/`. Smoke creates its marked temporary root directly under `.cache/v-*` to keep the management socket within Linux's pathname limit in the default GitHub checkout. It uses its own runtime/home and `--port 0`; it reads only that child process's announced actual loopback address and checks online CLI status in the same profile. Existing `.dev/dsh-home` and services on 13090 are independent. Only the newly created verification root is removed. `DSH_VERIFY_ROOT` is internal and rejects unmarked, symlinked or external paths; ordinary development commands retain their existing profile and port.

## Ordinary and full CI plans

`scripts/ci-plan.mjs` selects ordinary verification only when every changed path is one of `CHANGELOG.md`, `CHANGELOG.zh-CN.md`, `CONTRIBUTING.md`, `CONTRIBUTING.zh-CN.md`, `LICENSE` or `tests/unit/i18n.test.ts`. Any other path selects full verification, including source, shared tests/helpers, package/lock/build scripts, workflows, README, support policies and compatibility inventories. Renames/copies, unknown statuses, empty or incomplete differences and an unexpected/dirty checkout also select full. PR comparison uses the actual event base/head and verifies merge parents; push comparison uses before/after. Missing commit evidence falls back to full.

Manual dispatch, unknown events, every release and the Monday 00:00 UTC schedule always use full verification. Ordinary reduction is enabled only after the first eleven-release, same-archive full validation succeeds. Every plan retains CLI/smoke on all eleven releases; the ordinary browser matrix is fixed:

| Exact DSH release | Ordinary browser selection                      |
| ----------------- | ----------------------------------------------- |
| `0.1.7-rc.1`      | `browser` (complete)                            |
| `0.1.7-rc.2`      | `theme`                                         |
| `0.2.0-rc.1`      | No separate browser job; CLI/smoke retained     |
| `0.2.0-rc.2`      | `browser` (complete)                            |
| `0.2.1-alpha.1`   | `startup-transport`                             |
| `0.2.1-alpha.2`   | `startup-transport`                             |
| `0.2.1-alpha.3`   | `account`                                       |
| `0.2.1-alpha.4`   | `host-release`                                  |
| `0.2.1-alpha.5`   | `host-release`                                  |
| `0.2.1-rc.1`      | `rc-bootstrap`                                  |
| `0.2.1-rc.2`      | `browser` (complete, including search settings) |

The shared workflow validates the exact chosen matrix before consumption. A combination omitted by this explicit plan has no job; an unexpected skipped/cancelled job or zero required test file fails the aggregate. `CI Verify` requires the plan, producer and reusable verification to succeed. All high-risk changes and releases still require every browser target on the same archive. Keep fixed-port tests serial in one checkout; local concurrent jobs require separate source/dist/artifacts/runtime/profile trees, an independent copy of node_modules, and network namespaces. pnpm exec can refresh command shims, so workers must use their own writable dependency copy. Keep any shared source dependency directory read-only as a guard, and use copy-mode installation to avoid shared HMR inode changes.
