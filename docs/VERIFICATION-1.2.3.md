# Lemlio 1.2.3 verification

This update retains the `com.lemlio.desktop` application identity and existing project storage, settings, and Google Drive connection.

## Automated checks

- Frontend: 163 tests passed across 24 files.
- Rust backend: 127 tests passed.
- TypeScript and Vite production build passed.
- Biome repository check passed (144 files).
- Windows x64 NSIS installer built successfully.

New regressions cover PDF render resolution and size limits, exact Drive upload lengths including empty bodies, checksum-free empty file matching, and reachable LaTeX preamble option handling.

## Tectonic

All 13 imported CV projects with shared `cv_settings.tex` compiled successfully through the full application compilation path using Tectonic. SHA-256 comparisons confirmed their original top-level `.tex`, `.sty`, and `.cls` sources were unchanged.

The compatibility step collects literal xcolor options from the main document and reachable local preamble files, then passes those options before packages load in the staged build copy. It preserves original source line numbers. Tectonic remains the default compiler. This specifically addresses package option clashes; missing or corrupt figures and other document errors still need valid project assets.

## Google Drive

An existing connected project containing a zero-byte file completed a normal folder backup: 15 files uploaded and 15 skipped. An immediate second backup uploaded zero files and skipped all 30 unchanged files. Google confirmed both runs successfully. No OAuth configuration was reset.

Upload initialization and chunks declare their exact content lengths. Empty files use a separate metadata-only creation or empty media update, rather than a zero-length resumable chunk. Empty remote files without a checksum are recognized on later runs.

## Interface and PDF rendering

The actual PDF preview and sidebar components were rendered with a neutral demonstration PDF in an isolated browser at 1440 × 1000. The compilation overlay and PDF body had identical bounds (top 81 px, bottom 1000 px), leaving both toolbar rows fully visible without a partial uncovered strip. The sidebar actions and project title had a 12 px horizontal gap.

A PDF canvas rendered 1191 pixels across at approximately 595 CSS pixels: two raster samples per CSS pixel on a standard-density display. Higher-density displays use additional samples within a 12-million-pixel / 8192-pixel-edge limit. Display-density changes trigger rerendering.

The home Connections card now includes Voice with a recognizer-based Ready/Setup status and a link to Voice settings. Ready indicates an installed speech recognizer; microphone access is checked when recording starts.

## Practical limits

- This PC has no Windows speech recognizer installed, so live microphone transcription remains unverified here. Existing tests cover draft insertion, stopping, and ignoring late transcript events.
- Drive backup remains one-way. It updates managed remote files and does not automatically download remote edits or remove old backups.
- The generated installer was built and inspected; the user's running application was not closed, reset, or silently replaced. Close Lemlio and run the installer to update the installed app.
- The Windows installer is unsigned. The private GitHub repository requires access to download releases.
