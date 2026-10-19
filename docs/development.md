# Development

[简体中文](development.zh-CN.md)

Development and the full test suite use Linux (`/proc` is required for the profile lock), Node.js 24+, pnpm 12.5.1, and DSH `0.2.1-alpha.5`. Browser tests use Playwright-managed Chromium and a Node HTTP/HTTPS forwarder.

## Set up and check a checkout

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm check
pnpm pack:local
pnpm smoke
```

`pnpm check` runs type checking, formatting, build, package/deployment/document checks, then unit, integration, CLI, and browser tests. `pnpm pack:local` writes `artifacts/dsh-auth-remote-0.1.10.tgz` after static checks; it does not publish. `pnpm smoke` installs that archive into an isolated DSH home, starts the pinned DSH runtime briefly, checks readiness, anonymous redirection/denial and an online CLI status, then stops it.

## Use the isolated development profile

```sh
pnpm dev:prepare
pnpm dev:install
pnpm dev:start
```

The scripts manage only `.dev/runtime-<version>` and `.dev/dsh-home` under this checkout; the default listener is `127.0.0.1:13090`. They reject an ambient `DSH_HOME` pointing elsewhere and symlinked development paths. `dev:install` rebuilds and installs the current archive even when the version stays the same. `dev:start` runs DSH in the foreground; Ctrl+C stops it. A source watcher can run in another terminal with `pnpm dev`, but rebuilds still need `dev:install` and a `dev:start` restart to load the new package.

For direct inspection, use the same isolated home explicitly:

```sh
DSH_HOME="$PWD/.dev/dsh-home" "$PWD/.dev/runtime-0.2.1-alpha.5/node_modules/.bin/dsh" plugin --profile web exec dsh-auth-remote status --json
```

The development home contains test account data. Keep it private and do not commit or copy it into a deployment profile.

## Test boundaries

`pnpm test:unit` covers the auth state machine, TOTP, backup codes, origin policy, translations, storage durability and lock recovery. `pnpm test:integration` exercises real HTTP/WebSocket sockets, native readiness, cookies, origin decisions and revocation. `pnpm test:cli` builds the real archive and tests interactive and noninteractive commands against isolated profiles and Unix sockets. `pnpm test:browser` boots the selected DSH version with temporary profiles and verifies the login and Security & sign-in UI, native settings, workspace, upload/preview, SSE, WebSocket and an HTTPS forwarding chain.

Browser network traffic uses a Node HTTP/HTTPS forwarder. The dedicated self-signed certificate and key under `tests/fixtures/tls/` are test fixtures only; they are never packaged or deployment credentials. Chat uses a local model stub. No real third-party authorization or paid model request is exercised. The default browser is Playwright Chromium; `DSH_TEST_BROWSER` can select a local browser executable, and `DSH_TEST_BIN` can select another binary only if it reports the exact selected version (default `0.2.1-alpha.5`).

The DSH test runtime lives in `.cache/test-runtime/<version>` and is pinned separately from the source dependencies. Host services and React remain external to the client bundle. The [deployment guide](deployment.md) describes profile and backup rules.

Before changing compatibility declarations or adaptations, read the [legacy compatibility inventory](legacy-compatibility.md). Check runtime admission, test targets, CI and user claims together; remove exclusive runtime code and tests in the same change when its applicable versions leave support. Old plugin configuration follows its own migration policy. Keep shared security checks and update both inventory languages and both matrix views with exact-version evidence.

Isolated verification installs use pnpm file copies so shared package hardlink metadata changes cannot trigger client hot reloads in another profile.

## Cross-version verification

The default test target is DSH `0.2.1-alpha.5`. Set `DSH_TEST_VERSION` to `0.1.7-rc.1`, `0.1.7-rc.2`, `0.2.0-rc.1`, `0.2.0-rc.2`, `0.2.1-alpha.1`, `0.2.1-alpha.2`, `0.2.1-alpha.3`, `0.2.1-alpha.4`, or `0.2.1-alpha.5`; test runtimes live separately under `.cache/test-runtime/<version>` and development runtimes under `.dev/runtime-<version>`. `DSH_TEST_BIN` must report the exact selected version. CI runs CLI, installation smoke and browser tests for all nine versions. Development types and integration tests use the pinned DSH `0.2.1-alpha.5` packages. The source checkout test guide (`tests/README.md`) describes real Loader/model URL checks and native IPv6/TLS positive or unsupported-capability assertions; unavailable native test transport fails instead of skipping.

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

Official-account tests use a local Platform stand-in with the actual DSH `0.2.1-alpha.5` account provider. They check the original redirect URI and PKCE verifier during exchange, rejected state/URL/session combinations, duplicate submissions, cancellation, expiry and retries. Browser coverage checks the instruction-first menu and onboarding dialog, failed loopback navigation followed by paste/confirm, blocked popups, live locale and responsive light/dark layout. These tests do not establish a real official-account authorization session.

Core account tests load the exact provider from locked development dependencies, so they do not require a pre-existing CLI runtime cache. Browser tests still exercise the provider installed into each isolated DSH profile.

This temporary adapter uses `>=0.2.1-alpha.3` including prereleases, required capabilities and live configuration. Full manual-feature regression covers `0.2.1-alpha.3`, `0.2.1-alpha.4` and `0.2.1-alpha.5`. DSH `0.1.7-rc.1`, `0.1.7-rc.2`, `0.2.0-rc.1`, `0.2.0-rc.2`, `0.2.1-alpha.1`, `0.2.1-alpha.2` verify base authentication, complete Security & sign-in interactions, live configuration persistence and unavailable manual-feature feedback. Future admission is not verification. Support or shared host-adapter changes require the same final tgz across all nine CLI, browser and smoke runs. Run test files directly and use smoke:packed in that loop, avoiding the repacking test:cli/test:browser/smoke entries, and check SHA-256 after every release. See `DSH-ACCOUNT-001` for public-callback evidence, migration and retirement conditions.

`live-config.spec.ts` observes the real Loader reference/fiber, auth/store identity, lock, listener and SSE/WebSocket continuity, checks the loaded dependency chain and restarts to verify the profile override. It does not fabricate services. Dialog regression covers cancellation/errors, focus/keyboard, optional/enforced TOTP, one-time code copying and redirect holds after revocation. Task documents, test credentials, profiles, screenshots and generated directories must remain outside the npm archive.

`account-login.spec.ts` also exercises real native configuration HMR on every declared release: changing ordinary `sessionHours` rebuilds the listener, then an external Settings write must wait for an existing native transaction while genuine nesting is rejected. On `0.2.1-alpha.3`, `0.2.1-alpha.4` and `0.2.1-alpha.5`, modifying the isolated installed plugin additionally verifies native module replacement followed by re-enabling manual sign-in. The test-only transaction probe calls the real HMR service; it replaces no service and never enters the npm archive. The narrow listener-context adaptation is documented in `DSH-HMR-001`.

The account preference binding recovers an initial failed read through the native describe mirror’s `ensure()` API. Recovery of an already held namespace uses the explicitly injected `remote.settings` transport and folds the accepted namespace back into that mirror. A sign-in click while the preference is loading waits for the shared read, then uses the latest accepted true/false value; loading does not select the native flow. Browser regression covers initial failure, a temporarily missing namespace and delayed reads for both routing choices.

`browser/host-release.spec.ts` runs on `0.2.1-alpha.4` and `0.2.1-alpha.5`. It prepares actual `0.2.1-alpha.3` for the `0.2.1-alpha.4` target, and actual `0.2.1-alpha.4` for the `0.2.1-alpha.5` target. Each case switches Host in one temporary profile/port while retaining the page, checks the native release prompt, reloads and verifies authentication, the original session and saved configuration, then restores its starting release. The `0.2.1-alpha.3` destination has no release metadata and reads unknown; the `0.2.1-alpha.4` destination must show its real version. No upstream source, version or graph metadata is fabricated.
