# dsh-auth-remote

[English](README.md)

DeepSeek Harness（DSH）的单用户远程登录插件，提供密码、TOTP、一次性备用码和可撤销会话。插件运行在 DSH 进程内，保护浏览器页面、API、流式响应和 WebSocket。

## 前置条件

- Linux（含 `/proc`）、Node.js 24 或更高版本，以及 DSH **0.1.7-rc.1**、**0.1.7-rc.2**、**0.2.0-rc.1**、**0.2.0-rc.2**、**0.2.1-alpha.1**、**0.2.1-alpha.2**、**0.2.1-alpha.3**、**0.2.1-alpha.4** 或 **0.2.1-alpha.5**（默认）。仅从源码构建时需要 pnpm 12.5.1。
- DSH 默认的 `~/.dsh` 数据目录和 `web` profile。账号状态属于该 profile，不与其他 profile 共用。
- 源码浏览器测试先执行 `pnpm exec playwright install chromium`。测试使用 Playwright 管理的浏览器和专用自签 TLS 夹具。

## DSH 兼容性

`dsh.compatibility.dshReleases` 声明上述九个版本，开发默认使用 **0.2.1-alpha.5**。`engines.dsh`、宿主 peer 声明和运行时版本检查统一使用 `>=0.1.7-rc.1`，不设上限且包含预发布版本。

| DSH 版本      | 具体 IPv4 HTTP | 原生公开 URL CLI、Web 提示与 `DSH_WEB_URL`                           | 原生 IPv6 / HTTPS |
| ------------- | -------------- | -------------------------------------------------------------------- | ----------------- |
| 0.1.7-rc.1    | 支持           | 无 `--public-url`；原生模型侧 URL 保持 `http://127.0.0.1:<实际端口>` | 不支持            |
| 0.1.7-rc.2    | 支持           | 无 `--public-url`；原生模型侧 URL 保持 `http://127.0.0.1:<实际端口>` | 不支持            |
| 0.2.0-rc.1    | 支持           | 无 `--public-url`；原生模型侧 URL 保持 `http://127.0.0.1:<实际端口>` | 不支持            |
| 0.2.0-rc.2    | 支持           | 无 `--public-url`；原生模型侧 URL 保持 `http://127.0.0.1:<实际端口>` | 不支持            |
| 0.2.1-alpha.1 | 支持           | 支持；使用插件最终公开根地址                                         | 不支持            |
| 0.2.1-alpha.2 | 支持           | 支持；使用插件最终公开根地址                                         | 通过官方监听支持  |
| 0.2.1-alpha.3 | 支持           | 支持；最终公开根地址写入运行时上下文与 `DSH_WEB_URL`                 | 通过官方监听支持  |
| 0.2.1-alpha.4 | 支持           | 支持；最终公开根地址写入运行时上下文与 `DSH_WEB_URL`                 | 通过官方监听支持  |
| 0.2.1-alpha.5 | 支持           | 支持；最终公开根地址写入运行时上下文与 `DSH_WEB_URL`                 | 通过官方监听支持  |

后续版本属于向前准入，并不宣称已经逐版测试。插件仍检查必需的 WebServer／Connection 接口、宿主包实例一致性和原生认证交换。缺少能力时认证入口保持不可用并给出诊断。CI 在九个声明版本上运行 CLI、安装冒烟和浏览器回归。

九版均使用插件的单入口配置。原生 IPv6/TLS 在 DSH `0.2.1-alpha.2`、`0.2.1-alpha.3`、`0.2.1-alpha.4`、`0.2.1-alpha.5` 可用；HTTP 监听可由外部 HTTPS 代理提供入口。源码构建参见[开发指南](docs/development.zh-CN.md)。

[兼容维护清单](docs/legacy-compatibility.zh-CN.md)提供功能到版本、版本到功能的双向矩阵，并关联实现、测试与迁移退役条件。

## 从 npm 安装

安装 DSH 后，核对版本并把已发布的插件安装到默认 `web` profile：

```sh
dsh --version
dsh plugin --profile web add dsh-auth-remote@0.1.10
dsh plugin --profile web list
```

确认 `dsh --version` 输出 `0.2.1-alpha.5`（或上文其他兼容版本），且插件列表中有 `dsh-auth-remote@0.1.10`。这些命令使用 DSH 默认数据目录。源码构建及隔离开发运行时参见[开发指南](docs/development.zh-CN.md)。

