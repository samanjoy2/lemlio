<p align="center"><img src="assets/lemlio.svg" width="88" alt="Lemlio logo"></p>
<h1 align="center">Lemlio</h1>
<p align="center">A desktop LaTeX workspace with PDF previews and Codex.</p>
<p align="center"><a href="https://github.com/samanjoy2/lemlio/releases">Windows releases</a> · <a href="#getting-started">Getting started</a> · <a href="#building-from-source">Build from source</a> · <a href="LICENSE">MIT license</a></p>

![Lemlio project library](assets/screenshots/projects.png)

## Your documents, in one place

Browse projects by PDF preview, search by title, star favorites, and switch between cards and a list. Project cards show creation and modification dates, and titles can be renamed without breaking document paths.

| Feature | What it does |
| --- | --- |
| LaTeX + PDF | Edit source beside the compiled document, with source navigation and PDF selection. |
| Codex | Uses your existing Codex sign-in, streamed conversations, model selection, approvals, and saved chats. |
| Model default | GPT-6 Luna is the economical default. Other models can be selected in chat; access depends on your account. |
| Compiler choice | Use an installed MiKTeX / TeX Live distribution, or the included Windows Tectonic engine. |
| Activity feedback | Centered compilation orb, a subtle working border, and a labelled Stop agent control. |
| Auto or manual | Compile after edits, or switch to manual and compile when ready. |
| ZIP import / export | Import projects into the app’s Projects folder, preserve figures and bibliography, and export them again. Copy or move the original ZIP. |
| Research skills | View installed Codex skills in one library. |
| External editor | Open the project folder or continue in an installed VS Code editor. |
| Settings | Appearance, Codex connection, compilers, skills, backup guidance, and About. |

## Getting started

1. Install the Windows setup executable from Releases, or extract the portable ZIP into a writable folder.
2. Open Lemlio. The first-run Settings screen lets you connect Codex and choose a compiler. You can close setup and configure these later.
3. Create a project, open a folder, or choose **Import ZIP**.

Codex is optional for editing. Connect using your existing ChatGPT/Codex sign-in. AI requests use your account’s allowance; Lemlio does not include an additional AI subscription. Model availability and usage depend on your provider and plan. [Official Codex pricing](https://learn.chatgpt.com/docs/pricing).

MiKTeX can be installed separately using the link in **Settings → Compiler**. Tectonic is packaged with the Windows release and may fetch TeX packages during compilation. Some documents require a system compiler or additional fonts/packages.

![Compiler settings](assets/screenshots/compiler.png)

## Import and export

**Import ZIP** accepts a LaTeX project or a Prism library export. Projects are stored under `Projects/Imports`, preserving nested source folders and binary figures. Reimporting creates a new folder instead of replacing an existing project.

- **Copy project** keeps the original ZIP where it is.
- **Move ZIP** registers the project first, verifies a saved archive, then moves the original into `Projects/Archives`. A failed move keeps the original and displays a message.
- **Export project ZIP** is available on project cards and in the editor sidebar. It saves open edits first. Project files and empty folders are included; app caches, Git metadata, app history, virtual environments, and node_modules are excluded.

PDF cards use a matching compiled PDF where available; missing previews are compiled using the system compiler. A failed preview falls back to a document card. Project dates reflect local filesystem timestamps.

## Google Drive backup

Open **Settings → Backup** to connect your own Google account:

1. Create a Google Cloud project, enable Google Drive API, and configure the OAuth consent screen. Add your account as a test user while the OAuth app is in Testing.
2. Add the non-sensitive `https://www.googleapis.com/auth/drive.file` scope.
3. Create credentials with application type **Desktop app** and download the OAuth JSON.
4. Choose **Choose OAuth JSON** inside Lemlio, then **Connect Google Drive** and approve the Google sign-in.

The JSON is copied into local app settings outside your projects. Access and refresh tokens are stored in Windows Credential Manager. Keep the original JSON in `Keys/` or outside your project folders. `Keys/`, standard OAuth-client JSON filenames, and the app’s saved configuration are excluded from source publication/project exports; no credentials are shipped in releases.

**Back up automatically after saving** creates versioned project ZIPs in a `Lemlio Backups` folder in your Google Drive after an editing pause. Pending jobs stay locally queued when offline and retry while Lemlio is open, including after restarting the app. **Back up all projects** saves the initial library; **Back up open project** makes a manual snapshot. Existing backups remain until you remove them in Drive. Download a backup ZIP from Drive and import it to restore a project.

Standard Drive API use has [no additional API charge](https://developers.google.com/workspace/drive/api/guides/limits); uploads use your Google storage. OAuth apps in Testing may require reconnection. Drive for desktop folder sync is also an option, but is not required for the direct connection. Background backups require Lemlio to be running.

## Privacy and storage

Documents, compilation, and project history are local. Codex sends prompts and the files it uses to the configured model provider. Direct Google Drive backups upload the projects you back up or save with automatic backup enabled. Personal projects, archives, credentials, and local build tools are excluded from this source repository.

## Building from source

Requires Node.js 22+, pnpm, Rust, and the platform’s Tauri build prerequisites. On Windows, install Visual Studio C++ Build Tools and WebView2.

```powershell
pnpm install
powershell -ExecutionPolicy Bypass -File scripts/prepare-windows.ps1
pnpm --filter @prismpro/desktop build
pnpm --filter @prismpro/desktop tauri build --bundles nsis
```

The internal workspace package name remains `@prismpro/desktop` for compatibility. Windows installer output is under `apps/desktop/src-tauri/target/release/bundle/nsis`.

```powershell
pnpm --filter @prismpro/desktop test
cargo test --release --lib --manifest-path apps/desktop/src-tauri/Cargo.toml
```

The release workflow builds a Windows installer and publishes it when a `lemlio-v*` tag is pushed. GitHub signing credentials are not required for an unsigned release; Windows may identify unsigned installers as an unknown publisher.

## Credits and license

Lemlio builds on [Claude Prism by delibae](https://github.com/delibae/claude-prism), with substantial changes to AI integration, project management, compilation, transfers, and the interface. Original MIT copyright notices are retained in [LICENSE](LICENSE). Loading animations use [thinking-orbs](https://libraries.dev/orbs). The VS Code icon is from [Microsoft’s VS Code repository](https://github.com/microsoft/vscode).
