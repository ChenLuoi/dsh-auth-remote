# Changelog

[简体中文](CHANGELOG.zh-CN.md)

This file records user-visible changes to the released package. Version numbers follow the package's `package.json`; release tags use the same number with a `v` prefix. Add changes under Unreleased while developing, then move them to a dated version before tagging.

## Unreleased

## 0.1.10 - 2026-10-19

- Add DSH `0.2.1-alpha.4` and `0.2.1-alpha.5` support, pin development/default tests to `0.2.1-alpha.5`, and extend CLI, full browser and installation-smoke verification to all nine supported releases. Retain the remote callback and HMR isolation adaptations, exercise native host-release refresh on `0.2.1-alpha.4` and `0.2.1-alpha.5`, and declare `engines.dsh >=0.1.7-rc.1`.
- Fix native Settings writes after a running DSH hot-reloads the plugin: initialize the listener outside the reload transaction context so re-enabling remote account sign-in still enters the native configuration queue.
- Fix configuration retry after an initial Settings read failure or a temporarily missing namespace, and wait for the loaded preference before choosing manual or native account sign-in.
- Simplify the standalone sign-in heading and remove redundant account instructions; show account overview labels and reserved value rows before loading completes.
- Use a visual switch for remote account sign-in, place its explanation under the feature, show required TOTP policy as inline help, compact security actions and simplify account sign-in instructions with matching dialog styles.
- Add default-on `manualAccountLogin` through native Settings profile overrides. Accepted saves affect new attempts immediately; disabling preserves admitted authorizations and restores native entries. Manual admission uses SemVer `>=0.2.1-alpha.3` including prereleases, required APIs and configuration; exact full-feature targets are `0.2.1-alpha.3`, `0.2.1-alpha.4` and `0.2.1-alpha.5`.
- Default `requireTotp` to false while preserving explicit policy, existing TOTP and backup codes. Reorganize Security & sign-in into account overview, sign-in options and task dialogs for passwords, TOTP and current/all-session sign-out.
- Show backup codes once in the same successful TOTP dialog, with Copy all, protected acknowledgement and a redirect hold after revocation. Preserve atomic verification, cancellation/errors, rate limits, session and callback security boundaries.

## 0.1.9 - 2026-10-15

- Add DSH 0.2.1-alpha.3 to the compatibility declaration and seven-version CLI, installation smoke and browser matrix; use its packages for development and default verification.
- Validate the listener's bound port before finalizing authentication. Adapt browser Settings navigation and startup URL observation to DSH 0.2.1-alpha.3.
- Add an instruction-first official DeepSeek sign-in dialog on DSH 0.2.1-alpha.3. Open authorization only on explicit confirmation, then accept a pasted loopback callback URL through an authenticated, session-bound POST and reuse native state/PKCE exchange and credential storage. Handle blocked popups, invalid callbacks, cancellation, expiry and retries without a local listener or tunnel.
- Preserve the native API-key setup alternative in the DSH 0.2.1-alpha.3 manual account dialog. Selecting it continues credential onboarding without completing setup or starting account authorization; the account menu can reopen the same editor.
- Align the manual account sign-in dialog with DSH modal typography, spacing, controls and themed surfaces, keeping actions visible on short screens while the content scrolls.
- Publish bilingual compatibility inventories with complete DSH version numbers, feature-to-version and version-to-feature matrices, implementation/test references and migration/retirement rules.

## 0.1.8 - 2026-10-12

- Allow anonymous GET/HEAD access to the exact PWA manifest and favicon paths, and link the manifest from sign-in with the required CSP permission. Keep origin checks and business authentication in place.

## 0.1.7 - 2026-10-10

- Automatically declare the finalized native bridge authority in Connection's trusted hosts, fixing downstream plugin POST rejection when a concrete listener address was not explicitly trusted. Use the actual bound port and retain the legacy loopback bridge.
- Merge and deduplicate explicit CLI trusted hosts and public authorities required by preserved paths, while retaining the outer public-origin and session checks.

## 0.1.6 - 2026-10-10

- Use DSH 0.2.1-alpha.2 for development and default verification, repair native WebServer/Connection composition, and retain all six declared releases in the CLI, smoke and browser CI matrix.
- Select one top-level `publicUrl`; resolve CLI/file listener settings before startup and derive missing URLs only after the actual port binds. Alpha.1/2 native Web prompts and `DSH_WEB_URL` use that final root; older runtimes keep their own model-side projection.
- Support alpha.2 native concrete IPv6 and HTTPS through the official listener, with whole-pair `tlsCert`/`tlsKey` overrides and explicit profile-versus-cwd path rules. Native cookies follow the listener protocol, while browser cookies follow the effective external origin. Preserve guarded uploads, streams, upgrades and revocation through both proxy protocol directions.
- Migrate legacy zero/single `allowedOrigins` inputs in memory with one warning per activation. Multiple entries and explicit coexistence with file/CLI `publicUrl` fail; existing multi-entry profiles must choose one root. Account state and profile files are not rewritten.
- Document the six-version capability matrix, native TLS/IPv6 setup and migration in both languages. Add a single Chinese legacy inventory with separate runtime and plugin-contract retirement rules; keep task files, test keys and runtime data outside the npm archive.

## 0.1.5 - 2026-10-03

- Verify DSH 0.2.1-alpha.1 with the existing authentication implementation and add it to the CLI, installation smoke, and browser CI matrix, retaining all previously tested versions.
- Declare all verified releases in `dsh.compatibility.dshReleases` and use DSH 0.2.1-alpha.1 as the default development, test, and release runtime; update pinned dependencies and bilingual guides.
- Wait for the native API key onboarding prompt before interacting with Host settings or the workspace picker, preventing delayed host dialogs from blocking browser verification.

## 0.1.3 - 2026-09-30

- Verify DSH 0.2.0-rc.2 and add it to the CLI, installation smoke, and browser CI matrix, retaining all previously tested versions.
- Use DSH 0.2.0-rc.2 as the default development, test, and release verification runtime; update pinned development dependencies and English/Chinese setup guides.
- Match the chat completion status used by both older DSH runtimes and 0.2.0-rc.2 in the HTTPS forwarding regression.
- Coordinate session-monitor redirects with security changes so a successful update retains its sign-in message and newly issued backup codes remain visible until acknowledged. Pending-operation protection expires after 30 seconds.

## 0.1.2 - 2026-09-29

- Align login and security settings with DSH typography, neutral colors, controls, and light/dark themes.
- Verify DSH 0.1.7-rc.1, 0.1.7-rc.2, and 0.2.0-rc.1 in the CLI/browser matrix; use 0.2.0-rc.1 as the default development runtime.
- Admit DSH versions `>=0.1.7-rc.1` without an upper version ceiling, retaining required authentication API and package identity checks. Later versions are forward-admitted, not individually verified.

## 0.1.1 - 2026-09-28

- Documented installation from the published npm package in English and Chinese.
- Made the release workflow publish the tested archive by an explicit file path, with a dedicated archive preparation command.

## 0.1.0 - 2026-09-28

- Initial public release of the single-user DSH remote authentication plugin.
- Added password sign-in, TOTP setup, one-use backup codes, and revocable sessions.
- Added browser route, API, stream, and WebSocket protection plus profile administration commands.
- Added English and Chinese deployment, development, and test documentation.
