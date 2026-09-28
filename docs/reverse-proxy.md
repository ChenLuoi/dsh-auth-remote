# Reverse proxy and direct access

[简体中文](reverse-proxy.zh-CN.md)

DSH Auth Remote validates the browser authority before rewriting authenticated traffic for DSH. Choose an exact public URL first, then set the same scheme, host and port in `allowedOrigins`. The default internal-authority bridge needs no Connection `trustedHosts` entry. TLS may terminate at a proxy while DSH listens on private HTTP.

## Direct loopback

With the [profile example](../examples/web-profile-auth-remote.patch.yml), DSH binds `127.0.0.1:13090`. A browser on the same host may use `http://127.0.0.1:13090`. Literal `localhost`, canonical `127.0.0.0/8` addresses and bracketed `::1` are permitted as implicit loopback authorities, subject to the actual listener being reachable. The example does not claim an IPv6 listener. The auth bundle disables the native `webserver` row; the example also recommends an independent profile-level disable.

If `allowedOrigins` is empty, only those literal loopback authorities are admitted. Other LAN and public names must be registered explicitly. Registered HTTP and HTTPS entries may coexist when their canonical authorities do not conflict. Two entries do not create cross-origin permission: a mutation or WebSocket upgrade must carry an Origin matching its own Host entry. A GET without Origin can be admitted under the strict rules but cannot set or clear auth cookies when its protocol is unknown.

## Nginx with external TLS

Copy [the Nginx example](../examples/nginx.conf) into an `http {}` context. Replace `dsh.example.com`, the certificate/key paths, and the private upstream. The example serves TLS on 443 and forwards to `127.0.0.1:13090` on the same host. If Nginx is elsewhere, provide a private transport to the upstream; do not expose DSH's listener directly to the internet.

Use `$http_host` for the original Host including a nondefault port and `$http_origin` for the actual Origin. Nginx must explicitly forward `Upgrade` and a mapped `Connection` header for WebSockets. HTTP/1.1 upstream, disabled response buffering/cache, disabled request buffering, and long read/send timeouts keep event streams, uploads and long connections working. Do not replace Origin with the upstream URL or omit it on browser mutations. The proxy should not cache login, status or authenticated responses.

Register `https://dsh.example.com` in the profile for the example. If the public listener uses `:8443`, register `https://dsh.example.com:8443` and preserve that port in the forwarded Host. Secure cookies follow the validated external HTTPS origin, not the private HTTP socket or a forwarded-protocol hint. If a downstream route needs the original public Host, add its path to `preserveOriginPaths`; the auth bundle then configures Connection trust from `allowedOrigins` automatically.

## Traefik with external TLS

[The Traefik file-provider example](../examples/traefik-dsh.yml) defines one Host router, a replaceable TLS resolver and upstream URL, `passHostHeader: true`, and immediate response flushing. Supply a private reachable upstream for the chosen Traefik network setup. The example intentionally has no middleware that strips Origin, rewrites Host or caches responses. Keep WebSocket and stream forwarding enabled in the surrounding proxy stack.

For multiple public entry points, list each exact origin in `allowedOrigins`. Restart DSH after profile changes, then verify anonymous redirect/API denial, password plus TOTP login, Secure cookies, Settings mutations, WebSocket, SSE, uploads and previews on every entry. Keep the proxy closed until `/auth-remote/ready` reports the expected plugin/protocol and `ready: true` for the configured authorities.

The authentication gate ignores `Forwarded` and `X-Forwarded-*` for trust decisions. This avoids treating a client-supplied hint as proof of TLS or hostname. The source checkout's browser suite tests these rules with its own Node HTTP/HTTPS forwarder; it does not execute Nginx or Traefik binaries.
