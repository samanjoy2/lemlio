# Lemlio 1.4.0 verification

## Implementation

Optional local-first collaboration uses Yjs, CodeMirror bindings, and the app’s own native Rust WebSocket relay. Either participant can host; there is no Node runtime or paid collaboration backend. Text histories merge across live connections, offline change files, and verified Drive ZIP revisions. Simultaneous file replacements, renames, and deletion-versus-edit cases require review. Checkpoints and materialization use native file locking, expected hashes, source validation, and local recovery copies.

Messages use AES-256-GCM; a native implementation supports webviews without WebCrypto. Private invitation keys stay in local settings outside project ZIPs. The relay is an authenticated encrypted-message forwarder. Live shared editing currently requires agents to be offline; ordinary compilation remains available.

## Automated and browser checks

- 220 frontend tests passed, covering concurrent/offline text convergence, persisted restart, host handoff, structural conflicts, newline normalization, frozen causal rename/delete intent, encryption/tampering, native crypto fallback, runtime checkpoint recovery, and merge-before-Drive-upload behavior.
- Frontend TypeScript and production build passed. The existing large bundle warning remains.
- Repository-wide Biome CI passed.
- 155 Windows native tests passed; one opt-in live Drive test is excluded. Installer packaging and exact executable compiler smoke are recorded below after completion.
- Isolated browser tests use two fictional demo clients with real CodeMirror, Yjs, and encryption. They verify live text, an offline edit/reload, switching host roles, convergence, and a remote cursor. The final resumed-browser check reported two online peers, one remote cursor, equal text on both clients, and no React errors. The browser transport and filesystem are simulated; the native relay separately has a real loopback WebSocket authentication/transfer test.

No real project or live Drive backup was modified during verification. Physical two-device/private-network testing and physical Mac UI testing are not available on this Windows PC. Read [the collaboration guide](COLLABORATION.md) for setup and limits. Mac packages are ad hoc signed, not Apple notarized; the Windows installer is unsigned.

## Packaged release

Build results and published asset digests will be recorded here after verification.
