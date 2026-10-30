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
