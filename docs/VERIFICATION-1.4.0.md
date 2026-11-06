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

Windows NSIS packaging passed. The exact built 1.4.0 executable compiled a generated Latin Modern Sans document using bundled Tectonic into a 5,462-byte PDF. The Windows installer SHA-256 is `75175743f7ec3a6b72d56ea7e07354d376cc36e322bed72ec898f2da062e9d62`; it matches the draft GitHub asset digest.

Production source: `17bc8a4fe542f394e7a3782b0ca9af802b61361b` (includes bundled third-party notices). Apple Silicon passed 220 frontend tests and 153 native tests (one opt-in live Drive test excluded), app signature/dependency checks, and bundled Tectonic compilation to a 5,463-byte PDF. The downloaded DMG matches GitHub’s SHA-256 digest `3c31145e93f723f37dd42cf149ac8f2b8a06bbd7bf39148c1f695a5410e0d139`. Intel also passed 220 frontend tests and 153 native tests (one opt-in live Drive test excluded), packaging, signature/dependency checks, and bundled Tectonic compilation to a 5,463-byte PDF. Both workflow jobs finished successfully. [Native Mac verification workflow](https://github.com/samanjoy2/lemlio/actions/runs/42288202169).

All three installers were read locally and matched GitHub’s asset digests. The release includes `Lemlio-1.4.0-SHA256SUMS.txt`:

```text
3c31145e93f723f37dd42cf149ac8f2b8a06bbd7bf39148c1f695a5410e0d139  Lemlio_1.4.0_AppleSilicon.dmg
b683398c9896275e124624b9afa3c12a0d483aa4b31adc027bb747b439013b1d  Lemlio_1.4.0_Intel.dmg
75175743f7ec3a6b72d56ea7e07354d376cc36e322bed72ec898f2da062e9d62  Lemlio_1.4.0_x64-setup.exe
```

Later commits update verification documentation only. The desktop Windows setup file is a copy of this verified installer.
