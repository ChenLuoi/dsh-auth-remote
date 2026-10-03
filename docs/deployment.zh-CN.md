# 部署指南

[English](deployment.md)

本指南说明使用已验证的 DSH `0.2.1-alpha.1` 和默认的 `~/.dsh` 数据目录进行全新安装，不假定公网域名、代理网络、服务管理器或现有账号数据库。

下面的 npm 步骤使用插件 `0.1.5`。升级已有安装前，请参阅[兼容说明](../README.zh-CN.md#dsh-兼容性)；源码构建参见[开发指南](development.zh-CN.md)。

## 从 npm 最小化安装

把已发布的包安装到默认 `web` profile：

```sh
dsh --version
dsh plugin --profile web add dsh-auth-remote@0.1.5
dsh plugin --profile web list
```

确认 `dsh --version` 输出 `0.2.1-alpha.1`，且列表中有 `dsh-auth-remote@0.1.5`。bundle 提供认证监听，默认 `allowedOrigins: []`，因此只准入字面回环主机。最小安装无需修改 profile 补丁。在一个终端启动 DSH：

```sh
dsh web --no-open --port 13090
```

在另一个终端确认 `/auth-remote/ready` 返回 `"plugin":"dsh-auth-remote"`、`"protocolVersion":1` 和 `"ready":true`，随后初始化账号：

```sh
curl -fsS http://127.0.0.1:13090/auth-remote/ready
dsh plugin --profile web exec dsh-auth-remote init --lang zh
```

最小配置仅供本机使用。初始化后使用启动时打印的 `http://127.0.0.1:13090` 地址；未登录的浏览器访问会跳转到登录页。bundle 会关闭原生 token URL 输出与自动打开浏览器的行为。开发和测试 home 应与该默认 profile 分开。

## 公网入口完整配置

若使用 `https://dsh.example.com` 等 HTTPS 入口，将以下条目合并到 `~/.dsh/profiles/web/cordis.patch.yml`。这些条目也见可复用的 [profile 示例](../examples/web-profile-auth-remote.patch.yml)。保留无关模型和插件条目。`webserver` 条目建议用于在 profile 中独立禁用原生监听；认证 bundle 正常加载时不强制要求此条目：

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

在 profile 和代理配置中一致地替换主机名与精确来源，用 `dsh web --port` 选择私有端口。插件从 DSH web startup 读取该端口。后应用的 DSH 条目会整段替换插件 `config`。若 home 级补丁也定义了 `auth-remote`，开放代理前用 `dsh --profile web --dump-config` 核对最终合成配置。若卸载本插件并恢复 DSH 原生监听，也要移除可选的 `webserver` 禁用条目。

## Profile 与来源契约

| 设置                  | 必须满足的关系                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `webserver: disabled` | 建议在 profile 中独立禁用原生监听；认证 bundle 正常加载时会自行禁用。                                                                                  |
| `dsh web --port`      | 设置认证监听端口；示例使用 `127.0.0.1:13090`。插件读取 DSH web startup，无需在插件配置中重复填写监听参数。                                             |
| `allowedOrigins`      | 精确列出 HTTP(S) 来源，含非默认端口。示例为 `https://dsh.example.com`。空列表只允许字面回环；没有通配、转发头推断或 CORS 回退。                        |
| `requireTotp`         | 默认 `true`。设为 `false` 时未绑定账号可以跳过；已绑定账号仍需第二因素。                                                                               |
| `sessionHours`        | 默认固定 168 小时。缩短会收紧已有会话，放宽不会复活过期会话。                                                                                          |
| `preserveOriginPaths` | 可选的路径段前缀，让已验证的公网 Host 和请求中已有的 Origin 传给 DSH。默认 `[]` 把已认证请求改写到内部 authority；bundle 会为保留路径配置 Connection。 |

已登记 HTTP 与 HTTPS 入口的 authority 不能歧义。请求必须有一个合法 Host；修改请求和 WebSocket 升级必须携带匹配 Origin。一个登记入口的 Host 与另一个入口的 Origin 不构成同源。有 Fetch Metadata 时会拒绝跨站或不匹配模式。即使登记了公网入口，规范的回环直连仍可用；未登记的 LAN 或公网 Host 会被拒绝。`Forwarded` 和 `X-Forwarded-*` 不决定准入或 Secure 标志。外部 TLS 来源决定 Secure Cookie，私有上游可保持 HTTP。Cookie 仅限主机、HttpOnly、SameSite；端口不隔离 Cookie。

插件保护 DSH 页面、RPC、流、WebSocket，以及官方工作区浏览与预览。健康的 `/auth-remote/ready` 会预检内部 authority；仅在 `preserveOriginPaths` 非空时才预检已配置公网 authority。它不表示账号已经初始化。

标准 DSH `/api` 路由在 `preserveOriginPaths: []` 下即可工作，无需列出 `/api`。仅当下游路由在认证后仍需原始公网 Host 时，才加入对应路径前缀。路径匹配后，插件保留已验证的公网 Host；请求原本携带 Origin 时也透传该 Origin，未携带时不会补造。`preserveOriginPaths` 非空时，bundle 自动把 `allowedOrigins` 的 authority 加入原生 Connection，无需用户在 profile 中配置 Connection。转交前认证门禁仍检查原始 Host、Origin 和会话。

### 直接监听私有网卡

代理位于另一台机器时，可以参考 `dsh web --no-open --host 192.0.2.10 --port 13090`。运行前须将文档专用地址 `192.0.2.10` 替换为 DSH 主机实际拥有的 IPv4 地址。插件从 DSH web startup 读取监听地址。启动时在 `dsh web start at` 下打印 HTTP 监听 URL，在 `public access at` 下逐行打印 `allowedOrigins` 的根地址。监听 URL 只有在其来源被准入时才能作为浏览器入口。DSH 会在插件激活前拒绝 `--host 0.0.0.0`。

直接绑定网卡不会限制客户端来源 IP。需要限制来源时，在防火墙或私有网络策略中配置。还要将浏览器或代理的精确 HTTP(S) 来源登记到 `allowedOrigins`；它检查浏览器访问地址，不检查客户端 IP。

## 启动并检查公网入口

1. 核对 Linux、Node.js 24+ 和已安装的 DSH 版本。按上文最小化命令安装 npm 包。测试和开发运行时应与默认账号 profile 分开。
2. 合并上文公网入口的 profile 配置；建议独立禁用 `webserver`。代理只应通过受控私有传输访问监听；参见[代理指南](reverse-proxy.zh-CN.md)。
3. 用 `dsh web --no-open --port 13090` 启动。开放外部入口前检查 `curl -fsS -H 'Host: dsh.example.com' http://127.0.0.1:13090/auth-remote/ready`，要求 JSON 同时包含 `"plugin":"dsh-auth-remote"`、`"protocolVersion":1` 和 `"ready":true`。
4. 确认匿名 HTML 请求跳转 `/auth-remote/login`，匿名 `/api/settings` 等 API 被拒绝。若尚未初始化账号，先用本地 CLI 初始化；随后登录、绑定 TOTP、保存备用码，并经选定浏览器入口测试官方设置、工作区、预览、上传和流。

就绪和匿名拒绝检查成功前，监听必须保持私有。插件加载失败、状态损坏或原生 Connection 不可用时应失败关闭；排查后才能暴露上游。本仓库不会替你安装反向代理或服务管理配置。

## 备份、恢复与变更

停止 DSH 并确认已释放 profile 锁，再复制 `~/.dsh/profiles/web/auth-remote/auth-state.json`。副本放在权限 0700 的私有目录，文件权限 0600。该文件含密码哈希、TOTP 密钥、备用码哈希和会话状态。不要复制写入中的临时文件、覆盖运行中持锁的状态文件，或把副本提交到 Git。同时另存对应时期的 profile 补丁和包/锁文件。

恢复时先停止 DSH，确认目标使用相同状态 schema 与兼容包，以私有属主/权限恢复文件，再启动并检查就绪与 CLI `status --json`。本地恢复动作是 CLI `reset-password`、`reset-totp` 和 `revoke-sessions`，都会撤销会话。管理响应丢失后结果不明，先查状态再决定是否执行下一次修改。

外部入口变更时，先把新精确 URL 加到 `allowedOrigins`，更新代理以保留 Host/Origin，并检查新旧两个入口，再移除旧入口。profile 重启后，bundle 会从 `allowedOrigins` 更新 Connection 信任地址。profile 变更后重启 DSH。逐个入口验证 HTTPS Cookie、重定向、WebSocket 和流式响应。
