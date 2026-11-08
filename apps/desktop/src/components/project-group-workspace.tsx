import { ChatComposer } from "./codex-chat/chat-composer";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeftIcon,
  LayoutGridIcon,
  FileTextIcon,
  Columns2Icon,
} from "lucide-react";
import { useProjectCatalog } from "@/hooks/use-project-catalog";
import { useProjectGroups } from "@/stores/project-groups-store";
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
  }, [group?.id, group?.paths]);
  if (!group) return null;
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
  return (
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
      <div
        role="tablist"
        aria-label="Project versions"
        className="flex shrink-0 gap-1 overflow-x-auto border-b px-4 pt-2"
      >
        {group.paths.map((path) => (
          <button
            role="tab"
            aria-selected={root === path && mode === "edit"}
            key={path}
            type="button"
            title={label(path)}
            disabled={busy || streaming || compiling}
            onClick={() => void edit(path)}
            className={`max-w-56 shrink-0 truncate border-b-2 px-3 py-3 text-sm ${root === path && mode === "edit" ? "border-primary bg-muted/50 font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          >
            {label(path)}
          </button>
        ))}
      </div>
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
          <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-5">
            {group.paths.map((path) => (
              <button
                type="button"
                key={path}
                disabled={busy || streaming || compiling}
                onClick={() => void edit(path)}
                className="min-w-0 overflow-hidden rounded-lg border text-left transition-colors hover:border-primary/50 focus-visible:outline-2 focus-visible:outline-ring"
              >
                <GroupCover path={path} />
                <div className="space-y-1 border-t p-3">
                  <p className="line-clamp-2 font-medium text-sm">
                    {label(path)}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    Open editor & PDF
                  </p>
                </div>
              </button>
            ))}
          </div>
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
                <p className="p-4 text-muted-foreground text-sm">No changes</p>
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
      <footer className="shrink-0 border-t bg-muted/20 px-4 py-3">
        <div className="mx-auto max-w-6xl">
          <p className="mb-2 font-medium text-sm">
            Ask Codex · All {group.paths.length} versions
          </p>
          <ChatComposer
            isOpen
            placeholder="Update these versions together (/ for commands, @ to mention)"
            submissionDisabled={busy || compiling}
            streamingOverride={streaming}
            stopOverride={stopGroupAgent}
            onSubmit={async (prompt, context) => {
              setBusy(true);
              setError("");
              try {
                await runGroupEdit(
                  group.paths,
                  prompt,
                  () => setMode("edit"),
                  context,
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
    </div>
  );
}
