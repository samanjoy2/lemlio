import { switchGroupProject } from "@/lib/project-group-actions";
import { useEffect, useState } from "react";
import { LayersIcon, PlusIcon, FolderOpenIcon } from "lucide-react";
import { useProjectCatalog } from "@/hooks/use-project-catalog";
import {
  groupProjectPaths,
  useProjectGroups,
} from "@/stores/project-groups-store";
import { useCodexChatStore } from "@/stores/codex-chat-store";
import { Dialog } from "./panelui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
/** Opens the groups dialog from anywhere; `create` starts on an empty new group. */
export const requestProjectGroups = (create = false) =>
  window.dispatchEvent(
    new CustomEvent("lemlio-open-project-groups", { detail: { create } }),
  );

export function ProjectGroups({ disabled = false }: { disabled?: boolean }) {
  const [open, setOpen] = useState(false),
    [id, setId] = useState(""),
    [name, setName] = useState(""),
    [paths, setPaths] = useState<string[]>([]),
    [query, setQuery] = useState("");
  const [opening, setOpening] = useState(false),
    [error, setError] = useState("");
  const { projects } = useProjectCatalog();
  const groups = useProjectGroups((s) => s.groups);
  const active = useProjectGroups((s) => s.activeGroupId);
  const streaming =
    useCodexChatStore((s) => s.tabs.some((t) => t.isStreaming)) ||
    disabled ||
    opening;
  const select = (key: string) => {
    const group = groups.find((g) => g.id === key);
    setId(group?.id || "");
    setName(group?.name || "");
    setPaths(group?.paths || []);
    setQuery("");
  };
  const save = () => {
    const key = id || crypto.randomUUID();
    const previous = groups.find((g) => g.id === key);
    useProjectGroups.getState().save({
      id: key,
      name: name.trim(),
      paths,
      mainPath:
        previous?.mainPath && paths.includes(previous.mainPath)
          ? previous.mainPath
          : undefined,
    });
    setId(key);
    return key;
  };
  useEffect(() => {
    const show = (event: Event) => {
      const create = (event as CustomEvent<{ create?: boolean }>).detail
        ?.create;
      const current = useProjectGroups.getState();
      select(
        create ? "" : current.activeGroupId || current.groups[0]?.id || "",
      );
      setOpen(true);
    };
    window.addEventListener("lemlio-open-project-groups", show);
    return () => window.removeEventListener("lemlio-open-project-groups", show);
  }, []);
  return (
    <div className="px-3 py-2">
      <Button
        size="sm"
        variant="ghost"
        disabled={streaming}
        onClick={() => {
          select(active || groups[0]?.id || "");
          setOpen(true);
        }}
      >
        <LayersIcon size={16} />
        {active ? "Manage versions" : "Project groups"}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <Dialog.Content size="lg" className="max-w-4xl" variant="plain">
          <Dialog.Header
            title="Project groups"
            description="Keep related documents in one workspace with project tabs and PDF previews."
          />
          <Dialog.Body>
            <div className="grid min-w-0 gap-6 sm:grid-cols-[180px_minmax(0,1fr)]">
              <nav aria-label="Saved groups" className="space-y-1">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={streaming}
                  onClick={() => select("")}
                >
                  <PlusIcon size={15} />
                  New group
                </Button>
                {groups.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    disabled={streaming}
                    onClick={() => select(g.id)}
                    className={`block w-full rounded-md px-3 py-2 text-left text-sm ${g.id === id ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50"}`}
                  >
                    <span className="block truncate">{g.name}</span>
                    <span className="text-muted-foreground text-xs">
                      {g.paths.length} versions
                    </span>
                  </button>
                ))}
              </nav>
              <div className="min-w-0 space-y-4">
                <label htmlFor="group-name" className="block space-y-2 text-sm">
                  <span>Group name</span>
                  <Input
                    id="group-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="My CV versions"
                    disabled={streaming}
                  />
                </label>
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span>Choose projects</span>
                  <span className="text-muted-foreground">
                    {paths.length} selected
                  </span>
                </div>
                <Input
                  aria-label="Find a project"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Find a project…"
                />
                <div className="max-h-72 overflow-y-auto rounded-md border">
                  {projects
                    .filter((p) =>
                      p.name.toLowerCase().includes(query.toLowerCase()),
                    )
                    .map((p) => (
                      <label
                        key={p.path}
                        title={p.path}
                        className="flex min-w-0 items-center gap-3 border-b px-3 py-3 text-sm last:border-0 hover:bg-muted/40"
                      >
                        <input
                          type="checkbox"
                          disabled={streaming}
                          checked={paths.includes(p.path)}
                          onChange={(e) =>
                            setPaths(
                              e.target.checked
                                ? [...paths, p.path]
                                : paths.filter((x) => x !== p.path),
                            )
                          }
                        />
                        <span className="min-w-0 flex-1 break-words">
                          {p.name}
                        </span>
                      </label>
                    ))}
                  {paths
                    .filter((path) => !projects.some((p) => p.path === path))
                    .map((path) => (
                      <label
                        key={path}
                        className="flex min-w-0 gap-3 p-3 text-sm"
                      >
                        <input
                          type="checkbox"
                          checked
                          disabled={streaming}
                          onChange={() =>
                            setPaths(paths.filter((p) => p !== path))
                          }
                        />
                        <span className="min-w-0 break-all text-muted-foreground">
                          Unavailable: {path}
                        </span>
                      </label>
                    ))}
                </div>
                <p className="text-muted-foreground text-xs">
                  Grouping does not change your files. Open the workspace to
                  browse, edit, or ask the AI to update the versions you choose.
                </p>
              </div>
            </div>
            {error && (
              <p role="alert" className="text-destructive text-sm">
                {error}
              </p>
            )}
          </Dialog.Body>
          <Dialog.Footer className="flex-wrap gap-2">
            <Button
              variant="ghost"
              disabled={!id || streaming}
              onClick={() => {
                useProjectGroups.getState().remove(id);
                if (active === id)
                  useProjectGroups.setState({ activeGroupId: null });
                select("");
              }}
            >
              Delete group
            </Button>
            <div className="flex-1" />
            <Button
              variant="outline"
              disabled={
                streaming ||
                !name.trim() ||
                paths.length < 2 ||
                paths.length > 20
              }
              onClick={() => save()}
            >
              Save group
            </Button>
            <Button
              disabled={
                streaming ||
                !name.trim() ||
                paths.length < 2 ||
                paths.length > 20
              }
              onClick={() => {
                void (async () => {
                  setOpening(true);
                  setError("");
                  try {
                    const key = save();
                    const saved = useProjectGroups
                      .getState()
                      .groups.find((g) => g.id === key)!;
                    await switchGroupProject(groupProjectPaths(saved)[0]);
                    useProjectGroups.setState({ activeGroupId: key });
                    setOpen(false);
                  } catch (error) {
                    setError(String(error));
                  } finally {
                    setOpening(false);
                  }
                })();
              }}
            >
              <FolderOpenIcon size={16} />
              Open workspace
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog>
    </div>
  );
}
