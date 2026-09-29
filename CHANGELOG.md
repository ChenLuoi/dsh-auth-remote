# Changelog

[简体中文](CHANGELOG.zh-CN.md)

This file records user-visible changes to the released package. Version numbers follow the package's `package.json`; release tags use the same number with a `v` prefix. Add changes under Unreleased while developing, then move them to a dated version before tagging.

## Unreleased

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
