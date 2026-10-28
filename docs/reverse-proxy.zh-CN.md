# 反向代理与直连

[English](reverse-proxy.md)

DSH Auth Remote 会先验证浏览器 authority，再为 DSH 改写已认证流量。选择唯一 HTTP(S) 根地址，设置为 `publicUrl`，例如 `https://dsh.example.com/`。它配置准入和公布入口，不改变代理路由或 TLS。桥接无需额外 Connection 条目或 `--trusted-host`。TLS 可以在代理终止，DSH 继续监听私有 HTTP。

## 回环直连

按 [profile 示例](../examples/web-profile-auth-remote.patch.yml)，DSH 绑定 `127.0.0.1:13090`。同机浏览器可以使用 `http://127.0.0.1:13090/`。字面 `localhost`、规范 `127.0.0.0/8` 和方括号 `::1` 隐式准入，实际监听须可达。IPv4-mapped IPv6 回环来源只有作为生效 `publicUrl` 时才准入，可以显式配置，也可以从监听地址派生。当前支持 DSH 的 IPv6 HTTP/HTTPS 监听见[原生传输配置](deployment.zh-CN.md#原生-https-与-ipv6)。认证 bundle 禁用原生 `webserver`，受保护远程入口还必须在 profile 独立禁用。

准入为唯一生效公开来源加字面回环；未设置公开 URL 时，根据实际监听协议、地址、端口派生唯一根地址。只支持根路径，拒绝子路径、查询、片段、凭据。修改请求和 WebSocket 升级的 Origin 须匹配 Host，额外 CLI 原生 trusted hosts 不扩大策略。无 Origin 且协议不明的 GET 不能写入或清除认证 Cookie。变更旧数组前参阅[旧字段迁移](deployment.zh-CN.md#迁移旧-allowedorigins)。

## Nginx 外部 TLS

将 [Nginx 示例](../examples/nginx.conf)放进 `http {}` 上下文，替换 `dsh.example.com`、证书/私钥路径和私有上游。示例在 443 提供 TLS，转发到同机 `127.0.0.1:13090`。如果 Nginx 在另一处，请建立私有可达的上游传输，不要把 DSH 监听直接暴露到公网。

用 `$http_host` 保留含非默认端口的原始 Host，用 `$http_origin` 转交真实 Origin。Nginx 必须显式转交 WebSocket 的 `Upgrade` 和映射后的 `Connection`。上游 HTTP/1.1、关闭响应缓冲/缓存与请求缓冲、加长读写超时，保障事件流、上传和长连接。不要把 Origin 改成上游 URL，也不要删除浏览器修改请求的 Origin。代理不应缓存登录、状态或已认证响应。

示例设置 `publicUrl: https://dsh.example.com/`；公网 `:8443` 则使用 `https://dsh.example.com:8443/`，转发 Host 保留端口。插件 Secure Cookie 跟随已验证外部 HTTPS 来源，不取私有 HTTP socket 或转发协议提示。仅在路径需要原始公网 Host 时加入 `preserveOriginPaths`，原生 Connection 信任自动取最终来源。

## Traefik 外部 TLS

[Traefik file-provider 示例](../examples/traefik-dsh.yml)定义一个 Host router、可替换的 TLS resolver 和上游 URL、`passHostHeader: true` 及即时响应刷新。根据实际 Traefik 网络提供私有可达上游。示例刻意不配置删除 Origin、改写 Host 或缓存响应的 middleware；外围代理栈应保留 WebSocket 与流的转发。

使用唯一规范公开入口，在请求到达受保护上游前，把其他主机名导向该入口。入口变更后替换 `publicUrl` 并重启，核对新根地址以及旧非回环来源被拒绝。检查匿名跳转/API 拒绝、密码加 TOTP、Cookie、设置、WebSocket、SSE、上传、预览及撤销。`/auth-remote/ready` 返回预期插件/协议与 `ready: true` 前保持访问私有。

当前支持 DSH 原生 HTTPS 上游也可位于公开 HTTP 或 HTTPS 代理后。使用 HTTPS 上游 URL，配置代理的上游证书验证和与证书对应的 hostname/SNI。插件 Cookie 按外部入口协议，服务端原生 Cookie 按监听的 HTTPS audience/Secure；两个协议不同时仍保留 Host/Origin。文件和 CLI 相对证书路径基准不同，见[路径规则](deployment.zh-CN.md#配置优先级与路径基准)。

认证门禁不会用 `Forwarded` 或 `X-Forwarded-*` 作信任判断，避免把客户端可伪造提示当成 TLS 或主机证明。源码检出的浏览器套件使用自有 Node HTTP/HTTPS 转发器测试这些规则，不运行 Nginx 或 Traefik 二进制。
