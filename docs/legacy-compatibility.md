# Legacy 兼容维护清单

本清单是人工及本地 AI 修改兼容声明前的唯一维护入口，最后复核日期为 2026-10-10。用户配置指南仍使用中英文版本；不复制英文状态清单，不增加脚本或 CI 门禁。

## 复核与退役规则

修改 `package.json` 的 peers 或 `dsh.compatibility`、运行时准入范围、测试支持列表、CI 矩阵或用户兼容声明前，逐条读取本清单并检查新支持集合。

- `dsh-runtime`：适用版本与新支持集合仍有交集则保留；交集为空时，在修改声明的同一次变更删除专属实现、专属测试并更新清单和指南，不延后清理。共同安全校验和共享测试不属于删除范围。
- `plugin-contract`：按插件自身的迁移政策退役；DSH 支持范围收缩不触发退役。旧 `allowedOrigins` 单项和空数组兼容在 0.1.6 保留，只有未来明确结束旧配置支持时才能删除。
- 证据不足时保留实现，登记缺口和待复核版本，不编造退役阈值。未来版本的准入不等于经过兼容验证。

当前声明和测试目标为 `0.1.7-rc.1`、`0.1.7-rc.2`、`0.2.0-rc.1`、`0.2.0-rc.2`、`0.2.1-alpha.1`、`0.2.1-alpha.2`；默认运行时为 alpha.2。声明和针对性验证不单独证明开发完成，交付须有同一最终产物的六版 CLI/browser/smoke 矩阵与审计确认。本清单维护长期适用范围和退役条件，具体交付证据由执行记录保存。

本次证据沿安装目录中的 DSH 包 → WebApp 包 → 实际依赖包解析，核对 manifest 精确版本；从测试目录直接解析子包可能误用仓库或祖先目录的其他版本。下列上游位置均指对应精确版本的安装包，不使用浮动主分支。

## DSH-HOST-001：旧监听 host/schema 适配

| 字段            | 内容                                                                                                                                                                                                      |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 类型 / 生效状态 | `dsh-runtime` / 现存生效                                                                                                                                                                                  |
| 适用 DSH        | 前五版保留具体 IPv4/schema 适配；alpha.2 原生具体 IP 分支已接入                                                                                                                                           |
| 原因            | 五版 WebServer.Config 仅列 `127.0.0.1` 和 `0.0.0.0`；插件允许具体 IPv4，拒绝通配和非 IPv4，构造函数直接传递监听值                                                                                         |
| 代码 / 上游证据 | `src/config.ts`、`src/adapters/dsh/webserver.ts`；对应包 `@deepseek-ai/dsh-host-webserver/lib/index.js` 的 Config 和 server.listen                                                                        |
| 实现位置        | `src/adapters/dsh/runtime-capabilities.ts` 的旧具体 IPv4 分支及现代原生 Config 校验；生产入口在构造时使用统一 `resolveStartupConfig`，已删除过渡 resolver；GuardedWebServer 接收统一 NativeListenerConfig |
| 关联测试        | `tests/integration/dsh-adapter.test.ts`、`tests/integration/http-gate.test.ts`；`tests/unit/config.test.ts` 六版能力输入表；六个精确安装包 schema/能力已分别核对                                          |
| 客观退役条件    | 所有需要旧 schema 适配的 DSH 均退出支持集合，且精确包证据确认剩余版本具有原生具体 IP 校验                                                                                                                 |
| 删除 / 调整范围 | 仅旧 IPv4/schema 分支与专属拒绝测试；保留通配拒绝、端口检查、身份/API 校验及共同门禁测试                                                                                                                  |
| 最后复核依据    | 2026-10-10，前五版精确 schema 证据保留；alpha.2 真实 IPv4、IPv6、mapped/scoped loopback 和非回环 IPv4 监听通过；无可绑定的非回环 IPv6 接口，仅核对原生 schema 与策略，不据此扩大实测声明                  |

## DSH-PROTOCOL-001：旧原生 HTTP 协议假设

