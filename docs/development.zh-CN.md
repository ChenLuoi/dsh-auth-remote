# 开发指南

[English](development.md)

本指南描述候选 `0.3.6` 的八版精确验证目标，默认及推荐RC预发布宿主为 `0.2.2-rc.2`。候选未发布；最终同包、Actions与分发证据独立记录，历史或专项结果不认证修改后的最终候选。

开发和完整测试需要 Linux（profile 锁依赖 `/proc`）、Node.js 24、pnpm 12.5.1，以及 DSH `0.2.2-rc.2`。DSH `0.2.2-rc.2` 自身要求 Node.js `>=24.9.0`；插件引擎仍为 `>=24`。浏览器测试使用 Playwright 管理的 Chromium 和 Node HTTP/HTTPS 转发器。

兼容声明或适配变更前，先阅读 [Legacy 兼容维护清单](legacy-compatibility.zh-CN.md)。共同复核运行时准入、测试目标、CI 和用户声明；适用版本退出支持集合时同次清理专属运行时代码及测试。旧插件配置按自身迁移策略退役，保留共享安全逻辑，并用完整版本号与精确版本证据同步更新中英文清单及两个维度的矩阵。

## 准备和检查源码检出

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm check
pnpm pack:local
pnpm smoke
```

`pnpm check` 依次执行类型、格式、构建、包/部署/文档检查，以及单元、集成、CLI 和浏览器测试。`pnpm pack:local` 在静态检查后写出 `artifacts/dsh-auth-remote-0.3.6.tgz`，不会发布。`pnpm smoke` 会先再次运行 `pack:local` 重建/打包新候选，再安装到隔离DSH_HOME并短暂启动固定宿主，检查ready、匿名重定向/拒绝和在线CLI状态后停止。它不消费先前冻结摘要；固定归档应使用 `verify:packed --suite smoke`。

## 使用隔离开发 profile

```sh
pnpm dev:prepare
pnpm dev:install
pnpm dev:start
```

脚本只管理当前源码目录下的 `.dev/runtime-<version>` 和 `.dev/dsh-home`，默认监听 `127.0.0.1:13090`。终端的 `DSH_HOME` 若指向其他位置，或开发路径为符号链接，脚本会拒绝执行。即使版本号不变，`dev:install` 也会重建并安装当前压缩包。`dev:start` 在前台运行，Ctrl+C 停止。可在另一个终端执行 `pnpm dev` 监听源码，但重建后仍需重新 `dev:install` 并重启 `dev:start` 才会载入新包。

直接查看状态时显式使用同一隔离 home：

```sh
DSH_HOME="$PWD/.dev/dsh-home" "$PWD/.dev/runtime-0.2.2-rc.2/node_modules/.bin/dsh" plugin --profile web exec dsh-auth-remote status --json
```

开发 home 可能含测试账号数据，须保持私有，不要提交或复制到部署 profile。

## 测试边界

`pnpm test:unit` 覆盖认证状态机、TOTP、备用码、来源策略、翻译、存储持久性和锁恢复。`pnpm test:integration` 使用真实 HTTP/WebSocket socket 验证原生就绪、Cookie、来源判定与撤销。`pnpm test:cli` 构建真实压缩包，并用隔离 profile/Unix socket 验证交互与非交互命令。`pnpm test:browser` 用临时 profile 启动所选的 DSH 版本，验证登录、安全与登录页、原生设置、工作区、上传/预览、SSE、WebSocket 和 HTTPS 转发链。

浏览器网络链路使用 Node HTTP/HTTPS 转发器。`tests/fixtures/tls/` 下的专用自签证书与私钥仅为测试夹具，不进入安装包，也不是部署凭证。聊天使用本地模型替身；不执行真实第三方授权或付费模型请求。默认浏览器为 Playwright Chromium；`DSH_TEST_BROWSER` 可选择本地浏览器程序，`DSH_TEST_BIN` 仅在报告所选精确版本（默认 `0.2.2-rc.2`）时可替换 DSH 二进制。

共享 Host 环境由 allowlist 构造，清除真实模型凭据/endpoint；浏览器清除 ambient 代理变量。`localModelEndpoint` 在首次输入 Key 前把原生 llm-deepseek baseURL 指向本地 HTTP 替身，不预存 Key、不关闭引导。UI 专项要求零模型调用；代理聊天只接纳本地 chat 和原生 session-title 两次 POST。计数在 fixture 关闭时检查，异常请求使测试失败。

DSH 测试运行时位于 `.cache/test-runtime/<version>`，与源码依赖分别固定。宿主服务和 React 不打入客户端 bundle。[部署指南](deployment.zh-CN.md)说明 profile 与备份规则。

隔离验证安装使用 pnpm 的文件复制模式，避免不同 profile 共享包文件的硬链接元数据变化触发 DSH 客户端热重载。

当前支持见 [README](../README.zh-CN.md#dsh-兼容性)与[支持规范](support-policy.zh-CN.md)，发布事实见[双向历史](support-history.zh-CN.md)，适配证据见库存。不能用当前 manifest 推导旧发布声明。

## 跨版本验证

默认 DSH `0.2.2-rc.2`；`DSH_TEST_VERSION` 只接受 `0.2.1-rc.1`, `0.2.1-rc.2`, `0.2.1-rc.3`, `0.2.1-rc.4`, `0.2.1-rc.5`, `0.2.2-alpha.3`, `0.2.2-rc.1`, `0.2.2-rc.2`。三个退役Alpha不进入正向选择。测试runtime为 `.cache/test-runtime/<version>`，开发runtime为 `.dev/runtime-<version>`；`DSH_TEST_BIN` 必须报告所选精确版本。ordinary/full均完整执行八版CLI/browser/smoke。类型与集成使用锁定的 `0.2.2-rc.2` 开发包。八版均验证真实Loader、模型runtime context/`DSH_WEB_URL`与IPv4/IPv6 HTTP/HTTPS安全边界，传输不可用即失败，不跳过。

```sh
DSH_TEST_VERSION=0.2.1-rc.1 pnpm test:cli
DSH_TEST_VERSION=0.2.1-rc.1 pnpm test:browser
DSH_TEST_VERSION=0.2.1-rc.2 pnpm test:cli
DSH_TEST_VERSION=0.2.1-rc.2 pnpm test:browser
DSH_TEST_VERSION=0.2.1-rc.3 pnpm test:cli
DSH_TEST_VERSION=0.2.1-rc.3 pnpm test:browser
DSH_TEST_VERSION=0.2.1-rc.4 pnpm test:cli
DSH_TEST_VERSION=0.2.1-rc.4 pnpm test:browser
DSH_TEST_VERSION=0.2.1-rc.5 pnpm test:cli
DSH_TEST_VERSION=0.2.1-rc.5 pnpm test:browser
DSH_TEST_VERSION=0.2.2-alpha.3 pnpm test:cli
DSH_TEST_VERSION=0.2.2-rc.1 pnpm test:cli
DSH_TEST_VERSION=0.2.2-alpha.3 pnpm test:browser
DSH_TEST_VERSION=0.2.2-rc.1 pnpm test:browser
DSH_TEST_VERSION=0.2.2-rc.2 pnpm test:cli
DSH_TEST_VERSION=0.2.2-rc.2 pnpm test:browser
```

浏览器测试把浅色／深色、桌面／窄屏截图保存在 `.cache/ui-review/<version>`，供人工检查。安全页的 CSS 在插件生效时注入、销毁时移除，所有选择器只作用于插件页面，并直接引用宿主 `--dsw-*` 主题变量。独立登录页使用 dsh 0.2.0-rc.1 的主题变量子集并跟随系统配色，不读取登录前不可用的宿主设置。

官方账号专项测试使用本地平台替身与真实 DSH `0.2.2-rc.2` 合并账号提供者，验证兑换保留原始 redirect URI 和 PKCE verifier，以及错误 state/URL/会话、重复提交、取消、过期和重试。浏览器覆盖账号菜单与引导中的先说明弹窗、回环导航失败后粘贴确认、弹窗拦截、动态语言与浅深色响应式布局。这些测试不会建立真实官方账号授权。

账号核心测试从锁定的开发依赖加载精确版本提供者，无需预先存在 CLI 运行时缓存；浏览器测试仍使用隔离 DSH profile 中实际安装的提供者。

账号适配保留必要能力与动态配置检查，八版均完整回归手动登录；通过准入的未知版本不继承验证。`0.2.2-rc.2` 以私有component原位装饰保留entry/children/inject/options及原生disposer，自己的provideRoot贡献触发安装/移除重绘；停用旧wrapper后只条件恢复自身写入，无children的旧路径仍公开注册。两个独立私有runtime验证客户端/原生源码HMR、children归属、通知、后写保护、挂起describe和活动授权取消；通知和PKCE只用本地Platform/通知协议替身。八语访问集合有断言，但跨产品通知本地化映射未完全验证。见 `DSH-ACCOUNT-001` 和 `DSH-ACCOUNT-SLOT-001`。

`live-config.spec.ts` 仅观察真实 Loader 的配置引用/fiber、认证/存储实例、锁、监听器及 SSE/WebSocket 连续性，核对实际依赖链并重启验证 profile override；不伪造服务。安全弹窗回归覆盖取消/错误、焦点/键盘、默认及强制 TOTP、一次性备用码复制与会话撤销后跳转保持。任务文档、测试凭证、profile、截图及生成目录不得进入 npm 包。

`account-login.spec.ts` 在八版以普通 `sessionHours` 变更执行真实配置HMR，检查监听重建、独立Settings写入排队和真正嵌套拒绝；替换隔离插件源码后能重新开启手动登录。探针只调用真实HMR，不替代服务、不入包，见 `DSH-HMR-001`。八版 `startup-compatibility.spec.ts` 都破坏隔离插件自身 `engines.dsh`，验证Loader拒绝且模块未导入；另注入自身准入范围验证导入后拒绝。两路径自然非零退出，均无TCP/HTTP/readiness/WebSocket裸监听；profile独立禁用原生webserver，上游包和Loader审计不改。

账号配置绑定通过原生 describe 镜像的 `ensure()` API 恢复首次读取失败；已有镜像中的命名空间恢复使用明确注入的 `remote.settings` 传输，并将已接纳值回填到同一镜像。偏好加载期间点击登录会等待共享读取，再按最新接纳的 true/false 值选择入口；加载中不等同于关闭。浏览器回归覆盖首次读取失败、命名空间暂缺，以及两种路由选择的延迟读取。

`0.2.1-rc.2`、`0.2.1-rc.3`、`0.2.1-rc.4`、`0.2.1-rc.5`、`0.2.2-alpha.3`、`0.2.2-rc.1`、`0.2.2-rc.2` 的原生 Search/Fetch 设置回归覆盖真实设置/凭据域的选择、保存失败和刷新/重启持久化，以及匿名/撤销会话拒绝。全部地址为本地测试地址，请求计数必须为零。`rc-navigation.spec.ts` 在 `0.2.1-rc.3`、`0.2.1-rc.4`、`0.2.1-rc.5`、`0.2.2-alpha.3`、`0.2.2-rc.1`、`0.2.2-rc.2` 验证全局、会话、右侧栏 More 菜单、原生设置/模型选择及撤销后拒绝；只检查插件市场/Creator 入口可见，不执行安装或外部授权。通过公开 sessions/sessionProjections 构造真实会话的空完成 turn 以展示原生菜单，不发送聊天，不替换快照。官方动态 `/models` 内部语义不在承诺内。

在 `0.2.2-rc.2`，Search/Fetch分别验证auto/account/api-key计费选择、保存拒绝、刷新/重启持久化、测试密钥保存/替换/移除及响应不回显；匿名/撤销会话401。端点均本地，模型、Search/Fetch与外网请求均为零。

启动维护诊断读取已安装插件声明和显式生命周期记录，同一进程/版本/状态只提示一次，配置/模块HMR不重置。三个Alpha按原2026-10-28/14日/2026-11-11窗口在候选0.3.6维护退役，最后支持插件0.3.5；retiredOn=2026-11-13是准备日。正向不再保留Alpha独占的legacy模块HMR分支，通用告警去重/日期单元保留，真实告警及源码HMR边界迁入本次维护退役专项。六个技术退役宿主的0.3.1/最后0.2.0记录不变。日期从不自动停止服务，必要API/身份/安全失败仍拒绝。

`browser/host-release.spec.ts` 固定七组真实往返：`0.2.1-rc.2` ↔ `0.2.1-rc.1`、`0.2.1-rc.3` ↔ `0.2.1-rc.2`、`0.2.1-rc.4` ↔ `0.2.1-rc.3`、`0.2.1-rc.5` ↔ `0.2.1-rc.4`、`0.2.2-alpha.3` ↔ `0.2.1-rc.5`、`0.2.2-rc.1` ↔ `0.2.2-alpha.3`、`0.2.2-rc.2` ↔ `0.2.2-rc.1`。同一临时profile/端口保留页面，核对真实完整版本提示，刷新后验证认证、原会话和设置，最后恢复起始宿主。最低 `0.2.1-rc.1` 不注册该用例；不修改上游源码、版本或依赖图。

## 消费固定归档

`pnpm verify:packed` 消费已有 tgz，不构建或打包。先记录 SHA-256，再传入归档、该摘要、精确声明的 DSH 版本及一个或多个 suite：

```sh
sha256sum artifacts/dsh-auth-remote-0.3.6.tgz
pnpm verify:packed --archive artifacts/dsh-auth-remote-0.3.6.tgz --sha256 <recorded-sha256> --dsh-version 0.2.2-rc.2 --suite cli --suite browser --suite smoke
```

运行器验证包名/版本及所选宿主声明，将相同字节放到固定制品路径，仅恢复归档中的 dist，因此 CLI 执行与安装比较都使用这份 dist。不安全 tar 条目、摘要变化、未知选择、零真实用例及 skipped/cancelled/todo 用例均失败。Node 对无匹配用例文件产生的通过占位项不计作真实测试。`--test-name-pattern` 可筛选单个 `cli` 或 `browser` suite，报告明确标记为局部，并包含文件、筛选表达式与实际命令。固定专项不能覆盖其筛选/数量要求，每个必需文件均须注册测试。

| Suite          | 选择范围                                                                                                              |
| -------------- | --------------------------------------------------------------------------------------------------------------------- |
| `cli`          | 全部 CLI 测试文件                                                                                                     |
| `browser`      | 全部浏览器测试文件                                                                                                    |
| `smoke`        | 在新建且带标记的 home 中安装并短暂启动归档                                                                            |
| `theme`        | 精确登录/安全主题与窄屏用例（1 个真实测试）                                                                           |
| `account`      | `0.2.1-rc.1` 的startup-compatibility、account-login与live-config                                                      |
| `host-release` | `0.2.1-rc.2`、`0.2.1-rc.3`、`0.2.1-rc.4`、`0.2.1-rc.5`、`0.2.2-alpha.3`、`0.2.2-rc.1`、`0.2.2-rc.2`，一个真实往返测试 |

同一 checkout 的消费以锁保证串行。每个 suite 结束均重新校验输入归档、固定消费归档及恢复的 dist。JSON 报告和测试日志保留在 `.cache/verify-packed/`。smoke 直接在 `.cache/v-*` 新建带内部标记的短目录，确保默认 GitHub 检出路径下的管理 socket 不超过 Linux 路径上限；使用独立 runtime/home，以 `--port 0` 启动，仅读取该子进程公布的实际回环地址，并在相同 profile 检查在线 CLI 状态。既有 `.dev/dsh-home` 和 13090 上的服务保持独立，只清理本次新建的验证根目录。`DSH_VERIFY_ROOT` 是内部入口，拒绝无标记、符号链接及外部路径；普通开发命令保留原有 profile 和端口。

## 独立退役拒绝验证

`verify-retired.mjs` 不扩展 `DSH_TEST_VERSION` 或正向矩阵。它核验同一候选/SHA256SUMS 及已发布 `0.2.0` 的完整性，在两个私有旧 profile 验证真实 CLI 安装拒绝/完整回滚，以及完整不兼容包的原生 peer skip。后一路保留真实旧 peer 解析、连续确认无 TCP/HTTP/readiness/WebSocket 监听并清理进程。六版一次性验收属于 `0.3.1` 迁移历史；当前 full/发布仅运行 `0.2.1-alpha.2`，ordinary 不运行。

```sh
node scripts/verify-retired.mjs --archive artifacts/dsh-auth-remote-0.3.6.tgz --sha256 <recorded-sha256> --retired-dsh-version 0.2.1-alpha.2
```

六个独立负向目标：`0.1.7-rc.1`、`0.1.7-rc.2`、`0.2.0-rc.1`、`0.2.0-rc.2`、`0.2.1-alpha.1`、`0.2.1-alpha.2`。结果与正向报告分开保存在 `.cache/verify-retired/`。

## 本次维护退役专项

仅插件 `0.3.6` 的full/发布用同一归档分别运行三个精确目标；不扩大DSH_TEST_VERSION，不运行Chromium，不恢复其完整支持：

```sh
node scripts/verify-maintenance-retired.mjs --archive artifacts/dsh-auth-remote-0.3.6.tgz --sha256 <recorded-sha256> --dsh-version 0.2.1-alpha.3
node scripts/verify-maintenance-retired.mjs --archive artifacts/dsh-auth-remote-0.3.6.tgz --sha256 <recorded-sha256> --dsh-version 0.2.1-alpha.4
node scripts/verify-maintenance-retired.mjs --archive artifacts/dsh-auth-remote-0.3.6.tgz --sha256 <recorded-sha256> --dsh-version 0.2.1-alpha.5
```

每版三场景：真实安装/init、ready前精确告警、匿名拒绝/登录、真实配置及源码HMR后会话连续且告警一次、撤销拒绝；Loader故障后无监听（`0.2.1-alpha.3` 使用Host peer，其余两版使用engines）；自身准入故障导入后拒绝且无TCP/HTTP/readiness/WebSocket。只改临时插件副本，原生webserver在profile独立禁用，上游身份/依赖图和候选归档不改。旧原生watcher排除node_modules，故在验证真实安装文件后复制该候选自身文件到profile watch root并通过公开HMR root/file URL启用真实源码替换。报告在 `.cache/verify-maintenance-retired/`，TAP须恰好三个具名真实用例且进程完全清理。其他插件版本明确拒绝此专项。

## Producer与包外验收索引

核心检查后只执行一次 `node scripts/pack.mjs`，随后 `node scripts/packed-artifact.mjs record` 生成相邻 `SHA256SUMS` 和唯一 `producer.json`，记录HEAD/完整diff/未跟踪字节与模式、归档及Node/pnpm身份。即使tgz相同，新producer仍有独立身份。消费者原报告schema保留，`report-*-evidence.json` 关联原report、原始日志和所有 `report-*-runtimes/` receipt。每次验收context中的真实prepare记录CLI/lock/DSH→WebApp→八包SDK及全树nlink=1，包括smoke、前版宿主与私有账号runtime。

按打印的report路径，将本producer全部原JSON、相邻sidecar、receipt目录及sidecar列出的原始日志保留原basename复制到一个新的包外忽略目录。smoke有三个真实日志后缀：dev-prepare.mjs、dev-install.mjs、smoke.mjs；不得只复制不存在的合成smoke日志。不要混入历史producer或partial结果。消费结束以 `packed-artifact.mjs index ARCHIVE SHA256 REPORT_ROOT OUTPUT` 生成包外索引，完整示例见[发布指南](releasing.zh-CN.md)。索引核验八版CLI/完整browser/smoke、full独立技术拒绝和仅0.3.6 full的三版维护专项，以及所有原始摘要和必需runtime角色；缺失/错摘要/混producer/partial均失败，并替换过期passed索引为failed。不能把文件占位当真实用例。

## 普通与全量 CI 计划

`scripts/ci-plan.mjs` 仅在全部变更路径均为 `CHANGELOG.md`、`CHANGELOG.zh-CN.md`、`CONTRIBUTING.md`、`CONTRIBUTING.zh-CN.md`、`LICENSE` 或 `tests/unit/i18n.test.ts` 时选择普通计划。其他任何路径均全量，包括源码、共享测试/helper、package/lock/构建脚本、工作流、README、支持规范与兼容库存。重命名/复制、未知状态、空或不完整差异、异常/有未提交变更的检出也全量。PR 比较真实事件 base/head 并核对合并父提交，push 比较 before/after；缺少提交证据回退全量。

手动运行、未知事件、每次发布及UTC周一00:00定时检查固定full。ordinary/full均完整运行八版CLI/browser/smoke，低风险白名单只决定额外退役任务，不再缩减browser。full要求独立 `0.2.1-alpha.2` 技术拒绝；仅从已核验归档派生的plugin `0.3.6` full要求maintenance-retirement三版矩阵。ordinary预期跳过两类退役job；其他插件版本的full仅预期跳过maintenance-retirement，技术拒绝仍成功。聚合必须收到validate、cli-smoke、browser、retired-rejection、maintenance-retirement五项结果及明确true/false required输出；缺失、未知、失败、取消、其他skip一律拒绝。发布固定full且只消费同一producer，不重打包。

单checkout固定端口用例串行。本地并发需独立源码/dist/制品/runtime/profile、可写node_modules副本和网络命名空间；pnpm copy安装并核对nlink=1，避免共享HMR inode变化。

精确 DSH `0.2.2-alpha.3`、`0.2.2-rc.1`、`0.2.2-rc.2` 的 `native-transport.spec.ts` 比较真实原生 asset/fallback 文件与 ETag，覆盖 GET/HEAD/304、匿名/撤销携正确 ETag 仍拒绝；真实 bundle/map/chunk 保留 immutable 200，index 不采用 immutable 缓存。四个真实 `/api/remote.mux` 用例覆盖原生 HTTPS/代理、默认/none 压缩、whole-frame 阈值/RSV1、成功 ready 帧和真实到期/撤销；传输和压缩仍由原生 Gateway/ws 实现。

新版 `account-login.spec.ts` 的 source HMR 故障用例在导入失败时保留原实例，再于真实替换实例完成初始化后抛错，验证旧/失败资源清理和原生自动回滚。检查真实 provider fiber、监听器、状态锁 nonce、mux 关闭、认证持久性、恢复后的首次 Settings 保存和最终锁再获取。副本入口使用统一 file URL 与显式原生监听 root；公开日志 exporter 只观测 warn，不替换 HMR。

浏览器语言测试覆盖插件八语、登录回退/记忆、原生已接纳偏好与乐观选择、延迟/不可用/失败读取和保存、存储失败，以及退出/撤销后保留；不改变 DSH 原生语言目录。CLI 在不同环境语言下须固定英语，各种 `--lang` 在 profile 访问前拒绝；退役夹具对已发布 `0.2.0` 保留历史中文合同。

`liveshare.spec.ts` 只保留精确 `0.2.2-alpha.3`、`0.2.2-rc.1`、`0.2.2-rc.2` 的真实native viewer/index、carrier及管理员能力隔离。Owner/Relay产品流程及专用替身已删除。共享业务Origin链由 `business-origin-observer.mjs` 接真实Connection.fetch两个精确Owner POST路径，在HTTP/HTTPS/代理、真实配置HMR及匿名/撤销/错误Origin拒绝下观测原生Request与单次恢复；不加载Host/Relay、不手动构造waterfall结果。生产适配保留，产品流程未验证，历史报告仅认证原归档。

候选 `0.3.6` 的最终验收和公开发布待完成；已发布 `0.3.5` 保留原十版声明，新增 `0.2.2-rc.2` 支持不追溯旧包。验收使用同一最终归档与Linux/Node.js 24（默认宿主至少24.9.0）/Chromium，其他Node大版本不能替代；真实代理产品、外部授权、非回环IPv6网卡和其他平台/浏览器仍未验证。

直接开发依赖为 DSH `0.2.2-rc.2`、Cordis `4.1.0`、Schemastery `3.19.0`；实际新宿主链使用 Loader `1.1.0` 和 Include `1.1.0`。这些是分发包版本。保留 `autoInstallPeers: false`，发布时间例外只列经核验且安装器要求的精确版本。配置观测读取 canonical `entry.fiber.ctx.fiber` 的 `effectiveConfig`，只有不存在访问器的旧宿主才回退 `config`；未激活、缺值或非 `.get()` 引用报错。生产构造参数继续保留原生 Volatile。

`settings-icon.spec.ts` 在八版均注册：`0.2.2-alpha.3`、`0.2.2-rc.1`、`0.2.2-rc.2` 验证原生盾牌/size/currentColor/选中态、明暗窄屏、贡献释放默认恢复、真实声明撤下重建去重及卸载；其他五版验证默认图标。观测和释放入口仅在 fixture，模块仍由宿主 Loader 解析；viewer 不安装管理员效果。完整 browser 除整文件非空外，还核对必需 mux/资源/HMR/图标 TAP 名称；名称筛选明确为 partial。八语用例断言实际访问集合，不以标题代替执行。

LiveShare 是官方已发布、默认关闭的实验性可选插件（`listedByDefault: false`），本插件不自动启用。必要兼容只在精确 `0.2.2-alpha.3`、`0.2.2-rc.1`、`0.2.2-rc.2` 维护；本地协议替身不证明生产 Relay/OAuth、真实访客模型或文件写入。私有接口依赖与未知宿主限制见兼容库存。

源码、旧原型、阶段专项、完整候选、PR/master/tag producer及发布后字节核验分别记录，不互相继承。私有接口依赖、准确适用版本及退役条件见双向库存 `DSH-ACCOUNT-SLOT-001`、`DSH-RESOURCE-001`、`DSH-LIVESHARE-001`。
