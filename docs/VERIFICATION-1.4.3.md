# Lemlio 1.4.3 local update

## Shared projects in group runs

Removed the blanket collaboration-manifest prohibition from both the group frontend and native Codex path. A shared identity alone no longer prevents an agent run. A selected active replica leaves its live session before the run; existing identity, keys and history are retained. Every selected project's local sources reconcile into its existing shared history before checkpoints, without requiring Drive. The primary replica is activated before Codex starts.

On successful, failed, or stopped completion, the client reconciles all selected projects before clearing streaming status, keeping automatic Drive synchronization deferred until reconciliation finishes. Each project is attempted even if another fails; files are retained and errors are shown. Shared source scanning pauses during a group agent turn to avoid materializing files beneath an active filesystem edit. Reconnect live sharing after reviewing the results. Existing unresolved shared-file conflicts still require review.

Source history checkpoints exclude collaboration internals. Restoring even a legacy snapshot filters shared identity/history from checkout, so recovery changes document contents without rewinding CRDT state.

## Group controls and layout

- Project tabs and PDF preview cards have the same context menu: Mention in chat, Set as main version, and Remove from group. Removal changes membership only and invokes no project deletion/trash action.
- Mentions add a visible project-reference context chip to the existing Codex composer and focus it. No request is sent automatically.
- The chosen main/reference project is saved and visibly marked. It becomes the initial project for group requests and is described as the reference in the agent prompt, while intentional variant differences remain protected by instructions. Choosing it never copies files.
- Tabs and preview cards use dnd-kit Sortable 10 with the existing Core 6 installation, six-pixel pointer activation, keyboard handles, and 200ms transform transitions with reduced-motion overrides. The persisted display order stays independent of the main designation. Dragging does not switch the active project or delete files.
- A nested editor/PDF area places the group composer to the right of the sidebar, allowing the file sidebar to reach the bottom. Composer drafts and pinned context survive moving between overview and editor modes.

## Verification

235 frontend tests passed across 47 files; 156 Windows native tests passed with one opt-in live Drive test excluded. Production TypeScript/build and repository-wide Biome CI passed. New regressions cover shared group preparation/completion, preservation of shared identity and agent edits without Drive, continuing other projects after a history failure, membership-only removal, main/reference ordering, persisted visual order, and real context-menu actions with no project deletion.

An isolated browser with fictional projects verified real pointer dragging in both tab and preview layouts, saved shared ordering, main-role retention after dragging, all three context menu items, and preservation of a typed draft through overview/editor switches. At 1440×900, the sidebar ended at y=900 and the composer started at x=216.84, to the right of the sidebar edge x=215.84. Exactly one composer was present. Three layouts were visually inspected; no React error was reported. Demo sources and filesystem/connection responses were simulated. No real CV, live Drive archive, or paid agent request was modified by verification. Physical Mac testing/new Mac installers were not part of this local update.

Windows NSIS packaging passed. The exact packaged executable compiled a generated Latin Modern Sans document through bundled Tectonic to a 3,357-byte PDF. The installer on the desktop has SHA-256 `767beba5ec6d8d01fb52c661e0f21e7e97fdb00970326fdaeda9b0f7cdf3b03d`. The public GitHub release remains 1.4.0; this update is prepared locally and its source is pushed separately.
