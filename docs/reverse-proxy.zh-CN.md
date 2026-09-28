# 反向代理与直连

[English](reverse-proxy.md)

DSH Auth Remote 会先验证浏览器 authority，再为 DSH 改写已认证流量。先选定精确公网 URL，再把相同的协议、主机和端口写入 `allowedOrigins`。默认的内部 authority 桥接无需配置 Connection `trustedHosts`。TLS 可以在代理终止，DSH 继续监听私有 HTTP。

## 回环直连

按 [profile 示例](../examples/web-profile-auth-remote.patch.yml)，DSH 绑定 `127.0.0.1:13090`。同机浏览器可以使用 `http://127.0.0.1:13090`。字面量 `localhost`、规范的 `127.0.0.0/8` 地址和带方括号的 `::1` 可作为隐式回环 authority，但实际监听仍须可达；示例不宣称提供 IPv6 监听。认证 bundle 会禁用原生 `webserver` 条目；示例还建议在 profile 中独立禁用。

`allowedOrigins` 为空时，仅允许这些字面回环 authority。其他 LAN 与公网名称必须显式登记。规范 authority 不冲突时，可以并存已登记的 HTTP 与 HTTPS 入口。两个入口不会互相授权：修改请求和 WebSocket 升级的 Origin 必须匹配自身 Host 入口。严格规则下某些无 Origin 的 GET 可进入，但协议不明时不能写入或清除认证 Cookie。

## Nginx 外部 TLS

将 [Nginx 示例](../examples/nginx.conf)放进 `http {}` 上下文，替换 `dsh.example.com`、证书/私钥路径和私有上游。示例在 443 提供 TLS，转发到同机 `127.0.0.1:13090`。如果 Nginx 在另一处，请建立私有可达的上游传输，不要把 DSH 监听直接暴露到公网。

用 `$http_host` 保留含非默认端口的原始 Host，用 `$http_origin` 转交真实 Origin。Nginx 必须显式转交 WebSocket 的 `Upgrade` 和映射后的 `Connection`。上游 HTTP/1.1、关闭响应缓冲/缓存与请求缓冲、加长读写超时，保障事件流、上传和长连接。不要把 Origin 改成上游 URL，也不要删除浏览器修改请求的 Origin。代理不应缓存登录、状态或已认证响应。

示例对应的 profile 登记 `https://dsh.example.com`。公网若使用 `:8443`，需登记 `https://dsh.example.com:8443`，并在转发的 Host 保留该端口。Secure Cookie 跟随已验证的外部 HTTPS 来源，而非私有 HTTP socket 或转发协议提示。若下游路由需要原始公网 Host，把其路径加入 `preserveOriginPaths`；认证 bundle 会自动从 `allowedOrigins` 配置 Connection 信任地址。

## Traefik 外部 TLS

[Traefik file-provider 示例](../examples/traefik-dsh.yml)定义一个 Host router、可替换的 TLS resolver 和上游 URL、`passHostHeader: true` 及即时响应刷新。根据实际 Traefik 网络提供私有可达上游。示例刻意不配置删除 Origin、改写 Host 或缓存响应的 middleware；外围代理栈应保留 WebSocket 与流的转发。

多个公网入口需在 `allowedOrigins` 中逐一列出精确来源。profile 变更后重启 DSH，再逐个入口验证匿名跳转/API 拒绝、密码加 TOTP 登录、Secure Cookie、设置修改、WebSocket、SSE、上传和预览。`/auth-remote/ready` 对已配置 authority 返回预期插件/协议与 `ready: true` 前，不开放代理。

认证门禁不会用 `Forwarded` 或 `X-Forwarded-*` 作信任判断，避免把客户端可伪造提示当成 TLS 或主机证明。源码检出的浏览器套件使用自有 Node HTTP/HTTPS 转发器测试这些规则，不运行 Nginx 或 Traefik 二进制。
