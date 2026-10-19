# Test guide

[简体中文](README.zh-CN.md)

Run tests from a Linux source checkout with Node.js 24+, pnpm 12.5.1, and Playwright Chromium:

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm check
```

`pnpm check` runs static checks and all four test groups. Run a group directly while developing:

| Group       | Command                 | Contract covered                                                                                                                                                  |
| ----------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit        | `pnpm test:unit`        | Password/TOTP/backup codes, sessions, origin policy, translations, JSON durability and lock recovery.                                                             |
| Integration | `pnpm test:integration` | Real HTTP and WebSocket sockets, Host/Origin policy, native readiness, cookies, API mutations and revocation.                                                     |
| CLI         | `pnpm test:cli`         | Real local archive, DSH profile execution, pseudo-terminal prompts, en/zh selection, JSON output, Unix socket, offline lock and uncertain results.                |
| Browser     | `pnpm test:browser`     | Pinned DSH boot, anonymous gate, login, Security & sign-in settings, native settings, workspace, chat stream, upload/preview, SSE/WebSocket and HTTPS forwarding. |

The scripts prepare DSH `0.2.1-alpha.5` under `.cache/test-runtime/<version>` and create temporary `DSH_HOME` directories. `DSH_TEST_BIN` can override the executable only when `--version` reports the selected `DSH_TEST_VERSION` (default `0.2.1-alpha.5`); `DSH_TEST_BROWSER` can override the Playwright browser executable. The default is Playwright-managed Chromium.

CI runs CLI/smoke and browser jobs for `0.1.7-rc.1`, `0.1.7-rc.2`, `0.2.0-rc.1`, `0.2.0-rc.2`, `0.2.1-alpha.1`, `0.2.1-alpha.2`, `0.2.1-alpha.3`, `0.2.1-alpha.4`, and `0.2.1-alpha.5`. Select a target with `DSH_TEST_VERSION=<version>`. Startup tests exercise the actual Loader and observe its model-facing Web section (runtime context on DSH `0.2.1-alpha.3`, `0.2.1-alpha.4` and `0.2.1-alpha.5`) and `DSH_WEB_URL`; native transport tests run IPv4/IPv6 HTTP/HTTPS and confirmed CLI revocation on DSH `0.2.1-alpha.2`, `0.2.1-alpha.3`, `0.2.1-alpha.4`, `0.2.1-alpha.5`, and assert unsupported IPv6/TLS errors on DSH `0.1.7-rc.1`, `0.1.7-rc.2`, `0.2.0-rc.1`, `0.2.0-rc.2`, `0.2.1-alpha.1`. Missing IPv6 or TLS test support fails the suite.

The Node HTTP/HTTPS forwarder in `tests/helpers/` stands in for transport without depending on a local proxy installation. `tests/fixtures/tls/` contains a dedicated self-signed test certificate and key for the `.test` hostname. They are never installation or production credentials and are excluded from the archive. Browser chat uses a local model stub. No real external account, OAuth token or paid model request is needed.

The [TLS fixture guide](fixtures/tls/README.md) documents the native listener certificate's IPv4/IPv6 SANs, Node trust and browser public-key pin. The forwarder also validates TLS upstreams, so both HTTPS-to-HTTP and HTTP-to-native-HTTPS chains have coverage.

Do not point these commands at an existing account directory. Browser and CLI fixtures use separate temporary homes; `pnpm smoke` uses the marked `.dev/dsh-home`. The [development guide](../docs/development.md) describes the isolated development lifecycle, and the [deployment guide](../docs/deployment.md) describes a live profile and backup procedure.

Login and official-account browser fixtures unset inherited `DEEPSEEK_API_KEY` in their DSH runtime environment so an inherited DeepSeek API key does not hide fresh-profile onboarding. The API-key setup helper selects the native credential alternative in the DSH `0.2.1-alpha.3`, `0.2.1-alpha.4` and `0.2.1-alpha.5` account dialog. Plugin-settings persistence checks also handle onboarding after an explicit page reload.

Official-account coverage in `integration/account-login.test.ts` uses the actual installed DSH `0.2.1-alpha.5` provider from locked development dependencies and a local Platform stand-in to validate PKCE, redirect URI equality, state, callback parsing, session ownership, one-time submission, cancellation, expiry and retries. `browser/account-login.spec.ts` exercises instruction-first authorization, failed loopback navigation and pasted callback completion, blocked popups and bilingual responsive themes; DSH `0.1.7-rc.1`, `0.1.7-rc.2`, `0.2.0-rc.1`, `0.2.0-rc.2`, `0.2.1-alpha.1`, `0.2.1-alpha.2` verify startup, intact Settings and disabled manual account support. No real official account is used.

`browser/live-config.spec.ts` observes the real Loader and loaded package identities per release, writes true→false→true→false and verifies long connections and restart persistence. Full account-browser branches cover `0.2.1-alpha.3`, `0.2.1-alpha.4` and `0.2.1-alpha.5`, including native Settings save success/failure, immediate new-entry switching and completion of admitted attempts. Login/settings regression covers the five trusted overview values, password/TOTP/current/all-session dialogs, keyboard/focus, cancellation/errors, failed backup-code copying and one-time display. Screenshots mask passwords and backup codes. Full version matrices must reuse one final archive and check SHA-256 after each release, avoiding standard commands that repack inside the loop.

`browser/account-login.spec.ts` triggers real configuration HMR through an ordinary `sessionHours` change on all declared releases and verifies that Settings writes still wait for the native transaction queue and reject genuine nesting. The test-only `fixtures/hmr-config-probe.mjs` uses the real HMR service. The exact `0.2.1-alpha.3`, `0.2.1-alpha.4` and `0.2.1-alpha.5` targets also replace isolated installed host code and re-enable manual sign-in afterward.

`browser/host-release.spec.ts` runs on `0.2.1-alpha.4` and `0.2.1-alpha.5`. It prepares actual `0.2.1-alpha.3` for the `0.2.1-alpha.4` target, and actual `0.2.1-alpha.4` for the `0.2.1-alpha.5` target. Each case switches Host in one temporary profile/port while retaining the page, checks the native release prompt, reloads and verifies authentication, the original session and saved configuration, then restores its starting release. The `0.2.1-alpha.3` destination has no release metadata and reads unknown; the `0.2.1-alpha.4` destination must show its real version. No upstream source, version or graph metadata is fabricated.
