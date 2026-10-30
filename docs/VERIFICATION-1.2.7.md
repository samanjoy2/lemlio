# Lemlio 1.2.7

This update includes all 1.2.6 conflict-download changes on Windows and macOS, plus fixes for recurring conflict warnings and backup names.

- Ignore a background Drive status response when the local backup status has changed since that request started. An older response cannot undo a newer PC-version decision.
- Preserve the user's pause when a background upload finishes late. Explicitly choosing the PC version resumes that project's backups only after success.
- Treat regular and verbatim Windows paths as the same project, including legacy stored backup-status keys.
- Queue an explicit rename job when the project title changes, retain it across offline retries and later file edits, and do not discard it just because source files are unchanged.
- Preserve a ZIP filename renamed directly in Drive on ordinary backups. Renaming in Lemlio explicitly updates the backup filename.
- Download a conflicting Drive version into a new local project, verify its ZIP checksum, transfer its Drive link, and keep the older local folder paused. PC files are not silently replaced.

Drive filenames and local display titles are separate. This is not a collaborative rename notification or an activity feed showing who changed a name.

Windows uses Credential Manager and macOS uses Keychain. Both Mac architectures include Tectonic and Latin Modern fonts; Mac packages are ad hoc signed and are not Apple notarized. Physical Mac UI testing remains outstanding.

## Verification results

- Windows: 189 frontend tests passed across 30 files; 141 native tests passed, with the connected-Drive test excluded from the default run.
- The separate live Drive test passed with disposable generated data: restored source and binary files matched, an unchanged snapshot was skipped, and later local edits updated the same remote archive. Original test source files stayed unchanged. Only the generated test archive was moved to Trash afterward.
- TypeScript and source formatting checks passed. Windows installer packaging completed.
- Native Mac packaging and bundled-compiler checks: https://github.com/samanjoy2/lemlio/actions/runs/41063157259

## Updating earlier installations

The repository and release downloads are public. Older Lemlio versions can open Settings → About → Download latest update. Close the running app, then run the newer Windows installer, or replace the app in Applications on macOS. Existing project folders, settings, and account connections are retained. The earlier versions have no automatic updater; publishing a release cannot remotely replace those installed applications.

## In-app update checks

Settings → About → Check for updates reads the latest public GitHub release, compares versions numerically, and offers the installer for Windows x64, Mac Apple Silicon, or Mac Intel. Download starts only when the user clicks; it opens the browser. Installation remains manual: close Lemlio and run setup or replace the Mac app. No silent installation or retroactive update mechanism is claimed for earlier versions.

Version checks handle offline errors and do not offer downgrades. Existing local titles saved before this update are included in backup revision checks; old generated backup filenames are updated to those titles while custom filenames set in Drive are preserved on ordinary backups.

The extended live test also exercised the conflict-download action against a generated Drive ZIP: the old local source stayed unchanged, the new copy retained the same archive ID, the old folder's backup link was removed, and a backup of the new unchanged copy uploaded nothing. The test then moved only its exact generated remote archive to Trash.
