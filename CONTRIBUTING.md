# Contributing

[简体中文](CONTRIBUTING.zh-CN.md)

Thanks for helping improve dsh-auth-remote. Changes to authentication or deployment behavior need a clear description of the security impact and a way to verify the result. Do not include exploit details or secrets in public issues. If GitHub private vulnerability reporting is available, use it; otherwise request a private contact channel without posting technical details.

## Prepare a checkout

Use Linux with `/proc`, Node.js 24 or newer, and pnpm 12.5.1. Install dependencies and the managed browser from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm check
```

The [development guide](docs/development.md) explains the isolated DSH runtime and the full test boundaries. Run `pnpm pack:local` when a change affects packaging, and `pnpm smoke` when it affects installation or startup. Tests use temporary profiles; keep real account files and credentials out of the repository.

## Open a pull request

Create a focused branch from `master`. Include the reason for the change, its user-facing effect, tests run, and any migration or deployment steps. Update English and Chinese guides together when behavior changes. Add a short entry to the Unreleased section of both changelogs. Keep generated `dist/`, `artifacts/`, runtime data, secrets, and local profiles out of commits.

The `CI Verify` check runs on pull requests and again after a merge to `master`. A maintainer updates the version and dated changelog entry before creating a release tag. The [release guide](docs/releasing.md) describes that process.
