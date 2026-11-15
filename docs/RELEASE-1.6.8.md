# Lemlio 1.6.8

Includes everything described in the 1.6.7 notes (bundled uv manager, the native tool runner, PDFs saved beside the source file), plus:

- Claude Code: a short `lemlio-compile <main.tex> [--system]` command is always available on the assistant's PATH and allowed in both PowerShell and Bash, so compiling no longer fails on how a path is quoted.
- When Claude is refused a command, the chat shows a "Permission needed" card with the exact command: Allow once and continue, Always allow in this project, or Not now. Nothing runs until you choose; only narrow one-line Bash or PowerShell commands can be approved this way.
- Compiling with an installed MiKTeX or TeX Live no longer gets stuck on "Nothing to do… gave an error in previous invocation". After a failed run Lemlio clears latexmk's failure record, and if latexmk still refuses to run it forces one full rebuild, so the real error is always shown.
- Both assistants are told to explain which compiler engine to choose instead of changing the user's content to make a document compile.

Note: the previous Dropbox, template and collection changes shipped in 1.6.1–1.6.4.
