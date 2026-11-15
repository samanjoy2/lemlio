# Lemlio 1.6.7

- Bundle a checksum-verified uv manager. Tool setup uses an application-owned Python installation under Lemlio's tools folder, independent of other applications and system Python choices.
- Offer Python setup during Windows installation and Setup / Repair runtime under Settings → Tools. Repair preserves installed tool packages.
- Add `lemlio_run_tool`, a native runner for enabled, registered tools. It supplies the shared environment and returns actual exit status and diagnostics. Older chats and the alternate assistant can use the same runner through Lemlio's command-line fallback.
- Successful compilation atomically updates the PDF beside the selected source file, including nested files such as `latex/main.tex`. Failed builds keep the previous good project PDF. Locked output files produce an explicit save error.

Python needs a first download during setup. A tool's third-party package installation still requires the existing explicit confirmation; the agent runner cannot install or enable tools. Bundled uv is distributed under its MIT license.
