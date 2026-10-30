# 部署指南

[English](deployment.md)

本指南面向插件 `0.3.3` 与推荐 DSH `0.2.2-alpha.2`，使用默认 `~/.dsh` 数据目录。九个支持版本见 [README](../README.zh-CN.md#dsh-兼容性)，维护细节见[支持规范](support-policy.zh-CN.md)。源码构建见[开发指南](development.zh-CN.md)。

上游 DSH `0.2.2-alpha.2` 自身要求 Node `>=24.9.0`；插件仍声明 Node `>=24`，不增加小版本拦截。

## 最小化安装

安装和运行服务使用同一默认 `web` profile：

```sh
dsh --version
dsh plugin --profile web add dsh-auth-remote@0.3.3
dsh plugin --profile web list
dsh web --no-open --port 13090
```

核对所选 DSH 版本和插件列表。本地 IPv4 HTTP 回环检查不需要 profile 补丁。开放远程入口前，须应用下方完整配置，包括独立禁用原生监听的条目。在另一终端确认 `/auth-remote/ready` 返回 `"plugin":"dsh-auth-remote"`、`"protocolVersion":1` 和 `"ready":true`，随后初始化账号：

```sh
curl -fsS http://127.0.0.1:13090/auth-remote/ready
dsh plugin --profile web exec dsh-auth-remote init
```

打开打印的 `http://127.0.0.1:13090/` 根地址。匿名导航跳转登录页，匿名业务 API 被拒绝。bundle 关闭原生 token URL 输出和自动打开浏览器；开发、测试 home 与账号 profile 分开。

## 公开入口完整配置

HTTPS 代理入口可把以下条目合并到 `~/.dsh/profiles/web/cordis.patch.yml`，保留无关模型和插件条目。可复用的 [profile 示例](../examples/web-profile-auth-remote.patch.yml)使用相同配置：

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

在 profile 和代理中一致地替换公网主机名。示例在外部 TLS 后使用私有 HTTP 监听。`publicUrl` 选择浏览器入口，不会配置代理、证书或监听协议。远程入口依赖本插件保护时，必须在 profile 中独立禁用 `webserver`。Loader 可以跳过不兼容的认证 bundle 并继续组合 profile，此时 bundle 自带的禁用补丁也会消失。保留 profile 级独立条目才能阻止这条路径回退至原生监听。未加载的插件无法自行实施此前置条件。卸载插件并恢复原生监听时，移除独立禁用条目。

后应用的 DSH patch 条目会整段替换插件 `config`，因此该条目必须保留全部预期认证配置。home 级 patch 若也定义 `auth-remote`，开放入口前用 `dsh --profile web --dump-config` 核对最终组合。

## 配置优先级与路径基准

以下字段均直接位于 `auth-remote.config`，没有别名或嵌套 TLS 对象。

| 字段                  | 生效值                                                                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `publicUrl`           | CLI `--public-url` 整项覆盖文件，其次旧单项迁移、实际监听根。只接纳 HTTP(S) 根 URL，可带末尾斜杠，无凭据/子路径/查询/片段。             |
| `host`                | CLI、文件、默认 `127.0.0.1`。具体 IPv4/IPv6（含 mapped），拒绝 DNS 与通配绑定。                                                         |
| `port`                | CLI `--port`、文件、默认 `3080`，与 host 分别覆盖。`0` 在真实非零端口绑定后才生成入口。                                                 |
| `tlsCert`、`tlsKey`   | 文件字段或 CLI `--tls-cert`/`--tls-key` 必须成对，CLI 整组覆盖，不混来源，不读未采用文件。省略即 HTTP。                                 |
| `requireTotp`         | 默认 `false`，未绑定账号可跳过，已绑定账号仍需第二因素；设为 `true` 可强制先完成绑定再访问。升级保留显式 true/false、已有绑定及备用码。 |
| `manualAccountLogin`  | 默认 true，原生 Settings 写当前 profile override；保存立即影响新授权且重启保留，不重启认证。false 保留已接纳授权和官方凭据。            |
| `sessionHours`        | 默认固定 168 小时。缩短会收紧已有会话，放宽不会复活过期会话。                                                                           |
| `preserveOriginPaths` | 可选的规范路径段前缀，默认 `[]`。匹配路径在认证后保留已验证公网 Host 和已有 Origin；最终公开来源自动配置原生 Connection 信任。          |

**特别注意 TLS 路径：**文件中的相对值以所选 profile 目录为基准，即其 `cordis.patch.yml` 所在目录；CLI 的相对路径以进程启动 cwd 为基准。两者均不以 bundle 或其他 overlay 目录为基准。绝对路径保持绝对。

`dsh web --no-open --host ::1 --port 0 --public-url https://dsh.example.com/` 分别覆盖文件 host、port、URL。监听使用实际空闲端口，公开根地址保持显式值，代理须到达该实际端口；仅覆盖 port 时可省略 host。

例如文件 `tlsCert: ./tls/dsh.crt` 始终指 `~/.dsh/profiles/web/tls/dsh.crt`，从其他目录启动也不变。以下命令则使用 `./launch-workdir/tls/dsh.crt` 和对应私钥：

```sh
cd ./launch-workdir
dsh web --no-open --tls-cert ./tls/dsh.crt --tls-key ./tls/dsh.key
```

只给一个 CLI 参数会失败，即使文件提供另一半也不混用。证书/私钥缺失、不可读、空内容、PEM 无效或不匹配时启动失败，不回退 HTTP，并释放监听、管理 socket 和存储资源。证书须对浏览器主机名有效；TLS 由官方监听处理。

最终公开 Web URL 写入模型 runtime context 与 `DSH_WEB_URL`，不含原生认证 token。

## 原生 HTTPS 与 IPv6

合并以下完整认证条目，使用自己的证书/私钥提供 IPv6 回环 HTTPS：

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

用 `dsh web --no-open` 启动，派生根地址为 `https://[::1]:8443/`。IPv6 URL authority 需要方括号。省略 TLS 字段时，也可用 `dsh web --no-open --host ::1 --port 13090` 提供 IPv6 HTTP。具体非回环文档地址如 `192.0.2.10`、`2001:db8::10` 必须替换为主机实际拥有的地址；绑定网卡不限制客户端来源 IP，来源限制由网络策略实施。

拒绝 `0.0.0.0`、`::` 和 mapped IPv4 通配绑定。scope/zone 为绑定选择网卡，不能进入便携公开 URL；冗余回环 scope 会归一化，非回环 scoped bind 需要显式便携 `publicUrl`，例如 `https://dsh.example.com/`。

## 迁移旧 allowedOrigins

旧字段支持属于插件迁移契约，与 DSH 版本支持范围独立。每次激活只告警一次，在内存转换，不改写 profile 或账号状态。

| 旧输入                                                                      | 升级行为                                              |
| --------------------------------------------------------------------------- | ----------------------------------------------------- |
| 未提供字段                                                                  | 未提供 `publicUrl` 时，根据实际监听生成唯一根地址。   |
| `allowedOrigins: []`                                                        | 告警，派生实际监听根地址。                            |
| 一个根 URL                                                                  | 告警，将该根地址作为 `publicUrl`。                    |
| 两项及以上，包含重复值                                                      | 失败；人工选择唯一公开入口，用 `publicUrl` 替换数组。 |
| 任意显式 `allowedOrigins` 与文件或 CLI `publicUrl` 共存，含空数组或相同 URL | 失败；使用新字段前删除旧字段。                        |

升级前备份旧 patch。单项替换为 `publicUrl: https://dsh.example.com/`；空数组删除即可保留派生行为。旧多来源安装必须主动选择一个规范入口，在流量到达受保护上游前把其他浏览器主机名导向该入口。回退时须恢复与所选插件版本兼容的配置。

## 来源与桥接契约

准入为唯一生效公开来源加字面回环 authority；URL 根路径不支持部署前缀。请求须有唯一合法 Host，修改请求和 WebSocket 升级须有匹配 Origin；跨站或不匹配 Fetch Metadata 被拒绝。替换后旧公开来源不再登记。`Forwarded`、`X-Forwarded-*` 不决定准入或 Cookie Secure；CLI `--trusted-host` 只配置原生 Connection，不扩大外层策略。

匿名 GET/HEAD 请求仅在精确匹配 `/manifest.webmanifest`、`/favicon.svg`、`/favicon-dark.svg` 时，无需会话即可交给 DSH 静态服务处理。这些 PWA 元数据与图标仍受 Host、Origin、Fetch Metadata 和就绪检查约束；这些路径的 HEAD 与 GET 一样允许缺少 Origin。登录页引用 manifest 并在 CSP 中允许加载，浏览器可在登录前读取应用信息。业务页面、API、其他资源、其他方法和 WebSocket 升级仍受鉴权保护；实际安装还取决于上游 manifest 与浏览器自身条件。

插件 Cookie 跟随已验证外部来源，限主机、HttpOnly、SameSite，HTTPS 设置 Secure。原生桥接凭据仅保留服务端，跟随原生监听协议；公开 HTTP 代理接入原生 HTTPS 时，其原生 Cookie audience/Secure 仍按 HTTPS。浏览器 Cookie 不通过端口隔离。

标准 `/api` 路由在 `preserveOriginPaths: []` 下即可工作，无需列 `/api`。插件始终将定稿的原生桥接 authority 登记到 Connection 的 `trustedHosts`，使用实际绑定端口（包含 `--port 0`），读取该列表的下游插件无需额外 trusted-host 参数即可识别桥接地址。显式 CLI trusted hosts 合并去重，不扩大外层公开来源策略。仅在下游需要原始公网 Host 时加入前缀；Origin 仅在请求已有时透传，保留路径预检并登记所选公开 authority。无需单独 Connection 条目。普通路径使用归一化原生 bind authority，经过完整会话认证。撤销、Connection 丢失或存储故障会关闭活跃上传、流和升级连接，撤回业务准入。ready 不表示账号已初始化。

## 启动并验证公开入口

1. 核对 Linux、Node.js 24+（推荐 DSH `0.2.2-alpha.2` 至少需要 `24.9.0`）、精确兼容 DSH 版本及目标 profile/包；测试开发数据独立。
2. 合并一个完整 profile 配置，需要代理时建立私有可达上游，参见[代理指南](reverse-proxy.zh-CN.md)。
3. 启动 DSH。HTTP 上游示例检查 `curl -fsS -H 'Host: dsh.example.com' http://127.0.0.1:13090/auth-remote/ready`，要求预期插件/协议和 `ready: true`。
4. 核对匿名 HTML 跳转和 API 拒绝，再本地初始化、登录、绑定 TOTP、保存备用码。经所选入口测试官方设置、工作区、预览、上传、SSE/WebSocket 和撤销。

启动打印实际协议、地址、端口及一个不同的公开根地址，相同 URL 去重，不含 token 或登录路径。ready 和匿名拒绝检查通过前保持入口私有；插件、TLS、状态或 Connection 初始化失败时业务须不可用。

## 备份、恢复与变更

升级到 `0.3.3` 前，停止 DSH 并备份认证目录、profile patch、package/lock；保持入口私有和独立 `webserver disabled: true`。确认宿主属于所列支持版本（推荐 `0.2.2-alpha.2`），安装插件并核对 ready、匿名拒绝、登录及撤销。回退时停服并恢复匹配的宿主/插件包、锁和 patch 备份。此次发布不改变认证数据格式；恢复时仍核对 schema，禁止覆盖运行中的状态。

从早于 `0.3.2` 的插件升级时，须考虑 `0.3.2` 已引入、`0.3.3` 保留的行为：CLI 固定英语，删除脚本中的 `--lang` 参数；JSON 字段不变。独立登录页不提供语言选择器，按 `dsh-auth-remote-lang` 缓存、`navigator.language`、英文选择语言。旧 `dsh-auth-remote.locale` 不读取、不清理、不迁移；进入 DSH 后仅同步原生已接纳的偏好，退出保留。插件八语不会扩充 DSH 的原生语言目录。

停止 DSH 并确认释放 profile 锁，再复制 `~/.dsh/profiles/web/auth-remote/auth-state.json`。副本目录权限 0700、文件权限 0600；它含密码哈希、TOTP 密钥、备用码哈希和会话。不要复制写入中的临时文件、覆盖运行中持锁状态或提交 Git；同时备份对应 profile patch 和包/锁文件。

恢复时先停止 DSH，检查 schema/包兼容，以私有属主/权限恢复，再核对 ready 和 CLI `status --json`。本地 `reset-password`、`reset-totp`、`revoke-sessions` 均撤销会话。管理响应丢失后结果不明，先查状态再执行下一次修改。

外部入口变更时，替换唯一 `publicUrl`、更新代理并重启 DSH。检查新入口与旧非回环入口的拒绝，包含 Cookie、重定向、上传和长连接。不要在插件中临时配置两个来源。

官方 DeepSeek 账号授权使用 [README 的手动回填弹窗](../README.zh-CN.md#登录-deepseek-官方账号)。浏览器电脑无需监听器或开放回环端口。`/auth-remote/account/*` 保持相同会话/来源门禁，只接纳同源 JSON POST；直接 HTTP 访问原生 `/oauth/callback` 不能完成此手动对接。无需代理例外、扩大路径或放宽跨站规则。
