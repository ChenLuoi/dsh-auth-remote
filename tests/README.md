# Test guide

[简体中文](README.zh-CN.md)

Run tests from a Linux source checkout with Node.js 24+, pnpm 12.5.1, and Playwright Chromium:

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm check
```

`pnpm check` runs static checks and all four test groups. Run a group directly while developing:

| Group       | Command                 | Contract covered                                                                                                                                        |
| ----------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit        | `pnpm test:unit`        | Password/TOTP/backup codes, sessions, origin policy, translations, JSON durability and lock recovery.                                                   |
| Integration | `pnpm test:integration` | Real HTTP and WebSocket sockets, Host/Origin policy, native readiness, cookies, API mutations and revocation.                                           |
| CLI         | `pnpm test:cli`         | Real local archive, DSH profile execution, pseudo-terminal prompts, en/zh selection, JSON output, Unix socket, offline lock and uncertain results.      |
| Browser     | `pnpm test:browser`     | Pinned DSH boot, anonymous gate, login, Security settings, native settings, workspace, chat stream, upload/preview, SSE/WebSocket and HTTPS forwarding. |

The scripts prepare DSH `0.2.1-alpha.3` under `.cache/test-runtime/<version>` and create temporary `DSH_HOME` directories. `DSH_TEST_BIN` can override the executable only when `--version` reports the selected `DSH_TEST_VERSION` (default `0.2.1-alpha.3`); `DSH_TEST_BROWSER` can override the Playwright browser executable. The default is Playwright-managed Chromium.

CI runs CLI/smoke and browser jobs for `0.1.7-rc.1`, `0.1.7-rc.2`, `0.2.0-rc.1`, `0.2.0-rc.2`, `0.2.1-alpha.1`, `0.2.1-alpha.2`, and `0.2.1-alpha.3`. Select a target with `DSH_TEST_VERSION=<version>`. Startup tests exercise the actual Loader and observe its model-facing Web section (runtime context on DSH `0.2.1-alpha.3`) and `DSH_WEB_URL`; native transport tests run IPv4/IPv6 HTTP/HTTPS and confirmed CLI revocation on DSH `0.2.1-alpha.2`, `0.2.1-alpha.3`, and assert unsupported IPv6/TLS errors on DSH `0.1.7-rc.1`, `0.1.7-rc.2`, `0.2.0-rc.1`, `0.2.0-rc.2`, `0.2.1-alpha.1`. Missing IPv6 or TLS test support fails the suite.

The Node HTTP/HTTPS forwarder in `tests/helpers/` stands in for transport without depending on a local proxy installation. `tests/fixtures/tls/` contains a dedicated self-signed test certificate and key for the `.test` hostname. They are never installation or production credentials and are excluded from the archive. Browser chat uses a local model stub. No real external account, OAuth token or paid model request is needed.

The [TLS fixture guide](fixtures/tls/README.md) documents the native listener certificate's IPv4/IPv6 SANs, Node trust and browser public-key pin. The forwarder also validates TLS upstreams, so both HTTPS-to-HTTP and HTTP-to-native-HTTPS chains have coverage.

Do not point these commands at an existing account directory. Browser and CLI fixtures use separate temporary homes; `pnpm smoke` uses the marked `.dev/dsh-home`. The [development guide](../docs/development.md) describes the isolated development lifecycle, and the [deployment guide](../docs/deployment.md) describes a live profile and backup procedure.

Official-account coverage in `integration/account-login.test.ts` uses the actual installed DSH `0.2.1-alpha.3` provider and a local Platform stand-in to validate PKCE, redirect URI equality, state, callback parsing, session ownership, one-time submission, cancellation, expiry and retries. `browser/account-login.spec.ts` exercises instruction-first authorization, failed loopback navigation and pasted callback completion, blocked popups and bilingual responsive themes; DSH `0.1.7-rc.1`, `0.1.7-rc.2`, `0.2.0-rc.1`, `0.2.0-rc.2`, `0.2.1-alpha.1`, `0.2.1-alpha.2` verify startup, intact Settings and disabled manual account support. No real official account is used.
