# Deployment

[简体中文](deployment.zh-CN.md)

This guide describes a new installation with the verified DSH `0.1.7-rc.1` runtime and its default `~/.dsh` data directory. It does not depend on a particular public hostname, proxy network, service manager, or existing account database.

## Minimal local installation

From the source checkout, build the local archive and install it into the default `web` profile:

```sh
pnpm install --frozen-lockfile
pnpm pack:local
dsh --version
dsh plugin --profile web add "$PWD/artifacts/dsh-auth-remote-0.1.0.tgz"
```

Verify that `dsh --version` prints `0.1.7-rc.1`. DSH runs the plugin installer inside the profile directory, so `$PWD` supplies an absolute archive path. The bundle supplies an auth listener with `allowedOrigins: []`, which admits only literal loopback hosts. No profile patch is needed for this setup. Start DSH in one terminal:

```sh
dsh web --no-open --port 13090
```

In another terminal, require `/auth-remote/ready` to return `"plugin":"dsh-auth-remote"`, `"protocolVersion":1`, and `"ready":true`, then initialize the account:

```sh
curl -fsS http://127.0.0.1:13090/auth-remote/ready
dsh plugin --profile web exec dsh-auth-remote init --lang en
```

The minimal setup is local only. After initialization, use the `http://127.0.0.1:13090` URL printed at startup; unauthenticated browser navigation redirects to sign-in. The bundle suppresses the native token URL and browser handoff. Keep development and test homes separate from this default profile.

## Complete public-origin configuration

For an HTTPS entry such as `https://dsh.example.com`, merge the following rows into `~/.dsh/profiles/web/cordis.patch.yml`. They also appear in the reusable [profile example](../examples/web-profile-auth-remote.patch.yml). Keep unrelated model and plugin rows. The `webserver` row is recommended for an independent native-listener disable; it is optional while the auth bundle is active:

```yaml
- id: webserver
  disabled: true

- id: auth-remote
  config:
    allowedOrigins: [https://dsh.example.com]
    requireTotp: true
    sessionHours: 168
    preserveOriginPaths: []
```

Replace the hostname and exact origin in the profile and proxy configuration, and choose the private port with `dsh web --port`. The plugin reads that port from DSH web startup. DSH replaces an entire plugin `config` when a later row supplies one. If a home-level patch also defines `auth-remote`, inspect the final composition with `dsh --profile web --dump-config` before opening the proxy. Remove the optional `webserver` row if uninstalling this plugin and returning to DSH's native listener.

## Profile and origin contract

| Setting               | Required relationship                                                                                                                                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `webserver: disabled` | Recommended in the profile for an independent native-listener disable; the auth bundle disables it while active.                                                                                                                   |
| `dsh web --port`      | Sets the authenticated listener port; the example uses `127.0.0.1:13090`. The plugin reads DSH web startup, so no listener setting is repeated in its config.                                                                      |
| `allowedOrigins`      | List exact HTTP(S) origins, including nondefault ports. The example has `https://dsh.example.com`. An empty list allows only literal loopback. No wildcard, inferred forwarded host, or CORS fallback exists.                      |
| `requireTotp`         | Defaults to `true`. With `false`, an account without TOTP can skip setup; an already bound account still needs its second factor.                                                                                                  |
| `sessionHours`        | Defaults to a fixed 168-hour lifetime. Reducing it tightens existing sessions; increasing it does not resurrect expired ones.                                                                                                      |
| `preserveOriginPaths` | Optional segment-prefix paths whose validated public Host and existing Origin are passed to DSH. The default `[]` rewrites authenticated requests to the internal authority. The bundle configures Connection for preserved paths. |

Registered HTTP and HTTPS entries must have unambiguous authorities. A request must have one valid Host; mutations and WebSocket upgrades require a matching Origin. A Host from one registered entry and an Origin from another do not form a same-origin request. When Fetch Metadata is present, cross-site or mismatched modes are rejected. Direct canonical loopback requests remain available even with a public entry; an unregistered LAN or public Host is rejected. Neither `Forwarded` nor `X-Forwarded-*` decides admission or the Secure flag. The external TLS origin controls Secure cookies while the private upstream can remain HTTP. Cookies are host-only, HttpOnly, and SameSite; ports do not isolate cookies.

