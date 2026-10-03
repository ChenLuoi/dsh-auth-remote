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

The scripts prepare DSH `0.2.1-alpha.1` under `.cache/test-runtime/<version>` and create temporary `DSH_HOME` directories. `DSH_TEST_BIN` can override the executable only when `--version` reports the selected `DSH_TEST_VERSION` (default `0.2.1-alpha.1`); `DSH_TEST_BROWSER` can override the Playwright browser executable. The default is Playwright-managed Chromium.

The Node HTTP/HTTPS forwarder in `tests/helpers/` stands in for transport without depending on a local proxy installation. `tests/fixtures/tls/` contains a dedicated self-signed test certificate and key for the `.test` hostname. They are never installation or production credentials and are excluded from the archive. Browser chat uses a local model stub. No real external account, OAuth token or paid model request is needed.

Do not point these commands at an existing account directory. Browser and CLI fixtures use separate temporary homes; `pnpm smoke` uses the marked `.dev/dsh-home`. The [development guide](../docs/development.md) describes the isolated development lifecycle, and the [deployment guide](../docs/deployment.md) describes a live profile and backup procedure.
