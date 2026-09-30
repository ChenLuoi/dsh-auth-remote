# dsh-auth-remote

[English](README.md)

DeepSeek Harness（DSH）的单用户远程登录插件，提供密码、TOTP、一次性备用码和可撤销会话。插件运行在 DSH 进程内，保护浏览器页面、API、流式响应和 WebSocket。

## 前置条件

- Linux（含 `/proc`）、Node.js 24 或更高版本，以及已测试的 DSH **0.1.7-rc.1**、**0.1.7-rc.2**、**0.2.0-rc.1** 或 **0.2.0-rc.2**（默认）运行时。仅从源码构建时需要 pnpm 12.5.1。
- DSH 默认的 `~/.dsh` 数据目录和 `web` profile。账号状态属于该 profile，不与其他 profile 共用。
- 源码浏览器测试先执行 `pnpm exec playwright install chromium`。测试使用 Playwright 管理的浏览器和专用自签 TLS 夹具。

## DSH 兼容性

插件 0.1.3 已测试 DSH **0.1.7-rc.1**、**0.1.7-rc.2**、**0.2.0-rc.1** 和 **0.2.0-rc.2**，默认支持运行时为 **0.2.0-rc.2**。宿主 peer 声明和运行时版本检查统一使用 `>=0.1.7-rc.1`，不设版本上限。DSH 的加载器检查包含预发布版本，因此 0.2 及后续版本无需逐版豁免，也无需仅为放宽版本范围而更新插件。

后续版本属于向前准入，并不宣称已经逐版测试。插件仍检查必需的 WebServer／Connection 接口、宿主包实例一致性和原生认证交换。若这些约定改变，认证入口会保持不可用并给出诊断；取消版本上限不能保证未知接口变更后的兼容性。CI 在上述四个版本上运行 CLI、安装冒烟和浏览器回归。

插件 **0.1.3** 将 DSH 0.2.0-rc.2 设为默认已验证运行时。无版本上限的兼容范围和主题集成从插件 **0.1.2** 开始提供。源码构建参见[开发指南](docs/development.zh-CN.md)。

## 从 npm 安装

安装 DSH 后，核对版本并把已发布的插件安装到默认 `web` profile：

```sh
dsh --version
dsh plugin --profile web add dsh-auth-remote@0.1.3
dsh plugin --profile web list
```

确认 `dsh --version` 输出 `0.2.0-rc.2`（或上文列出的其他已测试版本），且插件列表中有 `dsh-auth-remote@0.1.3`。这些命令使用 DSH 默认数据目录。源码构建及隔离开发运行时参见[开发指南](docs/development.zh-CN.md)。

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

插件复用 DSH 的 WebServer、Connection、设置 slot、官方工作区浏览与预览。一个账号及其会话存储在 profile 的私有 JSON 文件中；无需独立身份服务。检查和边界参见[开发](docs/development.zh-CN.md)与[部署](docs/deployment.zh-CN.md)。变更记录见[更新日志](CHANGELOG.zh-CN.md)；参与项目可阅读[贡献指南](CONTRIBUTING.zh-CN.md)、[发布指南](docs/releasing.zh-CN.md)及 [MIT 协议](LICENSE)。