| 字段            | 内容                                                                                                                                                                                                                                                                                                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 类型 / 生效状态 | `dsh-runtime` / 旧版 HTTP 和回环 authority 回退保留；现代原生协议/地址桥接已接入                                                                                                                                                                                                                                                                                           |
| 适用 DSH        | 前五版没有 TLS/原生绑定 authority 识别；alpha.2 使用原生 protocol 和地址归一化                                                                                                                                                                                                                                                                                             |
| 原因            | 前五版 startup 没有 TLS 配置且 Connection 不认识具体非回环 bind，继续使用服务端 HTTP/127.0.0.1 桥接；监听和公开 URL 仍为实际具体 IPv4。现代分支支持 IPv6/HTTPS                                                                                                                                                                                                             |
| 代码 / 上游证据 | `src/adapters/dsh/readiness.ts`、`src/adapters/dsh/browser-auth.ts`、`src/adapters/dsh/startup-urls.ts`、`src/http/gate.ts`；对应 WebApp `lib/startup.js`                                                                                                                                                                                                                  |
| 实现位置        | `listenerProtocol`、`listenerTransport` 集中旧 HTTP/回环回退；现代回环使用原生 normalizeBindAddress/isLoopbackHost，非回环保留 Connection 绑定 authority 的 WHATWG IPv6 形式并去掉 zone；定稿 nativeAuthority/nativeOrigin 供 readiness 和 gate 共用；browser-auth 校验 token URL 协议和 Cookie Secure。外层 Cookie 按公开来源，原生 Cookie 按监听协议                     |
| 关联测试        | `tests/integration/native-transport.test.ts`、`tests/browser/native-transport.spec.ts`、`tests/unit/config.test.ts`、既有 dsh-adapter / proxy-chain；包括旧非回环实际包、旧能力拒绝、两种协议方向代理和流撤销                                                                                                                                                              |
| 客观退役条件    | 所有不提供原生监听协议能力的 DSH 均退出支持集合                                                                                                                                                                                                                                                                                                                            |
| 删除 / 调整范围 | 仅能力适配器内旧 HTTP/回环回退与专属能力测试；保留 HTTP 正向、双向代理、Cookie 和撤销安全回归                                                                                                                                                                                                                                                                              |
| 最后复核依据    | 2026-10-10，rc.1 / alpha.1 真实包非回环绑定曾在统一改写真实 host 后无法激活；恢复旧回环桥接后可认证访问原生设置 API。alpha.2 真实 HTTPS/IPv6 MFA、Host 设置和 CLI 撤销通过；整分支审查发现非回环 mapped IPv6 经 WebServer 归一化后与 Connection 的绑定比较不一致，新增 HTTP/HTTPS、preserveOriginPaths 空数组的实际监听回归。完整六版产物证据由 CLI/browser/smoke 矩阵核对 |

## DSH-PUBLIC-001：旧宿主公开地址投影边界

| 字段            | 内容                                                                                                                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 类型 / 生效状态 | `dsh-runtime` / 上游能力差异现存；能力解析及插件投影已实现，三个能力组真实包验证通过                                                                                                                                                             |
| 适用 DSH        | 前四版无原生 publicUrl；alpha.1 支持，alpha.2 精确包已核实支持                                                                                                                                                                                   |
| 原因            | 前四版没有 `--public-url`，提示和 `DSH_WEB_URL` 保持原生固定 `127.0.0.1` + 实际端口（无末尾斜杠）的行为；不能为旧宿主补造原生 CLI 参数                                                                                                           |
| 代码 / 上游证据 | [cordis.patch.yml](../cordis.patch.yml)、`src/adapters/dsh/startup-urls.ts`；对应 WebApp `lib/startup.js` 和 `lib/index.js`                                                                                                                      |
| 实现位置        | bundle 在 webStartup/webServer 可用后读取 `webServer.publicUrl` 只读属性，alpha.1/2 原生消费最终入口，旧版保留原生提示行为                                                                                                                       |
| 关联测试        | `tests/browser/deployment-profile.spec.ts` 和 `startup-compatibility.spec.ts`；profile 根目录只读 startup-observer 调用原生 systemPrompt.assemble 和 shellEnv.collect，核对 Web 提示与 DSH_WEB_URL，同一最终地址且无 token；三个能力组真实包验证 |
| 客观退役条件    | 所有缺少原生 publicUrl 的 DSH 均退出支持集合                                                                                                                                                                                                     |
| 删除 / 调整范围 | 仅旧版能力分支、原生提示差异和不支持 CLI 参数的专属测试；保留插件唯一入口、来源准入与启动输出测试                                                                                                                                                |
| 最后复核依据    | 2026-10-09，四版精确 startup 无 publicUrl，alpha.1 有该字段；不得伪造旧版支持                                                                                                                                                                    |

