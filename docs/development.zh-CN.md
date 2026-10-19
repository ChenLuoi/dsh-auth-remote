# 开发指南

[English](development.md)

本指南描述插件 `0.2.0` 的十一版精确验证目标；新增 RC 尚不能视为 npm `0.1.10` 的历史支持。最终同包运行证据另记执行记录。

开发和完整测试需要 Linux（profile 锁依赖 `/proc`）、Node.js 24+、pnpm 12.5.1，以及 DSH `0.2.1-rc.2`。浏览器测试使用 Playwright 管理的 Chromium 和 Node HTTP/HTTPS 转发器。

兼容声明或适配变更前，先阅读 [Legacy 兼容维护清单](legacy-compatibility.zh-CN.md)。共同复核运行时准入、测试目标、CI 和用户声明；适用版本退出支持集合时同次清理专属运行时代码及测试。旧插件配置按自身迁移策略退役，保留共享安全逻辑，并用完整版本号与精确版本证据同步更新中英文清单及两个维度的矩阵。

## 准备和检查源码检出

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm check
pnpm pack:local
pnpm smoke
```

`pnpm check` 依次执行类型、格式、构建、包/部署/文档检查，以及单元、集成、CLI 和浏览器测试。`pnpm pack:local` 在静态检查后写出 `artifacts/dsh-auth-remote-0.2.0.tgz`，不会发布。`pnpm smoke` 将包安装到隔离 DSH_HOME，短暂启动固定版本的 DSH，验证就绪、匿名重定向/拒绝和在线 CLI 状态，然后停止。

## 使用隔离开发 profile

```sh
pnpm dev:prepare
pnpm dev:install
pnpm dev:start
```

脚本只管理当前源码目录下的 `.dev/runtime-<version>` 和 `.dev/dsh-home`，默认监听 `127.0.0.1:13090`。终端的 `DSH_HOME` 若指向其他位置，或开发路径为符号链接，脚本会拒绝执行。即使版本号不变，`dev:install` 也会重建并安装当前压缩包。`dev:start` 在前台运行，Ctrl+C 停止。可在另一个终端执行 `pnpm dev` 监听源码，但重建后仍需重新 `dev:install` 并重启 `dev:start` 才会载入新包。

直接查看状态时显式使用同一隔离 home：

```sh
DSH_HOME="$PWD/.dev/dsh-home" "$PWD/.dev/runtime-0.2.1-rc.2/node_modules/.bin/dsh" plugin --profile web exec dsh-auth-remote status --json
```

开发 home 可能含测试账号数据，须保持私有，不要提交或复制到部署 profile。

## 测试边界

`pnpm test:unit` 覆盖认证状态机、TOTP、备用码、来源策略、翻译、存储持久性和锁恢复。`pnpm test:integration` 使用真实 HTTP/WebSocket socket 验证原生就绪、Cookie、来源判定与撤销。`pnpm test:cli` 构建真实压缩包，并用隔离 profile/Unix socket 验证交互与非交互命令。`pnpm test:browser` 用临时 profile 启动所选的 DSH 版本，验证登录、安全与登录页、原生设置、工作区、上传/预览、SSE、WebSocket 和 HTTPS 转发链。

浏览器网络链路使用 Node HTTP/HTTPS 转发器。`tests/fixtures/tls/` 下的专用自签证书与私钥仅为测试夹具，不进入安装包，也不是部署凭证。聊天使用本地模型替身；不执行真实第三方授权或付费模型请求。默认浏览器为 Playwright Chromium；`DSH_TEST_BROWSER` 可选择本地浏览器程序，`DSH_TEST_BIN` 仅在报告所选精确版本（默认 `0.2.1-rc.2`）时可替换 DSH 二进制。

DSH 测试运行时位于 `.cache/test-runtime/<version>`，与源码依赖分别固定。宿主服务和 React 不打入客户端 bundle。[部署指南](deployment.zh-CN.md)说明 profile 与备份规则。

隔离验证安装使用 pnpm 的文件复制模式，避免不同 profile 共享包文件的硬链接元数据变化触发 DSH 客户端热重载。

支持决策见[规范](support-policy.zh-CN.md)，发布事实见[双向历史](support-history.zh-CN.md)，适配证据见库存。三层与 README 同时维护两种语言，不能用当前候选 manifest 推导旧发布声明。

## 跨版本验证

默认测试 DSH `0.2.1-rc.2`；`DSH_TEST_VERSION` 可选择 `0.1.7-rc.1`、`0.1.7-rc.2`、`0.2.0-rc.1`、`0.2.0-rc.2`、`0.2.1-alpha.1`、`0.2.1-alpha.2`、`0.2.1-alpha.3`、`0.2.1-alpha.4`、`0.2.1-alpha.5`、`0.2.1-rc.1` 或 `0.2.1-rc.2`，测试运行时分别位于 `.cache/test-runtime/<version>`，开发运行时位于 `.dev/runtime-<version>`。`DSH_TEST_BIN` 必须报告所选的精确版本。CI 对十一版分别保留 CLI 和安装冒烟。全量验证执行全部 browser 目标，普通验证使用下文固定的边界选择。开发类型和集成测试使用锁定的 DSH `0.2.1-rc.2` 包。源码检出目录的测试指南（`tests/README.zh-CN.md`）说明真实 Loader/模型地址核对，以及原生 IPv6/TLS 正向或不支持能力的断言；原生测试传输不可用时失败，不跳过。

```sh
DSH_TEST_VERSION=0.1.7-rc.1 pnpm test:cli
DSH_TEST_VERSION=0.1.7-rc.1 pnpm test:browser
DSH_TEST_VERSION=0.1.7-rc.2 pnpm test:cli
DSH_TEST_VERSION=0.1.7-rc.2 pnpm test:browser
DSH_TEST_VERSION=0.2.0-rc.1 pnpm test:cli
DSH_TEST_VERSION=0.2.0-rc.1 pnpm test:browser
DSH_TEST_VERSION=0.2.0-rc.2 pnpm test:cli
DSH_TEST_VERSION=0.2.0-rc.2 pnpm test:browser
DSH_TEST_VERSION=0.2.1-alpha.1 pnpm test:cli
DSH_TEST_VERSION=0.2.1-alpha.1 pnpm test:browser
DSH_TEST_VERSION=0.2.1-alpha.2 pnpm test:cli
DSH_TEST_VERSION=0.2.1-alpha.2 pnpm test:browser
DSH_TEST_VERSION=0.2.1-alpha.3 pnpm test:cli
DSH_TEST_VERSION=0.2.1-alpha.3 pnpm test:browser
DSH_TEST_VERSION=0.2.1-alpha.4 pnpm test:cli
DSH_TEST_VERSION=0.2.1-alpha.4 pnpm test:browser
pnpm test:cli
pnpm test:browser
```

浏览器测试把浅色／深色、桌面／窄屏截图保存在 `.cache/ui-review/<version>`，供人工检查。安全页的 CSS 在插件生效时注入、销毁时移除，所有选择器只作用于插件页面，并直接引用宿主 `--dsw-*` 主题变量。独立登录页使用 dsh 0.2.0-rc.1 的主题变量子集并跟随系统配色，不读取登录前不可用的宿主设置。

官方账号专项测试使用本地平台替身与真实 DSH `0.2.1-rc.2` 账号提供者，验证兑换保留原始 redirect URI 和 PKCE verifier，以及错误 state/URL/会话、重复提交、取消、过期和重试。浏览器覆盖账号菜单与引导中的先说明弹窗、回环导航失败后粘贴确认、弹窗拦截、动态语言与浅深色响应式布局。这些测试不会建立真实官方账号授权。

账号核心测试从锁定的开发依赖加载精确版本提供者，无需预先存在 CLI 运行时缓存；浏览器测试仍使用隔离 DSH profile 中实际安装的提供者。

此临时适配按 `>=0.2.1-alpha.3`（包含预发布）加必要能力与动态配置准入；完整手动功能回归覆盖 `0.2.1-alpha.3`、`0.2.1-alpha.4`、`0.2.1-alpha.5`、`0.2.1-rc.1`、`0.2.1-rc.2`。DSH `0.1.7-rc.1`、`0.1.7-rc.2`、`0.2.0-rc.1`、`0.2.0-rc.2`、`0.2.1-alpha.1`、`0.2.1-alpha.2` 验证基础认证、完整安全与登录交互、动态配置持久化及手动能力不可用反馈。未来准入不构成已验证声明。支持范围或共享宿主适配变更须以同一最终 tgz 完整运行十一版 CLI、浏览器及 smoke；按下文及发布指南，对每个精确版本使用固定归档运行器的 `--suite cli --suite browser --suite smoke`。运行器恢复已验证 dist、逐 suite 核对 SHA-256，并隔离 smoke 与开发 profile；循环内不能调用重新打包的包装命令。公网回调证据、迁移及退役条件见兼容维护清单的 `DSH-ACCOUNT-001`。

`live-config.spec.ts` 仅观察真实 Loader 的配置引用/fiber、认证/存储实例、锁、监听器及 SSE/WebSocket 连续性，核对实际依赖链并重启验证 profile override；不伪造服务。安全弹窗回归覆盖取消/错误、焦点/键盘、默认及强制 TOTP、一次性备用码复制与会话撤销后跳转保持。任务文档、测试凭证、profile、截图及生成目录不得进入 npm 包。

`account-login.spec.ts` 还在每个声明版本验证真实原生配置 HMR：修改普通字段 `sessionHours` 重建监听器，之后独立 Settings 写入必须等待已有原生事务，而真正嵌套仍被拒绝。在 `0.2.1-alpha.3`、`0.2.1-alpha.4`、`0.2.1-alpha.5`、`0.2.1-rc.1`、`0.2.1-rc.2` 额外修改隔离安装的插件代码，验证原生模块替换后可以重新开启手动登录。测试专用事务探针调用真实 HMR，不替代服务且不进入 npm 包。监听器上下文的最小适配见 `DSH-HMR-001`。受保护远程部署必须按部署指南在 profile 级独立禁用原生监听。两个 RC 的启动回归只破坏隔离插件副本：不兼容的 `engines.dsh` 须使真实 Loader 跳过 bundle，注入插件侧准入范围则须触发其自身运行拒绝。两种情况均须启动失败，且无 TCP、HTTP、readiness 或 WebSocket 回退；不改上游代码、版本或 Loader 审计。

账号配置绑定通过原生 describe 镜像的 `ensure()` API 恢复首次读取失败；已有镜像中的命名空间恢复使用明确注入的 `remote.settings` 传输，并将已接纳值回填到同一镜像。偏好加载期间点击登录会等待共享读取，再按最新接纳的 true/false 值选择入口；加载中不等同于关闭。浏览器回归覆盖首次读取失败、命名空间暂缺，以及两种路由选择的延迟读取。

`0.2.1-rc.2` 原生 Search/Fetch 设置回归使用隔离远程 Host、实际三个设置命名空间和凭据域，覆盖提供者选择、校验/保存错误、刷新/重启持久化以及匿名/撤销会话拒绝。配置地址全部为本地测试地址，提供者请求计数必须为零，不执行付费 Search/Fetch 或真实官方账号操作。源码测试指南说明该验证边界。

启动维护诊断读取已安装插件的精确声明与显式生命周期记录。同一进程每个精确版本/状态仅提示一次，配置及模块 HMR 不重置，新进程重新提示。Legacy 日志包含公告日期与迁移建议；未验证/显式退役输入提示缺少当前支持承诺，正常支持版不增加提示。日期不停止服务，必要 API、包身份或安全失败仍拒绝服务。`dsh-support.test.ts` 使用模拟时钟跨过两个资格日期，账号 HMR 回归还检查真实 legacy 和正常版启动输出。独立 legacy 模块用例将同一候选的 manifest/dist 放入隔离的显式监听目录，使用公开 Loader 插入与 HMR `base/root`；原生默认的 node_modules 排除规则仍保留；没有真实版本登记为已退役。

`browser/host-release.spec.ts` 固定四组真实宿主往返切换：`0.2.1-alpha.4` ↔ `0.2.1-alpha.3`、`0.2.1-alpha.5` ↔ `0.2.1-alpha.4`、`0.2.1-rc.1` ↔ `0.2.1-alpha.5`、`0.2.1-rc.2` ↔ `0.2.1-rc.1`。同一临时 profile/端口保留页面，检查原生版本提示，刷新后核对认证、原会话和持久设置，再恢复起始版本。只有 `0.2.1-alpha.3` 无 release 元数据并显示未解析；其余目的宿主必须显示真实完整版本。不修改上游源码、版本或依赖图元数据。

## 消费固定归档

`pnpm verify:packed` 消费已有 tgz，不构建或打包。先记录 SHA-256，再传入归档、该摘要、精确声明的 DSH 版本及一个或多个 suite：

```sh
sha256sum artifacts/dsh-auth-remote-0.2.0.tgz
pnpm verify:packed --archive artifacts/dsh-auth-remote-0.2.0.tgz --sha256 <recorded-sha256> --dsh-version 0.2.1-rc.2 --suite cli --suite browser --suite smoke
```

运行器验证包名/版本及所选宿主声明，将相同字节放到固定制品路径，仅恢复归档中的 dist，因此 CLI 执行与安装比较都使用这份 dist。不安全 tar 条目、摘要变化、未知选择、零真实用例及 skipped/cancelled/todo 用例均失败。Node 对无匹配用例文件产生的通过占位项不计作真实测试。`--test-name-pattern` 可筛选单个 `cli` 或 `browser` suite，报告明确标记为局部，并包含文件、筛选表达式与实际命令。固定专项不能覆盖其筛选/数量要求，每个必需文件均须注册测试。

| Suite               | 选择范围                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------- |
| `cli`               | 全部 CLI 测试文件                                                                           |
| `browser`           | 全部浏览器测试文件                                                                          |
| `smoke`             | 在新建且带标记的 home 中安装并短暂启动归档                                                  |
| `theme`             | 精确登录/安全主题与窄屏用例（1 个真实测试）                                                 |
| `startup-transport` | `0.2.1-alpha.1`、`0.2.1-alpha.2` 的 startup-compatibility 与 native-transport               |
| `account`           | `0.2.1-alpha.3` 的 startup-compatibility、account-login 与 live-config                      |
| `host-release`      | `0.2.1-alpha.4`、`0.2.1-alpha.5`、`0.2.1-rc.1`、`0.2.1-rc.2` 的真实往返切换（1 个真实测试） |
| `rc-bootstrap`      | `0.2.1-rc.1` 的 host-release 与 dsh-bootstrap（2 个真实测试）                               |

同一 checkout 的消费以锁保证串行。每个 suite 结束均重新校验输入归档、固定消费归档及恢复的 dist。JSON 报告和测试日志保留在 `.cache/verify-packed/`。smoke 直接在 `.cache/v-*` 新建带内部标记的短目录，确保默认 GitHub 检出路径下的管理 socket 不超过 Linux 路径上限；使用独立 runtime/home，以 `--port 0` 启动，仅读取该子进程公布的实际回环地址，并在相同 profile 检查在线 CLI 状态。既有 `.dev/dsh-home` 和 13090 上的服务保持独立，只清理本次新建的验证根目录。`DSH_VERIFY_ROOT` 是内部入口，拒绝无标记、符号链接及外部路径；普通开发命令保留原有 profile 和端口。

## 普通与全量 CI 计划

`scripts/ci-plan.mjs` 仅在全部变更路径均为 `CHANGELOG.md`、`CHANGELOG.zh-CN.md`、`CONTRIBUTING.md`、`CONTRIBUTING.zh-CN.md`、`LICENSE` 或 `tests/unit/i18n.test.ts` 时选择普通计划。其他任何路径均全量，包括源码、共享测试/helper、package/lock/构建脚本、工作流、README、支持规范与兼容库存。重命名/复制、未知状态、空或不完整差异、异常/有未提交变更的检出也全量。PR 比较真实事件 base/head 并核对合并父提交，push 比较 before/after；缺少提交证据回退全量。

手动运行、未知事件、每次发布及 UTC 周一 00:00 的定时检查固定全量。首次十一版同包全量成功后才启用普通缩减。所有计划保留全部十一版 CLI/smoke；普通 browser 矩阵固定如下：

| 精确 DSH 版本   | 普通 browser 选择                  |
| --------------- | ---------------------------------- |
| `0.1.7-rc.1`    | `browser`（完整）                  |
| `0.1.7-rc.2`    | `theme`                            |
| `0.2.0-rc.1`    | 不单列 browser job，保留 CLI/smoke |
| `0.2.0-rc.2`    | `browser`（完整）                  |
| `0.2.1-alpha.1` | `startup-transport`                |
| `0.2.1-alpha.2` | `startup-transport`                |
| `0.2.1-alpha.3` | `account`                          |
| `0.2.1-alpha.4` | `host-release`                     |
| `0.2.1-alpha.5` | `host-release`                     |
| `0.2.1-rc.1`    | `rc-bootstrap`                     |
| `0.2.1-rc.2`    | `browser`（完整，含搜索设置）      |

共享工作流先验证所选矩阵的精确内容。显式计划未安排的组合不生成 job；意外 skipped/cancelled 或必需文件零用例使聚合失败。`CI Verify` 要求 plan、producer 和共用验证全部成功。高风险变更及每次发布仍须对同包执行全部 browser。单个 checkout 的固定端口测试保持串行；本地并发 job 须具备独立源码/dist/制品/runtime/profile 树、各自复制的 node_modules 与网络命名空间。pnpm exec 会刷新命令入口，因此 worker 须使用自己的可写依赖副本。共享的源依赖目录只读保护，并使用复制安装避免共享 HMR inode 变化。
