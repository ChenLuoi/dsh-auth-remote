# 发布指南

[English](releasing.md)

每次发布都从已通过检查的 `master` 提交开始。`vX.Y.Z` 标签必须与 `package.json` 中的稳定版本以及两份更新日志的日期条目一致。标签工作流会再次执行完整检查、构建 npm 压缩包、核对或发布 npm 版本，并创建包含相同压缩包和 `SHA256SUMS` 的 GitHub Release。

## 准备版本

将 `package.json` 更新为 `X.Y.Z`，把两份更新日志中用户可见的“未发布”变更移入 `## X.Y.Z - YYYY-MM-DD`，同时更新带版本号的安装示例。创建 Pull Request，等待 `CI Verify` 通过，合入后再等待 `master` 检查通过。检查尚未结束时不要打标签。

如需在已合入的检出中本地验证，可执行：

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm check
pnpm release:pack
pnpm smoke:packed
```

`pnpm release:pack` 执行静态检查，创建并验证 `artifacts/dsh-auth-remote-X.Y.Z.tgz`；`pnpm smoke:packed` 将这个压缩包安装到隔离 DSH home 并测试启动。标签工作流使用 `npm publish ./artifacts/dsh-auth-remote-X.Y.Z.tgz --access public` 将已验证的压缩包发布到 npm，无需在本地手动发布。

## 打标签并核对结果

使用已经位于 `master` 的版本：

```sh
git switch master
git pull --ff-only origin master
git tag -a v0.1.2 -m "Release v0.1.2"
git push origin v0.1.2
```

执行时把 `0.1.2` 换成目标版本。标签必须指向 `master` 可达的提交。标签版本不匹配、缺少更新日志条目、测试失败，或 npm 现存版本与本次压缩包字节不同，都会阻止发布。

工作流结束后检查运行状态、GitHub Release 和 npm 版本：

```sh
gh run list --workflow release.yml --limit 5
gh release view v0.1.2
npm view dsh-auth-remote@0.1.2 version dist.integrity
```

GitHub Release 包含 `.tgz` 和 `SHA256SUMS`。把两者下载到同一个目录，在该目录运行 `sha256sum -c SHA256SUMS` 验证附件。工作流失败时先查看 **Actions → Release** 再重试；npm 版本不可覆盖，因此只有现存版本的压缩包字节与本次构建一致时，工作流才会跳过重复发布。
