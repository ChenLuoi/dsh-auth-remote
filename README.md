# dsh-auth-remote

[简体中文](README.zh-CN.md)

Single-user remote sign-in for DeepSeek Harness (DSH), with password, TOTP, one-use backup codes, and revocable sessions. The package runs inside DSH and guards its browser routes, APIs, streams, and WebSockets.

## Requirements

- Linux with `/proc`, Node.js 24 or newer, and DSH **0.1.7-rc.1**, **0.1.7-rc.2**, **0.2.0-rc.1**, **0.2.0-rc.2**, **0.2.1-alpha.1**, or **0.2.1-alpha.2** (default). pnpm 12.5.1 is needed only when building from source.
- DSH's default `~/.dsh` data directory and a `web` profile. The account state belongs to that profile; it is not shared with another profile.
- For source browser tests, install Playwright Chromium with `pnpm exec playwright install chromium`. The tests use that managed browser and a dedicated, self-signed TLS fixture.

## DSH compatibility

Compatibility is declared for the six releases above in `dsh.compatibility.dshReleases`; development defaults to **0.2.1-alpha.2**. The host peer declaration and runtime version check both use `>=0.1.7-rc.1`, with no upper bound, including prereleases.

| DSH releases                     | Concrete IPv4 HTTP | Native public URL CLI, Web prompt and `DSH_WEB_URL`                               | Native IPv6 / HTTPS                |
| -------------------------------- | ------------------ | --------------------------------------------------------------------------------- | ---------------------------------- |
| 0.1.7-rc.1/rc.2, 0.2.0-rc.1/rc.2 | Yes                | No `--public-url`; native model-side URL remains `http://127.0.0.1:<actual-port>` | Unsupported                        |
| 0.2.1-alpha.1                    | Yes                | Yes; uses the plugin's final public root                                          | Unsupported                        |
| 0.2.1-alpha.2                    | Yes                | Yes; uses the plugin's final public root                                          | Yes, through the official listener |

Later versions are forward-admitted, not claimed as tested. The plugin still verifies the required WebServer/Connection APIs, shared host package identity, and native authentication exchange. Missing capabilities leave authentication unavailable with a diagnostic. CI covers CLI, installation smoke and browsers on all six declared versions.

The plugin's single-entry configuration works on all six releases. Native IPv6/TLS needs alpha.2; an external HTTPS proxy can serve older HTTP listeners. For source builds, see the [development guide](docs/development.md).

## Install from npm

With DSH installed, verify its version and install the published plugin into the default `web` profile:

```sh
dsh --version
dsh plugin --profile web add dsh-auth-remote@0.1.8
dsh plugin --profile web list
```

Check that `dsh --version` prints `0.2.1-alpha.2` (or another compatible release above) and the plugin list includes `dsh-auth-remote@0.1.8`. These commands use DSH's default data directory. For source builds and an isolated development runtime, see the [development guide](docs/development.md).

## Configure the web profile

The minimal setup needs no profile patch. Start with `dsh web --no-open --port 13090` and use the printed `http://127.0.0.1:13090/` root. Without an explicit `publicUrl`, the plugin derives one root from the actual listener protocol, address and bound port, including `--port 0`. Unauthenticated navigation redirects to sign-in. Check `/auth-remote/ready` before relying on the service. Startup prints the listener and one distinct public root, without a native `?token=` URL.

For a public HTTPS entry, use the [deployment guide](docs/deployment.md) and [profile example](examples/web-profile-auth-remote.patch.yml), with top-level `publicUrl: https://dsh.example.com/`, `host` and `port`. Alpha.2 also supports concrete IPv6 and paired top-level `tlsCert`/`tlsKey`. The URL must be an HTTP(S) root, with no credentials, child path, query or fragment. One public origin plus literal loopback is admitted. Setting a URL does not configure proxy routing or TLS.

The plugin automatically declares its finalized native bridge authority in Connection's `trustedHosts`, so downstream plugins can recognize a concrete listener without an extra `--trusted-host`. If a downstream route needs the original public Host, add its path to `preserveOriginPaths`; the final public authority is then declared as well. Explicit CLI trusted hosts are retained, while the outer public-origin and sign-in checks still apply. CLI host/port and public URL override file values; TLS overrides as one complete pair. See the [migration and path rules](docs/deployment.md#configuration-priority-and-path-bases) before upgrading `allowedOrigins`: zero or one item is migrated in memory with a warning, multiple items and any explicit coexistence with `publicUrl` fail.

## Initialize the account

Run this in a real terminal against the **same** default `web` profile as the service:

```sh
dsh plugin --profile web exec dsh-auth-remote init --lang en
```

Enter one username and a password of 12–256 Unicode characters. The password is not a command-line argument and is not echoed. The login page guides an uninitialized profile back to this command; it cannot create the account. With the default `requireTotp: true`, the first password sign-in requires authenticator setup. Save the ten backup codes when shown: each works once and the list cannot be retrieved later.

## Sign in and manage the account

Open the direct loopback URL for the minimal installation. After configuring a public origin, open `https://dsh.example.com/auth-remote/login`. Security settings inside DSH can change the password, bind or disable TOTP when policy permits, and revoke sessions. Password or factor changes revoke existing sessions. Sessions have a fixed default lifetime of 168 hours and survive service restarts.

The sign-in page references DSH's PWA manifest. The manifest and favicons are readable before sign-in; business pages and APIs still require authentication. See the [public resource rules](docs/deployment.md#source-and-bridge-contract).

```sh
dsh plugin --profile web exec dsh-auth-remote status --json
dsh plugin --profile web exec dsh-auth-remote reset-password --lang en
dsh plugin --profile web exec dsh-auth-remote reset-totp --lang en
dsh plugin --profile web exec dsh-auth-remote revoke-sessions --lang en
```

Mutating commands require an interactive confirmation. Online commands use a private Unix socket; offline commands acquire the same profile lock. If a management response is lost after submission, check `status` before deciding whether to try again. `status --json` keeps its machine-readable keys regardless of language.

The embedded Security page follows DSH's language setting. The standalone login page defaults to English and stores only `en` or `zh` at `localStorage["dsh-auth-remote.locale"]`; it does not read DSH settings before login. CLI human text uses `--lang en|zh`, or the first nonempty `LC_ALL`, `LC_MESSAGES`, then `LANG` (Chinese variants select `zh`, everything else English).

## Put a proxy in front

Use the [reverse proxy guide](docs/reverse-proxy.md) with the [Nginx](examples/nginx.conf) or [Traefik](examples/traefik-dsh.yml) example. Preserve the browser's Host and Origin, WebSocket upgrades, and streaming responses. TLS can terminate at the proxy; set its exact HTTPS root as `publicUrl`. Keep the DSH listener private and do not cache authentication responses.

## Project and maintenance

The plugin uses DSH's WebServer, Connection, settings slots, and official workspace browser and preview. It stores one account plus sessions in a private profile JSON file. It provides single-user access without a separate identity server. See [development](docs/development.md) and [deployment](docs/deployment.md) for checks and boundaries. Changes and releases are recorded in the [changelog](CHANGELOG.md); see [contributing](CONTRIBUTING.md), [releasing](docs/releasing.md), and the [MIT license](LICENSE).
