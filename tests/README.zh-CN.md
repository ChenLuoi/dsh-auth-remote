# 测试指南

[English](README.md)

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

脚本把 DSH `0.2.1-alpha.3` 准备到 `.cache/test-runtime/<version>`，并创建临时 `DSH_HOME`。`DSH_TEST_BIN` 只有在可执行文件的 `--version` 精确报告所选的 `DSH_TEST_VERSION`（默认 `0.2.1-alpha.3`） 时才能覆盖；`DSH_TEST_BROWSER` 可覆盖 Playwright 浏览器程序。默认使用 Playwright 管理的 Chromium。

CI 的 CLI/smoke 和浏览器任务覆盖 `0.1.7-rc.1`、`0.1.7-rc.2`、`0.2.0-rc.1`、`0.2.0-rc.2`、`0.2.1-alpha.1`、`0.2.1-alpha.2`、`0.2.1-alpha.3`。用 `DSH_TEST_VERSION=<version>` 选择版本。启动测试经过真实 Loader，观测模型侧 Web 提示（DSH `0.2.1-alpha.3` 改为运行时上下文）和 `DSH_WEB_URL`；原生传输测试在 DSH `0.2.1-alpha.2`、`0.2.1-alpha.3` 执行 IPv4/IPv6 HTTP/HTTPS 和确认后的 CLI 撤销，DSH `0.1.7-rc.1`、`0.1.7-rc.2`、`0.2.0-rc.1`、`0.2.0-rc.2`、`0.2.1-alpha.1` 断言 IPv6/TLS 不支持错误。IPv6 或 TLS 测试环境缺失会使测试失败。

`tests/helpers/` 的 Node HTTP/HTTPS 转发器代替本地代理安装。`tests/fixtures/tls/` 包含 `.test` 主机名专用自签测试证书和私钥；它们不是安装或生产凭证，不进入压缩包。浏览器聊天使用本地模型替身，无需真实外部账号、OAuth token 或付费模型请求。

[TLS fixture 说明](fixtures/tls/README.md)记录原生监听证书的 IPv4/IPv6 SAN、Node 信任和浏览器公钥 pin。转发器也验证 TLS upstream，覆盖 HTTPS→HTTP 和 HTTP→原生 HTTPS 两种代理链。

不要让这些命令指向现有账号目录。浏览器和 CLI 夹具使用独立临时 home；`pnpm smoke` 使用带标记的 `.dev/dsh-home`。[开发指南](../docs/development.zh-CN.md)说明隔离开发流程，[部署指南](../docs/deployment.zh-CN.md)说明正式 profile 与备份步骤。

登录与官方账号浏览器夹具在 DSH 运行时环境中清除继承的 `DEEPSEEK_API_KEY`，避免继承的 DeepSeek API Key 掩盖全新 profile 的引导。API Key 设置 helper 在 DSH `0.2.1-alpha.3` 账号弹窗中选择原生凭据入口；插件设置持久化检查也会在显式刷新页面后处理引导弹窗。

`integration/account-login.test.ts` 使用实际安装的 DSH `0.2.1-alpha.3` 账号提供者和本地平台替身，覆盖 PKCE、redirect URI 一致性、state、回调解析、会话归属、单次提交、取消、过期与重试。`browser/account-login.spec.ts` 验证先说明再授权、回环导航失败后粘贴完成、弹窗拦截和双语响应式主题；DSH `0.1.7-rc.1`、`0.1.7-rc.2`、`0.2.0-rc.1`、`0.2.0-rc.2`、`0.2.1-alpha.1`、`0.2.1-alpha.2` 验证启动、设置入口与手动回填未启用。全程不使用真实官方账号。
