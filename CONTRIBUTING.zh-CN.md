# 参与贡献

[English](CONTRIBUTING.md)

感谢改进 dsh-auth-remote。认证或部署行为的改动应说明安全影响，并提供可验证的结果。不要在公开 issue 中提供漏洞细节或密钥。如果 GitHub 私密漏洞报告已启用，请使用该渠道；否则仅请求私下联系渠道，不要公开技术细节。

## 准备源码环境

使用带 `/proc` 的 Linux、Node.js 24 或更高版本、pnpm 12.5.1。在仓库根目录安装依赖和测试浏览器：

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm check
```

[开发指南](docs/development.zh-CN.md)说明隔离的 DSH 运行时与完整测试范围。改动打包时执行 `pnpm pack:local`；改动安装或启动时再执行 `pnpm smoke`。测试使用临时 profile；真实账号文件与凭据不得进入仓库。

## 提交 Pull Request

从 `master` 创建专用分支。说明改动原因、用户可见效果、已运行的测试，以及迁移或部署步骤。行为变化需要同步修改中英文指南，并在两份更新日志的“未发布”部分补一条简短记录。不要提交生成的 `dist/`、`artifacts/`、运行时数据、密钥或本地 profile。

`CI Verify` 会在 Pull Request 和合入 `master` 后运行。维护者在创建发布标签前更新版本号和带日期的更新日志；具体流程见[发布指南](docs/releasing.zh-CN.md)。
