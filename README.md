# dsh-auth-remote

[简体中文](README.zh-CN.md)

Single-user remote sign-in for DeepSeek Harness (DSH), with password, TOTP, one-use backup codes, and revocable sessions. The plugin runs inside DSH and protects browser pages, APIs, streams, and WebSockets.

## Requirements

- Linux with `/proc` and Node.js 24. DSH `0.2.2-rc.2` requires Node.js `>=24.9.0`.
- A supported DSH release and a `web` profile. One account and its sessions belong to that profile.

## DSH compatibility

Source candidate **`0.3.6`** declares these eight exact DSH releases. **`0.2.2-rc.2`** is the development default and recommended migration host, still an upstream RC prerelease. The candidate is unpublished; final same-archive acceptance and PR/master/tag gates must precede publication. Declarations do not establish testing or distribution. Published `0.3.5` retains its original ten declarations and archive.

| DSH release     | Maintenance                          |
| --------------- | ------------------------------------ |
| `0.2.1-rc.1`    | Supported; minimum supported release |
| `0.2.1-rc.2`    | Supported                            |
| `0.2.1-rc.3`    | Supported                            |
| `0.2.1-rc.4`    | Supported                            |
| `0.2.1-rc.5`    | Supported                            |
| `0.2.2-alpha.3` | Supported                            |
| `0.2.2-rc.1`    | Supported                            |
| `0.2.2-rc.2`    | Recommended host (RC prerelease)     |

`0.2.1-alpha.3`, `0.2.1-alpha.4` and `0.2.1-alpha.5` leave maintenance in `0.3.6`; their last supporting plugin is available `0.3.5`. Technical admission remains `>=0.2.1-alpha.3`, including prereleases without a new upper bound. Retired hosts may run with a warning after necessary checks; that is not a compatibility commitment. See the [support policy](docs/support-policy.md) for dates and migration, and the [bidirectional history](docs/support-history.md) for exact historical pairs. Dates never change installed plugin behavior, and unknown newer releases inherit no exact support.

