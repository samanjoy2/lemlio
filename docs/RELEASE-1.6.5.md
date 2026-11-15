# Lemlio 1.6.5

- Save a compiler per project: Tectonic, pdfLaTeX, XeLaTeX, or LuaLaTeX. Editor, thumbnail, and agent compilations share that choice.
- Prefer latexmk for installed MiKTeX / TeX Live builds; report engine mismatches instead of silently using XeTeX.
- Resolve declared OpenType families from project or bundled files, report missing fonts, and stop rather than publish PDFs with logged font substitutions or missing glyphs.
- Add compiler diagnostics with the actual executable/version, package/font log entries, and prepared font checksums.
- Keep Settings the same size across tabs, widen the window, and wrap navigation into additional rows on narrow windows.
- Wrap long ZIP project names and paths without pushing import controls outside the dialog.
- Add optional Handy voice input on Windows and macOS, with detection, setup, executable selection, chat microphone controls, and cancellation on chat close. Handy and a local speech model are installed separately.

Tectonic stays bundled and remains the default for fresh installations. System engines are optional. Matching an older service's PDF requires the same engine, fonts, and compatible packages; environment diagnostics do not pin a full distribution. Handy's CLI integration is beta upstream; its own overlay confirms recording status.
