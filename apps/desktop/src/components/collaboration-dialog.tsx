import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import {
  UsersIcon,
  CopyIcon,
  DownloadIcon,
  UploadIcon,
  RadioIcon,
  UnplugIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Dialog } from "./panelui/dialog";
import { Field } from "./panelui/field";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { useDocumentStore } from "@/stores/document-store";
import { useCodexChatStore } from "@/stores/codex-chat-store";
import {
  activeCollaboration,
  activateCollaboration,
  enableCollaboration,
  flushCollaboration,
  useCollaborationStore,
} from "@/lib/collaboration/runtime";
import { parseInvitation, validateEndpoint } from "@/lib/collaboration/crypto";

export const openCollaboration = (join = false) =>
  window.dispatchEvent(
    new CustomEvent("lemlio-open-collaboration", { detail: { join } }),
  );
export function CollaborationBar() {
  const state = useCollaborationStore();
  return (
    <div className="flex min-h-9 shrink-0 flex-wrap items-center justify-between gap-2 border-b bg-background px-3 py-1 text-xs">
      <button
        type="button"
        className="flex min-w-0 items-center gap-2 text-muted-foreground hover:text-foreground"
        onClick={() => openCollaboration()}
      >
        <UsersIcon size={15} />
        <span>
          {state.enabled
            ? state.connected
              ? `${state.hosting ? "Hosting" : "Connected"} · ${state.peers.length + 1} online`
              : "Shared project · Offline"
            : "Collaborate"}
        </span>
        {state.enabled && (
          <span className="text-muted-foreground">
            {state.saved ? "History saved locally" : "Saving history…"}
          </span>
        )}
      </button>
      {state.enabled && (
        <button
          type="button"
          className={
            state.error || state.conflicts.length || state.diskConflicts.length
              ? "text-amber-600 dark:text-amber-300"
              : "text-muted-foreground hover:text-foreground"
          }
          onClick={() => openCollaboration()}
        >
          {state.conflicts.length || state.diskConflicts.length
            ? "Review shared file changes"
            : state.error
              ? "Connection or saving needs attention"
              : state.peers.length
                ? state.peers.join(", ")
                : "Share / Connect"}
        </button>
      )}
    </div>
  );
}

