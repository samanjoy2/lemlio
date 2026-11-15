# Verification — 1.6.7

The installed checker and Python launcher were initially functional when run directly; a missing interpreter was not reproduced outside the agent's shell. The changes remove reliance on shell discovery for registered tools and move the base interpreter into app-owned storage.

- Migrated the existing shared environment to app-owned CPython 3.12, preserving the installed ACL checker. Verified the launcher's help output and ran a real check on an isolated PDF copy through Lemlio's native CLI runner. The checker exited successfully and wrote its diagnostic report under the copy's `.prism` folder.
- A generated nested LaTeX project compiled twice with changed content. The project-side PDF hash changed after the successful second compile. A deliberately broken third compile failed and preserved the second PDF's hash.
- Unit coverage includes tool registration/enabled checks, app-owned runtime setup arguments, inherited Python preference removal, and project PDF replacement. Frontend coverage verifies native tool routing.
- The runtime does not create global Python executables, clear project folders, or reinstall tool packages during repair. No manuscript source or real project PDF was changed during testing.

macOS uses the same runner and runtime logic with a bundled native uv binary. Local live testing was on Windows.

Final checks: 252 frontend tests and 195 native tests passed (one opt-in live backup test excluded). Production frontend build, repository Biome checks, and Windows NSIS packaging passed. This update was prepared as a local Windows installer; a public 1.6.7 release has not been published by this verification run.
