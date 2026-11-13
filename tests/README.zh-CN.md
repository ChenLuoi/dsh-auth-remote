# 测试指南

[English](README.md)

已发布 `0.3.6` 声明八个精确目标：`0.2.1-rc.1`、`0.2.1-rc.2`、`0.2.1-rc.3`、`0.2.1-rc.4`、`0.2.1-rc.5`、`0.2.2-alpha.3`、`0.2.2-rc.1`、`0.2.2-rc.2`。默认及推荐宿主 `0.2.2-rc.2` 是上游RC预发布，要求Node.js `>=24.9.0`。不可变标签归档已通过完整验收及公开分发核验，见[支持历史](../docs/support-history.zh-CN.md#plugin-0.3.6)；后续每个 CI producer 分别保留自身证据，历史或partial结果不认证修订后的最终归档。

使用带 `/proc` 的Linux、Node.js 24、pnpm 12.5.1和Playwright Chromium：

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm check
```

| 分组   | 开发命令                | 契约                                                                                                             |
| ------ | ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 单元   | `pnpm test:unit`        | 认证、TOTP/备用码、会话、Origin、语言、存储/锁、精确支持、consumer/归档/索引与workflow拒绝                       |
| 集成   | `pnpm test:integration` | 真实HTTP/WebSocket、原生就绪、cookie、变更/撤销、原生账号PKCE、资源流式响应/背压                                 |
| CLI    | `pnpm test:cli`         | 真实归档/profile执行、私有终端输入、固定英语、profile访问前拒绝--lang、稳定JSON、Unix socket、离线锁及不确定结果 |
| 浏览器 | `pnpm test:browser`     | 精确原生DSH、匿名/登录/安全/设置/工作区/聊天/上传/预览、SSE/WebSocket、TLS/代理与生命周期                        |

开发CLI/browser包装命令会重建/重打包，最终循环必须使用[固定归档运行器](../docs/development.zh-CN.md#消费固定归档)。`DSH_TEST_VERSION` 只接受上述八版；`DSH_TEST_BIN` 必须报告所选精确版本。`DSH_TEST_BROWSER` 可指定程序，否则使用受管理Chromium。测试runtime位于 `.cache/test-runtime/<version>`，profile临时创建；普通开发/smoke使用 `.dev`，固定归档smoke独占新建且带标记的短 `.cache/v-*`、独立runtime/home和 `--port 0`。不得使用真实账号目录。

runtime采用pnpm copy安装，HMR/故障编辑前核对普通文件nlink=1。`isolatedDshEnv` 仅允许指定Host环境变量，移除真实凭据/端点；浏览器移除环境代理。首次输入测试key前将原生模型baseURL指向本地替身，不预置key、不关闭onboarding。UI用例模型调用为零；代理聊天只允许预期本地聊天/标题POST，fixture关闭时校验意外请求。[TLS夹具指南](fixtures/tls/README.md)说明专用证书、SAN、信任和浏览器pin；私钥/profile/task/截图/证据不入npm。真实IPv4/IPv6 HTTP/HTTPS及Node转发不可用就失败，不静默跳过。

`integration/account-login.test.ts` 使用锁定的真实 `@deepseek-ai/dsh-deepseek-account@0.2.2-rc.2` 和本地Platform，检查PKCE/redirect相等、state/URL/会话归属、一次回调、取消/到期/重试。浏览器使用逐版真实安装provider；观测明确选择旧platform包或合并account包，仅在不存在effectiveConfig访问器的旧宿主回退config，旧宿主保持自己的实际SDK链。

八版均保留完整手动登录/设置：说明优先、失败loopback导航后粘贴确认、弹窗阻止、初始/延迟偏好读取、镜像失败/暂缺、已接纳设置及进行中授权。检查八语实际访问集合、明暗/窄屏、安全概览/弹窗、键盘/焦点、TOTP/备用码复制和退出/撤销后偏好，截图遮蔽秘密。原生语言目录不改；旧locale缓存继续忽略/保留，已发布0.2.0技术拒绝夹具保留历史中文CLI契约。

两个必注册的 `0.2.2-rc.2` 账号用例各准备独立私有原生runtime，保留entry/children/inject/options/disposer归属，执行真实客户端/原生组件源码HMR、true/false、卸载/重装、第三方后写、停用wrapper委托、挂起describe和活动授权取消。本地通知list/content/events覆盖语言和生命周期，外网/模型请求及page errors为零。跨产品通知本地化映射未完全验证；私有观测点和证据边界见[库存](../docs/legacy-compatibility.zh-CN.md) `DSH-ACCOUNT-SLOT-001`。

`live-config.spec.ts` 观测真实Loader引用/fiber、auth/store/锁/监听器和SSE/WebSocket连续性，执行true→false→true→false及重启。`account-login.spec.ts` 以普通sessionHours变更执行真实配置HMR，检查独立Settings排队和真正嵌套拒绝；源码HMR故障先在导入失败时保留原实例，再于替换实例初始化后抛错，核验清理/回滚、锁nonce、mux关闭及恢复保存。canonical file URL、显式watch root及被动公开日志不替代原生HMR服务。

八版 `startup-compatibility.spec.ts` 都只破坏安装插件副本：不兼容engines触发Loader skip且不导入；自身准入范围故障触发导入后拒绝。profile独立禁用原生webserver，进程自然非零退出，TCP/HTTP/readiness/WebSocket均拒绝，上游包身份/依赖图/候选字节不改。七组真实宿主往返、原会话/设置和原生完整版本提示见[跨版本验证](../docs/development.zh-CN.md#跨版本验证)；最低 `0.2.1-rc.1` 无前版用例。

旧Search/Fetch表单适用于 `0.2.1-rc.2`、`0.2.1-rc.3`、`0.2.1-rc.4`、`0.2.1-rc.5`、`0.2.2-alpha.3`、`0.2.2-rc.1`。`0.2.2-rc.2` 的真实原生表单分别选择Search/Fetch auto/account/api-key计费，检查拒绝保存/草稿保留、刷新/重启持久化、凭据保存/替换/移除和响应不回显，以及匿名/撤销401；本地模型/Search/Fetch/外网计数均为零。导航适用 `0.2.1-rc.3`、`0.2.1-rc.4`、`0.2.1-rc.5`、`0.2.2-alpha.3`、`0.2.2-rc.1`、`0.2.2-rc.2`，检查全局/会话/右栏More、原生设置/模型选择及撤销。公开sessions/sessionProjections增加空完成turn，不聊天、不替换snapshot；只看Market/Creator入口，不安装或外部授权，官方动态 `/models` 内部语义未验证。

精确 `0.2.2-alpha.3`、`0.2.2-rc.1`、`0.2.2-rc.2` 保留真实native viewer/index/carrier隔离、资源/fallback/ETag GET/HEAD/304及mux HTTPS/代理/压缩/到期/撤销。传输归原生Gateway/ws。盾牌测试覆盖size/currentColor/选中、明暗/窄屏、贡献释放/默认恢复和声明撤下/重建/卸载；其他五版保留默认图标。viewer不安装管理员效果。

LiveShare是官方已发布、默认关闭的实验性可选插件，本插件不启用它。Owner/Relay产品E2E和专用替身已删除；`business-origin-observer.mjs` 在两个精确Owner POST路径使用真实Connection.fetch，不加载Host/Relay、不以高优先WebServer绕过、不构造Request/waterfall结果。native-transport保留准入、可信外层Origin、单次恢复、原始重复/缺失/错误/cross-site拒绝、HTTP/HTTPS/代理及真实配置HMR。生产适配、共享集成和capability检查保留；产品流程、生产Relay/OAuth、访客模型和文件写入未验证，历史产品报告只属于旧归档。

ordinary/full均完整运行八版CLI/browser/smoke；[白名单](../docs/development.zh-CN.md#普通与全量-ci-计划)只决定额外退役任务。full保留独立 `0.2.1-alpha.2` 技术拒绝，使用已发布0.2.0 baseline验证真实安装回滚和完整不兼容bundle peer skip/无延迟监听。六版历史技术目标只由 `verify-retired.mjs` 选择，不扩大DSH_TEST_VERSION；ordinary跳过该job。

仅已校验插件0.3.6的full/发布额外以 `verify-maintenance-retired.mjs` 验证精确 `0.2.1-alpha.3`、`0.2.1-alpha.4`、`0.2.1-alpha.5`。每版三个真实CLI/HTTP场景检查ready前告警及真实配置/源码HMR后只告警一次、会话连续后撤销、Loader skip、自身导入后拒绝及无监听。`0.2.1-alpha.3` 破坏Host peer，其余两个精确目标破坏engines，只改私有插件副本，原生webserver独立禁用，不启动Chromium。此一发布专项在browser glob之外，不恢复支持；Alpha正向独占分支移除后仍保留通用日期/告警单元。

每个producer记录源码/归档身份；消费者sidecar保留旧report schema，将原始JSON/TAP/日志关联真实CLI、lock、八包SDK链及私有copy receipt。索引按套件要求primary、独立smoke、精确前版及两个private-account runtime；遗漏receipt和引用、摘要/报告不符、混producer、partial均失败。完整套件必注册名还拒绝缺失账号/通知/Search/Origin/viewer/资源/mux/HMR/图标真实用例，逐版显式空文件例外不计作实际用例。CI严格检查成功/预期skip，包外上传原始证据和producer索引；最终发布消费同一归档，循环禁止build/pack。

测试边界为Linux/Node.js 24/Chromium、原生回环IPv4/IPv6 HTTP/HTTPS及既有Node转发。其他平台/浏览器/Node大版本、真实非回环IPv6网卡、Nginx/Traefik二进制、真实外部授权、付费provider及跨产品通知本地化未验证。完整备份、独立profile及匹配宿主/插件/配置/完整数据的回退见[部署指南](../docs/deployment.zh-CN.md)。
