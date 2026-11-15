# Verification — 1.6.6

- Frontend: production TypeScript/Vite build and 251 tests passed. Changed UI files passed Biome. The optional Handy test verifies commands and avoids starting a second microphone stream.
- Native: 191 tests passed, with one opt-in live backup test excluded. New tests cover portable compiler persistence, invalid profiles, engine mismatch rejection, missing-font reporting, portable font mappings, malformed font metadata, and Handy action validation.
- Real Windows compiler checks: generated projects compiled through Lemlio's release executable using bundled Tectonic, installed XeLaTeX, and installed LuaLaTeX. Each used the same declared Latin Modern family with bold and italic faces; source files remained unchanged. A missing font in an existence-test/fallback branch failed with its name as expected.
- Reference comparison: an isolated copy of the supplied 27-page paper compiled through Lemlio's saved pdfLaTeX profile. All 27 pages had identical extracted page text to the supplied Prism reference; 3,714 aligned text lines had identical positions in MuPDF's structured-text extraction. First-page renders were inspected. Prism reported pdfTeX 1.40.28; the installed compiler reported pdfTeX 1.40.27. This is a layout comparison, not a claim of byte-identical PDFs or exhaustive pixel equality.
- The same source through bundled Tectonic logged missing en/em dash glyphs in its legacy text font. The new font policy rejected that PDF and suggested selecting the original engine.
- Browser layout checks used real React components with fictional native responses: the ZIP dialog had equal client/scroll widths and visible actions despite a long name/path; Settings kept identical dimensions across five tabs; navigation wrapped into three rows at 420px without horizontal overflow. Settings and Handy setup screenshots were inspected.
- Handy's documented CLI controls were verified against upstream documentation and covered by wiring tests. No live audio transcription or Handy model download was performed. Native macOS compilation, packaging, and compiler smoke verification run in GitHub Actions; a physical Mac UI was not tested locally.

Private manuscript files, PDF comparison images, and local diagnostics remain outside tracked release files.

The canonical-path regression test verifies that an existing folder, an alias containing `nested/..`, and its canonical path share one receipt key. Existing folder-sync tests pass with this normalization.
