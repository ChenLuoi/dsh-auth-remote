# 发布指南

[English](releasing.md)

每次发布都从已通过检查的 `master` 提交开始。`vX.Y.Z` 标签必须与 `package.json` 中的稳定版本以及两份更新日志的日期条目一致。标签工作流先核对标签与 master 祖先关系，只构建一个 npm 压缩包，对全部声明的 DSH 版本验证该包，再核对或发布 npm 版本，并创建包含相同压缩包和 `SHA256SUMS` 的 GitHub Release。

候选 `0.3.6` 声明八个精确目标，新增推荐RC预发布 `0.2.2-rc.2`，维护退役 `0.2.1-alpha.3`、`0.2.1-alpha.4`、`0.2.1-alpha.5`。已发布 `0.3.5` 保留原十版声明及不可变归档，是三个Alpha的最后支持插件；已核验registry发布时间为2026-11-06T13:56:24.506Z。`0.3.6` 尚未发布，按PR/master CI/标签/可信工作流完成发布。准备日期2026-11-13与实际registry时间分别记录；最终同包报告及索引不入npm。

发布准备中修改支持版本前，先复核 [Legacy 兼容维护清单](legacy-compatibility.zh-CN.md)，共同检查 peers、兼容声明、运行时准入、测试目标、CI 和指南。同次删除与支持集合无交集的专属运行时适配，保留共享安全逻辑；旧插件配置退役有独立条件。打包前同步更新并人工核对中英文清单、两个维度的矩阵及完整版本号。

打包前同步维护双语 README、支持规范、[DSH → 插件](support-history.zh-CN.md#by-dsh)和[插件 → DSH](support-history.zh-CN.md#by-plugin)历史及库存。保留历史行/锚点，区分已发布 `0.2.0`/`0.3.1`/`0.3.2`/`0.3.3`/`0.3.4`/`0.3.5` 和 `0.3.6` 候选声明，不引用不存在的 tag 作为已核实证据。

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

生产及全部消费验证使用 Node.js 24，并满足所选宿主自身要求（`0.2.2-rc.2` 要求 `>=24.9.0`）；插件引擎仍为 `>=24`。直接集成测试命令复用静态检查的构建，`pack.mjs` 只生成一次归档，随后 `packed-artifact.mjs record` 写入摘要、唯一producer/源码身份与精确全量矩阵。对全部声明目标串行消费这份冻结归档：

```sh
node --input-type=module - <<'JS'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { archive, packageManifest, testedDshVersions } from './scripts/runtime.mjs'
import { checkProducerIdentity, maintenanceRetirementRequired } from './scripts/packed-artifact.mjs'
import { sha256 } from './scripts/verify-packed.mjs'
const digest = sha256(await readFile(archive))
await checkProducerIdentity(archive, digest)
const run = (script, args) => {
  const result = spawnSync(process.execPath, [script, '--archive', archive, '--sha256', digest, ...args], { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Verification failed: ${script} ${args.join(' ')}`)
}
for (const version of testedDshVersions)
  run('scripts/verify-packed.mjs', ['--dsh-version', version, '--suite', 'cli', '--suite', 'browser', '--suite', 'smoke'])
if (maintenanceRetirementRequired(packageManifest.version, 'full'))
  for (const version of ['0.2.1-alpha.3', '0.2.1-alpha.4', '0.2.1-alpha.5'])
    run('scripts/verify-maintenance-retired.mjs', ['--dsh-version', version])
