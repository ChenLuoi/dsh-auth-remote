# Releasing

[简体中文](releasing.zh-CN.md)

Each release starts from a tested commit on `master`. A `vX.Y.Z` tag must match the stable version in `package.json` and the dated entries in both changelogs. The tag workflow checks the tag and master ancestry, builds one npm archive, verifies that exact archive on every declared DSH release, then verifies or publishes the npm version and creates a GitHub Release containing the same archive and `SHA256SUMS`.

Current unpublished candidate `0.3.2` declares eight exact DSH targets, adding `0.2.2-alpha.2`; published `0.3.1` retains its seven-target history and immutable archive. Verify the final archive before publication; final same-archive reports are recorded separately. Candidate changelog dates record preparation; `retiredOn: 2026-10-28` remains the old retirement preparation record, not an npm publication timestamp.

Before changing version support for a release, review the [legacy compatibility inventory](legacy-compatibility.md). Check peers, compatibility declarations, runtime admission, test targets, CI and guides together. Remove runtime adaptations whose applicable versions no longer intersect support in that same change, while keeping shared security checks. Old plugin configuration has independent retirement conditions; update both inventory languages and both matrix views with complete version numbers before packing.

Before packing, update README, the [DSH → plugin](support-history.md#by-dsh) and [plugin → DSH](support-history.md#by-plugin) history, and inventory in both languages. For this `0.3.2` work both support-policy files remain unchanged as the previous release record. Keep historical rows/anchors, distinguish published `0.2.0`/`0.3.1` from this unpublished candidate, and never cite a nonexistent candidate tag as verified evidence.

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

Use Node.js 24 for production and every consumer, satisfying the selected Host's own requirement (`0.2.2-alpha.2` requires `>=24.9.0`); the plugin engine remains `>=24`. The direct integration command reuses the static build; `pack.mjs` creates the archive once, then `packed-artifact.mjs record` writes its checksum and exact full matrices. Consume that frozen archive serially across all declared targets:

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

Every current full/release also verifies adjacent retired `0.2.1-alpha.2` against that same archive. The six-host one-time negative acceptance belongs to the `0.3.1` migration history and is not repeated for `0.3.2`; negative reports stay separate from the positive business matrix.

```sh
node scripts/verify-retired.mjs --archive artifacts/dsh-auth-remote-0.3.2.tgz --sha256 <recorded-sha256> --retired-dsh-version 0.2.1-alpha.2
```

Do not build or pack inside the consumer loop. An archive content change requires a new candidate and full verification. JSON reports record the hash, exact release, suite scope, commands and actual test counts. See the [fixed-archive guide](development.md#consume-a-fixed-archive).

The workflow DAG is `tag` → `package` → reusable `verify-packed.yml` → `publish`. The producer uploads one `release-package` artifact. Independent CLI/smoke and complete-browser jobs cover all eight declared releases and check the producer's expected SHA-256, package identity and checksum file before consumption. A validation job rejects incomplete matrices; the full-plan aggregate requires every planned job, including the independent `0.2.1-alpha.2` retired-rejection job, to succeed. Failure, cancellation or an unexpected skip blocks publication.

`publish` downloads the same artifact and checks it against the producer's expected digest again. It never builds or packs. Existing npm-version byte comparison, trusted publishing and GitHub Release retry behavior remain in place. The workflow publishes the verified tgz with `npm publish ./artifacts/dsh-auth-remote-X.Y.Z.tgz --access public`; no local npm publication is needed.

## Tag and inspect the release

Use the version that is already on `master`:

```sh
git switch master
git pull --ff-only origin master
git tag -a v0.3.2 -m "Release v0.3.2"
git push origin v0.3.2
```

Replace `0.3.2` in these commands with the intended version. The tag must point to a commit reachable from `master`. A mismatched tag, missing changelog entry, failed test, or mismatched existing npm archive stops the release.

After the workflow completes, confirm the run, GitHub Release, and npm version:

```sh
gh run list --workflow release.yml --limit 5
gh release view v0.3.2
npm view dsh-auth-remote@0.3.2 version dist.integrity
```

The GitHub Release includes the `.tgz` and `SHA256SUMS`. Download them into the same directory and run `sha256sum -c SHA256SUMS` there to check the release asset. A failed workflow should be inspected in **Actions → Release** before retrying; npm versions are immutable, so the workflow only skips an existing version when its archive bytes match.
