# Repository instructions

@/home/chen/.codex/RTK.md

## Compatibility changes

Before changing supported DSH versions, read [the legacy compatibility inventory](docs/legacy-compatibility.md). This applies to manifest peers and `dsh.compatibility`, runtime admission, test targets, CI matrices, and user-facing compatibility statements.

For each `dsh-runtime` entry, compare its applicable versions with the resulting supported set. Keep the adaptation while the intersection is nonempty. When it becomes empty, remove its exclusive implementation and tests and update the inventory and guides in the same change. Keep shared security checks and tests. Missing evidence forbids retiring an adaptation; record the gap and obtain exact-version evidence.

Retire `plugin-contract` entries only under their own migration policy. Reducing DSH support does not end support for old plugin configuration. Update affected inventory entries whenever compatibility code changes. The inventory is a single Chinese maintenance document, reviewed manually and by local agents; do not introduce a script or CI gate for it.

Follow the bilingual contribution and development guides. Keep task documents, this file, test credentials, generated output, and runtime profiles out of the npm archive. Use isolated profiles for verification.