run('scripts/verify-retired.mjs', ['--retired-dsh-version', '0.2.1-alpha.2'])
await checkProducerIdentity(archive, digest)
JS
```

full/发布继续独立验证 `0.2.1-alpha.2` 技术拒绝。上面的三版维护退役专项仅用于已校验插件0.3.6的full/发布，不启动Chromium，也不恢复三个Alpha的完整支持；0.3.7及其他版本不继续要求该job。六版一次性技术负向属于0.3.1历史，不重跑成当前正向矩阵。

保留每次打印的原report JSON、相邻 `-evidence.json`、`-runtimes/`目录和sidecar所列原始日志（smoke含三个真实后缀）。把本producer的这些文件以原basename复制到新的忽略目录 `.cache/acceptance-local`；不要混入历史/partial/其他producer。全部消费结束后运行：

```sh
DSH_VERIFY_PLAN=full node scripts/packed-artifact.mjs index artifacts/dsh-auth-remote-0.3.6.tgz <recorded-sha256> .cache/acceptance-local artifacts/acceptance-index.json
```

索引核验完整矩阵、源码/producer/归档、实际CLI/lock/八包SDK链、全树copy、必需smoke/前版/两个账号私有runtime和所有原始报告/日志摘要。缺失、错摘要、混producer、partial或未知报告均拒绝并写failed状态。每个本地/PR/master/tag producer分别生成索引，旧producer成功不认证新producer。

消费循环中不得构建或打包。归档内容变化须产生新候选并重新全量验证。JSON 报告记录摘要、精确版本、suite 范围、命令和真实用例数，见[固定归档指南](development.zh-CN.md#消费固定归档)。

工作流DAG为 `tag` → `package` → 共用 `verify-packed.yml` → `publish`。producer上传一次 `release-package`（tgz、SHA256SUMS、producer.json）。八版独立CLI/smoke和完整browser job及两类退役job都下载同一制品，消费前校验源码/producer/包身份和SHA。validate从已校验归档派生required开关，聚合严格检查五项结果及明确true/false输出；0.3.6 full必须三版maintenance-retirement和独立 `0.2.1-alpha.2` 技术拒绝全部成功。归档证据和验收索引包外上传；失败、取消、遗漏、未知值或意外skip阻止发布。

`publish` 下载同一制品，再次与 producer 预期摘要核对，不构建或打包。保留 npm 同版本字节比较、可信发布及 GitHub Release 重试行为。工作流用 `npm publish ./artifacts/dsh-auth-remote-X.Y.Z.tgz --access public` 发布已验证 tgz，无需在本地手动发布。

## 打标签并核对结果

使用已经位于 `master` 的版本：

```sh
git switch master
git pull --ff-only origin master
node scripts/check-release.mjs --tag vX.Y.Z
git tag -a vX.Y.Z -m "Release vX.Y.Z"
git push origin vX.Y.Z
```

执行时把 `X.Y.Z` 换成目标版本。标签必须指向 `master` 可达的提交。标签版本不匹配、缺少更新日志条目、测试失败，或 npm 现存版本与本次压缩包字节不同，都会阻止发布。

工作流结束后检查运行状态、GitHub Release 和 npm 版本：

```sh
gh run list --workflow release.yml --limit 5
gh release view vX.Y.Z
npm view dsh-auth-remote@X.Y.Z version dist.integrity
```

GitHub Release 包含 `.tgz` 和 `SHA256SUMS`。把两者下载到同一个目录，在该目录运行 `sha256sum -c SHA256SUMS` 验证附件。工作流失败时先查看 **Actions → Release** 再重试；npm 版本不可覆盖，因此只有现存版本的压缩包字节与本次构建一致时，工作流才会跳过重复发布。

未提交候选的本地验收须另外冻结源码身份：HEAD、status、完整 binary diff、非忽略新增文件摘要、受跟踪和新增源码/测试/脚本/配置/文档/锁文件的路径、类型/模式与 SHA-256 清单，以及原暂存区基线。排除 task、运行数据、报告和生成物。消费者前后比较源码清单、index 和 tgz 摘要；任何源码、测试、脚本、锁文件或入包文档变化都重跑核心检查、重新冻结并完整重跑八版CLI/browser/smoke、full技术拒绝及仅0.3.6的三版维护专项，不能只记录 HEAD 或沿用旧归档结果。

发布后核验npm tarball/integrity、GitHub tgz/SHA256SUMS与tag producer完全相同，并用公开下载包在全新 `0.2.2-rc.2` profile跑smoke（ready、匿名拒绝、CLI status）。再次确认0.3.5仍可获取；同版本只允许相同字节重试，不能重发覆盖。发布后事实纠正不得重建已发布0.3.6。
