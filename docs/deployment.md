# Deployment

[简体中文](deployment.zh-CN.md)

This guide targets unpublished plugin candidate `0.3.2` with recommended DSH `0.2.2-alpha.2` and default `~/.dsh` data directory. See [README](../README.md#dsh-compatibility) for eight-version support/dates, [history](support-history.md#by-dsh) for old pairs and distribution, and [development](development.md) for source builds.

The native capabilities below apply to `0.2.1-alpha.3`, `0.2.1-alpha.4`, `0.2.1-alpha.5`, `0.2.1-rc.1`, `0.2.1-rc.2`, `0.2.1-rc.3`, `0.2.1-rc.4` and `0.2.2-alpha.2`.

Upstream DSH `0.2.2-alpha.2` itself requires Node `>=24.9.0`; the plugin still declares Node `>=24` and adds no minor-version gate.

## Minimal installation of the candidate archive

`0.3.2` is unpublished. Build and verify a local archive using the [development guide](development.md), then install that file. Published `0.3.1` retains its seven-host history and does not include this new-host adaptation; see the [exact distribution record](support-history.md#plugin-0.3.1). Use the same default `web` profile:

```sh
dsh --version
dsh plugin --profile web add ./artifacts/dsh-auth-remote-0.3.2.tgz
dsh plugin --profile web list
dsh web --no-open --port 13090
```

Verify the selected DSH version and plugin list. No profile patch is needed for this local IPv4 HTTP loopback check. Before exposing a remote entry, apply the complete configuration below, including the independent native-listener disable. In another terminal, require `/auth-remote/ready` to return `"plugin":"dsh-auth-remote"`, `"protocolVersion":1`, and `"ready":true`, then initialize the account:

```sh
curl -fsS http://127.0.0.1:13090/auth-remote/ready
dsh plugin --profile web exec dsh-auth-remote init
```

Open the printed root `http://127.0.0.1:13090/`. Anonymous navigation redirects to sign-in; anonymous business APIs are denied. The bundle suppresses native token URLs and automatic browser opening. Keep development and test homes separate from this account profile.

## Complete public-entry configuration

For an HTTPS proxy entry, merge the following rows into `~/.dsh/profiles/web/cordis.patch.yml`, keeping unrelated model and plugin rows. The reusable [profile example](../examples/web-profile-auth-remote.patch.yml) has the same configuration:

```yaml
- id: webserver
  disabled: true

- id: auth-remote
  config:
    publicUrl: https://dsh.example.com/
    host: 127.0.0.1
    port: 13090
    requireTotp: false
    manualAccountLogin: true
    sessionHours: 168
    preserveOriginPaths: []
```

Replace the public hostname consistently in the profile and proxy. This example keeps a private HTTP listener behind external TLS. `publicUrl` selects the browser entry; it does not configure a proxy, certificate or listener protocol. The independent `webserver` disable in the profile is required when a remote entry relies on this plugin. Loader can skip an incompatible auth bundle and continue composing the profile; the bundle’s own disable then disappears. Keeping the profile-level row prevents native-listener fallback on that path. A plugin that is not loaded cannot enforce this prerequisite itself. Remove the independent disable when uninstalling the plugin and returning to the native listener.

DSH replaces the entire plugin `config` when a later patch row supplies one. Preserve the full intended authentication configuration in that row. If a home-level patch also defines `auth-remote`, inspect the final composition with `dsh --profile web --dump-config` before opening access.

## Configuration priority and path bases

All plugin fields below belong directly in `auth-remote.config`; there are no aliases or nested TLS objects.

| Field                 | Effective value                                                                                                                                                                                                                                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `publicUrl`           | CLI `--public-url` replaces the file URL, then migrated legacy single item, then actual listener root. HTTP(S) roots only, optional final slash, no credentials/path/query/fragment.                                                                                                                                  |
| `host`                | CLI, file, then `127.0.0.1`. Concrete IPv4/IPv6, including mapped forms; reject DNS names and wildcard binds.                                                                                                                                                                                                         |
| `port`                | CLI `--port`, then file, then `3080`, independently of host. `0` derives the entry only after the actual nonzero port is bound.                                                                                                                                                                                       |
| `tlsCert`, `tlsKey`   | Supply both file fields or both CLI `--tls-cert`/`--tls-key`; CLI replaces the entire pair, without mixed sources or reading unused file paths. Omit for HTTP.                                                                                                                                                        |
| `requireTotp`         | Defaults to `false`. An unbound account may skip setup; an already bound account still needs its second factor. Set `true` to require TOTP enrollment before access. Explicit true/false settings, existing bindings and backup codes survive upgrades.                                                               |
| `manualAccountLogin`  | Defaults true. Native Settings writes the profile override; accepted saves immediately affect new authorizations and survive restart without restarting authentication. False preserves admitted attempts and official credentials. All eight have complete regression targets; see README for future admission/APIs. |
| `sessionHours`        | Fixed default lifetime of 168 hours. Reducing it tightens existing sessions; increasing it does not revive expired sessions.                                                                                                                                                                                          |
| `preserveOriginPaths` | Optional canonical segment-prefix paths; default `[]`. Matching routes keep the validated public Host and existing Origin after authentication. The final public origin configures native Connection trust automatically.                                                                                             |

**Pay particular attention to TLS paths:** relative file values resolve from the selected profile directory, where its `cordis.patch.yml` lives. Relative CLI paths resolve from the process's launch working directory. Neither uses the bundle or another overlay's directory. Absolute paths stay absolute.

On every supported version, `dsh web --no-open --host ::1 --port 0 --public-url https://dsh.example.com/` overrides file host, port and URL independently. The listener uses an actual free port while the explicit public root stays fixed; configure the proxy for that port. Omit host when overriding only port.

For example, file `tlsCert: ./tls/dsh.crt` means `~/.dsh/profiles/web/tls/dsh.crt` even if you launch from a different directory. The following command uses `./launch-workdir/tls/dsh.crt` and the matching key instead:

```sh
cd ./launch-workdir
dsh web --no-open --tls-cert ./tls/dsh.crt --tls-key ./tls/dsh.key
```

Supplying only one CLI flag fails even if the file contains the other half. Missing, unreadable, empty, malformed or mismatched certificate/key material fails startup without an HTTP fallback, and releases listener/admin/storage resources. Choose a certificate valid for the browser hostname; the plugin delegates TLS to the official listener.

All supported versions natively provide `--public-url`, IPv6 and TLS; this candidate retains the native API migration completed in `0.3.1`.

All eight project the final Web URL through model runtime context and `DSH_WEB_URL`; tests still scan all Web sections for duplicate URLs or tokens.

## Native HTTPS and IPv6

All eight supported versions can use this complete auth row for IPv6 loopback HTTPS with your own certificate/key:

```yaml
- id: auth-remote
  config:
    host: ::1
    port: 8443
    tlsCert: ./tls/dsh.crt
    tlsKey: ./tls/dsh.key
    requireTotp: false
    manualAccountLogin: true
    sessionHours: 168
    preserveOriginPaths: []
```

Start with `dsh web --no-open`; the derived root is `https://[::1]:8443/`. IPv6 URL authorities need brackets. HTTP IPv6 is also available with `dsh web --no-open --host ::1 --port 13090` and no TLS fields. Concrete non-loopback documentation addresses such as `192.0.2.10` or `2001:db8::10` must be replaced with addresses actually assigned to your host; binding does not limit client source IPs. Apply source restrictions through your network policy.

Do not use `0.0.0.0`, `::`, or mapped IPv4 wildcard binds. A scope/zone selects an interface for a bind and cannot appear in a portable public URL. Redundant loopback scope is normalized; a non-loopback scoped bind requires an explicit portable `publicUrl` such as `https://dsh.example.com/`.

## Migrate old allowedOrigins

The old field remains a plugin migration contract, independently of DSH version support. Each activation warns once and converts in memory, without rewriting the profile or account state.

| Old input                                                                                        | Upgrade behavior                                                               |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Field absent                                                                                     | Derive one root from the actual listener unless `publicUrl` is supplied.       |
| `allowedOrigins: []`                                                                             | Warn and derive the actual listener root.                                      |
| One root URL                                                                                     | Warn and use that root as `publicUrl`.                                         |
| Two or more items, even duplicates                                                               | Fail; manually choose one public entry and replace the array with `publicUrl`. |
| Any explicit `allowedOrigins` plus file or CLI `publicUrl`, even an empty array or identical URL | Fail; remove the legacy field before using the new one.                        |

Back up the old patch before upgrading. Replace a single item with `publicUrl: https://dsh.example.com/`; remove an empty array to keep derived behavior. An installation with several public origins needs a deliberate choice of one canonical entry. Route alternate browser hostnames to that entry before they reach the protected upstream. To roll back to 0.1.5, restore its compatible old configuration backup; the new fields are not a 0.1.5 contract.

## Source and bridge contract

Admission is the one effective public origin plus literal loopback authorities. The URL's root path has no deployment prefix. Requests need one valid Host; mutations and WebSocket upgrades require a matching Origin, and cross-site or mismatched Fetch Metadata is rejected. An old public origin is no longer registered after replacement. `Forwarded` and `X-Forwarded-*` never decide admission or Cookie Secure. CLI `--trusted-host` configures native Connection only and does not enlarge this outer policy.

Anonymous GET/HEAD requests to exactly `/manifest.webmanifest`, `/favicon.svg`, and `/favicon-dark.svg` pass through to DSH's static server without a session. These PWA metadata and icons retain the same Host, Origin, Fetch Metadata, and readiness checks; HEAD on these paths accepts an absent Origin just like GET. The sign-in page links the manifest and allows it in CSP, so browsers can read application metadata before sign-in. Business pages, APIs, other assets, other methods, and WebSocket upgrades remain protected. Browser installation also depends on the upstream manifest and the browser's own requirements.

Plugin cookies follow the validated external origin and are host-only, HttpOnly and SameSite; HTTPS sets Secure. Native bridge credentials stay server-side and follow the native listener protocol, including HTTPS cookie audience/Secure when a public HTTP proxy fronts native HTTPS. Ports do not isolate browser cookies.

Standard `/api` routes work with `preserveOriginPaths: []`; there is no need to list `/api`. The plugin always declares its finalized native bridge authority in Connection's `trustedHosts`, using the actual bound port (including `--port 0`), so downstream plugins that read this list can recognize the bridge without an extra trusted-host flag. Explicit CLI trusted hosts are merged and deduplicated; they do not expand the outer public-origin policy. Add a prefix only when a downstream route needs the original public Host. The plugin forwards an Origin only when the request supplied one, and preflights and declares the selected public authority for preserved paths. No separate Connection row is needed. Ordinary routes on all eight use the normalized native bind authority and require a full session. Revocation, Connection loss or storage failure closes active uploads, streams and upgrades and withdraws business admission. Readiness does not mean the account is initialized.

## Start and verify the public entry

1. Verify Linux, Node.js 24+, the exact compatible DSH version, and the intended profile/package. Keep test and development data separate.
2. Merge one complete profile configuration and configure a private reachable proxy upstream if needed; see the [proxy guide](reverse-proxy.md).
3. Start DSH. For the HTTP upstream example, inspect `curl -fsS -H 'Host: dsh.example.com' http://127.0.0.1:13090/auth-remote/ready` and require the expected plugin/protocol and `ready: true`.
4. Confirm anonymous HTML redirect and API denial, then initialize locally, sign in, bind TOTP and save backup codes. Exercise official settings, workspace, preview, uploads, SSE/WebSocket and revocation through the selected entry.

Startup prints the actual protocol/address/port and one distinct public root, deduplicating identical URLs. It prints no token or login path. Keep access private until readiness and anonymous denial checks pass; failed plugin, TLS, state or Connection initialization must leave business unavailable.

## Backup, recovery and changes

Before upgrading an old deployment to `0.3.2`, stop DSH and back up the authentication directory, profile patch and package/lock files. Keep access private and retain independent `webserver disabled: true`. Upgrade DSH to a listed target first (recommended `0.2.2-alpha.2`), then install the plugin and verify readiness, anonymous denial, login and revocation. The six retired hosts cannot install `0.3.2`; do not grant a version-risk exemption. To roll back, stop the service, select an explicit old host (for example `0.2.1-alpha.2`) with last supported plugin `0.2.0`, and restore matching package/lock/patch backups. The six-host retirement happened in published `0.3.1` and is not repeated here. This migration does not change authentication data format; still check schema when restoring and never overwrite live state.

These are plugin `0.3.2` behavior changes, independent of DSH retirement: CLI text is fixed English, so remove `--lang` from scripts; JSON fields are unchanged. The standalone login page has no language selector and uses new `dsh-auth-remote-lang` memory, then `navigator.language`, then English. Old `dsh-auth-remote.locale` is ignored, retained and not migrated. Entering DSH remembers only native accepted preferences; signing out keeps them. The eight plugin languages do not expand old DSH native language catalogs.

Stop DSH and verify it released the profile lock before copying `~/.dsh/profiles/web/auth-remote/auth-state.json`. Keep the copy in a private directory (0700) with file mode 0600. It contains password hashes, the TOTP secret, backup-code hashes and sessions. Do not copy an in-progress temporary file, overwrite live locked state or commit it. Back up the corresponding profile patch and package/lock files.

For recovery, stop DSH, check schema/package compatibility, restore with private ownership/mode, then check readiness and CLI `status --json`. Local `reset-password`, `reset-totp` and `revoke-sessions` revoke sessions. A lost management response has an uncertain outcome; inspect status before another mutation.

To change the external entry, replace the one `publicUrl`, update the proxy and restart DSH. Verify the new entry and rejection of the former non-loopback entry, including cookies, redirects, uploads and long connections. Do not temporarily configure both origins in this plugin.

Official DeepSeek authorization on all eight uses the [README manual callback dialog](../README.md#sign-in-to-an-official-deepseek-account). No callback listener or open loopback port is needed on the browser computer. `/auth-remote/account/*` retains the session/origin gate and same-origin JSON POSTs; direct HTTP access to native `/oauth/callback` cannot complete this handoff. No proxy exception, broader paths or cross-site allowance is required.

Before using LiveShare on DSH `0.2.2-alpha.2`, enable it, configure Relay and sign in as Owner through native DSH setup. This plugin does not enable sharing or rewrite Relay configuration. Viewers receive no administrator identity; plugin sign-out and stopping a share are independent operations. Local protocol stand-ins establish basic compatibility; real Relay/OAuth, visitor models and file-write experience require separate verification. No broader anonymous exception or preserveOriginPaths setting is required.