## DSH-THEME-001：旧主题 token fallback

| 字段            | 内容                                                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 类型 / 生效状态 | `dsh-runtime` / 现存生效                                                                                                   |
| 适用 DSH        | `0.1.7-rc.1` 缺少 radius-md、radius-lg、focus-ring-color；其他五个已声明版本已提供                                         |
| 原因            | Security 样式需在最旧支持版本保持圆角和键盘焦点可见性                                                                      |
| 代码 / 上游证据 | `src/client/settings/style.css`；精确 `@deepseek-ai/dsh-client-ui-theme/lib` 中 CSS token 定义                             |
| 实现位置        | `var(--dsw-radius-md, ...)`、`var(--dsw-radius-lg, 16px)`、focus-ring 的 business-primary fallback                         |
| 关联测试        | `tests/browser/dsh-bootstrap.spec.ts` 的主题与布局；各版本截图人工复核                                                     |
| 客观退役条件    | `0.1.7-rc.1` 退出支持集合，并确认其余支持版本都有上述 token                                                                |
| 删除 / 调整范围 | 仅上述 var 的 fallback 参数和专属旧主题说明；保留宿主动态主题、布局与共享视觉回归                                          |
| 最后复核依据    | 2026-10-09，五版精确 theme 包 CSS 搜索：rc.1 缺少，rc.2 起均存在；alpha.2 精确 theme 包三个 lib JS 文件的 token 定义均存在 |

## DSH-TEST-001：旧宿主 onboarding 交互

| 字段            | 内容                                                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------------------- |
| 类型 / 生效状态 | `dsh-runtime` / 现存生效，精确适用范围有证据缺口                                                               |
| 适用 DSH        | 六版共享测试 helper；具体 notice 名称、首次保存重载与设置页关闭行为的版本范围待真实 UI 复核                    |
| 原因            | 宿主启动 notice/API Key 提示可能延迟出现；首次保存可能重载页面并关闭设置                                       |
| 代码 / 上游证据 | `tests/helpers/runtime.ts` 的注释和实际交互；不能只由源码字符串推定 UI 生命周期                                |
| 实现位置        | `completeApiKeyPrompt`、`clickThroughDshPrompts` 中 notice 名称与 reopen 处理                                  |
| 关联测试        | `tests/browser/dsh-bootstrap.spec.ts`、`tests/browser/dsh-gate.spec.ts`                                        |
| 客观退役条件    | 真实 UI 复核得到精确适用版本后，交集为空才能删除专属交互；证据缺口未补齐时不得退役                             |
| 删除 / 调整范围 | 仅经证明确属旧宿主的 notice/reload 分支；通用异步 UI 重试、主题持久化等待和浏览器 fallback 不自动归类为 legacy |
| 最后复核依据    | 2026-10-10，六版完整浏览器矩阵均使用共享 helper 并通过；各项 notice/reload 适配的精确适用范围仍须独立 UI 复核  |

## PLUGIN-CONFIG-001：旧 allowedOrigins 配置迁移

| 字段            | 内容                                                                                                                                                                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 类型 / 生效状态 | `plugin-contract` / 旧数组配置现存；0.1.6 内存迁移及监听后单入口定稿已生效                                                                                                                                                                |
| 适用契约        | 0.1.5 的顶层 `allowedOrigins`；与 DSH 版本集合无关                                                                                                                                                                                        |
| 原因            | 0.1.6 迁移到唯一顶层 `publicUrl`，保留旧单项和空数组输入，不改写 profile                                                                                                                                                                  |
| 代码 / 上游证据 | `src/config.ts`、[cordis.patch.yml](../cordis.patch.yml)；插件自身配置契约                                                                                                                                                                |
| 实现位置        | schema 用 undefined union 取消 Schemastery 数组默认值；bundle 无旧数组默认；`resolveStartupConfig` 检查显式互斥并内存转换，`finalizeAuthConfig` 用实际 port 生成唯一策略，旧 resolver 已删除                                              |
| 关联测试        | `tests/unit/origin-policy.test.ts`、`tests/integration/http-gate.test.ts`；`tests/unit/config.test.ts` 配置解析；startup-compatibility 真实 Loader 验证旧 0/1 项、重复/不同多项、显式 null、新旧 file/CLI 冲突、一次警告和 profile 不改写 |
| 客观退役条件    | 未来产品契约明确结束旧插件配置支持，并提供迁移说明；DSH 版本收缩不触发                                                                                                                                                                    |
| 删除 / 调整范围 | 仅旧输入检测、0/1 项转换、弃用提示和专属迁移测试；保留唯一 URL 验证、来源策略和安全回归                                                                                                                                                   |
| 最后复核依据    | 2026-10-09，0.1.5 当前源码；计划保留 0/1 项，多项及任一显式新旧共存报错，每次激活仅一次提示                                                                                                                                               |

