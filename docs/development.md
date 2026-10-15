# Development

[简体中文](development.zh-CN.md)

Development and the full test suite use Linux (`/proc` is required for the profile lock), Node.js 24+, pnpm 12.5.1, and DSH `0.2.1-alpha.3`. Browser tests use Playwright-managed Chromium and a Node HTTP/HTTPS forwarder.

## Set up and check a checkout

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm check
pnpm pack:local
pnpm smoke
```

`pnpm check` runs type checking, formatting, build, package/deployment/document checks, then unit, integration, CLI, and browser tests. `pnpm pack:local` writes `artifacts/dsh-auth-remote-0.1.9.tgz` after static checks; it does not publish. `pnpm smoke` installs that archive into an isolated DSH home, starts the pinned DSH runtime briefly, checks readiness, anonymous redirection/denial and an online CLI status, then stops it.

## Use the isolated development profile

```sh
pnpm dev:prepare
pnpm dev:install
pnpm dev:start
```

The scripts manage only `.dev/runtime-<version>` and `.dev/dsh-home` under this checkout; the default listener is `127.0.0.1:13090`. They reject an ambient `DSH_HOME` pointing elsewhere and symlinked development paths. `dev:install` rebuilds and installs the current archive even when the version stays the same. `dev:start` runs DSH in the foreground; Ctrl+C stops it. A source watcher can run in another terminal with `pnpm dev`, but rebuilds still need `dev:install` and a `dev:start` restart to load the new package.

For direct inspection, use the same isolated home explicitly:

```sh
DSH_HOME="$PWD/.dev/dsh-home" "$PWD/.dev/runtime-0.2.1-alpha.3/node_modules/.bin/dsh" plugin --profile web exec dsh-auth-remote status --json
```

The development home contains test account data. Keep it private and do not commit or copy it into a deployment profile.

## Test boundaries

`pnpm test:unit` covers the auth state machine, TOTP, backup codes, origin policy, translations, storage durability and lock recovery. `pnpm test:integration` exercises real HTTP/WebSocket sockets, native readiness, cookies, origin decisions and revocation. `pnpm test:cli` builds the real archive and tests interactive and noninteractive commands against isolated profiles and Unix sockets. `pnpm test:browser` boots the selected DSH version with temporary profiles and verifies the login and Security UI, native settings, workspace, upload/preview, SSE, WebSocket and an HTTPS forwarding chain.

Browser network traffic uses a Node HTTP/HTTPS forwarder. The dedicated self-signed certificate and key under `tests/fixtures/tls/` are test fixtures only; they are never packaged or deployment credentials. Chat uses a local model stub. No real third-party authorization or paid model request is exercised. The default browser is Playwright Chromium; `DSH_TEST_BROWSER` can select a local browser executable, and `DSH_TEST_BIN` can select another binary only if it reports the exact selected version (default `0.2.1-alpha.3`).

The DSH test runtime lives in `.cache/test-runtime/<version>` and is pinned separately from the source dependencies. Host services and React remain external to the client bundle. The [deployment guide](deployment.md) describes profile and backup rules.

Before changing compatibility declarations or adaptations, read the [legacy compatibility inventory](legacy-compatibility.md). Check runtime admission, test targets, CI and user claims together; remove exclusive runtime code and tests in the same change when its applicable versions leave support. Old plugin configuration follows its own migration policy. Keep shared security checks and update both inventory languages and both matrix views with exact-version evidence.

Isolated verification installs use pnpm file copies so shared package hardlink metadata changes cannot trigger client hot reloads in another profile.

## Cross-version verification

The default test target is DSH `0.2.1-alpha.3`. Set `DSH_TEST_VERSION` to `0.1.7-rc.1`, `0.1.7-rc.2`, `0.2.0-rc.1`, `0.2.0-rc.2`, `0.2.1-alpha.1`, `0.2.1-alpha.2`, or `0.2.1-alpha.3`; test runtimes live separately under `.cache/test-runtime/<version>` and development runtimes under `.dev/runtime-<version>`. `DSH_TEST_BIN` must report the exact selected version. CI runs CLI, installation smoke and browser tests for all seven versions. Development types and integration tests use the pinned DSH `0.2.1-alpha.3` packages. The source checkout test guide (`tests/README.md`) describes real Loader/model URL checks and native IPv6/TLS positive or unsupported-capability assertions; unavailable native test transport fails instead of skipping.

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
pnpm test:cli
pnpm test:browser
```

Browser tests save light/dark, desktop/narrow-screen screenshots under `.cache/ui-review/<version>` for visual review. Security CSS is installed and removed with the plugin, scopes its selectors to the plugin page, and reads the host's live `--dsw-*` tokens. The standalone login uses a subset of DSH 0.2.0-rc.1 theme tokens and the system color scheme without reading host preferences before authentication.

Official-account tests use a local Platform stand-in with the actual DSH `0.2.1-alpha.3` account provider. They check the original redirect URI and PKCE verifier during exchange, rejected state/URL/session combinations, duplicate submissions, cancellation, expiry and retries. Browser coverage checks the instruction-first menu and onboarding dialog, failed loopback navigation followed by paste/confirm, blocked popups, live locale and responsive light/dark layout. These tests do not establish a real official-account authorization session.

Core account tests load the exact provider from locked development dependencies, so they do not require a pre-existing CLI runtime cache. Browser tests still exercise the provider installed into each isolated DSH profile.

This temporary adapter is enabled only on exact `0.2.1-alpha.3`, which alone needs full feature regression. DSH `0.1.7-rc.1`, `0.1.7-rc.2`, `0.2.0-rc.1`, `0.2.0-rc.2`, `0.2.1-alpha.1`, `0.2.1-alpha.2` need startup, Settings and disabled-feature checks for this change, without a full seven-version rerun. Support-range or shared host adaptation changes still need the complete matrix; CI targets stay unchanged. Later releases default to their native flow. See `DSH-ACCOUNT-001` in the compatibility inventory for public-callback evidence, migration and retirement conditions.
