# Changelog

[简体中文](CHANGELOG.zh-CN.md)

This file records user-visible changes to the released package. Version numbers follow the package's `package.json`; release tags use the same number with a `v` prefix. Add changes under Unreleased while developing, then move them to a dated version before tagging.

## Unreleased

## 0.3.3 - 2026-10-30

- Add DSH `0.2.1-rc.5` to the compatibility declaration and CLI, complete browser and installation-smoke matrices. Retain all existing supported releases and the `0.2.2-alpha.2` development default and recommendation.
- Cover native `0.2.1-rc.5` ↔ `0.2.1-rc.4` host switching, Search/Fetch settings and navigation, while retaining authentication, account sign-in and hot-reload regression coverage.
- Rewrite the English and Chinese README around current installation and usage. Remove outdated candidate and retired-version descriptions, repeated capability version lists and the LiveShare compatibility section.

## 0.3.2 - 2026-10-28

- Add DSH `0.2.2-alpha.2` to the original seven exact targets and pin the development default and manual migration recommendation to it. Retain DSH `>=0.2.1-alpha.3`, forward admission and plugin Node `>=24`.
- Gate native named/fallback HTTP resources before Fetch conversion while preserving native routing, ETag/HEAD, stream cancellation and in-process peer reads.
- Isolate LiveShare viewers from the administrator client; restore trusted business Origin only for the two native Owner-login POSTs. Verify basic flows with a local Relay protocol stand-in and keep share/session lifetimes independent; real Relay/OAuth and visitor business operations are outside that verification.
- Make CLI text fixed English and remove `--lang` and environment-language selection; old language arguments are invalid. Preserve JSON fields, exit codes, confirmation and secret-input contracts.
- Complete browser English, Chinese, Japanese, Spanish, French, German, Russian and Brazilian Portuguese without expanding old DSH language catalogs. Remove the login language selector; use new `dsh-auth-remote-lang` memory, then `navigator.language`, then English. Remember only native accepted preferences and keep them on sign-out. Ignore, retain and do not migrate old `dsh-auth-remote.locale`.
- Extend native caching, mux compression/expiry/revocation, host switching, UI and genuine HMR failure/rollback regression while retaining ACCOUNT/HMR, allowedOrigins and shared security checks.

- Clean regular build output before emission so deleted modules leave no stale published declarations.

## 0.3.1 - 2026-10-28

- Publish `0.3.1` for seven exact DSH releases, adding `0.2.1-rc.3` and `0.2.1-rc.4`; use `0.2.1-rc.4` by default and require DSH `>=0.2.1-alpha.3`.
- Retire six older hosts with plugin `0.2.0` as their last supported plugin. Mark `0.2.1-alpha.3`, `0.2.1-alpha.4` and `0.2.1-alpha.5` legacy from 2026-10-28, with earliest retirement eligibility 2026-11-11 (Asia/Shanghai); dates do not automatically stop support.

- Remove retired-host-only IPv4/TLS/protocol/public-URL and direct Settings branches. Remove old theme fallbacks and delegate focus color to native rules while retaining shared authentication, Secure, revocation and TLS-failure cleanup. Keep account callback, HMR context and old allowedOrigins configuration migration.
- Extend six real host-switch pairs, three Search/Fetch targets and both new RC menu/model-selection regressions, rejecting missing registration or zero-case false success. Point native model baseURL at a local stub before first key entry, preserve credential-free onboarding, and require zero model calls for UI cases.
- Add independent retired-host installation rollback/whole-package Loader refusal verification. Full/releases verify adjacent `0.2.1-alpha.2`; ordinary accepts only its planned skip. This migration additionally verifies all six retired hosts against the same candidate digest.
- Synchronize bilingual current support, bidirectional history, development/deployment/release and migration/rollback guides. Preserve both previous-release support policies unchanged; preparation dates do not establish npm publication.

## 0.2.0 - 2026-10-19

- Regenerate stable Cordis/Schemastery lockfile resolutions and peer snapshots for clean frozen installs; shorten managed verification profiles and test real Unix socket binding at the default CI checkout length.

- Synchronize current normal/legacy dates, two-way history navigation, adaptation evidence and frozen-artifact operating guides without retiring any supported DSH version.

- Add manually maintained bilingual, bidirectional support history with exact historical evidence, archive availability and clear separation of published releases from the RC candidate.

- Add conservative ordinary/full CI planning: keep every-release CLI/smoke, fixed browser capability suites for six low-risk paths, full verification for all other changes and weekly Monday UTC checks.

- Build one release artifact, verify its producer identity across all declared CLI/smoke and complete-browser targets through a shared workflow, and gate publication on the same successful artifact.

- Add fixed-archive CLI/browser/smoke consumption with SHA-256 and package checks, restored dist, explicit suites, strict test counts and an isolated ephemeral-port smoke profile.

- Require independent profile-level native-listener disable for protected remote deployments; verify real Loader bundle skipping and plugin runtime refusal on both RC targets without listener fallback.

- Emit process-scoped startup maintenance warnings for legacy or unverified DSH versions, preserving warning history through HMR. Keep technical admission independent of dates and record no actual retirement.
- Verify the native DSH `0.2.1-rc.2` Search/Fetch settings over the protected remote Host, including three namespaces, test-credential redaction, persistence and session refusal, without invoking paid providers.
- Add candidate targets DSH `0.2.1-rc.1` and `0.2.1-rc.2`, pin development/default verification to `0.2.1-rc.2` with stable Cordis and Schemastery, and retain all eleven release targets. Correct account branches and four real host-release round trips; assert visible focus and switch thumbs on older themes. These additions do not change published `0.1.10` history.
- Publish bilingual support-lifecycle rules with explicit legacy dates, continued verification until actual retirement, independent technical admission and exact-version release evidence requirements.

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
