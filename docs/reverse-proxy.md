# Reverse proxy and direct access

[简体中文](reverse-proxy.zh-CN.md)

DSH Auth Remote validates the browser authority before rewriting authenticated traffic for DSH. Select one HTTP(S) root and set it as `publicUrl`, for example `https://dsh.example.com/`. It configures admission and advertised entry, without changing proxy routing or TLS. The bridge needs no extra Connection row or `--trusted-host`. TLS may terminate at a proxy while DSH listens on private HTTP.

## Direct loopback

With the [profile example](../examples/web-profile-auth-remote.patch.yml), DSH binds `127.0.0.1:13090`. A browser on the same host may use `http://127.0.0.1:13090/`. Literal `localhost`, canonical `127.0.0.0/8` and bracketed `::1` are implicitly allowed when the actual listener is reachable. An IPv4-mapped IPv6 loopback origin is admitted when it is the effective `publicUrl`, either configured explicitly or derived from the listener. For an alpha.2 IPv6 HTTP or HTTPS listener, follow the [native transport configuration](deployment.md#native-https-and-ipv6). The auth bundle disables the native `webserver` row; an independent profile disable is recommended.

Admission is the unique effective public origin plus literal loopback. Without a public URL, derive one root from the actual bound protocol, address and port. Root paths only are supported; no child path, query, fragment or credentials. Mutations and WebSocket upgrades need Origin matching their Host; extra CLI native trusted hosts do not widen this policy. A GET without Origin cannot set or clear auth cookies when its protocol is unknown. See the [old-field migration rules](deployment.md#migrate-old-allowedorigins) before changing a legacy array.

## Nginx with external TLS

Copy [the Nginx example](../examples/nginx.conf) into an `http {}` context. Replace `dsh.example.com`, the certificate/key paths, and the private upstream. The example serves TLS on 443 and forwards to `127.0.0.1:13090` on the same host. If Nginx is elsewhere, provide a private transport to the upstream; do not expose DSH's listener directly to the internet.

Use `$http_host` for the original Host including a nondefault port and `$http_origin` for the actual Origin. Nginx must explicitly forward `Upgrade` and a mapped `Connection` header for WebSockets. HTTP/1.1 upstream, disabled response buffering/cache, disabled request buffering, and long read/send timeouts keep event streams, uploads and long connections working. Do not replace Origin with the upstream URL or omit it on browser mutations. The proxy should not cache login, status or authenticated responses.

Set `publicUrl: https://dsh.example.com/` for the example. For a public `:8443` listener, use `https://dsh.example.com:8443/` and preserve that port in Host. Plugin Secure cookies follow the validated external HTTPS origin, not the private HTTP socket or a forwarded-protocol hint. Add a path to `preserveOriginPaths` only when it needs the original public Host; native Connection trust then follows the final origin automatically.

## Traefik with external TLS

[The Traefik file-provider example](../examples/traefik-dsh.yml) defines one Host router, a replaceable TLS resolver and upstream URL, `passHostHeader: true`, and immediate response flushing. Supply a private reachable upstream for the chosen Traefik network setup. The example intentionally has no middleware that strips Origin, rewrites Host or caches responses. Keep WebSocket and stream forwarding enabled in the surrounding proxy stack.

Use one canonical public entry; route alternate hostnames to it before requests reach the protected upstream. Replace `publicUrl` and restart after an entry change, then verify the new root and rejection of the former non-loopback origin. Check anonymous redirect/API denial, password plus TOTP login, cookies, Settings, WebSocket, SSE, uploads, previews and revocation. Keep access private until `/auth-remote/ready` reports the expected plugin/protocol and `ready: true`.

An alpha.2 native HTTPS upstream also works behind a public HTTP or HTTPS proxy. Use an HTTPS upstream URL and configure the proxy's upstream certificate verification and hostname/SNI for that certificate. Plugin cookies follow the external entry's protocol; server-side native cookies use the listener's HTTPS audience/Secure. Preserve Host/Origin even when the two transport protocols differ. Relative file/CLI certificate paths have different bases; see the [path rules](deployment.md#configuration-priority-and-path-bases).

The authentication gate ignores `Forwarded` and `X-Forwarded-*` for trust decisions. This avoids treating a client-supplied hint as proof of TLS or hostname. The source checkout's browser suite tests these rules with its own Node HTTP/HTTPS forwarder; it does not execute Nginx or Traefik binaries.