## 共享安全边界

包身份、未来准入后的 API 检查、具体绑定、原始 Host/Origin/Fetch Metadata、回环准入、密码/TOTP、会话、流撤销、存储故障和 CLI 确认是共享安全逻辑，不随某个 runtime 分支退役。反向代理 HTTPS→HTTP、客户端通用浏览器 fallback 也不是可自动删除的旧 DSH 专属功能。

后续实施须将“待实现”更新成实际位置与测试。组合修复已将 Connection 改为依赖 webStartup/webServer，删除 web-runtime 的过时 trustedHosts 转发；`tests/browser/startup-compatibility.spec.ts` 在 alpha.2 原补丁复现 required Connection 等待 webRuntime 的审计失败。不得通过伪造服务、关闭启动审计或放开原生 listener 完成。alpha.1/2 的 startup-compatibility 与 dsh-gate 各 4/4 通过；类型、单元 38/38、集成 29/29 通过。仍不代表新配置、TLS/IPv6 或最终六版矩阵已完成。

2026-10-09 任务 3 复核：DSH 开发依赖均升级 alpha.2，Cordis/Schemastery 范围不变。新增 public-url / runtime-capabilities 及配置解析测试，六版真实安装锚点的 WebServer 版本和能力校验均通过。任务 3 曾保留 resolver 过渡路径，任务 4 已删除；当前生产入口仅使用统一启动前解析与监听后定稿，不并行维护两套来源规则。

2026-10-10 任务 4 复核：DenyGate 下原生监听后定稿，ready 与 AuthGate 共用唯一来源策略；启动输出使用实际端口并去重。Connection 正常丢失时撤回 ready，桥接预检失败由官方 fiber 释放 listener/admin/存储锁。多来源传输回归拆成独立单入口，保留 HTTP/HTTPS、默认端口、IP、回环、Cookie、头和升级拒绝断言。真实 Loader 旧字段每次激活一次弃用提示且不改写文件；安装包仅在隔离目录测试。

任务 4 补证：三个能力组 startup/deployment 各 9/9 通过，alpha.2 dsh-gate 3/3；类型、52 项单元、34 项集成与包验证通过。四个旧 WebApp 的 `localWebUrl` 都使用固定 LOOPBACK_HOST，不能把其模型侧地址误写成插件真实 bind IP。文件、CLI 及旧迁移的插件入口仍按实际生效值；未改写旧版原生注册。显式 null 的 host/port/TLS 不再被当作缺省，证书整组 CLI 覆盖仍优先。

2026-10-10 任务 5 复核：旧 HTTP/回环桥接集中在 runtime-capabilities；现代桥接使用原生协议和归一化 authority，zone 不进入便携公开 URL。静态检查、55 项单元、45 项集成通过；alpha.2 原生传输和既有代理浏览器 9/9，rc.1/alpha.1 旧能力拒绝与具体非回环 IPv4 真实包各 4/4，无跳过。TLS 材料错误、Connection 丢失和存储通知故障关闭入口；外层和原生 Cookie 协议独立验证。上述证据来自 0.1.5 开发包；开发包证据不能替代最终 0.1.6 全六版验证。

2026-10-10 任务 6 复核：默认测试/开发运行时为 alpha.2，两个既有 CI 矩阵覆盖六版；release 沿用共同默认。原生 systemPrompt Web section 与 DSH_WEB_URL 的最终地址相同且无 token。rc.1/alpha.1/alpha.2 的真实 startup/deployment/native-transport/admin CLI 分别 29/29、29/29、33/33，无跳过；旧多项、重复项、null 及新旧冲突均经过 Loader。静态、55 项单元、45 项集成通过。alpha.2 的最终 0.1.6 六版全量交付另需最终产物证据；onboarding 精确适用范围缺口继续保留。
