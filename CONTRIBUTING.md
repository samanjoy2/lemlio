# Developing PrismPro

See [README.md](README.md) for setup, build commands, and Codex integration details.

The frontend is in apps/desktop/src and the Rust backend is in apps/desktop/src-tauri/src. Codex communication lives in codex.rs; the UI uses codex-chat-store.ts and use-codex-events.ts. Windows uses a packaged Tectonic CLI; other platforms retain the original embedded compiler.

Use Biome for TypeScript formatting and cargo fmt for Rust. Run the frontend and Rust tests before sharing changes. Preserve the existing MIT license and upstream attribution.
