# dsh-auth-remote

[简体中文](README.zh-CN.md)

Single-user remote sign-in for DeepSeek Harness (DSH), with password, TOTP, one-use backup codes, and revocable sessions. The package runs inside DSH and guards its browser routes, APIs, streams, and WebSockets.

## Requirements

- Linux with `/proc`, Node.js 24 or newer, and a tested DSH runtime: **0.1.7-rc.1**, **0.1.7-rc.2**, **0.2.0-rc.1**, or **0.2.0-rc.2** (default). pnpm 12.5.1 is needed only when building from source.
- DSH's default `~/.dsh` data directory and a `web` profile. The account state belongs to that profile; it is not shared with another profile.
- For source browser tests, install Playwright Chromium with `pnpm exec playwright install chromium`. The tests use that managed browser and a dedicated, self-signed TLS fixture.

## DSH compatibility

Plugin 0.1.3 is tested against DSH **0.1.7-rc.1**, **0.1.7-rc.2**, **0.2.0-rc.1**, and **0.2.0-rc.2**. The default supported runtime is **0.2.0-rc.2**. The host peer declaration and runtime version check both use `>=0.1.7-rc.1`, with no upper bound. DSH's loader includes prereleases, so 0.2 and later releases are admitted without a per-version exemption or a plugin update solely to widen the range.

Later versions are forward-admitted, not claimed as tested. The plugin still verifies the required WebServer/Connection APIs, shared host package identity, and native authentication exchange. If those contracts change, authentication stays unavailable with a diagnostic; removing the version ceiling cannot guarantee compatibility with unknown API changes. CI runs CLI, installation smoke, and browser regressions on all four tested versions.

Plugin **0.1.3** makes DSH 0.2.0-rc.2 the default verified runtime. The open-ended compatibility range and theme integration were introduced in **0.1.2**. For source builds, see the [development guide](docs/development.md).

## Install from npm

With DSH installed, verify its version and install the published plugin into the default `web` profile:

```sh
dsh --version
dsh plugin --profile web add dsh-auth-remote@0.1.3
dsh plugin --profile web list
```

Check that `dsh --version` prints `0.2.0-rc.2` (or another tested version listed above) and the plugin list includes `dsh-auth-remote@0.1.3`. These commands use DSH's default data directory. For source builds and an isolated development runtime, see the [development guide](docs/development.md).

## Configure the web profile

The installed bundle supplies the auth listener with `allowedOrigins: []`, so only literal loopback hosts are admitted. The minimal setup needs no profile patch. Start with `dsh web --no-open --port 13090` and use the printed `http://127.0.0.1:13090` URL; unauthenticated browser navigation redirects to sign-in. Check `/auth-remote/ready` before relying on the listener. Startup prints the listener and configured public origins without a native `?token=` URL.

For a public HTTPS origin, use the complete [profile configuration and deployment steps](docs/deployment.md). Its reusable [profile example](examples/web-profile-auth-remote.patch.yml) registers `https://dsh.example.com` and recommends an independent native-listener disable. Replace the example hostname and port consistently before opening a proxy.

If a downstream route needs the original public Host, add its path to `preserveOriginPaths`. The bundle configures native Connection trust from `allowedOrigins`; no separate Connection profile row is needed.

## Initialize the account

Run this in a real terminal against the **same** default `web` profile as the service:

```sh
dsh plugin --profile web exec dsh-auth-remote init --lang en
```

Enter one username and a password of 12–256 Unicode characters. The password is not a command-line argument and is not echoed. The login page guides an uninitialized profile back to this command; it cannot create the account. With the default `requireTotp: true`, the first password sign-in requires authenticator setup. Save the ten backup codes when shown: each works once and the list cannot be retrieved later.

## Sign in and manage the account

Open the direct loopback URL for the minimal installation. After configuring a public origin, open `https://dsh.example.com/auth-remote/login`. Security settings inside DSH can change the password, bind or disable TOTP when policy permits, and revoke sessions. Password or factor changes revoke existing sessions. Sessions have a fixed default lifetime of 168 hours and survive service restarts.

```sh
dsh plugin --profile web exec dsh-auth-remote status --json
dsh plugin --profile web exec dsh-auth-remote reset-password --lang en
dsh plugin --profile web exec dsh-auth-remote reset-totp --lang en
dsh plugin --profile web exec dsh-auth-remote revoke-sessions --lang en
```

Mutating commands require an interactive confirmation. Online commands use a private Unix socket; offline commands acquire the same profile lock. If a management response is lost after submission, check `status` before deciding whether to try again. `status --json` keeps its machine-readable keys regardless of language.

The embedded Security page follows DSH's language setting. The standalone login page defaults to English and stores only `en` or `zh` at `localStorage["dsh-auth-remote.locale"]`; it does not read DSH settings before login. CLI human text uses `--lang en|zh`, or the first nonempty `LC_ALL`, `LC_MESSAGES`, then `LANG` (Chinese variants select `zh`, everything else English).

## Put a proxy in front

Use the [reverse proxy guide](docs/reverse-proxy.md) with the [Nginx](examples/nginx.conf) or [Traefik](examples/traefik-dsh.yml) example. Preserve the browser's Host and Origin, WebSocket upgrades, and streaming responses. TLS can terminate at the proxy; register its exact HTTPS origin in `allowedOrigins`. Keep the DSH listener private and do not cache authentication responses.

## Project and maintenance

The plugin uses DSH's WebServer, Connection, settings slots, and official workspace browser and preview. It stores one account plus sessions in a private profile JSON file. It provides single-user access without a separate identity server. See [development](docs/development.md) and [deployment](docs/deployment.md) for checks and boundaries. Changes and releases are recorded in the [changelog](CHANGELOG.md); see [contributing](CONTRIBUTING.md), [releasing](docs/releasing.md), and the [MIT license](LICENSE).
