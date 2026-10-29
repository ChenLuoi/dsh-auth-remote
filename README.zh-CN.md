# dsh-auth-remote

[English](README.md)

DeepSeek Harness（DSH）的单用户远程登录插件，提供密码、TOTP、一次性备用码和可撤销会话。插件运行在 DSH 进程内，保护浏览器页面、API、流式响应和 WebSocket。

## 前置条件

- Linux（含 `/proc`）、Node.js 24 或更高版本，以及下表某个精确 DSH 目标；开发默认 `0.2.2-alpha.2`。仅从源码构建时需要 pnpm 12.5.1。
- DSH `0.2.2-alpha.2` 自身要求 Node.js `>=24.9.0`；插件自身仍保持 `>=24` 引擎范围。
- DSH 默认的 `~/.dsh` 数据目录和 `web` profile。账号状态属于该 profile，不与其他 profile 共用。
- 源码浏览器测试先执行 `pnpm exec playwright install chromium`。测试使用 Playwright 管理的浏览器和专用自签 TLS 夹具。

## DSH 兼容性

已发布 `0.3.1` 保留原有七版发布记录。未发布候选 **`0.3.2`** 在 `dsh.compatibility.dshReleases` 声明以下八个精确目标。`engines.dsh`、WebServer peer 和运行时准入下限一致为 `>=0.2.1-alpha.3`，不设上限且按 SemVer 包含预发布。开发默认与迁移推荐为 **`0.2.2-alpha.2`**。最终同包验证记录与声明分开保存。

| 精确支持的 DSH 版本 | 维护状态           | Legacy 起算 | 窗口  | 最早退役资格日 |
| ------------------- | ------------------ | ----------- | ----- | -------------- |
| `0.2.1-alpha.3`     | Legacy；继续支持   | 2026-10-28  | 14 日 | 2026-11-11     |
| `0.2.1-alpha.4`     | Legacy；继续支持   | 2026-10-28  | 14 日 | 2026-11-11     |
| `0.2.1-alpha.5`     | Legacy；继续支持   | 2026-10-28  | 14 日 | 2026-11-11     |
| `0.2.1-rc.1`        | 正常支持           | —           | —     | 未公告         |
| `0.2.1-rc.2`        | 正常支持           | —           | —     | 未公告         |
| `0.2.1-rc.3`        | 正常支持           | —           | —     | 未公告         |
| `0.2.1-rc.4`        | 正常支持           | —           | —     | 未公告         |
| `0.2.2-alpha.2`     | 正常支持；开发默认 | —           | —     | 未公告         |

