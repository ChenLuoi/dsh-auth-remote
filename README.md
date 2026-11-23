# dsh-auth-remote

[简体中文](README.zh-CN.md)

Single-user remote sign-in for DeepSeek Harness (DSH), with password, TOTP, one-use backup codes, and revocable sessions. The plugin runs inside DSH and protects browser pages, APIs, streams, and WebSockets.

## Requirements

- Linux with `/proc` and Node.js 24. DSH `0.2.2-rc.5` requires Node.js `>=24.9.0`.
- DSH `0.2.3-alpha.2` requires Node.js `^24.22.3 || >=26.13.1`. The release verification matrix uses `24.22.3`.
- A supported DSH release and a `web` profile. One account and its sessions belong to that profile.

## DSH compatibility

The **`0.4.0`** release supports the twelve exact DSH versions below. Upstream RC prerelease **`0.2.2-rc.5`** is the development default and recommended migration host. Choose **`0.2.3-alpha.2`** to use native device authorization. See the [support history](docs/support-history.md#plugin-0.4.0).

| DSH release     | Maintenance                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------- |
| `0.2.1-rc.1`    | Supported; minimum supported release                                                        |
| `0.2.1-rc.2`    | Supported                                                                                   |
| `0.2.1-rc.3`    | Supported                                                                                   |
| `0.2.1-rc.4`    | Supported                                                                                   |
| `0.2.1-rc.5`    | Supported                                                                                   |
| `0.2.2-alpha.3` | Supported                                                                                   |
| `0.2.2-rc.1`    | Supported                                                                                   |
| `0.2.2-rc.2`    | Supported, recommended for `0.3.6`                                                          |
| `0.2.2-rc.3`    | Supported since `0.3.7`                                                                     |
| `0.2.2-rc.4`    | Supported since `0.3.7`                                                                     |
| `0.2.2-rc.5`    | Supported since `0.3.7`, development default and recommended migration host (RC prerelease) |
| `0.2.3-alpha.2` | Supported since `0.4.0`, with native device authorization                                   |

`0.2.1-alpha.3`, `0.2.1-alpha.4` and `0.2.1-alpha.5` leave maintenance in `0.3.6`; their last supporting plugin is available `0.3.5`. Technical admission remains `>=0.2.1-alpha.3`, including prereleases without a new upper bound. Retired hosts may run with a warning after necessary checks; that is not a compatibility commitment. See the [support policy](docs/support-policy.md) for dates and migration, and the [bidirectional history](docs/support-history.md) for exact historical pairs. Dates never change installed plugin behavior, and unknown newer releases inherit no exact support.

DSH `0.2.2-alpha.2` retired in plugin `0.3.4` because fresh SDK resolution breaks native settings updates; an old plugin cannot repair that dependency combination. Migrate to the recommended host with a verified matching plugin; see the [retirement exception](docs/support-policy.md#upstream-failure-exception).

## Install

```sh
dsh --version
dsh plugin --profile web add dsh-auth-remote@0.4.0
dsh plugin --profile web list
```

This command installs `0.4.0` on one of its exact supported hosts. Published `0.3.6` remains available for its eight declared hosts. For an offline installation, substitute the absolute path to the verified release archive. Published `0.3.5` remains available for its historical ten hosts, including the three retired Alphas. Use the same data directory and profile for installation, initialization, and the running service. These commands use DSH's default `~/.dsh` directory and the `web` profile. First rehearse upgrades in an independent profile, following the [backup and rollback procedure](docs/deployment.md#backup-recovery-and-changes).

To rehearse an archive installation in a fresh `DSH_HOME`, verify the recorded SHA-256 and use the exact DSH binary. Keep `DSH_HOME` and the binary consistent for the commands that follow. Build and verify the archive in a separate checkout using the [local procedure](docs/releasing.md#local-candidate-verification).

```sh
export DSH_HOME="$(mktemp -d)"
/path/to/exact/dsh --version
/path/to/exact/dsh plugin --profile web add /absolute/path/to/dsh-auth-remote-0.4.0.tgz
```

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

The listener supports concrete IPv4/IPv6 addresses, HTTP, and HTTPS with paired `tlsCert`/`tlsKey` settings. `publicUrl` must be an HTTP(S) root without credentials, child paths, query, or fragment. It admits one public origin plus literal loopback addresses; setting it does not configure routing or TLS. CLI listener and public-URL options override profile values. On the earlier bridge hosts, if a downstream route needs the original public Host, configure `preserveOriginPaths` as described in the deployment guide.

## Sign in and manage the account

Open the local root or your configured public URL. Inside DSH, open the sidebar account menu, then **Settings → Security & sign-in**. The page shows the plugin username, TOTP status, session expiry, and active session count. It can change the password, set up or rebind TOTP, disable TOTP when policy permits, and revoke sessions.

Password and second-factor changes revoke existing sessions. Password sessions default to 168 hours (`sessionHours`) and survive service restarts. Signing out the current session preserves other issued sessions. Signing out all sessions verifies the password and any bound second factor. TOTP setup displays backup codes once, so save and acknowledge them before signing in again.

Management commands are also available:

```sh
dsh plugin --profile web exec dsh-auth-remote status --json
dsh plugin --profile web exec dsh-auth-remote reset-password
dsh plugin --profile web exec dsh-auth-remote reset-totp
dsh plugin --profile web exec dsh-auth-remote revoke-sessions
```

Mutating commands require interactive confirmation. If a submitted command loses its response, check `status` before retrying.

Browser text supports English, Chinese, Japanese, Spanish, French, German, Russian, and Brazilian Portuguese. The embedded page follows DSH's language setting. The standalone login page uses the remembered DSH preference, then the browser language, then English; it has no language selector. CLI output is English.

Native navigation shows a shield on DSH `0.2.2-alpha.3`, `0.2.2-rc.1`, `0.2.2-rc.2`, `0.2.2-rc.3`, `0.2.2-rc.4`, `0.2.2-rc.5` and `0.2.3-alpha.2`. The other five hosts use their default icon.

## Authorize another browser

Version `0.4.0` enables this flow on exact DSH `0.2.3-alpha.2`. The password-signed-in owner (A) can copy the ordinary application address in **Settings → Remote Connection**. This page reuses the native Remote Connection panel and adds a session duration and any required second-factor check when issuing device access. The protected profile rejects native startup tokens, native session cookies and token-only `/connect` access.

1. To invite a device, A generates a QR code in **Settings → Remote Connection**. Keep one valid QR at a time. Cancel or replace it there. B opens the scanned invitation and enters the workspace directly. The QR expires after two minutes by default. Use a reachable non-loopback entry for QR invitations.
2. To request access, B chooses **Use a pairing code** in the upper-right corner of the sign-in card. The request starts automatically. A checks the displayed code and request source in **Settings → Remote Connection**, then approves or rejects the individual request. The request expires after five minutes by default. The pairing view supports requesting a fresh code, cancellation and recovery after an uncertain response.
3. For each QR or approval, A chooses 1, 3 or 7 days, with 3 as the default. A bound TOTP requires a current code or one unused backup code for each action. An unbound A can authorize directly once signed in under the profile's existing policy. Cancel and reject do not require an extra code.

B uses the workspace with a fixed session deadline from the first successful claim. `sessionHours`, A's remaining time, retries, reloads and restarts leave that deadline unchanged. Only an A session can issue devices. A signing out or expiring invalidates its pending grants and leaves issued B sessions active until their own expiry. B signing out ends that session. Global session revocation clears both kinds of session and pending grants, and expired or revoked sessions lose their active SSE and WebSocket connections.

## Sign in to an official DeepSeek account

The adapter preserves the native account entry and notification children on `0.2.2-rc.2`, `0.2.2-rc.3`, `0.2.2-rc.4`, `0.2.2-rc.5`. On `0.2.3-alpha.2`, manual sign-in delivers the callback to the native provider using its original PKCE and state. Other notification entries use public registration. Local stand-ins exercise authorization and notifications. Cross-product notification localization mapping remains unverified.

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
