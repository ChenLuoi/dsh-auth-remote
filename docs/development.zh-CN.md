# 开发指南

[English](development.md)

本指南描述未发布插件候选 `0.3.2` 的八版精确验证目标，默认 DSH `0.2.2-alpha.2`。最终同包运行证据另记包外执行记录；声明与实测报告分开表达。

开发和完整测试需要 Linux（profile 锁依赖 `/proc`）、Node.js 24+、pnpm 12.5.1，以及 DSH `0.2.2-alpha.2`。DSH `0.2.2-alpha.2` 自身要求 Node.js `>=24.9.0`；插件引擎仍为 `>=24`。浏览器测试使用 Playwright 管理的 Chromium 和 Node HTTP/HTTPS 转发器。

兼容声明或适配变更前，先阅读 [Legacy 兼容维护清单](legacy-compatibility.zh-CN.md)。共同复核运行时准入、测试目标、CI 和用户声明；适用版本退出支持集合时同次清理专属运行时代码及测试。旧插件配置按自身迁移策略退役，保留共享安全逻辑，并用完整版本号与精确版本证据同步更新中英文清单及两个维度的矩阵。

## 准备和检查源码检出

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm check
pnpm pack:local
pnpm smoke
```

`pnpm check` 依次执行类型、格式、构建、包/部署/文档检查，以及单元、集成、CLI 和浏览器测试。`pnpm pack:local` 在静态检查后写出 `artifacts/dsh-auth-remote-0.3.2.tgz`，不会发布。`pnpm smoke` 将包安装到隔离 DSH_HOME，短暂启动固定版本的 DSH，验证就绪、匿名重定向/拒绝和在线 CLI 状态，然后停止。

## 使用隔离开发 profile

```sh
pnpm dev:prepare
pnpm dev:install
pnpm dev:start
```

脚本只管理当前源码目录下的 `.dev/runtime-<version>` 和 `.dev/dsh-home`，默认监听 `127.0.0.1:13090`。终端的 `DSH_HOME` 若指向其他位置，或开发路径为符号链接，脚本会拒绝执行。即使版本号不变，`dev:install` 也会重建并安装当前压缩包。`dev:start` 在前台运行，Ctrl+C 停止。可在另一个终端执行 `pnpm dev` 监听源码，但重建后仍需重新 `dev:install` 并重启 `dev:start` 才会载入新包。

直接查看状态时显式使用同一隔离 home：

```sh
DSH_HOME="$PWD/.dev/dsh-home" "$PWD/.dev/runtime-0.2.2-alpha.2/node_modules/.bin/dsh" plugin --profile web exec dsh-auth-remote status --json
```

开发 home 可能含测试账号数据，须保持私有，不要提交或复制到部署 profile。

## 测试边界

`pnpm test:unit` 覆盖认证状态机、TOTP、备用码、来源策略、翻译、存储持久性和锁恢复。`pnpm test:integration` 使用真实 HTTP/WebSocket socket 验证原生就绪、Cookie、来源判定与撤销。`pnpm test:cli` 构建真实压缩包，并用隔离 profile/Unix socket 验证交互与非交互命令。`pnpm test:browser` 用临时 profile 启动所选的 DSH 版本，验证登录、安全与登录页、原生设置、工作区、上传/预览、SSE、WebSocket 和 HTTPS 转发链。

浏览器网络链路使用 Node HTTP/HTTPS 转发器。`tests/fixtures/tls/` 下的专用自签证书与私钥仅为测试夹具，不进入安装包，也不是部署凭证。聊天使用本地模型替身；不执行真实第三方授权或付费模型请求。默认浏览器为 Playwright Chromium；`DSH_TEST_BROWSER` 可选择本地浏览器程序，`DSH_TEST_BIN` 仅在报告所选精确版本（默认 `0.2.2-alpha.2`）时可替换 DSH 二进制。

共享 Host 环境由 allowlist 构造，清除真实模型凭据/endpoint；浏览器清除 ambient 代理变量。`localModelEndpoint` 在首次输入 Key 前把原生 llm-deepseek baseURL 指向本地 HTTP 替身，不预存 Key、不关闭引导。UI 专项要求零模型调用；代理聊天只接纳本地 chat 和原生 session-title 两次 POST。计数在 fixture 关闭时检查，异常请求使测试失败。

DSH 测试运行时位于 `.cache/test-runtime/<version>`，与源码依赖分别固定。宿主服务和 React 不打入客户端 bundle。[部署指南](deployment.zh-CN.md)说明 profile 与备份规则。

隔离验证安装使用 pnpm 的文件复制模式，避免不同 profile 共享包文件的硬链接元数据变化触发 DSH 客户端热重载。

本候选当前支持见 [README](../README.zh-CN.md#dsh-兼容性)，发布事实见[双向历史](support-history.zh-CN.md)，适配证据见库存。两份 support-policy 保留前一发布记录，本次 `0.3.2` 不修改；不能用当前候选 manifest 推导旧发布声明。

## 跨版本验证

默认测试 DSH `0.2.2-alpha.2`；`DSH_TEST_VERSION` 仅可选择 `0.2.1-alpha.3`、`0.2.1-alpha.4`、`0.2.1-alpha.5`、`0.2.1-rc.1`、`0.2.1-rc.2`、`0.2.1-rc.3`、`0.2.1-rc.4`、`0.2.2-alpha.2`。测试运行时位于 `.cache/test-runtime/<version>`，开发运行时位于 `.dev/runtime-<version>`；`DSH_TEST_BIN` 必须报告所选精确版本。CI 保留八版 CLI/安装 smoke，全量运行八版完整 browser，普通使用下文固定选择。开发类型与集成测试使用锁定的 `0.2.2-alpha.2` 包。八版均验证真实 Loader、模型 runtime context/`DSH_WEB_URL` 和 IPv4/IPv6 HTTP/HTTPS 正向安全边界；测试传输不可用时失败，不跳过。

```sh
DSH_TEST_VERSION=0.2.1-alpha.3 pnpm test:cli
DSH_TEST_VERSION=0.2.1-alpha.3 pnpm test:browser
DSH_TEST_VERSION=0.2.1-alpha.4 pnpm test:cli
DSH_TEST_VERSION=0.2.1-alpha.4 pnpm test:browser
DSH_TEST_VERSION=0.2.1-alpha.5 pnpm test:cli
DSH_TEST_VERSION=0.2.1-alpha.5 pnpm test:browser
DSH_TEST_VERSION=0.2.1-rc.1 pnpm test:cli
DSH_TEST_VERSION=0.2.1-rc.1 pnpm test:browser
DSH_TEST_VERSION=0.2.1-rc.2 pnpm test:cli
DSH_TEST_VERSION=0.2.1-rc.2 pnpm test:browser
DSH_TEST_VERSION=0.2.1-rc.3 pnpm test:cli
DSH_TEST_VERSION=0.2.1-rc.3 pnpm test:browser
DSH_TEST_VERSION=0.2.2-alpha.2 pnpm test:cli
DSH_TEST_VERSION=0.2.2-alpha.2 pnpm test:browser
DSH_TEST_VERSION=0.2.2-alpha.2 pnpm test:cli
DSH_TEST_VERSION=0.2.2-alpha.2 pnpm test:browser
```

浏览器测试把浅色／深色、桌面／窄屏截图保存在 `.cache/ui-review/<version>`，供人工检查。安全页的 CSS 在插件生效时注入、销毁时移除，所有选择器只作用于插件页面，并直接引用宿主 `--dsw-*` 主题变量。独立登录页使用 dsh 0.2.0-rc.1 的主题变量子集并跟随系统配色，不读取登录前不可用的宿主设置。

官方账号专项测试使用本地平台替身与真实 DSH `0.2.2-alpha.2` 账号提供者，验证兑换保留原始 redirect URI 和 PKCE verifier，以及错误 state/URL/会话、重复提交、取消、过期和重试。浏览器覆盖账号菜单与引导中的先说明弹窗、回环导航失败后粘贴确认、弹窗拦截、动态语言与浅深色响应式布局。这些测试不会建立真实官方账号授权。

账号核心测试从锁定的开发依赖加载精确版本提供者，无需预先存在 CLI 运行时缓存；浏览器测试仍使用隔离 DSH profile 中实际安装的提供者。

此临时账号适配保留必要能力与动态配置检查；完整手动功能回归覆盖 `0.2.1-alpha.3`、`0.2.1-alpha.4`、`0.2.1-alpha.5`、`0.2.1-rc.1`、`0.2.1-rc.2`、`0.2.1-rc.3`、`0.2.1-rc.4`、`0.2.2-alpha.2`。全局下限准入后的服务端不再分流旧宿主，独立导出 helper 仍检查缺省、无效和旧版本参数。未来准入不构成已验证声明。支持范围或共享宿主适配变更须用同一最终 tgz 完整运行八版 CLI、browser 与 smoke，逐版执行 `--suite cli --suite browser --suite smoke`；禁止在消费循环调用重建/重打包包装命令。运行器恢复归档 dist、逐 suite 校验 SHA-256，并隔离 smoke 与开发 profile。公网回调、迁移及退役条件见 `DSH-ACCOUNT-001`。

`live-config.spec.ts` 仅观察真实 Loader 的配置引用/fiber、认证/存储实例、锁、监听器及 SSE/WebSocket 连续性，核对实际依赖链并重启验证 profile override；不伪造服务。安全弹窗回归覆盖取消/错误、焦点/键盘、默认及强制 TOTP、一次性备用码复制与会话撤销后跳转保持。任务文档、测试凭证、profile、截图及生成目录不得进入 npm 包。

`account-login.spec.ts` 在八版验证真实原生配置 HMR：修改普通 `sessionHours` 重建监听器，独立 Settings 写入仍等待已有事务，真正嵌套仍被拒绝；隔离插件代码替换后可重新开启手动登录。事务探针调用真实 HMR，不替代服务，不进入 npm 包，最小监听器上下文适配见 `DSH-HMR-001`。受保护远程部署独立禁用原生 webserver。`startup-compatibility.spec.ts` 在八版破坏隔离插件副本：`0.2.1-alpha.3` 用不兼容 Host peer 验证 Loader skip，其余七版用不兼容 `engines.dsh`；各版还注入插件自身准入范围，验证导入后的运行拒绝。两路径均须自行失败且无 TCP/HTTP/readiness/WebSocket 回退，不改上游或 Loader 审计。

账号配置绑定通过原生 describe 镜像的 `ensure()` API 恢复首次读取失败；已有镜像中的命名空间恢复使用明确注入的 `remote.settings` 传输，并将已接纳值回填到同一镜像。偏好加载期间点击登录会等待共享读取，再按最新接纳的 true/false 值选择入口；加载中不等同于关闭。浏览器回归覆盖首次读取失败、命名空间暂缺，以及两种路由选择的延迟读取。

`0.2.1-rc.2`、`0.2.1-rc.3`、`0.2.1-rc.4`、`0.2.2-alpha.2` 的原生 Search/Fetch 设置回归覆盖真实设置/凭据域的选择、保存失败和刷新/重启持久化，以及匿名/撤销会话拒绝。全部地址为本地测试地址，请求计数必须为零。`rc-navigation.spec.ts` 在 `0.2.1-rc.3`、`0.2.1-rc.4`、`0.2.2-alpha.2` 验证全局、会话、右侧栏 More 菜单、原生设置/模型选择及撤销后拒绝；只检查插件市场/Creator 入口可见，不执行安装或外部授权。通过公开 sessions/sessionProjections 构造真实会话的空完成 turn 以展示原生菜单，不发送聊天，不替换快照。官方动态 `/models` 内部语义不在承诺内。

启动维护诊断读取已安装插件的精确声明与显式生命周期记录，同一进程每个精确版本/状态只提示一次，配置/模块 HMR 不重置。三个 Alpha 的 legacy 起算 2026-10-28、14 日窗口、最早资格 2026-11-11（Asia/Shanghai），日期不会停服。六个退役版本记录最后插件 `0.2.0`、退役版本 `0.3.1` 和准备日期 `retiredOn: 2026-10-28`，该日期不是 npm 实际发布时间。单元以模拟时钟确认到期不改变分类；真实 legacy HMR 用例观察同进程去重。必要 API、包身份和安全失败仍拒绝服务。

`browser/host-release.spec.ts` 固定七组真实宿主往返切换：`0.2.1-alpha.4` ↔ `0.2.1-alpha.3`、`0.2.1-alpha.5` ↔ `0.2.1-alpha.4`、`0.2.1-rc.1` ↔ `0.2.1-alpha.5`、`0.2.1-rc.2` ↔ `0.2.1-rc.1`、`0.2.1-rc.3` ↔ `0.2.1-rc.2`、`0.2.1-rc.4` ↔ `0.2.1-rc.3`、`0.2.2-alpha.2` ↔ `0.2.1-rc.4`。同一临时 profile/端口保留页面，检查原生版本提示，刷新后核对认证、原会话和持久设置，再恢复起始版本。只有 `0.2.1-alpha.3` 无 release 元数据并显示未解析；其余目的宿主必须显示真实完整版本。不修改上游源码、版本或依赖图元数据。

## 消费固定归档

`pnpm verify:packed` 消费已有 tgz，不构建或打包。先记录 SHA-256，再传入归档、该摘要、精确声明的 DSH 版本及一个或多个 suite：

```sh
sha256sum artifacts/dsh-auth-remote-0.3.2.tgz
pnpm verify:packed --archive artifacts/dsh-auth-remote-0.3.2.tgz --sha256 <recorded-sha256> --dsh-version 0.2.2-alpha.2 --suite cli --suite browser --suite smoke
```

运行器验证包名/版本及所选宿主声明，将相同字节放到固定制品路径，仅恢复归档中的 dist，因此 CLI 执行与安装比较都使用这份 dist。不安全 tar 条目、摘要变化、未知选择、零真实用例及 skipped/cancelled/todo 用例均失败。Node 对无匹配用例文件产生的通过占位项不计作真实测试。`--test-name-pattern` 可筛选单个 `cli` 或 `browser` suite，报告明确标记为局部，并包含文件、筛选表达式与实际命令。固定专项不能覆盖其筛选/数量要求，每个必需文件均须注册测试。

| Suite          | 选择范围                                                                                                                                 |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `cli`          | 全部 CLI 测试文件                                                                                                                        |
| `browser`      | 全部浏览器测试文件                                                                                                                       |
| `smoke`        | 在新建且带标记的 home 中安装并短暂启动归档                                                                                               |
| `theme`        | 精确登录/安全主题与窄屏用例（1 个真实测试）                                                                                              |
| `account`      | `0.2.1-alpha.3` 的 startup-compatibility、account-login 与 live-config                                                                   |
| `host-release` | `0.2.1-alpha.4`、`0.2.1-alpha.5`、`0.2.1-rc.1`、`0.2.1-rc.2`、`0.2.1-rc.3`、`0.2.1-rc.4`、`0.2.2-alpha.2` 的真实往返切换（1 个真实测试） |
| `rc-bootstrap` | `0.2.1-rc.1` 的 host-release 与 dsh-bootstrap（2 个真实测试）                                                                            |

同一 checkout 的消费以锁保证串行。每个 suite 结束均重新校验输入归档、固定消费归档及恢复的 dist。JSON 报告和测试日志保留在 `.cache/verify-packed/`。smoke 直接在 `.cache/v-*` 新建带内部标记的短目录，确保默认 GitHub 检出路径下的管理 socket 不超过 Linux 路径上限；使用独立 runtime/home，以 `--port 0` 启动，仅读取该子进程公布的实际回环地址，并在相同 profile 检查在线 CLI 状态。既有 `.dev/dsh-home` 和 13090 上的服务保持独立，只清理本次新建的验证根目录。`DSH_VERIFY_ROOT` 是内部入口，拒绝无标记、符号链接及外部路径；普通开发命令保留原有 profile 和端口。

## 独立退役拒绝验证

`verify-retired.mjs` 不扩展 `DSH_TEST_VERSION` 或正向矩阵。它核验同一候选/SHA256SUMS 及已发布 `0.2.0` 的完整性，在两个私有旧 profile 验证真实 CLI 安装拒绝/完整回滚，以及完整不兼容包的原生 peer skip。后一路保留真实旧 peer 解析、连续确认无 TCP/HTTP/readiness/WebSocket 监听并清理进程。六版一次性验收属于 `0.3.1` 迁移历史；当前 full/发布仅运行 `0.2.1-alpha.2`，ordinary 不运行。

```sh
node scripts/verify-retired.mjs --archive artifacts/dsh-auth-remote-0.3.2.tgz --sha256 <recorded-sha256> --retired-dsh-version 0.2.1-alpha.2
```

六个独立负向目标：`0.1.7-rc.1`、`0.1.7-rc.2`、`0.2.0-rc.1`、`0.2.0-rc.2`、`0.2.1-alpha.1`、`0.2.1-alpha.2`。结果与正向报告分开保存在 `.cache/verify-retired/`。

## 普通与全量 CI 计划

`scripts/ci-plan.mjs` 仅在全部变更路径均为 `CHANGELOG.md`、`CHANGELOG.zh-CN.md`、`CONTRIBUTING.md`、`CONTRIBUTING.zh-CN.md`、`LICENSE` 或 `tests/unit/i18n.test.ts` 时选择普通计划。其他任何路径均全量，包括源码、共享测试/helper、package/lock/构建脚本、工作流、README、支持规范与兼容库存。重命名/复制、未知状态、空或不完整差异、异常/有未提交变更的检出也全量。PR 比较真实事件 base/head 并核对合并父提交，push 比较 before/after；缺少提交证据回退全量。

手动运行、未知事件、每次发布及 UTC 周一 00:00 的定时检查固定 full。所有计划保留八版 CLI/smoke；full 运行八版完整 browser 和 `0.2.1-alpha.2` 独立真实负向任务，ordinary 不运行真实旧宿主负向。普通 browser 固定如下：

| 精确 DSH 版本   | 普通 browser 选择 |
| --------------- | ----------------- |
| `0.2.1-alpha.3` | `browser`         |
| `0.2.1-alpha.4` | `host-release`    |
| `0.2.1-alpha.5` | `host-release`    |
| `0.2.1-rc.1`    | `rc-bootstrap`    |
| `0.2.1-rc.2`    | `browser`         |
| `0.2.1-rc.3`    | `browser`         |
| `0.2.1-rc.4`    | `browser`         |
| `0.2.2-alpha.2` | `browser`         |

共享工作流先验证精确矩阵。full 聚合要求 validate、cli-smoke、browser、retired-rejection 全部成功；ordinary 仅接受 retired-rejection 的预定 skipped，其余必须成功。未知 plan、缺失结果、失败/取消或其他 skip 均拒绝。`CI Verify` 还要求 plan/producer 成功，发布固定 full 并继承负向门禁。单 checkout 固定端口测试串行；本地并发需独立源码/dist/制品/runtime/profile、可写 node_modules 副本及网络命名空间，复制安装避免共享 HMR inode 变化。

精确 DSH `0.2.2-alpha.2` 的 `native-transport.spec.ts` 比较真实原生 asset/fallback 文件与 ETag，覆盖 GET/HEAD/304、匿名/撤销携正确 ETag 仍拒绝；真实 bundle/map/chunk 保留 immutable 200，index 不采用 immutable 缓存。四个真实 `/api/remote.mux` 用例覆盖原生 HTTPS/代理、默认/none 压缩、whole-frame 阈值/RSV1、成功 ready 帧和真实到期/撤销；传输和压缩仍由原生 Gateway/ws 实现。

新版 `account-login.spec.ts` 的 source HMR 故障用例在导入失败时保留原实例，再于真实替换实例完成初始化后抛错，验证旧/失败资源清理和原生自动回滚。检查真实 provider fiber、监听器、状态锁 nonce、mux 关闭、认证持久性、恢复后的首次 Settings 保存和最终锁再获取。副本入口使用统一 file URL 与显式原生监听 root；公开日志 exporter 只观测 warn，不替换 HMR。

浏览器语言测试覆盖插件八语、登录回退/记忆、原生已接纳偏好与乐观选择、延迟/不可用/失败读取和保存、存储失败，以及退出/撤销后保留；不改变 DSH 原生语言目录。CLI 在不同环境语言下须固定英语，各种 `--lang` 在 profile 访问前拒绝；退役夹具对已发布 `0.2.0` 保留历史中文合同。

`liveshare.spec.ts` 仅在精确 `0.2.2-alpha.2` 注册：真实原生 Host/Owner PKCE/分享 worker/查看页载体和停止操作配本地 Relay 身份/传输替身；viewer 不挂载管理员功能。不宣称真实 Relay/OAuth、访客模型或文件写入已验证。局部筛选报告和文件 placeholder 不认证最终八版归档。