## 配置 web profile

最小安装无需修改 profile 补丁。用 `dsh web --no-open --port 13090` 启动，使用终端打印的 `http://127.0.0.1:13090/` 根地址。未显式设置 `publicUrl` 时，插件根据监听的实际协议、地址和绑定端口生成唯一根地址，包含 `--port 0` 的实际结果。未登录导航跳转登录页；使用服务前检查 `/auth-remote/ready`。启动输出包含监听地址和一个不同的公开根地址，不含原生 `?token=` URL。

公网 HTTPS 入口请使用[部署指南](docs/deployment.zh-CN.md)和 [profile 示例](examples/web-profile-auth-remote.patch.yml)，设置顶层 `publicUrl: https://dsh.example.com/`、`host`、`port`。DSH `0.2.1-alpha.2`、`0.2.1-alpha.3`、`0.2.1-alpha.4`、`0.2.1-alpha.5` 还支持具体 IPv6 和成对的顶层 `tlsCert`/`tlsKey`。URL 必须是 HTTP(S) 根地址，不能带凭据、子路径、查询或片段。准入范围是唯一公开来源加字面回环。配置 URL 不会配置代理路由或 TLS。

插件自动将定稿的原生桥接 authority 登记到 Connection 的 `trustedHosts`，下游插件无需额外 `--trusted-host` 即可识别具体监听地址。下游路由若需要原始公网 Host，可把路径加入 `preserveOriginPaths`，此时也自动登记最终公开 authority。显式 CLI trusted hosts 继续保留，外层公开来源与登录校验仍然生效。CLI 的 host/port 和公开 URL 覆盖文件值；TLS 按完整一对覆盖。升级 `allowedOrigins` 前阅读[迁移和路径规则](docs/deployment.zh-CN.md#配置优先级与路径基准)：零项或单项在内存迁移并告警，多项及任意显式新旧字段共存报错。

## 初始化账号

在真实交互终端中，使用与服务**相同**的默认 `web` profile：

```sh
dsh plugin --profile web exec dsh-auth-remote init --lang zh
```

输入一个用户名和 12–256 个 Unicode 字符的密码。密码不作为命令行参数传递，也不会回显。未初始化时登录页会提示该命令，但网页不能创建账号。默认 `requireTotp: false`，首次密码登录可选择绑定或跳过；设为 `true` 可强制绑定。升级仅在未显式配置时采用新默认值，已有 TOTP、备用码与显式 true/false 均保留。显示十个备用码时立即妥善保存：每个只能用一次，之后不能重新查看列表。

## 登录与账号管理

最小化安装时访问本机回环地址；配置公网入口后访问 `https://dsh.example.com/auth-remote/login`。DSH 内的安全设置可以修改密码、绑定 TOTP、在策略允许时关闭 TOTP，以及撤销会话。密码或第二因素变更会撤销已有会话。会话默认固定有效 168 小时，服务重启后仍保留。

DSH `0.2.1-alpha.3`、`0.2.1-alpha.4`、`0.2.1-alpha.5` 从侧栏账号菜单进入 **设置 → 安全与登录**；DSH `0.1.7-rc.1`、`0.1.7-rc.2`、`0.2.0-rc.1`、`0.2.0-rc.2`、`0.2.1-alpha.1`、`0.2.1-alpha.2` 从侧栏直接打开设置。

登录页引用 DSH 的 PWA manifest，manifest 与 favicon 在登录前即可读取；业务页面和 API 仍需认证。具体范围见[公开资源规则](docs/deployment.zh-CN.md#来源与桥接契约)。

```sh
dsh plugin --profile web exec dsh-auth-remote status --json
dsh plugin --profile web exec dsh-auth-remote reset-password --lang zh
dsh plugin --profile web exec dsh-auth-remote reset-totp --lang zh
dsh plugin --profile web exec dsh-auth-remote revoke-sessions --lang zh
```

修改命令需要交互确认。在线命令走私有 Unix socket；离线命令取得同一 profile 锁。如果管理请求已提交但响应丢失，先运行 `status` 再判断是否重试。`status --json` 的机器字段不随语言变化。

内嵌安全页跟随 DSH 语言设置。独立登录页默认英文，仅在 `localStorage["dsh-auth-remote.locale"]` 保存 `en` 或 `zh`，登录前不读取 DSH 设置。CLI 人类文案由 `--lang en|zh` 指定；未指定时取首个非空的 `LC_ALL`、`LC_MESSAGES`、`LANG`（中文变体为 `zh`，其他为英文）。

安全与登录页面展示本插件用户名、TOTP 状态、本次登录时间、到期时间和有效会话数；时间按当前界面语言及浏览器本地时区显示。修改密码、开启/重新绑定/关闭 TOTP 均在独立任务弹窗完成；强制策略不允许关闭 TOTP。退出当前会话只需确认且保留其他会话，退出所有会话需验证密码及已绑定的第二因素，并包含当前会话。安全修改会撤销所有会话；绑定成功的同一弹窗最后一步仅展示一次备用码，支持复制全部，确认保存后重新登录。此步骤不能用 Esc、遮罩或父设置关闭；离开或刷新后无法恢复。

## 登录 DeepSeek 官方账号

手动回填按 SemVer（包含预发布）从 `>=0.2.1-alpha.3` 前向准入，还须具备必要原生 API 且 `manualAccountLogin: true`。完整功能实测目标为 **0.2.1-alpha.3**、**0.2.1-alpha.4**、**0.2.1-alpha.5**；未来版本须精确回归后才宣称已验证。账号菜单中的“登录”先打开步骤说明弹窗，不会立即发起授权。点击“打开登录页”，在新标签页完成官方登录；授权后该标签页可能在回环地址显示连接失败或 404。复制地址栏中的完整 URL（包含 `code` 和 `state`），粘贴到“完整回调地址”，再点击“确认登录”。整个过程中保留原 DSH 页面；弹窗被浏览器拦截时，可使用弹窗内的授权链接。

在 **设置 → 安全与登录 → 登录配置** 中切换“远程 DeepSeek 账号登录”，默认开启。保存通过原生 Settings 写入当前 profile override，当前页新授权立即采用最新值，重启后保留；保存失败会显示错误。关闭只恢复新授权的原生入口，不取消已接纳的手动授权、不退出已有官方账号，也不承诺原生公网回调可用。其他已打开页面无需主动同步；旧页新建授权会提示关闭并建议刷新。

手动回填无需本地监听器、SSH 隧道或浏览器扩展。回环地址用于承载授权结果，页面无需正常打开。插件只解析粘贴的 URL，在 DSH 内部分发回调，保留原生 state 校验、PKCE 兑换与凭据存储，不会请求粘贴的地址。待完成授权绑定发起操作的远程会话，最长有效期为十分钟；关闭弹窗或撤销该会话会取消待完成授权。过期或失败后须重新开始。DSH `0.1.7-rc.1`、`0.1.7-rc.2`、`0.2.0-rc.1`、`0.2.0-rc.2`、`0.2.1-alpha.1`、`0.2.1-alpha.2` 保留原有界面与 API Key 设置。

DSH `0.2.1-alpha.3`、`0.2.1-alpha.4`、`0.2.1-alpha.5` 的弹窗在授权开始前也提供“使用 API Key”，点击后进入原生凭据编辑器，直到保存密钥或用户选择“稍后配置”才结束引导；账号菜单中也保留同一入口。授权进行中时，次要按钮用于取消本次授权。

## 接入反向代理

参见[反向代理指南](docs/reverse-proxy.zh-CN.md)以及 [Nginx](examples/nginx.conf) 或 [Traefik](examples/traefik-dsh.yml) 示例。保留浏览器原始 Host、Origin、WebSocket 升级和流式响应。TLS 可在代理终止；把其精确 HTTPS 根地址设置为 `publicUrl`。保持 DSH 监听私有，且不要缓存认证响应。

## 项目与维护

插件复用 DSH 的 WebServer、Connection、设置 slot、官方工作区浏览与预览。一个账号及其会话存储在 profile 的私有 JSON 文件中；无需独立身份服务。检查和边界参见[开发](docs/development.zh-CN.md)与[部署](docs/deployment.zh-CN.md)。变更记录见[更新日志](CHANGELOG.zh-CN.md)；参与项目可阅读[贡献指南](CONTRIBUTING.zh-CN.md)、[发布指南](docs/releasing.zh-CN.md)及 [MIT 协议](LICENSE)。
