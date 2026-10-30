# dsh-auth-remote

[English](README.md)

DeepSeek Harness（DSH）的单用户远程登录插件，提供密码、TOTP、一次性备用码和可撤销会话。插件运行在 DSH 进程内，保护浏览器页面、API、流式响应和 WebSocket。

## 前置条件

- Linux（含 `/proc`）和 Node.js 24 或更高版本。推荐的 DSH `0.2.2-alpha.2` 要求 Node.js `>=24.9.0`。
- 一个受支持的 DSH 版本和 `web` profile。一个账号及其会话属于该 profile。

## DSH 兼容性

插件 **`0.3.3`** 支持以下精确 DSH 版本，推荐使用 **`0.2.2-alpha.2`**。

| DSH 版本        | 维护状态       |
| --------------- | -------------- |
| `0.2.1-alpha.3` | Legacy；支持中 |
| `0.2.1-alpha.4` | Legacy；支持中 |
| `0.2.1-alpha.5` | Legacy；支持中 |
| `0.2.1-rc.1`    | 支持中         |
| `0.2.1-rc.2`    | 支持中         |
| `0.2.1-rc.3`    | 支持中         |
| `0.2.1-rc.4`    | 支持中         |
| `0.2.1-rc.5`    | 支持中         |
| `0.2.2-alpha.2` | 推荐版本       |

Legacy 版本在明确发布退役版本前继续支持，详见[支持规范](docs/support-policy.zh-CN.md)。更新版本可通过能力检查后加载，但不在上述精确兼容声明内。

## 安装

```sh
dsh --version
dsh plugin --profile web add dsh-auth-remote@0.3.3
dsh plugin --profile web list
```

安装、初始化和运行服务须使用相同的数据目录及 profile。这些命令使用 DSH 默认的 `~/.dsh` 目录和 `web` profile。

## 初始化账号

在真实交互终端中执行：

```sh
dsh plugin --profile web exec dsh-auth-remote init
```

输入一个用户名和 12–256 个 Unicode 字符的密码。密码不会回显，也不作为命令行参数传递。账号只能通过 CLI 创建。

默认 `requireTotp: false`，首次密码登录可选择绑定或跳过 TOTP；设为 `true` 可强制绑定。显示十个备用码时立即妥善保存：每个只能用一次，之后不能重新查看列表。

## 配置 web profile

最小化本机配置无需修改 profile 补丁：

```sh
dsh web --no-open --port 13090
```

打开终端打印的 `http://127.0.0.1:13090/` 地址。未登录导航会跳转登录页。未显式设置 `publicUrl` 时，插件根据监听的实际地址、协议和绑定端口生成根地址。`/auth-remote/ready` 用于检查服务是否就绪。

公网访问请按[部署指南](docs/deployment.zh-CN.md)和 [profile 示例](examples/web-profile-auth-remote.patch.yml)配置顶层 `publicUrl: https://dsh.example.com/`、`host`、`port`，并按示例在 profile 补丁中独立禁用原生 `webserver`。

监听支持具体 IPv4/IPv6 地址、HTTP，以及通过成对 `tlsCert`/`tlsKey` 配置的 HTTPS。`publicUrl` 必须是 HTTP(S) 根地址，不能带凭据、子路径、查询或片段；准入范围是唯一公开来源加字面回环地址。配置此值不会配置路由或 TLS。CLI 的监听和公开 URL 参数覆盖 profile 值。下游路由若需要原始公网 Host，按部署指南配置 `preserveOriginPaths`。

## 登录与账号管理

打开本机根地址或配置的公开 URL。在 DSH 侧栏账号菜单中进入 **设置 → 安全与登录**，即可查看本插件用户名、TOTP 状态、会话到期时间和有效会话数，修改密码、绑定或重新绑定 TOTP、在策略允许时关闭 TOTP，以及撤销会话。

密码或第二因素变更会撤销已有会话。会话默认固定有效 168 小时（`sessionHours`），服务重启后仍保留。退出当前会话会保留其他会话；退出所有会话需验证密码及已绑定的第二因素。TOTP 绑定成功后仅展示一次备用码，请保存并确认后重新登录。

也可通过命令管理：

```sh
dsh plugin --profile web exec dsh-auth-remote status --json
dsh plugin --profile web exec dsh-auth-remote reset-password
dsh plugin --profile web exec dsh-auth-remote reset-totp
dsh plugin --profile web exec dsh-auth-remote revoke-sessions
```

修改命令需要交互确认。命令提交后若响应丢失，先检查 `status`，再决定是否重试。

浏览器文案支持英、中、日、西、法、德、俄和巴西葡萄牙语。内嵌页面跟随 DSH 语言设置；独立登录页依次使用已记住的 DSH 偏好、浏览器语言、英文，不提供语言选择器。CLI 文案固定英语。

## 登录 DeepSeek 官方账号

远程 DeepSeek 账号登录默认开启（`manualAccountLogin: true`）：

1. 在账号菜单中选择“登录”，再点击步骤说明弹窗中的“打开登录页”。
2. 在新标签页完成官方登录。随后回环地址可能显示连接失败或 404，该页面无需正常打开。
3. 复制包含 `code` 和 `state` 的完整回调 URL，粘贴到原 DSH 标签页的“完整回调地址”，再点击“确认登录”。

整个过程中保留原 DSH 标签页。弹窗被浏览器拦截时，可使用弹窗内的授权链接。无需本地监听器、SSH 隧道或浏览器扩展；插件在 DSH 内部分发回调，不会请求粘贴的地址。授权十分钟后过期，关闭弹窗或撤销发起授权的会话会取消本次授权；过期或失败后须重新开始。

授权开始前，“使用 API Key”会打开 DSH 原生凭据编辑器，账号菜单中也有同一入口；授权进行中时，次要按钮用于取消本次授权。

**设置 → 安全与登录 → 登录配置** 中的开关控制新的手动授权，并保存在 profile 中。关闭后恢复原生登录入口，保留进行中的授权和已有官方账号凭据。原生登录仍要求浏览器能够访问回调地址。

## 接入反向代理

参见[反向代理指南](docs/reverse-proxy.zh-CN.md)以及 [Nginx](examples/nginx.conf) 或 [Traefik](examples/traefik-dsh.yml) 示例。保留浏览器原始 Host、Origin、WebSocket 升级和流式响应。TLS 可在代理终止；将其精确 HTTPS 根地址设为 `publicUrl`。保持 DSH 监听私有，不要缓存认证响应。

## 文档

[部署指南](docs/deployment.zh-CN.md)介绍配置、profile 备份和运维细节；从源码构建与测试请阅读[开发指南](docs/development.zh-CN.md)。变更见[更新日志](CHANGELOG.zh-CN.md)，参与项目请阅读[贡献指南](CONTRIBUTING.zh-CN.md)和[发布指南](docs/releasing.zh-CN.md)。项目采用 [MIT 协议](LICENSE)。