日期按 `Asia/Shanghai` 当日 00:00 计算；资格日不自动终止支持或删除 CI。插件 `0.3.1` 退役 DSH `0.1.7-rc.1`、`0.1.7-rc.2`、`0.2.0-rc.1`、`0.2.0-rc.2`、`0.2.1-alpha.1`、`0.2.1-alpha.2`，这些宿主最后支持的插件为已发布 `0.2.0`，不能安装本候选。按[DSH → 插件](docs/support-history.zh-CN.md#by-dsh)或[插件 → DSH](docs/support-history.zh-CN.md#by-plugin)查询历史声明、报告与分发事实；两份支持规范保留前一发布的记录，本候选事实以本文和历史表为准。

八版均使用同一入口配置，支持具体 IPv4/IPv6、原生 HTTP/HTTPS、CLI `--public-url`，最终公开根地址写入模型运行时上下文与 `DSH_WEB_URL`。模型 Web 提示各段不应重复公开 URL 或泄露 token。原生能力与保留适配见[兼容维护清单](docs/legacy-compatibility.zh-CN.md)。

后续版本按范围向前准入，仍须通过 WebServer/Connection API、宿主包身份和原生认证交换检查；准入不构成逐版支持或实测声明。八版始终运行 CLI/smoke，全量、手动、定时及发布计划运行八版完整 browser，并独立验证退役边界 `0.2.1-alpha.2` 的拒绝路径。普通低风险计划使用[固定 browser 选择](docs/development.zh-CN.md#普通与全量-ci-计划)，不运行真实旧宿主负向任务。

## 安装候选归档

`0.3.2` 尚未发布。先按[开发指南](docs/development.zh-CN.md)构建并验证本地归档，再安装该文件。已发布 `0.3.1` 保留历史七版支持，不包含本次新版宿主适配。

```sh
dsh --version
dsh plugin --profile web add ./artifacts/dsh-auth-remote-0.3.2.tgz
dsh plugin --profile web list
```

确认 `dsh --version` 输出推荐的 `0.2.2-alpha.2`，且插件列表中有 `dsh-auth-remote@0.3.2`。这些命令使用 DSH 默认数据目录；隔离开发运行时参见[开发指南](docs/development.zh-CN.md)。

## 配置 web profile

最小安装无需修改 profile 补丁。用 `dsh web --no-open --port 13090` 启动，使用终端打印的 `http://127.0.0.1:13090/` 根地址。未显式设置 `publicUrl` 时，插件根据监听的实际协议、地址和绑定端口生成唯一根地址，包含 `--port 0` 的实际结果。未登录导航跳转登录页；使用服务前检查 `/auth-remote/ready`。启动输出包含监听地址和一个不同的公开根地址，不含原生 `?token=` URL。

公网 HTTPS 入口请使用[部署指南](docs/deployment.zh-CN.md)和 [profile 示例](examples/web-profile-auth-remote.patch.yml)，设置顶层 `publicUrl: https://dsh.example.com/`、`host`、`port`。全部八个支持版本还支持具体 IPv6 和成对的顶层 `tlsCert`/`tlsKey`。URL 必须是 HTTP(S) 根地址，不能带凭据、子路径、查询或片段。准入范围是唯一公开来源加字面回环。配置 URL 不会配置代理路由或 TLS。

插件自动将定稿的原生桥接 authority 登记到 Connection 的 `trustedHosts`，下游插件无需额外 `--trusted-host` 即可识别具体监听地址。下游路由若需要原始公网 Host，可把路径加入 `preserveOriginPaths`，此时也自动登记最终公开 authority。显式 CLI trusted hosts 继续保留，外层公开来源与登录校验仍然生效。CLI 的 host/port 和公开 URL 覆盖文件值；TLS 按完整一对覆盖。升级 `allowedOrigins` 前阅读[迁移和路径规则](docs/deployment.zh-CN.md#配置优先级与路径基准)：零项或单项在内存迁移并告警，多项及任意显式新旧字段共存报错。

## 初始化账号

在真实交互终端中，使用与服务**相同**的默认 `web` profile：

```sh
dsh plugin --profile web exec dsh-auth-remote init
```

输入一个用户名和 12–256 个 Unicode 字符的密码。密码不作为命令行参数传递，也不会回显。未初始化时登录页会提示该命令，但网页不能创建账号。默认 `requireTotp: false`，首次密码登录可选择绑定或跳过；设为 `true` 可强制绑定。升级仅在未显式配置时采用新默认值，已有 TOTP、备用码与显式 true/false 均保留。显示十个备用码时立即妥善保存：每个只能用一次，之后不能重新查看列表。

## 登录与账号管理

最小化安装时访问本机回环地址；配置公网入口后访问 `https://dsh.example.com/auth-remote/login`。DSH 内的安全设置可以修改密码、绑定 TOTP、在策略允许时关闭 TOTP，以及撤销会话。密码或第二因素变更会撤销已有会话。会话默认固定有效 168 小时，服务重启后仍保留。

全部八个支持版本从侧栏账号菜单进入 **设置 → 安全与登录**。

登录页引用 DSH 的 PWA manifest，manifest 与 favicon 在登录前即可读取；业务页面和 API 仍需认证。具体范围见[公开资源规则](docs/deployment.zh-CN.md#来源与桥接契约)。

```sh
dsh plugin --profile web exec dsh-auth-remote status --json
dsh plugin --profile web exec dsh-auth-remote reset-password
dsh plugin --profile web exec dsh-auth-remote reset-totp
dsh plugin --profile web exec dsh-auth-remote revoke-sessions
```

修改命令需要交互确认。在线命令走私有 Unix socket；离线命令取得同一 profile 锁。如果管理请求已提交但响应丢失，先运行 `status` 再判断是否重试。`status --json` 的机器字段不随语言变化。

内嵌安全页跟随 DSH 语言设置。浏览器文案支持英、中、日、西、法、德、俄和巴西葡萄牙语。独立登录页依次使用 `localStorage["dsh-auth-remote-lang"]`、`navigator.language`、英文，不提供语言选择器；支持的合法语言标签忽略大小写并匹配地区变体；非法或不支持的值依次回退。插件不扩充 DSH 自身的语言选择目录。进入 DSH 后仅按原生 locale 表单已接纳的偏好更新缓存，明确清除偏好时删除缓存；加载中、读取或保存失败时保留，退出也保留。旧 `dsh-auth-remote.locale` 字段不读取、不清理。CLI 文案固定英语；语言环境变量不会改变输出，`--lang` 不再接受。

安全与登录页面展示本插件用户名、TOTP 状态、本次登录时间、到期时间和有效会话数；时间按当前界面语言及浏览器本地时区显示。修改密码、开启/重新绑定/关闭 TOTP 均在独立任务弹窗完成；强制策略不允许关闭 TOTP。退出当前会话只需确认且保留其他会话，退出所有会话需验证密码及已绑定的第二因素，并包含当前会话。安全修改会撤销所有会话；绑定成功的同一弹窗最后一步仅展示一次备用码，支持复制全部，确认保存后重新登录。此步骤不能用 Esc、遮罩或父设置关闭；离开或刷新后无法恢复。

## 登录 DeepSeek 官方账号

手动回填按 SemVer（包含预发布）从 `>=0.2.1-alpha.3` 前向准入，还须具备必要原生 API 且 `manualAccountLogin: true`。完整功能实测目标为 **0.2.1-alpha.3**、**0.2.1-alpha.4**、**0.2.1-alpha.5**、**0.2.1-rc.1**、**0.2.1-rc.2**、**0.2.1-rc.3**、**0.2.1-rc.4**、**0.2.2-alpha.2**；未来版本须精确回归后才宣称已验证。账号菜单中的“登录”先打开步骤说明弹窗，不会立即发起授权。点击“打开登录页”，在新标签页完成官方登录；授权后该标签页可能在回环地址显示连接失败或 404。复制地址栏中的完整 URL（包含 `code` 和 `state`），粘贴到“完整回调地址”，再点击“确认登录”。整个过程中保留原 DSH 页面；弹窗被浏览器拦截时，可使用弹窗内的授权链接。

在 **设置 → 安全与登录 → 登录配置** 中切换“远程 DeepSeek 账号登录”，默认开启。保存通过原生 Settings 写入当前 profile override，当前页新授权立即采用最新值，重启后保留；保存失败会显示错误。关闭只恢复新授权的原生入口，不取消已接纳的手动授权、不退出已有官方账号，也不承诺原生公网回调可用。其他已打开页面无需主动同步；旧页新建授权会提示关闭并建议刷新。

手动回填无需本地监听器、SSH 隧道或浏览器扩展。回环地址用于承载授权结果，页面无需正常打开。插件只解析粘贴的 URL，在 DSH 内部分发回调，保留原生 state 校验、PKCE 兑换与凭据存储，不会请求粘贴的地址。待完成授权绑定发起操作的远程会话，最长有效期为十分钟；关闭弹窗或撤销该会话会取消待完成授权。过期或失败后须重新开始。

DSH `0.2.1-alpha.3`、`0.2.1-alpha.4`、`0.2.1-alpha.5`、`0.2.1-rc.1`、`0.2.1-rc.2`、`0.2.1-rc.3`、`0.2.1-rc.4`、`0.2.2-alpha.2` 的弹窗在授权开始前也提供“使用 API Key”，点击后进入原生凭据编辑器，直到保存密钥或用户选择“稍后配置”才结束引导；账号菜单中也保留同一入口。授权进行中时，次要按钮用于取消本次授权。

## LiveShare 基础兼容

在 DSH `0.2.2-alpha.2` 中先按原生方式启用 LiveShare、配置 Relay 并完成 Owner 身份登录；本插件不会自动启用分享或改写 Relay 配置。管理员登录与分享查看者使用各自的身份和传输，退出本插件会话不会停止已创建的分享；停止分享仍由原生 LiveShare 管理。

本地验证覆盖真实 Host、Owner PKCE 流程、分享 worker、查看页和停止分享，Relay 身份/传输使用本地协议替身。真实 Relay/OAuth、访客模型调用及文件写入体验不属于这些验证结论。

## 接入反向代理

参见[反向代理指南](docs/reverse-proxy.zh-CN.md)以及 [Nginx](examples/nginx.conf) 或 [Traefik](examples/traefik-dsh.yml) 示例。保留浏览器原始 Host、Origin、WebSocket 升级和流式响应。TLS 可在代理终止；把其精确 HTTPS 根地址设置为 `publicUrl`。保持 DSH 监听私有，且不要缓存认证响应。

## 项目与维护

插件复用 DSH 的 WebServer、Connection、设置 slot、官方工作区浏览与预览。一个账号及其会话存储在 profile 的私有 JSON 文件中；无需独立身份服务。检查和边界参见[开发](docs/development.zh-CN.md)与[部署](docs/deployment.zh-CN.md)。变更记录见[更新日志](CHANGELOG.zh-CN.md)；参与项目可阅读[贡献指南](CONTRIBUTING.zh-CN.md)、[发布指南](docs/releasing.zh-CN.md)及 [MIT 协议](LICENSE)。