The plugin guards DSH pages, RPC, streams, WebSockets, and the official workspace browser and preview. A healthy `/auth-remote/ready` preflights the internal authority; it also preflights configured public authorities when `preserveOriginPaths` is nonempty. It does not mean an account has been initialized.

The standard DSH `/api` routes work with `preserveOriginPaths: []`; there is no need to list `/api`. If a downstream route requires the original public Host after authentication, add only that path prefix. When a path matches, the plugin preserves the validated public Host and forwards the original Origin if the request supplied one; it does not create an Origin for requests without one. The bundle adds the authorities from `allowedOrigins` to native Connection automatically when `preserveOriginPaths` is nonempty. No profile-level Connection configuration is needed. The auth gate still checks the original Host, Origin and session before forwarding.

### Bind directly to a private interface

For a proxy on another machine, an example command is `dsh web --no-open --host 192.0.2.10 --port 13090`. Replace the documentation address `192.0.2.10` with an IPv4 address assigned to the DSH host before running it. The plugin reads the listener address from DSH web startup. Startup prints `dsh web start at` with the HTTP listener URL, then `public access at` with each configured `allowedOrigins` root URL. The listener URL is a browser entry only if its origin is admitted. DSH rejects `--host 0.0.0.0` before plugins activate.

Binding to an interface does not restrict client source addresses. Apply any required source restrictions through a firewall or private network policy. Register the browser or proxy's exact HTTP(S) origin in `allowedOrigins`; this checks browser authority, not the client's IP address.

## Start and verify the public entry

1. Verify Linux, Node.js 24+, pnpm 12.5.1, and the installed DSH version. Install the archive with the minimal commands above. Keep any test or development runtime separate from the default account profile.
2. Merge the public-origin profile configuration above. The independent `webserver` disable is recommended. A proxy should reach only the private listener through a transport you control; see the [proxy guide](reverse-proxy.md).
3. Start with `dsh web --no-open --port 13090`. Before opening external access, inspect `curl -fsS -H 'Host: dsh.example.com' http://127.0.0.1:13090/auth-remote/ready` and require JSON containing `"plugin":"dsh-auth-remote"`, `"protocolVersion":1`, and `"ready":true`.
4. Confirm an anonymous HTML request redirects to `/auth-remote/login`, and an anonymous API request such as `/api/settings` is denied. Initialize through the local CLI if needed, then sign in, bind TOTP, save backup codes and exercise official settings, workspace, preview, uploads and streams through the chosen browser origin.

The listener must remain private until the readiness and anonymous denial checks succeed. A failed plugin load, corrupt state, or unavailable native Connection should fail closed; investigate it before exposing an upstream. This repository does not install a reverse proxy or service manager configuration for you.

## Backup, recovery and changes

Stop DSH and verify it has released the profile lock before copying `~/.dsh/profiles/web/auth-remote/auth-state.json`. Store the copy in a private directory (0700) with file mode 0600. That file includes password hashes, the TOTP secret, backup code hashes and session state. Do not copy an in-progress temporary file, overwrite a live locked state file, or commit any copy to Git. Keep a separate copy of the profile patch and package/lock files used at the same time.

For recovery, stop DSH, verify the target uses the same state schema and compatible package, restore the saved file with private ownership/mode, then start and check readiness and CLI `status --json`. CLI `reset-password`, `reset-totp`, and `revoke-sessions` are the supported local recovery actions; they revoke sessions. A lost management response has an uncertain outcome, so inspect status before another mutation.

When changing an external origin, add the new exact URL to `allowedOrigins`, update the proxy to preserve Host/Origin, and check both entries before removing the old one. The bundle updates Connection trust from `allowedOrigins` when the profile restarts. Restart DSH after profile changes. Validate HTTPS cookies, redirects, WebSocket and streaming through every entry.
