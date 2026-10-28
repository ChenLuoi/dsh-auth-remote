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

The [development guide](docs/development.md) explains the isolated DSH runtime and the full test boundaries. Run `pnpm pack:local` when a change affects packaging, and `pnpm smoke` when it affects installation or startup. Tests use temporary profiles; ordinary development/smoke wrappers manage the checkout’s .dev profile. Final verification uses the fixed-archive consumer’s new marked home. Keep real account files and credentials out of the repository.

Before changing supported versions, consult the [legacy compatibility inventory](docs/legacy-compatibility.md). Review manifest peers and compatibility declarations, runtime admission, test targets, CI matrices, and user claims together. Retire runtime adaptations in the same change only when none of their applicable DSH versions remain supported; retire old plugin configuration under its own migration policy. Keep shared security checks. Update both inventory languages, both matrix views and affected entries with complete version numbers whenever compatibility code changes.

Keep the [support policy](docs/support-policy.md), both directions of [support history](docs/support-history.md), README and inventory synchronized in both languages for support changes. Use the [fixed-archive consumer](docs/development.md#consume-a-fixed-archive) for same-package verification; packaging wrappers are for preparing a new candidate.

## Open a pull request

Create a focused branch from `master`. Include the reason for the change, its user-facing effect, tests run, and any migration or deployment steps. Update English and Chinese guides together when behavior changes. Add a short entry to the Unreleased section of both changelogs. Keep generated `dist/`, `artifacts/`, runtime data, secrets, and local profiles out of commits.

The `CI Verify` check runs on pull requests and again after a merge to `master`. A maintainer updates the version and dated changelog entry before creating a release tag. The [release guide](docs/releasing.md) describes that process.

For the `0.3.1` support migration, README/history record the current seven targets and retirements; both support policies retain the previous release content unchanged. Support/shared-host changes require one final archive across seven complete CLI/browser/smoke targets, following the release guide. Full/releases also require independent `0.2.1-alpha.2` refusal; ordinary runs no real retired-host negative job. Never rebuild or pack in the final consumer loop.
