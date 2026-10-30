# 发布指南

[English](releasing.md)

每次发布都从已通过检查的 `master` 提交开始。`vX.Y.Z` 标签必须与 `package.json` 中的稳定版本以及两份更新日志的日期条目一致。标签工作流先核对标签与 master 祖先关系，只构建一个 npm 压缩包，对全部声明的 DSH 版本验证该包，再核对或发布 npm 版本，并创建包含相同压缩包和 `SHA256SUMS` 的 GitHub Release。

本次计划发布 `0.3.3`，声明九个精确 DSH 目标，新增 `0.2.1-rc.5`；已发布 `0.3.2` 保留八版历史和不可变归档。发布前验证最终归档，最终同包测试报告不进入 npm 归档。更新日志日期是准备日期；`retiredOn: 2026-10-28` 仍为旧退役准备记录，不是 npm 发布时间。

发布准备中修改支持版本前，先复核 [Legacy 兼容维护清单](legacy-compatibility.zh-CN.md)，共同检查 peers、兼容声明、运行时准入、测试目标、CI 和指南。同次删除与支持集合无交集的专属运行时适配，保留共享安全逻辑；旧插件配置退役有独立条件。打包前同步更新并人工核对中英文清单、两个维度的矩阵及完整版本号。

打包前同步维护双语 README、支持规范、[DSH → 插件](support-history.zh-CN.md#by-dsh)和[插件 → DSH](support-history.zh-CN.md#by-plugin)历史及库存。保留历史行/锚点，区分已发布 `0.2.0`/`0.3.1`/`0.3.2` 和计划发布的 `0.3.3`，不引用不存在的 tag 作为已核实证据。

## 准备版本

将 `package.json` 更新为 `X.Y.Z`，把两份更新日志中用户可见的“未发布”变更移入 `## X.Y.Z - YYYY-MM-DD`，同时更新带版本号的安装示例。创建 Pull Request，等待 `CI Verify` 通过，合入后再等待 `master` 检查通过。检查尚未结束时不要打标签。

如需在已合入的检出中本地验证，可执行：

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm check:static
pnpm test:unit
pnpm exec tsx --test tests/integration/*.test.ts
node scripts/pack.mjs
node scripts/packed-artifact.mjs record
```

生产及全部消费验证使用 Node.js 24，并满足所选宿主自身要求（`0.2.2-alpha.2` 要求 `>=24.9.0`）；插件引擎仍为 `>=24`。直接集成测试命令复用静态检查的构建，`pack.mjs` 只生成一次归档，随后 `packed-artifact.mjs record` 写入摘要和精确全量矩阵。对全部声明目标串行消费这份冻结归档：

```sh
node --input-type=module - <<'JS'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { archive, testedDshVersions } from './scripts/runtime.mjs'
import { sha256 } from './scripts/verify-packed.mjs'
const digest = sha256(await readFile(archive))
for (const version of testedDshVersions) {
  const result = spawnSync(process.execPath, [
    'scripts/verify-packed.mjs', '--archive', archive, '--sha256', digest,
    '--dsh-version', version, '--suite', 'cli', '--suite', 'browser', '--suite', 'smoke',
  ], { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Verification failed for ${version}`)
}
JS
```

当前每次 full/发布还须用同包验证相邻退役 `0.2.1-alpha.2`。六版一次性负向验收属于 `0.3.1` 迁移历史，`0.3.3` 不重复；负向报告与正向业务矩阵分开。

```sh
node scripts/verify-retired.mjs --archive artifacts/dsh-auth-remote-0.3.3.tgz --sha256 <recorded-sha256> --retired-dsh-version 0.2.1-alpha.2
```

消费循环中不得构建或打包。归档内容变化须产生新候选并重新全量验证。JSON 报告记录摘要、精确版本、suite 范围、命令和真实用例数，见[固定归档指南](development.zh-CN.md#消费固定归档)。

工作流 DAG 为 `tag` → `package` → 共用 `verify-packed.yml` → `publish`。producer 上传一份 `release-package` 制品，独立 CLI/smoke 与完整 browser job 覆盖全部九个声明版本，消费前核对 producer 给出的预期 SHA-256、包身份及摘要文件。验证 job 拒绝不完整矩阵，full 聚合要求全部计划 job（含独立 `0.2.1-alpha.2` 退役拒绝）成功；失败、取消或意外跳过均阻止发布。

`publish` 下载同一制品，再次与 producer 预期摘要核对，不构建或打包。保留 npm 同版本字节比较、可信发布及 GitHub Release 重试行为。工作流用 `npm publish ./artifacts/dsh-auth-remote-X.Y.Z.tgz --access public` 发布已验证 tgz，无需在本地手动发布。

## 打标签并核对结果

使用已经位于 `master` 的版本：

```sh
git switch master
git pull --ff-only origin master
git tag -a v0.3.3 -m "Release v0.3.3"
git push origin v0.3.3
```

执行时把 `0.3.3` 换成目标版本。标签必须指向 `master` 可达的提交。标签版本不匹配、缺少更新日志条目、测试失败，或 npm 现存版本与本次压缩包字节不同，都会阻止发布。

工作流结束后检查运行状态、GitHub Release 和 npm 版本：

```sh
gh run list --workflow release.yml --limit 5
gh release view v0.3.3
npm view dsh-auth-remote@0.3.3 version dist.integrity
```

GitHub Release 包含 `.tgz` 和 `SHA256SUMS`。把两者下载到同一个目录，在该目录运行 `sha256sum -c SHA256SUMS` 验证附件。工作流失败时先查看 **Actions → Release** 再重试；npm 版本不可覆盖，因此只有现存版本的压缩包字节与本次构建一致时，工作流才会跳过重复发布。
