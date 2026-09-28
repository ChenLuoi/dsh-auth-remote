# dsh-auth-remote

[English](README.md)

DeepSeek Harness（DSH）的单用户远程登录插件，提供密码、TOTP、一次性备用码和可撤销会话。插件运行在 DSH 进程内，保护浏览器页面、API、流式响应和 WebSocket。

## 前置条件

- Linux（含 `/proc`）、Node.js 24 或更高版本、pnpm 12.5.1，以及已测试的 DSH **0.1.7-rc.1** 运行时。
- DSH 默认的 `~/.dsh` 数据目录和 `web` profile。账号状态属于该 profile，不与其他 profile 共用。
- 浏览器测试先执行 `pnpm exec playwright install chromium`。测试使用 Playwright 管理的浏览器和专用自签 TLS 夹具。

## 从源码最小化本地安装

在源码检出目录执行：

```sh
pnpm install --frozen-lockfile
pnpm pack:local
dsh --version
dsh plugin --profile web add "$PWD/artifacts/dsh-auth-remote-0.1.0.tgz"
```

确认 `dsh --version` 输出 `0.1.7-rc.1`。在源码目录运行命令，使 `$PWD` 指向生成的压缩包；DSH 会在 profile 目录执行插件安装。`pnpm pack:local` 只构建、检查本地压缩包，不发布。这些 `dsh` 命令使用默认数据目录。需要隔离开发运行时时可执行 `pnpm dev:prepare`；参见[开发指南](docs/development.zh-CN.md)。

## 配置 web profile

安装后的 bundle 提供认证监听，默认 `allowedOrigins: []`，因此只准入字面回环主机。最小安装无需修改 profile 补丁。用 `dsh web --no-open --port 13090` 启动，使用终端打印的 `http://127.0.0.1:13090` 地址；未登录的浏览器访问会跳转到登录页。使用监听前检查 `/auth-remote/ready`。启动输出包含监听地址和已配置的公网来源，不含原生 `?token=` 地址。

公网 HTTPS 入口请使用[部署指南](docs/deployment.zh-CN.md)的完整 profile 配置及步骤。可复用的 [profile 示例](examples/web-profile-auth-remote.patch.yml)登记 `https://dsh.example.com`，并建议在 profile 中独立禁用原生监听。开放代理前须一致地替换示例主机名和端口。

下游路由若需要原始公网 Host，可把其路径加入 `preserveOriginPaths`。bundle 会根据 `allowedOrigins` 自动配置原生 Connection 的信任地址，无需在 profile 中另写 Connection 条目。

## 初始化账号

在真实交互终端中，使用与服务**相同**的默认 `web` profile：

```sh
dsh plugin --profile web exec dsh-auth-remote init --lang zh
```

输入一个用户名和 12–256 个 Unicode 字符的密码。密码不作为命令行参数传递，也不会回显。未初始化时登录页会提示该命令，但网页不能创建账号。默认 `requireTotp: true`，首次密码登录必须绑定身份验证器。显示十个备用码时立即妥善保存：每个只能用一次，之后不能重新查看列表。

## 登录与账号管理

最小化安装时访问本机回环地址；配置公网入口后访问 `https://dsh.example.com/auth-remote/login`。DSH 内的安全设置可以修改密码、绑定 TOTP、在策略允许时关闭 TOTP，以及撤销会话。密码或第二因素变更会撤销已有会话。会话默认固定有效 168 小时，服务重启后仍保留。

```sh
dsh plugin --profile web exec dsh-auth-remote status --json
dsh plugin --profile web exec dsh-auth-remote reset-password --lang zh
dsh plugin --profile web exec dsh-auth-remote reset-totp --lang zh
dsh plugin --profile web exec dsh-auth-remote revoke-sessions --lang zh
```

修改命令需要交互确认。在线命令走私有 Unix socket；离线命令取得同一 profile 锁。如果管理请求已提交但响应丢失，先运行 `status` 再判断是否重试。`status --json` 的机器字段不随语言变化。

内嵌安全页跟随 DSH 语言设置。独立登录页默认英文，仅在 `localStorage["dsh-auth-remote.locale"]` 保存 `en` 或 `zh`，登录前不读取 DSH 设置。CLI 人类文案由 `--lang en|zh` 指定；未指定时取首个非空的 `LC_ALL`、`LC_MESSAGES`、`LANG`（中文变体为 `zh`，其他为英文）。

## 接入反向代理

参见[反向代理指南](docs/reverse-proxy.zh-CN.md)以及 [Nginx](examples/nginx.conf) 或 [Traefik](examples/traefik-dsh.yml) 示例。保留浏览器原始 Host、Origin、WebSocket 升级和流式响应。TLS 可在代理终止，但 `allowedOrigins` 必须登记精确的 HTTPS 来源。保持 DSH 监听私有，且不要缓存认证响应。

## 项目与维护

插件复用 DSH 的 WebServer、Connection、设置 slot、官方工作区浏览与预览。一个账号及其会话存储在 profile 的私有 JSON 文件中；无需独立身份服务。检查和边界参见[开发](docs/development.zh-CN.md)与[部署](docs/deployment.zh-CN.md)。
