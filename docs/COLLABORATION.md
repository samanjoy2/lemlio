# Writing together in Lemlio

Collaboration is optional. Every participant needs Lemlio 1.4.0 or later and keeps a local working copy. There is no owner computer that decides whose text wins.

## Start a session

1. Open your existing project, save it, and wait for compilation or Codex to finish.
2. Click **Collaborate** above the workspace, enter your name, then **Enable collaboration**. Enable it once; a second person joins this identity rather than independently enabling a separate copy.
3. Choose **Host on this device**. Lemlio runs its own relay; no Node, database, subscription, or Google account is required.
4. Check **Host address**. On a LAN, use this computer’s reachable private IP. For different networks, connect both computers to a private network such as [Tailscale](https://tailscale.com/pricing), then enter `ws://<host-private-address>:46317`. The suggested LAN address may need replacing with the Tailscale address. A firewall may need to allow Lemlio on that private network.
5. Choose **Copy invitation** and send it privately. On the other computer, choose **Join shared project** on the home page, paste it, and choose **Join session**.

The other computer creates its own project folder and receives the shared sources. The workspace bar shows connection state, local-history saving, and collaborators. Shared cursors appear in the text editor. Keep the host awake and Lemlio open during a session. PDF previews are compiled independently on each computer.

There is no public relay, automatic NAT traversal, public account directory, or automatic host election. A connection timeout usually means the address, private network, or firewall needs attention. An invitation is pasted in the app; it is not a registered operating-system deep link.

## Either person can host

Choose **Work offline** to leave a session. The other person can choose **Host on this device**, check their address, and send a fresh invitation containing it. Joiners use that invitation or **Connect to host** with the new address. Project identity and key stay the same. The next host does not have to possess everyone’s newest changes: peers merge their local histories when they connect.

Only one session can be hosted by a Lemlio instance at a time. Hosting is a connection role, not an ownership role. Everyone with the project invitation can edit and host; there are no viewer permissions, invite revocation, or per-user accounts in this release.

## Work completely offline

Continue editing an existing shared project without internet, Drive, or a running host. Local source and shared history save on your computer. When you reconnect to a reachable host, the histories merge. A later upload of an older copy cannot replace someone’s offline edits merely because it has a newer upload timestamp.

If you never overlap online:

1. In **Collaboration**, choose **Export offline changes** and save the encrypted `.lemlio-changes` file.
2. Send that file by your preferred method.
3. The recipient opens the same shared project and selects **Import offline changes**. For a new collaborator, use the invitation with **Join from offline changes**.
4. Exchange the recipient’s changes file back if both people edited. Receiving one file is a one-way transfer, so the sender needs the return history to receive the recipient’s edits.

Text changes use the shared edit history from [Yjs](https://docs.yjs.dev/), rather than choosing the newest whole file. Simultaneous edits can still need human editorial review even when they merge mechanically. Binary assets cannot be merged as text. Conflicting replacements, renames, duplicate filenames, and deletion-versus-edit cases appear under **Review shared file changes**; choose the intended version there.

## Drive and restoration

Drive remains optional backup transport, using immutable project ZIP revisions. For shared projects, Lemlio verifies each remote head and merges its shared history before uploading. It rechecks those heads to detect an upload race. Both histories are retained; an unresolved file conflict blocks automatic backup until reviewed. Shared project titles and file renames follow the project’s stable identity.

A new device can restore a project ZIP from Drive. Its history travels with the ZIP, but the private invitation key stays outside projects, so paste the original invitation to reconnect or decrypt offline files. Keep a private copy of that invitation. Each Google account only sees backups available through its own Drive connection; joining collaborators does not automatically share a Google Drive account or folder.

All devices handling a shared project must use 1.4.0 or later. An older app or external tool that edits ZIP sources without updating the history is detected and requires separate recovery/review. Lemlio does not blindly load that stale history over changed source. Ordinary non-shared projects retain their existing Drive conflict workflow.

## Local files, agents, and recovery

Sources stay in normal local files. Shared identity and history live in `.lemlio-collab/project.json` and `state.bin`; keep that folder with exported/restored shared projects. It is intentionally included in project ZIPs. Clone project creates an independent project and removes the copied sharing identity.

Native checkpoint writes use a file lock and expected-hash checks. Before replacing a local file, Lemlio checks its last materialized bytes. Unexpected external edits prompt **Keep local** or **Use shared**. Explicit replacement and deletion preserve local recovery files under `.prism/collaboration/recovery`. These recovery files stay local and are excluded from backups. Keep your own backups too: unsent changes are not protected against losing the computer.

Known text/code files use LF line endings so CodeMirror and shared text agree on character positions. Figures, PDFs, fonts, and other binary assets preserve their bytes. Normal source writes and renames are tracked; external changes are checked periodically. Avoid editing the same files simultaneously in another program while live sharing. Use **Work offline**, finish Codex’s work, then reconnect; Codex is blocked while a live shared connection is active in this first version.

## Privacy and limits

Live document/presence messages and offline change files use authenticated AES-256-GCM encryption. Invitations contain the private project key; anyone holding one can edit and host. The relay checks a token derived from that key and forwards encrypted messages. Use a trusted private network, not a publicly exposed unencrypted WebSocket address. Project identity and traffic metadata are not concealed from the relay.

Ordinary local sources, collaboration history, and Drive ZIP backups are not encrypted by this feature. Private invitation settings stay in local app configuration, outside project ZIPs; they are not stored in an operating-system credential vault. Unix settings/checkpoint files receive owner-only permissions, while Windows uses its normal account directory permissions. Hidden directories, known OAuth credential paths, caches, and agent conversations are excluded from sharing. Inspect your source files before inviting others: filtering cannot identify arbitrary secrets written inside a document.

Current limits: **16 MB** of shared source/assets, **96 MB** of serialized history, **192 MB** encrypted-message envelope, and **12 connected clients** per host. Superseded binary payloads are pruned while revision links remain. Large asset-heavy projects may exceed these limits; they can still be used as ordinary local projects. Long-lived text history can grow and there is no history compaction/reset UI yet.
