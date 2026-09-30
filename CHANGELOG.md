# Changelog

[简体中文](CHANGELOG.zh-CN.md)

This file records user-visible changes to the released package. Version numbers follow the package's `package.json`; release tags use the same number with a `v` prefix. Add changes under Unreleased while developing, then move them to a dated version before tagging.

## Unreleased

No changes recorded yet.

## 0.1.3 - 2026-09-30

- Verify DSH 0.2.0-rc.2 and add it to the CLI, installation smoke, and browser CI matrix, retaining all previously tested versions.
- Use DSH 0.2.0-rc.2 as the default development, test, and release verification runtime; update pinned development dependencies and English/Chinese setup guides.
- Match the chat completion status used by both older DSH runtimes and 0.2.0-rc.2 in the HTTPS forwarding regression.

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
