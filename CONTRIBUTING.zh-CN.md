# 参与贡献

[English](CONTRIBUTING.md)

感谢改进 dsh-auth-remote。认证或部署行为的改动应说明安全影响，并提供可验证的结果。不要在公开 issue 中提供漏洞细节或密钥。如果 GitHub 私密漏洞报告已启用，请使用该渠道；否则仅请求私下联系渠道，不要公开技术细节。

修改支持版本前，先阅读 [Legacy 兼容维护清单](docs/legacy-compatibility.zh-CN.md)，共同检查 manifest peers/兼容声明、运行时准入、测试目标、CI 矩阵及用户声明。适用 DSH 与支持集合无交集时须同次删除专属适配并更新清单；旧插件配置按自身迁移策略退役。保留共享安全逻辑，兼容代码变更同步维护中英文清单、两个维度的矩阵与相关条目，适用范围须使用完整版本号。

## 准备源码环境

使用带 `/proc` 的 Linux、Node.js 24（十二版发布矩阵使用 `24.22.3`）、pnpm 12.5.1。在仓库根目录安装依赖和测试浏览器：

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm check
```

[开发指南](docs/development.zh-CN.md)说明隔离的 DSH 运行时与完整测试范围。改动打包时执行 `pnpm pack:local`；改动安装或启动时再执行 `pnpm smoke`。测试使用临时 profile；普通开发/smoke 包装命令管理当前 checkout 的 .dev profile，最终验证使用固定归档运行器新建的带标记 home。真实账号文件与凭据不得进入仓库。

支持变更须同时维护[支持规范](docs/support-policy.zh-CN.md)、[双向支持历史](docs/support-history.zh-CN.md)、README 与兼容库存的两种语言。同包验证使用[固定归档运行器](docs/development.zh-CN.md#消费固定归档)，打包包装命令只用于准备新候选。

## 提交 Pull Request

从 `master` 创建专用分支。说明改动原因、用户可见效果、已运行的测试，以及迁移或部署步骤。行为变化需要同步修改中英文指南，并在两份更新日志的“未发布”部分补一条简短记录。不要提交生成的 `dist/`、`artifacts/`、运行时数据、密钥或本地 profile。

`CI Verify` 会在 Pull Request 和合入 `master` 后运行。维护者在创建发布标签前更新版本号和带日期的更新日志；具体流程见[发布指南](docs/releasing.zh-CN.md)。

源码继续使用 RC 预发布 `0.2.2-rc.5` 作为开发默认。ordinary/full 均在同一归档跑 `0.4.0` 支持的十二版完整 CLI/browser/smoke。未提交的候选在独立检出目录执行[本地验收](docs/releasing.zh-CN.md#local-candidate-verification)。full 继续独立验证 `0.2.1-alpha.2` 技术拒绝，三个 Alpha 的维护退役专项仅适用于已校验的 `0.3.6` full。已发布 `0.3.6` 的八版记录与 `0.3.5` 的十版历史声明见[支持历史](docs/support-history.zh-CN.md)。每个本地、PR、master、tag producer 的源码、归档、实际 runtime/SDK 与原始报告由包外索引关联。依次通过 PR CI、master CI、附注标签及可信发布。最终消费者使用固定归档。LiveShare 验证原生 viewer、Origin 和认证边界，Owner/Relay 产品流程仍待验证。
