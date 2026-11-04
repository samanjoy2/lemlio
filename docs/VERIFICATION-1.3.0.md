# Lemlio 1.3.0

Google Drive now distinguishes incoming revisions from genuine conflicts. Local content hashes include source paths, contents, deletions, and the saved project title, independently of filesystem timestamps and operating system path separators. Existing legacy receipts remain readable.

Each new ZIP is an immutable revision. Its `.lemlio-sync.json` and Drive metadata record parent revisions, project identity, portable content hash, device identity, and save time. Two simultaneous uploads leave separate heads; explicit resolution creates a descendant of the current heads. No clock-based last-writer-wins replacement is used. Old revisions remain in Drive and consume storage.

Unchanged closed projects can fast-forward automatically every minute and on app focus. Open projects wait for a review action; unsaved edits, compilation, and active agents prevent that action. The native installer rechecks the local baseline and verifies the downloaded ZIP and content. It swaps a staged folder on the same filesystem, keeps old source in a hidden recovery sibling, preserves local-only Git/environment/cache state, and rolls back failed swaps. Project-level conflicts require a version choice; line-level merging is not implemented.

Use the same Google account and OAuth project on both devices. New devices still explicitly select projects to restore. All devices must use 1.3.0 or newer; older apps do not understand the immutable history. Manually imported unrelated copies do not automatically acquire another project's identity.

## Interface pass

Direction: a calm, exact, slightly warm research workspace, with paper and ink as its material. Document previews carry the detail; navigation stays neutral. The signature is a device-aware saved-revision line.

- Spacing: consistent 36px navigation/control rows, 16px sidebar padding, 32px page edges, and aligned actions.
- Color: retain the Lemlio mark; use neutral fallback covers and quieter connection states.
- Icons: keep Lucide, consistent stroke and alignment.
- Copy: sentence-case section labels and concrete revision states.
- Type: readable metadata, fewer weight variations, no cramped label tracking.
- Layout: retain the library/editor arrangement and desktop proportions.
- Details: remove empty card footers and category text over PDF covers.
- Visuals: real document thumbnails remain the visual focus; no generated filler.
- Motion: retain task-related loading feedback and quiet color transitions.

Process: [unslop](https://heydamir.design/unslop) by Damir Sokolovsky (@heydamir), CC BY 4.0.

## Verification

Windows production build and lint passed. Final Windows native tests passed 145 tests (one opt-in live test excluded); frontend passed 191 tests. A real Drive test using disposable generated projects passed cross-device fast-forward, binary integrity, rename propagation, no-change deduplication, genuine conflict protection, explicit resolution, and recovery-source checks. Only its generated ZIPs were moved to Trash.

Both Mac architectures passed **191 frontend tests and 143 native tests**, plus app signature/dependency checks and real compilation with bundled Tectonic and Latin Modern fonts. Each produced a 5,463-byte smoke-test PDF. [Mac verification workflow](https://github.com/samanjoy2/lemlio/actions/runs/41875476673).

Windows packaging passed and the packaged application compiled the same demo document to a 5,463-byte PDF. The final release source passed the opt-in live Drive test again. The repository lint workflow passed. Production code was built from `41ca06ff1c3764c83dade14637b0b55ce14b3517`; the later verification commit changes documentation only.

Installer SHA-256 values:

- Windows x64: `fa1a67ffb2c3f6fd4297cb376534e3f910713605348a1f99b3a67e958ff429df`
- Apple Silicon: `5de6a7ac5097261c0bbd157ea85e394a93f1a9289d4e782583a26769bfad7e93`
- Mac Intel: `d69c913357bb801fdc23499f90e196f4fc72e31485be42fad30019bd80f650ce`

Mac installers are ad hoc signed, not Apple notarized. Physical Mac UI testing is not available on this Windows PC. The interface was checked in a browser using isolated fictional demo data, in dark and light themes.
