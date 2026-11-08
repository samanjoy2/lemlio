import { useProjectStore } from "@/stores/project-store";
import { flushCollaboration } from "@/lib/collaboration/runtime";
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { CopyPlusIcon, FolderIcon } from "lucide-react";
import { Dialog } from "./panelui/dialog";
import { Field } from "./panelui/field";
import { Input } from "./panelui/input";
import { Button } from "./ui/button";
import { useDocumentStore } from "@/stores/document-store";
import { useCodexChatStore } from "@/stores/codex-chat-store";
import { projectPathKey } from "@/lib/project-catalog";

export function requestProjectClone(path: string, name: string) {
  window.dispatchEvent(
    new CustomEvent("lemlio-clone-project", { detail: { path, name } }),
  );
}
export function CloneProjectDialog() {
  const [source, setSource] = useState<{ path: string; name: string }>();
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const show = (event: Event) => {
      const project = (event as CustomEvent<{ path: string; name: string }>)
        .detail;
      setSource(project);
      setName(`Copy of ${project.name}`.slice(0, 200));
      setError("");
    };
    window.addEventListener("lemlio-clone-project", show);
    return () => window.removeEventListener("lemlio-clone-project", show);
  }, []);
  const copy = async () => {
    if (!source || !name.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const doc = useDocumentStore.getState();
      const active =
        doc.projectRoot &&
        projectPathKey(doc.projectRoot) === projectPathKey(source.path);
      if (active) {
        if (
          doc.isCompiling ||
          useCodexChatStore.getState().tabs.some((t) => t.isStreaming)
        )
          throw new Error(
            "Wait for compilation and the agent to finish before cloning",
          );
        await doc.saveAllFiles();
        if (useDocumentStore.getState().files.some((f) => f.isDirty))
          throw new Error("Save your changes before cloning");
      }
      await flushCollaboration(source.path);
      const result = await invoke<{
        path: string;
        name: string;
        warning?: string;
      }>("clone_project", { projectPath: source.path, name: name.trim() });
      const main = active
        ? doc.mainFileId
        : localStorage.getItem(`lemlio-main:${source.path}`);
      if (main) localStorage.setItem(`lemlio-main:${result.path}`, main);
      useProjectStore.getState().addRecentProject(result.path);
      window.dispatchEvent(
        new CustomEvent("lemlio-project-cloned", { detail: result.path }),
      );
      window.dispatchEvent(new Event("project-library-changed"));
      window.dispatchEvent(
        new CustomEvent("lemlio-project-saved", { detail: result.path }),
      );
      toast.success("Project cloned", {
        description:
          result.warning || `${result.name} is available in Projects`,
      });
      setSource(undefined);
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={!!source}
      onOpenChange={(open) => {
        if (!open && !busy) setSource(undefined);
      }}
      dismissible={!busy}
    >
      <Dialog.Content size="md" showClose={!busy}>
        <Dialog.Header
          title="Clone project"
          description="Create an independent copy in your project library"
        />
        <Dialog.Body className="space-y-4">
          <div className="flex items-center gap-3 rounded-lg border bg-muted/40 p-3 text-sm">
            <FolderIcon size={18} className="shrink-0 text-muted-foreground" />
            <span className="truncate">{source?.name}</span>
          </div>
          <Field name="clone-name">
            <Field.Label>Project name</Field.Label>
            <Input
              autoFocus
              maxLength={200}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void copy();
                }
              }}
              aria-invalid={!!error}
            />
            <Field.Description>
              Source files, bibliography and figures are copied. The clone has
              its own Drive backup.
            </Field.Description>
          </Field>
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
        </Dialog.Body>
        <Dialog.Footer>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => setSource(undefined)}
          >
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={!name.trim()}
            onClick={() => void copy()}
          >
            <CopyPlusIcon size={16} />
            {busy ? "Cloning…" : "Clone project"}
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog>
  );
}
