# Releasing

[简体中文](releasing.zh-CN.md)

Each release starts from a tested commit on `master`. A `vX.Y.Z` tag must match the stable version in `package.json` and the dated entries in both changelogs. The tag workflow repeats the full checks, builds the npm archive, verifies or publishes the npm version, and creates a GitHub Release containing the same archive and `SHA256SUMS`.

## Prepare the version

Update `package.json` to `X.Y.Z`, move user-visible changes from Unreleased into `## X.Y.Z - YYYY-MM-DD` in both changelogs, and update any versioned installation examples. Open a pull request, let `CI Verify` pass, merge it, and wait for the `master` check to pass. Do not tag a commit whose checks are still running.

To verify the merged checkout locally, run:

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm check
pnpm release:pack
pnpm smoke:packed
```

`pnpm release:pack` runs static checks, creates and verifies `artifacts/dsh-auth-remote-X.Y.Z.tgz`; `pnpm smoke:packed` installs that exact archive into an isolated DSH home and tests startup. The tag workflow publishes the verified archive to npm with `npm publish ./artifacts/dsh-auth-remote-X.Y.Z.tgz --access public`. No local npm publication is needed.

## Tag and inspect the release

Use the version that is already on `master`:

```sh
git switch master
git pull --ff-only origin master
git tag -a v0.1.1 -m "Release v0.1.1"
git push origin v0.1.1
```

Replace `0.1.1` in these commands with the intended version. The tag must point to a commit reachable from `master`. A mismatched tag, missing changelog entry, failed test, or mismatched existing npm archive stops the release.

After the workflow completes, confirm the run, GitHub Release, and npm version:

```sh
gh run list --workflow release.yml --limit 5
gh release view v0.1.1
npm view dsh-auth-remote@0.1.1 version dist.integrity
```

The GitHub Release includes the `.tgz` and `SHA256SUMS`. Download them into the same directory and run `sha256sum -c SHA256SUMS` there to check the release asset. A failed workflow should be inspected in **Actions → Release** before retrying; npm versions are immutable, so the workflow only skips an existing version when its archive bytes match.
