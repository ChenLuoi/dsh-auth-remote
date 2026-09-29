# 开发指南

[English](development.md)

开发和完整测试需要 Linux（profile 锁依赖 `/proc`）、Node.js 24+、pnpm 12.5.1，以及 DSH `0.2.0-rc.1`。浏览器测试使用 Playwright 管理的 Chromium 和 Node HTTP/HTTPS 转发器。

## 准备和检查源码检出

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm check
pnpm pack:local
pnpm smoke
```

`pnpm check` 依次执行类型、格式、构建、包/部署/文档检查，以及单元、集成、CLI 和浏览器测试。`pnpm pack:local` 在静态检查后写出 `artifacts/dsh-auth-remote-0.1.1.tgz`，不会发布。`pnpm smoke` 将包安装到隔离 DSH_HOME，短暂启动固定版本的 DSH，验证就绪、匿名重定向/拒绝和在线 CLI 状态，然后停止。

## 使用隔离开发 profile

```sh
pnpm dev:prepare
pnpm dev:install
pnpm dev:start
```

脚本只管理当前源码目录下的 `.dev/runtime-<version>` 和 `.dev/dsh-home`，默认监听 `127.0.0.1:13090`。终端的 `DSH_HOME` 若指向其他位置，或开发路径为符号链接，脚本会拒绝执行。即使版本号不变，`dev:install` 也会重建并安装当前压缩包。`dev:start` 在前台运行，Ctrl+C 停止。可在另一个终端执行 `pnpm dev` 监听源码，但重建后仍需重新 `dev:install` 并重启 `dev:start` 才会载入新包。

直接查看状态时显式使用同一隔离 home：

```sh
DSH_HOME="$PWD/.dev/dsh-home" "$PWD/.dev/runtime-0.2.0-rc.1/node_modules/.bin/dsh" plugin --profile web exec dsh-auth-remote status --json
```

开发 home 可能含测试账号数据，须保持私有，不要提交或复制到部署 profile。

## 测试边界

`pnpm test:unit` 覆盖认证状态机、TOTP、备用码、来源策略、翻译、存储持久性和锁恢复。`pnpm test:integration` 使用真实 HTTP/WebSocket socket 验证原生就绪、Cookie、来源判定与撤销。`pnpm test:cli` 构建真实压缩包，并用隔离 profile/Unix socket 验证交互与非交互命令。`pnpm test:browser` 用临时 profile 启动所选的 DSH 版本，验证登录、安全页、原生设置、工作区、上传/预览、SSE、WebSocket 和 HTTPS 转发链。

浏览器网络链路使用 Node HTTP/HTTPS 转发器。`tests/fixtures/tls/` 下的专用自签证书与私钥仅为测试夹具，不进入安装包，也不是部署凭证。聊天使用本地模型替身；不执行真实第三方授权或付费模型请求。默认浏览器为 Playwright Chromium；`DSH_TEST_BROWSER` 可选择本地浏览器程序，`DSH_TEST_BIN` 仅在报告所选精确版本（默认 `0.2.0-rc.1`）时可替换 DSH 二进制。

DSH 测试运行时位于 `.cache/test-runtime/<version>`，与源码依赖分别固定。宿主服务和 React 不打入客户端 bundle。[部署指南](deployment.zh-CN.md)说明 profile 与备份规则。

## 跨版本验证

默认测试 DSH `0.2.0-rc.1`；`DSH_TEST_VERSION` 可选择 `0.1.7-rc.1`、`0.1.7-rc.2` 或 `0.2.0-rc.1`，测试运行时分别位于 `.cache/test-runtime/<version>`，开发运行时位于 `.dev/runtime-<version>`。`DSH_TEST_BIN` 必须报告所选的精确版本。CI 对三个版本分别运行 CLI、安装冒烟和浏览器测试。开发类型和集成测试使用锁定的 0.2.0-rc.1 包。

```sh
DSH_TEST_VERSION=0.1.7-rc.1 pnpm test:cli
DSH_TEST_VERSION=0.1.7-rc.1 pnpm test:browser
DSH_TEST_VERSION=0.1.7-rc.2 pnpm test:cli
DSH_TEST_VERSION=0.1.7-rc.2 pnpm test:browser
pnpm test:cli
pnpm test:browser
```

浏览器测试把浅色／深色、桌面／窄屏截图保存在 `.cache/ui-review/<version>`，供人工检查。安全页的 CSS 在插件生效时注入、销毁时移除，所有选择器只作用于插件页面，并直接引用宿主 `--dsw-*` 主题变量。独立登录页使用 dsh 0.2.0-rc.1 的主题变量子集并跟随系统配色，不读取登录前不可用的宿主设置。
