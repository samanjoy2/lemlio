# Lemlio 1.2.4 verification

## Automated checks and build

- Frontend: 168 tests passed across 25 files.
- Rust backend: 134 tests passed.
- TypeScript, Vite production build, and the repository Biome check passed.
- Windows x64 NSIS installer built successfully. Its generated file list includes the Latin Modern font files, license, and manifest.

New regression coverage includes ZIP repeatability, empty files and local deletion handling, local change detection, folder-to-ZIP migration, conflict upload blocking, confirmation of the exact reviewed remote checksum, source-of-truth preservation, backup summary accuracy, safe deletion targets, XML-escaped font paths, and staged EPS references.

## Drive backup reset and ZIP verification

The configured old Lemlio backup folder was moved to Drive's Trash through the signed-in Google Drive page after Google rejected the app-only reset with `appNotAuthorizedToChild`. Its original folder contents remain recoverable through Drive's normal Trash flow. No broader OAuth scope was requested, and the existing sign-in configuration was retained.

A fresh Lemlio backup folder was created. All 42 local imported project folders, containing 947 source files, were successfully uploaded as 42 ZIP archives. Each upload required Google's returned SHA-256 checksum to match the local archive. A repeat backup of the 30-file regression project uploaded zero archives and skipped its one unchanged ZIP. Local project files were not replaced with Drive content.

The application keeps PC files authoritative. It uploads complete ZIP snapshots, including nested assets and empty files, and detects local additions, modifications, and deletions. It does not download Drive files into working projects. A changed remote ZIP raises a conflict instead of being silently overwritten. The user can replace the specific reviewed remote version with the PC snapshot or keep the Drive copy and pause that project's backups.

## Interface checks

Actual project card, backup summary, conflict dialog, deletion dialog, CodeMirror editor, and app context menu components were tested with neutral demonstration data in an isolated browser.

- Project right-click: Open, Rename, Open folder, Export ZIP, Star, Delete.
- Library right-click: New project, Import ZIP, Open folder, Refresh, Settings.
- Editor right-click: Undo, Redo, Cut, Copy, Paste, Select all, Toggle comment, Save, Compile, Open folder, Delete, Settings.
- Nested project menus retained their actions instead of opening the outer library menu.
- Deleting a project displayed confirmation; cancellation did not call the native delete command.
- The Windows Recycle Bin operation was exercised with a newly created disposable test folder under the workspace's `.tools` directory. No user project was deleted.
- Editor Toggle comment and Undo changed and restored the actual CodeMirror document. Ctrl+X in text inputs was no longer intercepted by the PDF capture shortcut.
- Conflict review sent the reviewed remote checksum on replacement. Keeping the Drive version paused uploads without changing PC document content. The all-project summary only reported complete backup when every project had a confirmed current snapshot.

## Tectonic fonts and figures

Latin Modern 2.005 was obtained from CTAN with a pinned archive SHA-256 and bundled with its GUST Font License and manifest. A generated Fontconfig configuration exposes these fonts plus installed Windows fonts to bundled Tectonic without installing system fonts.

A direct Latin Modern Sans test, including bold and italic, compiled successfully. The actual Cambridge poster that reported the missing font compiled successfully through the application with Tectonic to a 93,239-byte PDF. SHA-256 checks confirmed all nine checked original source and logo files were unchanged. Its EPS logo was converted only in the staged build copy using the existing installed converter. Tectonic remained the compiler.

All 13 affected imported CVs also compiled successfully with the final release binary. Original top-level `.tex`, `.sty`, and `.cls` files remained unchanged in each project.

## Limits

- Automatic backup runs while Lemlio is open, connected, and auto-backup is enabled. Saved edits debounce for about 15 seconds; local changes and pending jobs are checked every minute. A failed or paused project is not described as fully backed up.
- Project deletion moves the folder to the Windows Recycle Bin after confirmation. Existing Drive ZIPs remain as recovery copies.
- EPS conversion needs an installed Ghostscript-compatible converter. Without one, use PDF figures or install a converter. Custom fonts outside the bundled Latin Modern family may still require installation.
- Windows dictation still requires a speech language and microphone permission; this release does not install a Windows speech recognizer.
- The installer is unsigned. It retains the stable app identity, project storage, local settings, and Google connection. The user should run the new installer to update the installed application.
