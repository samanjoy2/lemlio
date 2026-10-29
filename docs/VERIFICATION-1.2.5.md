# Lemlio 1.2.5 verification

## Scope

Windows installer plus native macOS Apple Silicon and Intel disk images. Persistent project covers, guarded app closing, explicit Drive restoration onto a new device, and per-device conflict detection.

## Automated checks

- Frontend: **182 tests across 29 files passed**; TypeScript production check passed.
- Rust: **138 passed**, one connected-Drive integration test intentionally excluded from the default run.
- Connected-Drive integration: explicitly run and passed with disposable generated LaTeX and binary data. The test uploads one project, emulates its absence on a new device, restores it to a separate local folder, checks source and binary bytes, confirms an unchanged backup is skipped, and verifies a later local edit replaces the same remote ZIP. The original generated source stays unchanged. Only the exact test-created remote archive is moved to Trash afterward.
- Thumbnail tests cover disk-cache reuse without PDF rendering, first-generation deduplication, persisted fallback after failure, and non-detached viewer bytes.
- Save tests cover serialized disk writes and edits arriving during a save. Closing tests cover verified backups, the skip preference, pending/disconnected backups, active compilation, and failed local saves. The Tauri close/destroy capability has a regression check.
- Native ZIP tests cover traversal rejection, duplicate paths, original archive preservation, and restoration into a new folder when a local folder with the same name exists.
- Conflict tests cover a legitimate upload by another Lemlio device and require the exact remote version reviewed by the user before overwriting it. Idle-project polling has a frontend regression test.

## macOS packaging

Both architectures build on native GitHub macOS runners. The workflow tests frontend and Rust code, produces a DMG, verifies the app's ad hoc signature, rejects Homebrew-linked dependencies, and compiles a real fontspec document with Latin Modern Sans regular, bold, and italic using the compiler inside the packaged app.

Final packaging run: https://github.com/samanjoy2/lemlio/actions/runs/40938243985

Initial complete packaging verification: https://github.com/samanjoy2/lemlio/actions/runs/40933682102

## Behavior and limits

- Connecting Drive does not download projects. **Restore from Google Drive** explicitly downloads selected archives into new local folders; it does not overwrite working files. Use the same Google account and OAuth project to access the existing backups.
- After restoration, local files are the working source. Per-device confirmed hashes detect changes from other devices. There is no automatic merge or silent cloud-to-PC overwrite.
- Backup requires the app to remain open. Closing checks current local revisions and remote backup metadata. Pending/conflicting/unsaved work is never skipped by the “don't ask again when backed up” preference.
- Covers are stored locally and refreshed by compilation. Opening the library reuses cached images, including a persisted fallback after a failed attempt.
- Collections remain predefined and inferred from original folder/project/main-file names. Display-title edits do not recategorize projects; custom categories are not implemented.
- Windows uses Credential Manager; macOS uses Keychain. Personal projects and OAuth JSON are not included in release packages.
- Mac builds are ad hoc signed, **not Apple notarized**. Interactive testing on a physical Mac has not been performed here; native CI compilation and packaged-compiler checks are recorded above.
- Windows speech recording remains Windows-only. macOS uses its system Dictation shortcut; the microphone button opens Voice setup.
- Latin Modern is bundled. Arbitrary missing fonts are not downloaded automatically. EPS conversion still requires an available Ghostscript/system converter.