export function CollaborationDialog() {
  const root = useDocumentStore((s) => s.projectRoot);
  const state = useCollaborationStore();
  const [visible, setVisible] = useState(false),
    [joining, setJoining] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [invite, setInvite] = useState(""),
    [name, setName] = useState("Writer"),
    [endpoint, setEndpoint] = useState("");
  const [copied, setCopied] = useState("");
  useEffect(() => {
    const show = (event: Event) => {
      setJoining(
        Boolean((event as CustomEvent<{ join?: boolean }>).detail?.join) ||
          !useDocumentStore.getState().projectRoot,
      );
      const replica = activeCollaboration();
      setName(
        replica?.settings.name ||
          localStorage.getItem("lemlio-collaboration-name") ||
          "Writer",
      );
      setEndpoint(replica?.settings.endpoint || "");
      setError("");
      setCopied("");
      setVisible(true);
    };
    window.addEventListener("lemlio-open-collaboration", show);
    return () => window.removeEventListener("lemlio-open-collaboration", show);
  }, []);
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const ready = async () => {
    if (
      useDocumentStore.getState().isCompiling ||
      useCodexChatStore.getState().tabs.some((t) => t.isStreaming)
    )
      throw Error("Wait for the compiler and agent to finish first");
    await useDocumentStore.getState().saveAllFiles();
    if (useDocumentStore.getState().files.some((f) => f.isDirty))
      throw Error("Save your local edits first");
    await flushCollaboration();
    localStorage.setItem("lemlio-collaboration-name", name.trim() || "Writer");
  };
  const importFile = async () => {
    const path = await open({
      multiple: false,
      filters: [
        { name: "Lemlio offline changes", extensions: ["lemlio-changes"] },
      ],
    });
    if (!path || Array.isArray(path)) return;
    const body = await readTextFile(path);
    if (body.length > 192 * 1024 * 1024)
      throw Error("This changes file exceeds 192 MB");
    const replica = activeCollaboration();
    if (!replica) throw Error("Open the shared project first");
    await replica.importChanges(body);
    toast.success("Offline changes merged", {
      description:
        "Both histories are preserved. Review any file conflicts below.",
    });
  };
  const join = async (offline: boolean) => {
    await ready();
    const invitation = parseInvitation(invite);
    let replica = activeCollaboration();
    if (!replica || replica.project.id !== invitation.id) {
      const path = await invoke<string>("collaboration_create", {
        id: invitation.id,
        key: invitation.key,
        title: invitation.title || "Shared project",
      });
      await useDocumentStore.getState().openProject(path);
      replica = await activateCollaboration(path);
      window.dispatchEvent(new Event("project-library-changed"));
    }
    if (!replica) throw Error("Could not create the local shared replica");
    await replica.configure(invitation, name.trim() || "Writer");
    setJoining(false);
    if (offline) await importFile();
    else {
      if (!invitation.endpoint)
        throw Error(
          "This invitation has no host address. Ask either collaborator to host, or import an offline changes file.",
        );
      setEndpoint(invitation.endpoint);
      await replica.connect(invitation.endpoint);
    }
  };
  return (
    <Dialog
      open={visible}
      onOpenChange={(value) => {
        if (!busy) setVisible(value);
      }}
      dismissible={!busy}
    >
      <Dialog.Content size="lg" showClose={!busy}>
        <Dialog.Header
          title="Collaboration"
          description="Write together, keep working offline, and merge when you reconnect"
        />
        <Dialog.Body className="space-y-4">
          <div className="flex gap-2">
            <Button
              size="sm"
              variant={!joining ? "secondary" : "ghost"}
              disabled={!root || busy}
              onClick={() => setJoining(false)}
            >
              This project
            </Button>
            <Button
              size="sm"
              variant={joining ? "secondary" : "ghost"}
              disabled={busy}
              onClick={() => setJoining(true)}
            >
              Join a shared project
            </Button>
          </div>
          <Field>
            <Field.Label>Your name</Field.Label>
            <Input
              value={name}
              maxLength={48}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          {joining ? (
            <>
              <Field>
                <Field.Label>Invitation</Field.Label>
                <Input
                  value={invite}
                  onChange={(e) => setInvite(e.target.value)}
                  placeholder="lemlio-collab://join/…"
                  autoComplete="off"
                  spellCheck={false}
                />
                <Field.Description>
                  Invitations contain the private project key. Everyone with one
                  can edit and host.
                </Field.Description>
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={busy || !invite.trim()}
                  onClick={() => void run(() => join(false))}
                >
                  <UsersIcon size={15} />
                  Join session
                </Button>
                <Button
                  variant="outline"
                  disabled={busy || !invite.trim()}
                  onClick={() => void run(() => join(true))}
                >
                  <UploadIcon size={15} />
                  Join from offline changes
                </Button>
              </div>
            </>
          ) : !state.enabled ? (
            <>
              <p className="text-muted-foreground text-sm">
                Create a shared history for this project. Every collaborator
                keeps a local copy and can host. Internet collaboration needs a
                reachable private network, such as Tailscale; no hosting
                subscription is required.
              </p>
              <p className="text-muted-foreground text-xs">
                Source and asset files are shared. Credentials, hidden folders,
                compiler caches and agent chats are excluded. Shared files are
                limited to 16 MB in total.
              </p>
              <Button
                disabled={busy || !root}
                onClick={() =>
                  void run(async () => {
                    await ready();
                    const replica = await enableCollaboration(root!);
                    if (!replica)
                      throw Error("Could not initialize shared history");
                    await replica.configure(
                      { id: replica.project.id, key: replica.settings.key! },
                      name.trim() || "Writer",
                    );
                  })
                }
              >
                Enable collaboration
              </Button>
            </>
          ) : (
            <>
              <div className="rounded-lg border bg-muted/30 p-3 text-sm">
                <p>
                  {state.connected
                    ? `${state.hosting ? "Hosting" : "Connected"} · ${state.peers.length + 1} online`
                    : "Offline · You can keep editing"}
                </p>
                <p className="mt-1 text-muted-foreground text-xs">
                  {state.saved
                    ? "Shared history is saved on this device"
                    : "Saving shared history…"}
                  . Other devices receive offline changes when you reconnect or
                  exchange a changes file.
                </p>
                {!!state.peers.length && (
                  <p className="mt-2 text-xs">{state.peers.join(", ")}</p>
                )}
              </div>
              {!activeCollaboration()?.settings.key && (
                <Field>
                  <Field.Label>Original invitation</Field.Label>
                  <Input
                    value={invite}
                    onChange={(e) => setInvite(e.target.value)}
                    placeholder="Restore the private key to reconnect"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !invite}
                    onClick={() =>
                      void run(async () => {
                        await activeCollaboration()!.configure(
                          parseInvitation(invite),
                          name,
                        );
                      })
                    }
                  >
                    Use invitation
                  </Button>
                </Field>
              )}
              <Field>
                <Field.Label>Host address</Field.Label>
                <Input
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  placeholder="ws://100.x.x.x:46317"
                  spellCheck={false}
                  autoComplete="off"
                />
                <Field.Description>
                  For hosting, enter this computer’s reachable LAN or Tailscale
                  address before copying the invitation. Keep the host awake.
                  Another person can host later using the same project history.
                </Field.Description>
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await ready();
                      const replica = activeCollaboration()!;
                      if (replica.settings.key)
                        await replica.configure(
                          { id: replica.project.id, key: replica.settings.key },
                          name.trim() || "Writer",
                        );
                      const hosted = await replica.host();
                      setEndpoint(hosted.endpoint);
                    })
                  }
                >
                  <RadioIcon size={15} />
                  Host on this device
                </Button>
                <Button
                  variant="outline"
                  disabled={busy || !endpoint}
                  onClick={() =>
                    void run(async () => {
                      await ready();
                      const replica = activeCollaboration()!;
                      await replica.disconnect();
                      await replica.configure(
                        {
                          id: replica.project.id,
                          key: replica.settings.key!,
                          endpoint: validateEndpoint(endpoint),
                        },
                        name.trim() || "Writer",
                      );
                      await replica.connect(endpoint);
                    })
                  }
                >
                  Connect to host
                </Button>
                <Button
                  variant="outline"
                  disabled={busy || !endpoint}
                  onClick={() =>
                    void run(async () => {
                      const replica = activeCollaboration()!;
                      await replica.configure(
                        {
                          id: replica.project.id,
                          key: replica.settings.key!,
                          endpoint: validateEndpoint(endpoint),
                        },
                        name.trim() || "Writer",
                      );
                      const value = activeCollaboration()!.invitation(
                        validateEndpoint(endpoint),
                      );
                      setCopied(value);
                      await navigator.clipboard.writeText(value);
                      toast.success("Invitation copied");
                    })
                  }
                >
                  <CopyIcon size={15} />
                  Copy invitation
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy || (!state.connected && !state.connecting)}
                  onClick={() =>
                    void run(async () => {
                      await activeCollaboration()!.disconnect();
                      await activeCollaboration()!.flush();
                    })
                  }
                >
                  <UnplugIcon size={15} />
                  Work offline
                </Button>
              </div>
              {copied && (
                <details className="text-muted-foreground text-xs">
                  <summary>Show invitation to copy manually</summary>
                  <textarea
                    readOnly
                    value={copied}
                    className="mt-2 w-full rounded border bg-background p-2"
                    aria-label="Private collaboration invitation"
                  />
                </details>
              )}
              <div className="space-y-2 border-t pt-4">
                <p className="text-sm">
                  Exchange changes without cloud backup or a live connection
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await ready();
                        const body =
                          await activeCollaboration()!.exportChanges();
                        const path = await save({
                          defaultPath: "project.lemlio-changes",
                          filters: [
                            {
                              name: "Lemlio offline changes",
                              extensions: ["lemlio-changes"],
                            },
                          ],
                        });
                        if (path) {
                          await writeTextFile(path, body);
                          toast.success("Encrypted offline changes saved");
                        }
                      })
                    }
                  >
                    <DownloadIcon size={15} />
                    Export offline changes
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await ready();
                        await importFile();
                      })
                    }
                  >
                    <UploadIcon size={15} />
                    Import offline changes
                  </Button>
                </div>
                <p className="text-muted-foreground text-xs">
                  Backups merge the shared histories before uploading. Upload
                  time does not decide whose edits survive. Live agent sessions
                  must finish before connecting; work offline to run an agent.
                </p>
              </div>
              {!!state.conflicts.length && (
                <section
                  className="space-y-3 rounded-lg border border-amber-500/30 p-3"
                  aria-label="Shared file conflicts"
                >
                  <p className="font-medium text-sm">
                    Review competing file changes
                  </p>
                  {state.conflicts.map((conflict) => (
                    <div
                      key={conflict.file}
                      className="space-y-2 border-t pt-2 text-xs"
                    >
                      <p>{conflict.reason}</p>
                      {conflict.versions.map((version) => (
                        <div
                          key={version.id}
                          className="flex flex-wrap items-center gap-2"
                        >
                          <span className="min-w-0 flex-1 break-all">
                            {version.path} ·{" "}
                            {version.deleted ? "Deletion" : version.kind} ·{" "}
                            {version.author} ·{" "}
                            {new Date(version.time).toLocaleString()}
                          </span>
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={busy}
                            onClick={() =>
                              void run(async () => {
                                await activeCollaboration()!.resolveFile(
                                  conflict,
                                  version,
                                  true,
                                );
                              })
                            }
                          >
                            Keep this file
                          </Button>
                          {version.deleted && (
                            <Button
                              size="xs"
                              variant="outline"
                              disabled={busy}
                              onClick={() =>
                                void run(async () => {
                                  await activeCollaboration()!.resolveFile(
                                    conflict,
                                    version,
                                    false,
                                  );
                                })
                              }
                            >
                              Accept deletion
                            </Button>
                          )}
                        </div>
                      ))}
                    </div>
                  ))}
                </section>
              )}
              {!!state.diskConflicts.length && (
                <section
                  className="space-y-2 rounded-lg border border-amber-500/30 p-3"
                  aria-label="Local file conflicts"
                >
                  <p className="text-sm">
                    Local files changed outside the shared history
                  </p>
                  <p className="text-muted-foreground text-xs">
                    A recovery copy is kept before applying your choice.
                  </p>
                  {state.diskConflicts.map((path) => (
                    <div
                      key={path}
                      className="flex flex-wrap items-center gap-2 text-xs"
                    >
                      <span className="min-w-0 flex-1 break-all">{path}</span>
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void run(() =>
                            activeCollaboration()!.resolveDisk(path, true),
                          )
                        }
                      >
                        Keep local file
                      </Button>
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void run(() =>
                            activeCollaboration()!.resolveDisk(path, false),
                          )
                        }
                      >
                        Use shared file
                      </Button>
                    </div>
                  ))}
                </section>
              )}
            </>
          )}
          {(error || state.error) && (
            <p role="alert" className="text-destructive text-sm">
              {error || state.error}
            </p>
          )}
        </Dialog.Body>
        <Dialog.Footer>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => setVisible(false)}
          >
            Close
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog>
  );
}
