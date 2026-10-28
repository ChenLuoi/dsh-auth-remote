# 测试指南

[English](README.md)

本指南描述未发布候选 `0.3.1` 的七版精确验证目标，默认 DSH `0.2.1-rc.4`。最终同包报告单独记录，不把专项或历史候选认证为最终归档。

在 Linux 源码检出目录准备 Node.js 24+、pnpm 12.5.1 和 Playwright Chromium：

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm check
```

`pnpm check` 执行静态检查与全部四组测试。开发时可单独运行：

| 分组   | 命令                    | 验证契约                                                                                                    |
| ------ | ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| 单元   | `pnpm test:unit`        | 密码/TOTP/备用码、会话、来源策略、翻译、JSON 持久性及锁恢复。                                               |
| 集成   | `pnpm test:integration` | 真实 HTTP/WebSocket socket、Host/Origin 策略、原生就绪、Cookie、API 修改和撤销。                            |
| CLI    | `pnpm test:cli`         | 真实本地包、DSH profile 执行、伪终端提示、英中选择、JSON 输出、Unix socket、离线锁和结果不明。              |
| 浏览器 | `pnpm test:browser`     | 固定 DSH 启动、匿名门禁、登录、安全设置、原生设置、工作区、聊天流、上传/预览、SSE/WebSocket 和 HTTPS 转发。 |

脚本把 DSH `0.2.1-rc.4` 准备到 `.cache/test-runtime/<version>`，并创建临时 `DSH_HOME`。`DSH_TEST_BIN` 只有在可执行文件的 `--version` 精确报告所选的 `DSH_TEST_VERSION`（默认 `0.2.1-rc.4`） 时才能覆盖；`DSH_TEST_BROWSER` 可覆盖 Playwright 浏览器程序。默认使用 Playwright 管理的 Chromium。

正向目标为 `0.2.1-alpha.3`、`0.2.1-alpha.4`、`0.2.1-alpha.5`、`0.2.1-rc.1`、`0.2.1-rc.2`、`0.2.1-rc.3`、`0.2.1-rc.4`，由 `DSH_TEST_VERSION` 选择；七版均运行 CLI/smoke。启动经过真实 Loader，核对模型 runtime context、`DSH_WEB_URL` 和所有 Web 段无重复 URL/token。原生传输覆盖七版 IPv4/IPv6 HTTP/HTTPS、Host/Origin、上传/长连接/Secure/CLI 撤销；IPv6/TLS 环境缺失失败，不跳过。

`tests/helpers/` 的 Node HTTP/HTTPS 转发器代替本地代理安装。`tests/fixtures/tls/` 包含 `.test` 主机名专用自签测试证书和私钥；它们不是安装或生产凭证，不进入压缩包。浏览器聊天使用本地模型替身，无需真实外部账号、OAuth token 或付费模型请求。

[TLS fixture 说明](fixtures/tls/README.md)记录原生监听证书的 IPv4/IPv6 SAN、Node 信任和浏览器公钥 pin。转发器也验证 TLS upstream，覆盖 HTTPS→HTTP 和 HTTP→原生 HTTPS 两种代理链。

不要让这些命令指向现有账号目录。浏览器和 CLI 夹具使用独立临时 home；`pnpm smoke` 使用带标记的 `.dev/dsh-home`。[开发指南](../docs/development.zh-CN.md)说明隔离开发流程，[部署指南](../docs/deployment.zh-CN.md)说明正式 profile 与备份步骤。

共享 `isolatedDshEnv` 从 allowlist 构造 Host 环境，移除真实模型凭据/endpoint；浏览器启动环境同时清除 ambient HTTP(S)/ALL_PROXY。`localModelEndpoint` 在第一次输入 Key 前把原生 llm-deepseek baseURL 指向本地 HTTP fixture；不预存 Key、不关闭引导，仍检查原生 API Key 选择、保存、重开及刷新持久化。只操作 UI 的用例必须零模型请求；代理聊天只接纳预期的本地 chat 与原生 session-title 两次 POST，计数在 fixture 关闭时核验。

`integration/account-login.test.ts` 使用锁定开发依赖中实际安装的 DSH `0.2.1-rc.4` 账号提供者和本地平台替身，覆盖 PKCE、redirect URI 一致性、state、回调解析、会话归属、单次提交、取消、过期与重试。`browser/account-login.spec.ts` 验证先说明再授权、回环导航失败后粘贴完成、弹窗拦截和双语响应式主题；七版正向均保留完整账号流程，全程不使用真实官方账号。

`browser/live-config.spec.ts` 逐版观察真实 Loader 及实际依赖身份，执行开关 true→false→true→false、长连接保持和重启持久化。账号浏览器完整分支为 `0.2.1-alpha.3`、`0.2.1-alpha.4`、`0.2.1-alpha.5`、`0.2.1-rc.1`、`0.2.1-rc.2`、`0.2.1-rc.3`、`0.2.1-rc.4`；覆盖真实原生 Settings 保存成功/失败、当前页新入口切换与已接纳授权继续完成。登录设置回归覆盖五项可信概览、密码/TOTP/当前及全部会话弹窗、键盘焦点、取消/错误、备用码复制失败与一次性展示；截图对密码及备用码脱敏。完整版本矩阵须使用同一最终包，每版校验 SHA-256，循环内不能使用会重新打包的标准测试命令。

`browser/account-login.spec.ts` 在全部声明版本通过普通 `sessionHours` 字段变化触发真实配置 HMR，并验证 Settings 写入仍等待原生事务队列、真正嵌套仍被拒绝。测试专用 `fixtures/hmr-config-probe.mjs` 调用真实 HMR 服务。精确目标 `0.2.1-alpha.3`、`0.2.1-alpha.4`、`0.2.1-alpha.5`、`0.2.1-rc.1`、`0.2.1-rc.2`、`0.2.1-rc.3`、`0.2.1-rc.4` 还替换隔离安装的插件入口代码，随后重新开启手动登录。

HMR 队列用例在配置重载前后核对精确启动维护提示。独立 legacy 用例将同一候选的 package.json 与 dist 复制到隔离 profile 的目录，禁用原宿主条目，按公开 Loader 契约插入副本入口，并显式设置原生 HMR `base/root` 开启源码监听。用例观察真实模块替换和下一代监听器，确认同一进程仅提示一次且会话仍有效。旧版默认模块监听排除 node_modules，本夹具不表示该位置会自动替换；正常支持目标不得输出维护提示。`unit/dsh-support.test.ts` 检查日期、到期后分类不变、虚构退役输入及进程级去重，这些夹具不修改真实宿主版本。

`browser/startup-compatibility.spec.ts` 在七版验证损坏副本两路径：`0.2.1-alpha.3` 修改 Host peer（原生 Loader 不读 engines），其余六版修改 engines，均要求 Loader skip 且不导入插件；各版还注入插件自己的范围，要求导入后运行拒绝。profile 独立禁用 webserver，进程自然非零结束、各类探测拒绝连接，patch/上游/候选归档不变。

`browser/host-release.spec.ts` 固定六组真实宿主往返切换：`0.2.1-alpha.4` ↔ `0.2.1-alpha.3`、`0.2.1-alpha.5` ↔ `0.2.1-alpha.4`、`0.2.1-rc.1` ↔ `0.2.1-alpha.5`、`0.2.1-rc.2` ↔ `0.2.1-rc.1`、`0.2.1-rc.3` ↔ `0.2.1-rc.2`、`0.2.1-rc.4` ↔ `0.2.1-rc.3`。同一临时 profile/端口保留页面，检查原生版本提示，刷新后核对认证、原会话和持久设置，再恢复起始版本。只有 `0.2.1-alpha.3` 无 release 元数据并显示未解析；其余目的宿主必须显示真实完整版本。不修改上游源码、版本或依赖图元数据。

`browser/web-search-settings.spec.ts` 在 `0.2.1-rc.2`、`0.2.1-rc.3`、`0.2.1-rc.4` 注册。通过已认证的远程 Host 打开原生 Search/Fetch 设置，检查 `web`、`web-search-deepseek`、`web-deepseek-api`，切换提供者、保存地址/限制及测试凭据，观察校验和注入的传输拒绝，再验证刷新及真实进程重启后的持久化。匿名请求、会话撤销后重新提交原 Cookie 的设置/凭据读写均须拒绝。本地提供者统计请求并必须为零；只验证设置与认证边界，不验证 Search/Fetch 结果、不发付费请求或真实账号授权，不替换宿主提供者。

固定归档验证使用 `pnpm verify:packed --archive <archive> --sha256 <recorded-sha256> --dsh-version <exact-version> --suite <suite>`，不重新构建或打包。[开发指南](../docs/development.zh-CN.md#消费固定归档) 列出全部固定 suite 和筛选规则。运行器先恢复归档 dist 供 CLI/安装比较，拒绝空用例或跳过，记录 SHA-256 与数量，并使 smoke 独立于 `.dev` 和 13090。`unit/verify-packed.test.ts` 覆盖损坏/逃逸/链接归档、真实 Node 空筛选输出和带标记目录保护。发布全量验证仍须对每个声明版本使用相同归档运行 CLI、完整 browser 与 smoke。

CI 使用[普通/全量计划](../docs/development.zh-CN.md#普通与全量-ci-计划)。普通保留七版 CLI/smoke，`0.2.1-alpha.3`、`0.2.1-rc.2`、`0.2.1-rc.3`、`0.2.1-rc.4` 完整 browser，`0.2.1-alpha.4`、`0.2.1-alpha.5` host-release、`0.2.1-rc.1` rc-bootstrap；源码/设施/未知变更、手动/每周与发布全量运行七版完整 browser，并独立运行 `0.2.1-alpha.2` 真实退役拒绝。ordinary 精确接受负向 job 的唯一预定 skip；full 要求其成功，缺失/未知 plan/其他 skip 均拒绝。每个必需文件须有真实用例，只有明确声明的不适用文件可零注册，新 RC 的任何文件不可例外。

`browser/rc-navigation.spec.ts` 在 `0.2.1-rc.3`、`0.2.1-rc.4` 检查全局/会话/右侧栏 More、原生设置/模型选择和撤销后拒绝。仅查看市场/Creator 入口，不安装。专用 `fixtures/rc-navigation-state.mjs` 经公开 sessions/sessionProjections 为真实原生会话添加空完成 turn，拒绝已有 turn，不发送聊天或修改快照，模型调用必须为零。官方动态 `/models` 的内部语义与完整官方授权未验证。

独立 `scripts/verify-retired.mjs` 只接受六个明确退役目标，不扩展正向选版；核验同包摘要、已发布 `0.2.0` 基线、真实安装回滚及完整不兼容 bundle 的原生 peer skip/持续无监听。本次最终验收串行跑六版，后续 full/发布只跑 `0.2.1-alpha.2`，ordinary 不跑。命令与报告边界见开发指南。
