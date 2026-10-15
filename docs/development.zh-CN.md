# 开发指南

[English](development.md)

开发和完整测试需要 Linux（profile 锁依赖 `/proc`）、Node.js 24+、pnpm 12.5.1，以及 DSH `0.2.1-alpha.3`。浏览器测试使用 Playwright 管理的 Chromium 和 Node HTTP/HTTPS 转发器。

兼容声明或适配变更前，先阅读 [Legacy 兼容维护清单](legacy-compatibility.zh-CN.md)。共同复核运行时准入、测试目标、CI 和用户声明；适用版本退出支持集合时同次清理专属运行时代码及测试。旧插件配置按自身迁移策略退役，保留共享安全逻辑，并用完整版本号与精确版本证据同步更新中英文清单及两个维度的矩阵。

## 准备和检查源码检出

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm check
pnpm pack:local
pnpm smoke
```

`pnpm check` 依次执行类型、格式、构建、包/部署/文档检查，以及单元、集成、CLI 和浏览器测试。`pnpm pack:local` 在静态检查后写出 `artifacts/dsh-auth-remote-0.1.9.tgz`，不会发布。`pnpm smoke` 将包安装到隔离 DSH_HOME，短暂启动固定版本的 DSH，验证就绪、匿名重定向/拒绝和在线 CLI 状态，然后停止。

## 使用隔离开发 profile

```sh
pnpm dev:prepare
pnpm dev:install
pnpm dev:start
```

脚本只管理当前源码目录下的 `.dev/runtime-<version>` 和 `.dev/dsh-home`，默认监听 `127.0.0.1:13090`。终端的 `DSH_HOME` 若指向其他位置，或开发路径为符号链接，脚本会拒绝执行。即使版本号不变，`dev:install` 也会重建并安装当前压缩包。`dev:start` 在前台运行，Ctrl+C 停止。可在另一个终端执行 `pnpm dev` 监听源码，但重建后仍需重新 `dev:install` 并重启 `dev:start` 才会载入新包。

直接查看状态时显式使用同一隔离 home：

```sh
DSH_HOME="$PWD/.dev/dsh-home" "$PWD/.dev/runtime-0.2.1-alpha.3/node_modules/.bin/dsh" plugin --profile web exec dsh-auth-remote status --json
```

开发 home 可能含测试账号数据，须保持私有，不要提交或复制到部署 profile。

## 测试边界

`pnpm test:unit` 覆盖认证状态机、TOTP、备用码、来源策略、翻译、存储持久性和锁恢复。`pnpm test:integration` 使用真实 HTTP/WebSocket socket 验证原生就绪、Cookie、来源判定与撤销。`pnpm test:cli` 构建真实压缩包，并用隔离 profile/Unix socket 验证交互与非交互命令。`pnpm test:browser` 用临时 profile 启动所选的 DSH 版本，验证登录、安全页、原生设置、工作区、上传/预览、SSE、WebSocket 和 HTTPS 转发链。

浏览器网络链路使用 Node HTTP/HTTPS 转发器。`tests/fixtures/tls/` 下的专用自签证书与私钥仅为测试夹具，不进入安装包，也不是部署凭证。聊天使用本地模型替身；不执行真实第三方授权或付费模型请求。默认浏览器为 Playwright Chromium；`DSH_TEST_BROWSER` 可选择本地浏览器程序，`DSH_TEST_BIN` 仅在报告所选精确版本（默认 `0.2.1-alpha.3`）时可替换 DSH 二进制。

DSH 测试运行时位于 `.cache/test-runtime/<version>`，与源码依赖分别固定。宿主服务和 React 不打入客户端 bundle。[部署指南](deployment.zh-CN.md)说明 profile 与备份规则。

隔离验证安装使用 pnpm 的文件复制模式，避免不同 profile 共享包文件的硬链接元数据变化触发 DSH 客户端热重载。

## 跨版本验证

默认测试 DSH `0.2.1-alpha.3`；`DSH_TEST_VERSION` 可选择 `0.1.7-rc.1`、`0.1.7-rc.2`、`0.2.0-rc.1`、`0.2.0-rc.2`、`0.2.1-alpha.1`、`0.2.1-alpha.2` 或 `0.2.1-alpha.3`，测试运行时分别位于 `.cache/test-runtime/<version>`，开发运行时位于 `.dev/runtime-<version>`。`DSH_TEST_BIN` 必须报告所选的精确版本。CI 对七版分别运行 CLI、安装冒烟和浏览器测试。开发类型和集成测试使用锁定的 DSH `0.2.1-alpha.3` 包。源码检出目录的测试指南（`tests/README.zh-CN.md`）说明真实 Loader/模型地址核对，以及原生 IPv6/TLS 正向或不支持能力的断言；原生测试传输不可用时失败，不跳过。

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
pnpm test:cli
pnpm test:browser
```

浏览器测试把浅色／深色、桌面／窄屏截图保存在 `.cache/ui-review/<version>`，供人工检查。安全页的 CSS 在插件生效时注入、销毁时移除，所有选择器只作用于插件页面，并直接引用宿主 `--dsw-*` 主题变量。独立登录页使用 dsh 0.2.0-rc.1 的主题变量子集并跟随系统配色，不读取登录前不可用的宿主设置。

官方账号专项测试使用本地平台替身与真实 DSH `0.2.1-alpha.3` 账号提供者，验证兑换保留原始 redirect URI 和 PKCE verifier，以及错误 state/URL/会话、重复提交、取消、过期和重试。浏览器覆盖账号菜单与引导中的先说明弹窗、回环导航失败后粘贴确认、弹窗拦截、动态语言与浅深色响应式布局。这些测试不会建立真实官方账号授权。

账号核心测试从锁定的开发依赖加载精确版本提供者，无需预先存在 CLI 运行时缓存；浏览器测试仍使用隔离 DSH profile 中实际安装的提供者。

此临时适配仅在精确 `0.2.1-alpha.3` 启用，完整功能回归只针对该版本；DSH `0.1.7-rc.1`、`0.1.7-rc.2`、`0.2.0-rc.1`、`0.2.0-rc.2`、`0.2.1-alpha.1`、`0.2.1-alpha.2` 只需验证启动、设置入口与功能未启用，无需因该专项重跑七版完整矩阵。支持范围或共享宿主适配变更仍须完整矩阵，CI 目标不变。后续版本默认使用原生流程；公网回调证据、迁移及退役条件见兼容维护清单的 `DSH-ACCOUNT-001`。
