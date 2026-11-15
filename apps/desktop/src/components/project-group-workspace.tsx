import { GroupSortArea, SortableGroupMember } from "./group-sortable";
import { GroupComposerContext } from "@/lib/group-composer-context";
import { AGENT_LABELS } from "@/lib/agent-provider";
import { useSettingsStore } from "@/stores/settings-store";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "./ui/context-menu";
import { ChatComposer } from "./codex-chat/chat-composer";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeftIcon,
  LayoutGridIcon,
  FileTextIcon,
  Columns2Icon,
} from "lucide-react";
import { useProjectCatalog } from "@/hooks/use-project-catalog";
import {
  groupProjectPaths,
  useProjectGroups,
} from "@/stores/project-groups-store";
import { useDocumentStore } from "@/stores/document-store";
import { useCodexChatStore } from "@/stores/codex-chat-store";
import {
  cachedProjectThumbnail,
  THUMBNAIL_UPDATED,
} from "@/lib/project-thumbnails";
import { listen } from "@tauri-apps/api/event";
import {
  runGroupEdit,
  stopGroupAgent,
  reviewGroupEdit,
  switchGroupProject,
  type GroupDiff,
} from "@/lib/project-group-actions";
import { ProjectGroups } from "./project-groups";
import { Button } from "./ui/button";
function GroupMemberMenu({
  children,
  onRemove,
  onMention,
  onSetMain,
  isMain,
  disabled,
}: {
  children: ReactNode;
  onRemove: () => void;
  onMention: () => void;
  onSetMain: () => void;
  isMain: boolean;
  disabled: boolean;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onMention}>Mention in chat</ContextMenuItem>
        <ContextMenuItem disabled={disabled || isMain} onSelect={onSetMain}>
          {isMain ? "Main version" : "Set as main version"}
        </ContextMenuItem>
        <ContextMenuItem disabled={disabled} onSelect={onRemove}>
          Remove from group
        </ContextMenuItem>
        <p className="max-w-56 px-2 py-1 text-muted-foreground text-xs">
          Keeps the project and all of its files
        </p>
      </ContextMenuContent>
    </ContextMenu>
  );
}
function GroupCover({ path }: { path: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      void cachedProjectThumbnail(path)
        .then((t) => {
          if (alive) setSrc(t.dataUrl || null);
        })
        .catch(() => {});
    load();
    const stop = listen<string>(THUMBNAIL_UPDATED, (e) => {
      if (e.payload === path) load();
    });
    return () => {
      alive = false;
      void stop.then((fn) => fn()).catch(() => {});
    };
  }, [path]);
  return (
    <div className="flex aspect-[8/9] items-center justify-center overflow-hidden bg-muted/40 p-4">
      {src ? (
        <img
          src={src}
          alt="Saved PDF first page"
          className="h-full max-w-full object-contain shadow-sm"
        />
      ) : (
        <div className="space-y-3 text-center text-muted-foreground">
          <FileTextIcon size={32} strokeWidth={1.25} className="mx-auto" />
          <p className="text-xs">
            Compile this version
            <br />
            to save a PDF preview
          </p>
        </div>
      )}
    </div>
  );
}
export function ProjectGroupWorkspace({ children }: { children?: ReactNode }) {
  const group = useProjectGroups((s) =>
    s.groups.find((g) => g.id === s.activeGroupId),
  );
  const reviewBaseline = useProjectGroups((s) => s.review);
  const { projects } = useProjectCatalog();
  const root = useDocumentStore((s) => s.projectRoot);
  const streaming = useCodexChatStore((s) => s.tabs.some((t) => t.isStreaming));
  const provider = useSettingsStore((s) => s.agentProvider);
  const compiling = useDocumentStore((s) => s.isCompiling);
  const [mode, setMode] = useState<"overview" | "edit" | "review">("overview");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [diffs, setDiffs] = useState<GroupDiff[]>([]);
  const hadProject = useRef(!!root);
  useEffect(() => {
    if (root) hadProject.current = true;
    else if (hadProject.current)
      useProjectGroups.setState({ activeGroupId: null });
  }, [root]);
  useEffect(() => {
    setMode("overview");
    setError("");
    setDiffs([]);
  }, [group?.id]);
  useEffect(() => {
    if (mode === "edit" && root && group && !group.paths.includes(root))
      setMode("overview");
  }, [group?.paths, root, mode]);
  if (!group) return null;
  const orderedPaths = group.paths;
  const label = (path: string) =>
    projects.find((p) => p.path === path)?.name ||
    path.split(/[/\\]/).pop() ||
    path;
  const work = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const edit = (path: string) =>
    work(async () => {
      await switchGroupProject(path);
      setMode("edit");
    });
  const canReview =
    reviewBaseline.length > 0 &&
    reviewBaseline.length === group.paths.length &&
    reviewBaseline.every((r) => group.paths.includes(r.path));
  const composer = (
    <footer className="shrink-0 border-t bg-muted/20 px-4 py-3">
      <div className="mx-auto max-w-6xl">
        <p className="mb-2 font-medium text-sm">
          Ask {AGENT_LABELS[provider]} · All {group.paths.length} versions
        </p>
        <ChatComposer
          isOpen
          placeholder="Update these versions together (/ for commands, @ to mention)"
          submissionDisabled={busy || compiling || group.paths.length < 2}
          streamingOverride={streaming}
          stopOverride={stopGroupAgent}
          onSubmit={async (prompt, context) => {
            setBusy(true);
            setError("");
            try {
              await runGroupEdit(
                groupProjectPaths(group),
                prompt,
                () => setMode("edit"),
                context,
                group.mainPath,
              );
            } catch (error) {
              setError(String(error));
              throw error;
            } finally {
              setBusy(false);
            }
          }}
        />
        <p className="mt-2 text-muted-foreground text-xs">
          Applies only to this group. Checkpoints are saved first; review the
          changes after the agent finishes.
        </p>
      </div>
    </footer>
  );
  return (
    <GroupComposerContext.Provider value={mode === "edit" ? composer : null}>
      <div className="flex h-full min-h-0 flex-col bg-background">
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <Button
              size="icon"
              variant="ghost"
              aria-label="Leave group workspace"
              disabled={busy || streaming || compiling}
              onClick={() =>
                void work(async () => {
                  await useDocumentStore.getState().saveAllFiles();
                  if (useDocumentStore.getState().files.some((f) => f.isDirty))
                    throw Error("Save your edits before leaving.");
                  useProjectGroups.setState({ activeGroupId: null });
                })
              }
            >
              <ArrowLeftIcon size={16} />
            </Button>
            <div className="min-w-0">
              <h1 className="truncate font-medium text-base">{group.name}</h1>
              <p className="text-muted-foreground text-xs">
                {group.paths.length} project versions
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant={mode === "overview" ? "secondary" : "ghost"}
              onClick={() => setMode("overview")}
            >
              <LayoutGridIcon size={16} />
              All versions
            </Button>
            <Button
              size="sm"
              variant={mode === "review" ? "secondary" : "ghost"}
              disabled={busy || streaming || compiling || !canReview}
              onClick={() =>
                void work(async () => {
                  setDiffs(await reviewGroupEdit());
                  setMode("review");
                })
              }
            >
              <Columns2Icon size={16} />
              Review changes
            </Button>
            <ProjectGroups disabled={busy} />
          </div>
        </header>
        <GroupSortArea
          paths={orderedPaths}
          horizontal
          onMove={(from, to) =>
            useProjectGroups.getState().moveMember(group.id, from, to)
          }
        >
          {orderedPaths.map((path) => (
            <SortableGroupMember
              key={path}
              path={path}
              label={label(path)}
              disabled={busy || streaming || compiling}
              tab
            >
              <GroupMemberMenu
                key={path}
                disabled={busy || streaming || compiling}
                isMain={group.mainPath === path}
                onSetMain={() =>
                  useProjectGroups.getState().setMain(group.id, path)
                }
                onMention={() =>
                  useCodexChatStore.getState().addPendingAttachment({
                    label: `@project ${label(path)}`,
                    filePath: path,
                    selectedText: `Referenced project directory: ${JSON.stringify(path)}; project name: ${JSON.stringify(label(path))}`,
                  })
                }
                onRemove={() =>
                  useProjectGroups.getState().removeMember(group.id, path)
                }
              >
                <button
                  role="tab"
                  aria-selected={root === path && mode === "edit"}
                  key={path}
                  type="button"
                  title={label(path)}
                  disabled={busy || streaming || compiling}
                  onClick={() => void edit(path)}
                  className={`flex max-w-56 shrink-0 items-center gap-2 border-b-2 py-3 pr-3 pl-7 text-sm ${root === path && mode === "edit" ? "border-primary bg-muted/50 font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
                >
                  {label(path)}
                  {group.mainPath === path && (
                    <span className="shrink-0 text-primary text-xs">Main</span>
                  )}
                </button>
              </GroupMemberMenu>
            </SortableGroupMember>
          ))}
        </GroupSortArea>
        {error && (
          <p
            role="alert"
            className="shrink-0 border-b px-4 py-2 text-destructive text-sm"
          >
            {error}
          </p>
        )}
        <div
          className={`min-h-0 flex-1 overflow-y-auto ${mode === "overview" ? "" : "hidden"}`}
        >
          <div className="mx-auto max-w-7xl p-6">
            {!group.paths.length && (
              <p className="mb-4 text-muted-foreground">
                This group is empty. Use Manage versions to add projects.
              </p>
            )}
            <div className="mb-5 flex flex-wrap items-end justify-between gap-2">
              <div>
                <h2 className="font-medium text-lg">Project previews</h2>
                <p className="mt-1 text-muted-foreground text-sm">
                  Open a preview or a tab to edit that version beside its PDF
                </p>
              </div>
              <span className="text-muted-foreground text-xs">
                Edits in a tab affect that version only
              </span>
            </div>
            <GroupSortArea
              paths={orderedPaths}
              onMove={(from, to) =>
                useProjectGroups.getState().moveMember(group.id, from, to)
              }
            >
              {orderedPaths.map((path) => (
                <SortableGroupMember
                  key={path}
                  path={path}
                  label={label(path)}
                  disabled={busy || streaming || compiling}
                >
                  <GroupMemberMenu
                    key={path}
                    disabled={busy || streaming || compiling}
                    isMain={group.mainPath === path}
                    onSetMain={() =>
                      useProjectGroups.getState().setMain(group.id, path)
                    }
                    onMention={() =>
                      useCodexChatStore.getState().addPendingAttachment({
                        label: `@project ${label(path)}`,
                        filePath: path,
                        selectedText: `Referenced project directory: ${JSON.stringify(path)}; project name: ${JSON.stringify(label(path))}`,
                      })
                    }
                    onRemove={() =>
                      useProjectGroups.getState().removeMember(group.id, path)
                    }
                  >
                    <button
                      type="button"
                      key={path}
                      disabled={busy || streaming || compiling}
                      onClick={() => void edit(path)}
                      className="w-full min-w-0 overflow-hidden rounded-lg border text-left transition-colors hover:border-primary/50 focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      <GroupCover path={path} />
                      <div className="space-y-1 border-t p-3">
                        <p className="line-clamp-2 font-medium text-sm">
                          {label(path)}
                          {group.mainPath === path && (
                            <span className="shrink-0 text-primary text-xs">
                              Main
                            </span>
                          )}
                        </p>
                        <p className="text-muted-foreground text-xs">
                          Open editor & PDF
                        </p>
                      </div>
                    </button>
                  </GroupMemberMenu>
                </SortableGroupMember>
              ))}
            </GroupSortArea>
          </div>
        </div>
        <div
          className={`min-h-0 flex-1 ${mode === "edit" ? "flex flex-col" : "hidden"}`}
        >
          {children}
        </div>
        {mode === "review" && (
          <div className="min-h-0 flex-1 overflow-y-auto p-6">
            <h2 className="mb-1 font-medium text-lg">
              Changes across your versions
            </h2>
            <p className="mb-6 text-muted-foreground text-sm">
              Compared with the checkpoints saved before your last group request
            </p>
            {diffs.map((result) => (
              <section key={result.path} className="mb-6 rounded-lg border">
                <div className="flex items-center justify-between gap-2 border-b bg-muted/30 p-3">
                  <h3 className="font-medium text-sm">{label(result.path)}</h3>
                  <span className="text-muted-foreground text-xs">
                    {result.files.length} changed files
                  </span>
                </div>
                {!result.files.length ? (
                  <p className="p-4 text-muted-foreground text-sm">
                    No changes
                  </p>
                ) : (
                  result.files.map((file) => (
                    <details
                      key={file.file_path}
                      className="border-b p-3 last:border-0"
                      open
                    >
                      <summary className="cursor-pointer text-sm">
                        {file.file_path}{" "}
                        <span className="text-muted-foreground">
                          · {file.status}
                        </span>
                      </summary>
                      <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                        <div>
                          <p className="mb-2 text-muted-foreground text-xs">
                            Before
                          </p>
                          <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded border bg-muted/20 p-3 text-xs">
                            {file.old_content ?? "Absent or binary file"}
                          </pre>
                        </div>
                        <div>
                          <p className="mb-2 text-muted-foreground text-xs">
                            After
                          </p>
                          <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded border bg-muted/20 p-3 text-xs">
                            {file.new_content ?? "Absent or binary file"}
                          </pre>
                        </div>
                      </div>
                    </details>
                  ))
                )}
              </section>
            ))}
          </div>
        )}
        {mode !== "edit" && composer}
      </div>
    </GroupComposerContext.Provider>
  );
}
