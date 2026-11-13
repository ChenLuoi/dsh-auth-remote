# Releasing

[简体中文](releasing.zh-CN.md)

Each release starts from a tested commit on `master`. A `vX.Y.Z` tag must match the stable version in `package.json` and the dated entries in both changelogs. The tag workflow checks the tag and master ancestry, builds one npm archive, verifies that exact archive on every declared DSH release, then verifies or publishes the npm version and creates a GitHub Release containing the same archive and `SHA256SUMS`.

Published `0.3.6` declares eight exact targets, adds recommended RC prerelease `0.2.2-rc.2` and retires maintenance of `0.2.1-alpha.3`, `0.2.1-alpha.4`, `0.2.1-alpha.5`. Published `0.3.5` retains its original ten declarations and immutable archive as the last supporting plugin for those Alphas; its checked registry publication time is 2026-11-06T13:56:24.506Z. `0.3.6` completed PR/master CI and tag Release run `43460497597`; its registry publication time is 2026-11-13T16:31:13.920Z. The [support history](support-history.md#plugin-0.3.6) records the immutable released digest and full verification. Subsequent repository publication-fact corrections do not rebuild or republish that archive. Record preparation date 2026-11-13 separately from actual registry time; final same-archive reports/index stay outside npm.

Before changing version support for a release, review the [legacy compatibility inventory](legacy-compatibility.md). Check peers, compatibility declarations, runtime admission, test targets, CI and guides together. Remove runtime adaptations whose applicable versions no longer intersect support in that same change, while keeping shared security checks. Old plugin configuration has independent retirement conditions; update both inventory languages and both matrix views with complete version numbers before packing.

Before packing, update README, the support policy, the [DSH → plugin](support-history.md#by-dsh) and [plugin → DSH](support-history.md#by-plugin) history, and inventory in both languages. Keep historical rows/anchors, distinguish published `0.2.0`/`0.3.1`/`0.3.2`/`0.3.3`/`0.3.4`/`0.3.5`/`0.3.6` from future candidate declarations, and never cite a nonexistent tag as verified evidence.

## Prepare the version

Update `package.json` to `X.Y.Z`, move user-visible changes from Unreleased into `## X.Y.Z - YYYY-MM-DD` in both changelogs, and update any versioned installation examples. Open a pull request, let `CI Verify` pass, merge it, and wait for the `master` check to pass. Do not tag a commit whose checks are still running.

To verify the merged checkout locally, run:

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm check:static
pnpm test:unit
pnpm exec tsx --test tests/integration/*.test.ts
node scripts/pack.mjs
node scripts/packed-artifact.mjs record
```

Use Node.js 24 for production and every consumer, satisfying the selected Host's own requirement (`0.2.2-rc.2` requires `>=24.9.0`); the plugin engine remains `>=24`. The direct integration command reuses the static build; `pack.mjs` creates the archive once, then `packed-artifact.mjs record` writes its checksum, unique producer/source identity and exact full matrices. Consume that frozen archive serially across all declared targets:

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

Full/releases retain independent `0.2.1-alpha.2` technical refusal. The three maintenance-retirement checks above apply only to validated plugin `0.3.6` full/releases, start no Chromium and do not restore full Alpha support; plugin `0.3.7` and other versions do not require that job. The six-host one-time technical negative run remains `0.3.1` history, not a current positive matrix.

Keep each printed raw report JSON, adjacent `-evidence.json`, `-runtimes/` directory and sidecar-listed raw logs (smoke has three actual suffixes). Copy only this producer’s files, retaining basenames, into a new ignored `.cache/acceptance-local` directory; do not mix historical/partial/other-producer files. After all consumption, run:

```sh
DSH_VERIFY_PLAN=full node scripts/packed-artifact.mjs index artifacts/dsh-auth-remote-0.3.6.tgz <recorded-sha256> .cache/acceptance-local artifacts/acceptance-index.json
```

The index checks complete coverage, source/producer/archive, actual CLI/lock/eight-package SDK chains, complete-tree copies, required smoke/previous-host/two private-account runtimes and all raw report/log hashes. Missing/mismatched/mixed/partial/unknown reports fail and write failed status. Each local/PR/master/tag producer needs its own index; old success cannot certify a new producer.

Do not build or pack inside the consumer loop. An archive content change requires a new candidate and full verification. JSON reports record the hash, exact release, suite scope, commands and actual test counts. See the [fixed-archive guide](development.md#consume-a-fixed-archive).

The workflow DAG is `tag` → `package` → reusable `verify-packed.yml` → `publish`. One `release-package` contains tgz, SHA256SUMS and producer.json. Eight independent CLI/smoke and complete-browser jobs, plus both retirement jobs, download the same artifact and check source/producer/package identity and SHA before consumption. Validate derives required flags from the checked archive; aggregation strictly checks five results and explicit true/false output. Plugin `0.3.6` full requires all three maintenance targets and independent `0.2.1-alpha.2` technical refusal. Raw evidence and the acceptance index upload outside npm; failure/cancellation/omissions/unknown values/unexpected skips block publication.

`publish` downloads the same artifact and checks it against the producer's expected digest again. It never builds or packs. Existing npm-version byte comparison, trusted publishing and GitHub Release retry behavior remain in place. The workflow publishes the verified tgz with `npm publish ./artifacts/dsh-auth-remote-X.Y.Z.tgz --access public`; no local npm publication is needed.

## Tag and inspect the release

Use the version that is already on `master`:

```sh
git switch master
git pull --ff-only origin master
node scripts/check-release.mjs --tag vX.Y.Z
git tag -a vX.Y.Z -m "Release vX.Y.Z"
git push origin vX.Y.Z
```

Replace `X.Y.Z` in these commands with the intended version. The tag must point to a commit reachable from `master`. A mismatched tag, missing changelog entry, failed test, or mismatched existing npm archive stops the release.

After the workflow completes, confirm the run, GitHub Release, and npm version:

```sh
gh run list --workflow release.yml --limit 5
gh release view vX.Y.Z
npm view dsh-auth-remote@X.Y.Z version dist.integrity
```

The GitHub Release includes the `.tgz` and `SHA256SUMS`. Download them into the same directory and run `sha256sum -c SHA256SUMS` there to check the release asset. A failed workflow should be inspected in **Actions → Release** before retrying; npm versions are immutable, so the workflow only skips an existing version when its archive bytes match.

For an uncommitted local candidate, also freeze source identity: HEAD, status, complete binary diff, nonignored new-file digests, a path/type/mode/SHA-256 manifest of tracked and new source/tests/scripts/configuration/docs/locks, and the original index baseline. Exclude task, runtime data, reports and generated output. Compare source manifest, index and tgz digest before and after consumption. Any source, test, script, lock or packaged-document edit requires core checks, a new freeze and all eight CLI/browser/smoke targets, full technical refusal and, for `0.3.6`, all three maintenance targets again; HEAD alone and old-archive success are insufficient.

After publication, match npm tarball/integrity and GitHub tgz/SHA256SUMS to the tag producer exactly, then smoke the publicly downloaded package in a fresh `0.2.2-rc.2` profile (ready, anonymous denial, CLI status). Reconfirm0.3.5 availability. Same-version retries require identical bytes, never replacement publication; later factual corrections must not rebuild published0.3.6.
