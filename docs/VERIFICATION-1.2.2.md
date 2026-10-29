# Lemlio 1.2.2 verification

This release keeps the `com.lemlio.desktop` profile used by 1.2.1. It does not reset project storage, OAuth configuration, or the Drive connection.

## Automated checks

- Frontend: 161 tests passed across 23 files.
- Rust backend: 123 tests passed.
- TypeScript and Vite production build passed.
- Biome repository check passed.
- Windows NSIS installer compiled successfully with the per-user Imports/Archives creation hook.

Regression coverage includes copied-folder discovery without rewriting the catalog, repeat discovery without duplicate entries, PDF stability while browsing bibliography/section files, late compile results from another root, queued backup retries, and dictation stopping/ignoring late transcript events.

## Google Drive

The folder backup was exercised against the connected Google account using an existing project already designated for automatic backup. Google confirmed 22 files uploaded into a normal project folder. A second run uploaded zero files and skipped all 22 unchanged files using Drive's file checksums. No source project files were modified. No credentials or document contents are included in this report.

Uploads preserve ordinary files and nested folders. Backup is one-way: local changes update the managed Drive copy; remote edits are not downloaded automatically. Local deletions and earlier ZIP backups are not deleted remotely.

## Interface

The current React components were rendered with harmless demonstration documents in an isolated browser. Dark and light project/editor views, the colorful chat border, main-file badges, backup age, and the compact thinking indicator were visually checked. The header begins at the top of the app with no extra Windows titlebar spacer. A long Python environment path was checked: the dialog's content width matched its container instead of overflowing.

README screenshots use generated demonstration fixtures, including simulated connection/agent states; no account details, OAuth JSON, or personal project content is shown.

## Practical limits

- Windows speech dictation requires a Windows speech recognizer and microphone permission. This PC has no installed recognizer, so actual live speech recognition could not be tested. Draft insertion, recording cleanup, and late-event rejection are covered by tests. Settings → Voice opens the Windows language setup.
- Installation/update behavior was checked against the generated NSIS script and stable application identity. The user's installed app was not silently replaced or reset during verification. Close the app and run the new installer, choosing to continue without uninstalling for an in-place update.
- The Windows installer is unsigned. Downloads from the private repository require repository access.
