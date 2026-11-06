# Lemlio 1.3.1

Codex now gets dedicated compiler and PDF inspection tools. Previously, its instructions only mentioned editor auto-compilation; the bundled Tectonic path and native compile pipeline were not exposed to the agent. Terminal discovery could therefore fail even though Lemlio itself could compile.

- New threads register `lemlio_compile` and `lemlio_view_pdf_page` using the [Codex App Server dynamic-tool interface](https://learn.chatgpt.com/docs/app-server). The client opts into the documented experimental API.
- The host binds requests to the thread's project. The frontend verifies that this project is open, rejects traversal and dirty edits, and uses the editor's selected main file and compiler through its existing native compile command. Agent-supplied arguments cannot select an arbitrary project directory.
- The compile result contains actual diagnostics and updates the editor's PDF cache. Failed compiles invalidate the agent's previous verified snapshot.
- PDF inspection returns an actual PNG, with page selection, bounded image dimensions and size, and explicit last-compilation semantics. At most two project snapshots remain cached for this purpose.
- Chat/history display includes compiler tool activity and text results without copying image payloads into chat cards.
- The bundled compiler directory is added to the spawned Codex process PATH. Existing pre-tool chats receive a native CLI fallback; new chats are recommended after upgrading. The compiler resolver is shared with the existing native pipeline, including bundled fonts and staging.
- Model instructions prohibit claiming compilation or visual verification without doing the checks.

## Reader, library and Drive changes

- Fixed the text-selection layer for MuPDF 1.27's flat structured-text format; older span output remains supported. Fixed a pixel-buffer lifetime error and release native page, text, link and pixmap resources after use.
- Added exact PDF search highlights, match navigation, lazy page thumbnails, system-reader opening for printing, and default fit-to-width. Raster resolution follows zoom and display scaling with bounded memory. Normal double-click selects words; source navigation uses modifiers.
- Recompilation leaves the previous PDF sharp with a compact, nonblocking indicator. Toolbar controls wrap at narrow panel widths.
- Clone project saves open edits and copies transferable files into an independent library folder, excluding caches and Drive identity. Native copy validation detects source edits and avoids cloning the library into itself.
- Drive remote verification is limited to five-minute intervals; focus/minimize/restore does not force a check. Saved edits still debounce for 15 seconds and retries/local discovery run every minute.
- Missing remote projects produce a review/download notice, deduplicated by stable project identity. Connecting never silently restores a new project. Competing branches remain a user choice.
- Uses official PanelUI web source components (MIT), with shared buttons/inputs, settings tabs/switches, clone dialog, library compiler selector and Drive notices. The requested CLI creates a separate Expo app, so it was not run over this Tauri project. Only Base UI and tailwind-variants were added as dependencies. Attribution is bundled in installers.

## Verification

Frontend production build and all 201 tests passed. Windows native tests passed 147 tests; one opt-in live Drive test was not run. Repository-wide Biome CI passed; the corresponding GitHub lint run also passed after a packaging-JSON formatting correction. A real signed-in Codex smoke test accepted the tool schemas, called the actual Lemlio compiler on a generated project, correctly identified the blue heading in its rendered PDF, resumed the thread with its tools, and received a deliberately introduced compilation error. The generated chat was archived. No credential files were read by the test script.

Isolated browser checks used fictional projects with real MuPDF rendering: selectable words, 3 exact search hits, lazy thumbnails, no clipped controls at a 382px PDF pane, no recompile blur, clone dialog and settings navigation. Checked dark/light appearance and a 2x display (1901 canvas pixels for 475 CSS pixels). No real project or Drive archive was modified.

Windows NSIS packaging passed. The built 1.3.1 executable compiled a generated Latin Modern Sans document using bundled Tectonic to a 5,463-byte PDF. The real Codex compile/image/error check passed again against this exact executable. The Windows installer SHA-256 is `a244fe75cef7ea8c7fd78286bef8c846f22c041516157ec6e537f6168f275d26`.

Both Mac architectures passed **201 frontend tests and 145 native tests** (one opt-in live Drive test excluded), app signature/dependency checks, and compilation with bundled Tectonic and Latin Modern fonts. Each smoke PDF was 5,463 bytes. [Mac verification workflow](https://github.com/samanjoy2/lemlio/actions/runs/42159068167).

All three installers were downloaded/read locally and matched GitHub's asset SHA-256 digests:

```text
99e5ca9b504d478765aedd197fa60b527ebb078dae9588ccfe41404061d75a2a  Lemlio_1.3.1_AppleSilicon.dmg
d668e46847cef85fd5d03180a653636f80ede55b1c03028b116fe1bb1457e500  Lemlio_1.3.1_Intel.dmg
a244fe75cef7ea8c7fd78286bef8c846f22c041516157ec6e537f6168f275d26  Lemlio_1.3.1_x64-setup.exe
```

Production source: `1684d5c0d9557598870981e901539e4d4254044e`. Later commits change packaging JSON formatting and verification documentation only. Physical Mac UI testing is unavailable on this Windows PC; Mac packages remain ad hoc signed and not Apple notarized.