DSH `0.2.2-alpha.2` retired in plugin `0.3.4` because fresh SDK resolution breaks native settings updates; an old plugin cannot repair that dependency combination. Migrate to the recommended host with a verified matching plugin; see the [retirement exception](docs/support-policy.md#upstream-failure-exception).

## Install

```sh
dsh --version
dsh plugin --profile web add dsh-auth-remote@0.3.6
dsh plugin --profile web list
```

Use this npm command after the release workflow has published the version. For an offline installation, substitute the absolute path to the verified release archive. Published `0.3.5` remains available for its historical ten hosts, including the three retired Alphas. Use the same data directory and profile for installation, initialization, and the running service. These commands use DSH's default `~/.dsh` directory and the `web` profile. First rehearse upgrades in an independent profile, following the [backup and rollback procedure](docs/deployment.md#backup-recovery-and-changes).

## Initialize the account

Run this in a real terminal:

```sh
dsh plugin --profile web exec dsh-auth-remote init
```

Enter one username and a password of 12–256 Unicode characters. The password is not echoed or passed as a command-line argument. Account creation is available only through the CLI.

TOTP is optional by default (`requireTotp: false`); the first password sign-in offers setup or skipping it. Set `requireTotp: true` to require setup. Save the ten backup codes when shown: each works once, and the list cannot be retrieved later.

## Configure the web profile

The minimal local setup needs no profile patch:

```sh
dsh web --no-open --port 13090
```

Open the printed `http://127.0.0.1:13090/` address. Unauthenticated navigation redirects to sign-in. Without an explicit `publicUrl`, the plugin derives the root URL from the actual listener address, protocol, and bound port. `/auth-remote/ready` reports service readiness.

For public access, follow the [deployment guide](docs/deployment.md) and [profile example](examples/web-profile-auth-remote.patch.yml). Set top-level `publicUrl: https://dsh.example.com/`, `host`, and `port`. Keep the native `webserver` independently disabled in the profile patch, as shown in the example.

The listener supports concrete IPv4/IPv6 addresses, HTTP, and HTTPS with paired `tlsCert`/`tlsKey` settings. `publicUrl` must be an HTTP(S) root without credentials, child paths, query, or fragment. It admits one public origin plus literal loopback addresses; setting it does not configure routing or TLS. CLI listener and public-URL options override profile values. If a downstream route needs the original public Host, configure `preserveOriginPaths` as described in the deployment guide.

## Sign in and manage the account

Open the local root or your configured public URL. Inside DSH, open the sidebar account menu, then **Settings → Security & sign-in**. The page shows the plugin username, TOTP status, session expiry, and active session count. It can change the password, set up or rebind TOTP, disable TOTP when policy permits, and revoke sessions.

Password and second-factor changes revoke existing sessions. Sessions have a fixed default lifetime of 168 hours (`sessionHours`) and survive service restarts. Signing out the current session preserves other sessions; signing out all sessions verifies the password and any bound second factor. TOTP setup displays backup codes once, so save and acknowledge them before signing in again.

Management commands are also available:

```sh
dsh plugin --profile web exec dsh-auth-remote status --json
dsh plugin --profile web exec dsh-auth-remote reset-password
dsh plugin --profile web exec dsh-auth-remote reset-totp
dsh plugin --profile web exec dsh-auth-remote revoke-sessions
```

Mutating commands require interactive confirmation. If a submitted command loses its response, check `status` before retrying.

Browser text supports English, Chinese, Japanese, Spanish, French, German, Russian, and Brazilian Portuguese. The embedded page follows DSH's language setting. The standalone login page uses the remembered DSH preference, then the browser language, then English; it has no language selector. CLI output is English.

On DSH `0.2.2-alpha.3`, `0.2.2-rc.1` and `0.2.2-rc.2`, the native navigation uses a shield for this page; the other five declared hosts retain their default icon.

## Sign in to an official DeepSeek account

On `0.2.2-rc.2`, the adapter preserves the native account entry and notification children; older hosts retain public registration. Notifications use local protocol stand-ins; cross-product notification localization mapping is not fully verified.

Remote DeepSeek account sign-in is enabled by default (`manualAccountLogin: true`):

1. Choose **Sign in** in the account menu, then **Open sign-in page** in the instruction dialog.
2. Complete official sign-in in the new tab. The resulting loopback address may show a connection error or 404; its page does not need to load.
3. Copy the entire callback URL, including `code` and `state`, into **Full callback address** in the original DSH tab, then choose **Confirm sign-in**.

Keep the original DSH tab open. If a popup is blocked, use the dialog's authorization link. No local listener, SSH tunnel, or browser extension is needed. The plugin delivers the callback inside DSH and never requests the pasted URL. Authorization expires after ten minutes and is cancelled when its dialog is dismissed or the initiating session is revoked; expired or failed attempts must be restarted.

Before authorization, **Use API key** opens DSH's native credential editor; the same option is available from the account menu. During authorization, the secondary button cancels the attempt.

The switch in **Settings → Security & sign-in → Sign-in preferences** controls new manual authorizations and persists in the profile. Turning it off restores native sign-in entries while preserving active attempts and existing official-account credentials. Native sign-in still requires a callback route reachable by your browser.

## Put a proxy in front

Use the [reverse proxy guide](docs/reverse-proxy.md) with the [Nginx](examples/nginx.conf) or [Traefik](examples/traefik-dsh.yml) example. Preserve the browser's Host and Origin, WebSocket upgrades, and streaming responses. TLS can terminate at the proxy; set its exact HTTPS root as `publicUrl`. Keep the DSH listener private and do not cache authentication responses.

Acceptance targets Linux, Node.js 24, Chromium, native IPv4/IPv6 HTTP/HTTPS and the existing Node forwarding topologies. Other platforms/browsers, a real non-loopback IPv6 interface, Nginx/Traefik binaries and real external authorization are not established by these tests. See the deployment and development guides for the precise boundaries; local verification is separate from GitHub Actions and publication.

## Documentation

See [deployment](docs/deployment.md) for configuration, profile backups, and operational details, or [development](docs/development.md) to build and test from source. Changes are in the [changelog](CHANGELOG.md). Contributions follow the [contribution guide](CONTRIBUTING.md) and [release guide](docs/releasing.md). Licensed under [MIT](LICENSE).
