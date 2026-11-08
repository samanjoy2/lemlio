import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useProjectCatalog } from "@/hooks/use-project-catalog";
import { useProjectGroups } from "@/stores/project-groups-store";
import { useDocumentStore } from "@/stores/document-store";
import { useCodexChatStore } from "@/stores/codex-chat-store";
import { Dialog } from "./panelui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
interface Diff {
  file_path: string;
  status: string;
  old_content: string | null;
  new_content: string | null;
}
export function ProjectGroups() {
  const [open, setOpen] = useState(false),
    [id, setId] = useState(""),
    [name, setName] = useState(""),
    [paths, setPaths] = useState<string[]>([]),
    [prompt, setPrompt] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [diffs, setDiffs] = useState<{ path: string; files: Diff[] }[]>([]);
  const { projects } = useProjectCatalog();
  const groups = useProjectGroups((s) => s.groups);
  const streaming = useCodexChatStore((s) => s.tabs.some((t) => t.isStreaming));
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
  const run = async () => {
    const doc = useDocumentStore.getState();
    if (
      doc.isCompiling ||
      useCodexChatStore.getState().tabs.some((t) => t.isStreaming)
    )
      throw Error("Wait for compilation and running agents to finish.");
    await doc.saveAllFiles();
    if (useDocumentStore.getState().files.some((f) => f.isDirty))
      throw Error("Save your changes first.");
    if (paths.length < 2 || paths.length > 20)
      throw Error("Choose between 2 and 20 projects.");
    const review: { path: string; snapshot: string }[] = [];
    for (const path of paths) {
      const shared = await invoke<{ enabled: boolean }>("collaboration_load", {
        projectPath: path,
      });
      if (shared.enabled)
        throw Error(
          "Group runs currently support non-collaborative projects only.",
        );
      await invoke("history_init", { projectRoot: path });
      await invoke("history_snapshot", {
        projectRoot: path,
        message: "Before group agent edit",
      });
      const snapshots = await invoke<{ id: string }[]>("history_list", {
        projectRoot: path,
        limit: 1,
        offset: 0,
      });
      if (!snapshots[0]) throw Error(`Could not checkpoint ${path}`);
      review.push({ path, snapshot: snapshots[0].id });
    }
    useProjectGroups.setState({ review });
    await doc.openProject(paths[0]);
    const chat = useCodexChatStore.getState();
    const tabId = chat.createTab();
    useProjectGroups.setState({ scope: { tabId, paths: [...paths] } });
    await useCodexChatStore.getState().sendPrompt(prompt);
    setOpen(false);
  };
  const review = async () => {
    await useDocumentStore.getState().saveAllFiles();
    if (useDocumentStore.getState().files.some((f) => f.isDirty))
      throw Error("Save your edits before review.");
    const result: { path: string; files: Diff[] }[] = [];
    for (const item of useProjectGroups.getState().review) {
      await invoke("history_snapshot", {
        projectRoot: item.path,
        message: "Group edit review checkpoint",
      });
      const latest = await invoke<{ id: string }[]>("history_list", {
        projectRoot: item.path,
        limit: 1,
        offset: 0,
      });
      const files = await invoke<Diff[]>("history_diff", {
        projectRoot: item.path,
        fromId: item.snapshot,
        toId: latest[0].id,
      });
      result.push({ path: item.path, files });
    }
    setDiffs(result);
  };
  return (
    <div className="px-3 py-2">
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Project groups / Review changes
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <Dialog.Content size="lg">
          <Dialog.Header
            title="Project groups"
            description="Choose related versions yourself. Run one request across them, then review each project's changes."
          />
          <Dialog.Body className="space-y-4">
            <label className="block text-sm">
              Group
              <select
                className="mt-1 w-full rounded border bg-background p-2 text-foreground"
                value={id}
                disabled={busy || streaming}
                onChange={(e) => {
                  const g = groups.find((g) => g.id === e.target.value);
                  setId(g?.id || "");
                  setName(g?.name || "");
                  setPaths(g?.paths || []);
                }}
              >
                <option value="">New group</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </label>
            <Input
              aria-label="Group name"
              placeholder="e.g. My CV versions"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy || streaming}
            />
            <div className="max-h-48 overflow-auto rounded border p-2">
              {projects.map((p) => (
                <label
                  key={p.path}
                  className="flex items-center gap-2 p-2 text-sm"
                >
                  <input
                    type="checkbox"
                    checked={paths.includes(p.path)}
                    disabled={busy || streaming}
                    onChange={(e) =>
                      setPaths(
                        e.target.checked
                          ? [...paths, p.path]
                          : paths.filter((x) => x !== p.path),
                      )
                    }
                  />
                  <span>
                    {p.name}
                    <small className="block text-muted-foreground">
                      {p.path}
                    </small>
                  </span>
                </label>
              ))}
            </div>
            <div className="flex gap-2">
              <Button
                disabled={busy || streaming || !name.trim() || paths.length < 2}
                onClick={() => {
                  const next = id || crypto.randomUUID();
                  useProjectGroups
                    .getState()
                    .save({ id: next, name: name.trim(), paths });
                  setId(next);
                }}
              >
                Save group
              </Button>
              <Button
                variant="ghost"
                disabled={!id || busy || streaming}
                onClick={() => {
                  useProjectGroups.getState().remove(id);
                  setId("");
                  setName("");
                  setPaths([]);
                }}
              >
                Delete group
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">
              Membership is manual. Saving a group never copies or edits
              documents. Runs edit the selected local files and create recovery
              checkpoints. Other open Lemlio instances or external editors must
              finish editing first.
            </p>
            <textarea
              aria-label="Group edit request"
              className="min-h-24 w-full rounded border bg-background p-3 text-sm"
              placeholder="Update my phone number across these CVs; keep each version's tailored content."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={busy || streaming}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={
                  busy || streaming || paths.length < 2 || !prompt.trim()
                }
                onClick={() => void work(run)}
              >
                Run Codex on {paths.length} projects
              </Button>
              <Button
                variant="outline"
                disabled={
                  busy ||
                  streaming ||
                  !useProjectGroups.getState().review.length
                }
                onClick={() => void work(review)}
              >
                Review last group run
              </Button>
            </div>
            {streaming && (
              <p className="text-sm">
                Agent running. Use Stop agent in chat to cancel, then review
                changes here.
              </p>
            )}
            {diffs.map((result) => (
              <section key={result.path} className="space-y-2 border-t pt-3">
                <h3 className="break-all font-medium text-sm">{result.path}</h3>
                {!result.files.length && <p className="text-xs">No changes</p>}
                {result.files.map((f) => (
                  <details key={f.file_path}>
                    <summary className="text-sm">
                      {f.status}: {f.file_path}
                    </summary>
                    <div className="grid grid-cols-2 gap-2">
                      <pre
                        role="region"
                        aria-label="File version"
                        className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs"
                      >
                        {"BEFORE\n\n" +
                          (f.old_content ?? "(absent or binary file)")}
                      </pre>
                      <pre
                        role="region"
                        aria-label="File version"
                        className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs"
                      >
                        {"AFTER\n\n" +
                          (f.new_content ?? "(absent or binary file)")}
                      </pre>
                    </div>
                  </details>
                ))}
              </section>
            ))}
            {error && (
              <p role="alert" className="text-destructive text-sm">
                {error}
              </p>
            )}
          </Dialog.Body>
          <Dialog.Footer>
            <Button onClick={() => setOpen(false)}>Close</Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog>
    </div>
  );
}
