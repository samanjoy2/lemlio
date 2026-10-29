import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { useProjectStore } from "@/stores/project-store";
import { useDocumentStore } from "@/stores/document-store";
import { useCodexChatStore } from "@/stores/codex-chat-store";
import { forgetDriveProject } from "@/lib/drive-backup-status";

export function requestProjectDelete(path: string, name: string) {
  window.dispatchEvent(
    new CustomEvent("lemlio-delete-project", { detail: { path, name } }),
  );
}

export function DeleteProjectDialog() {
  const [project, setProject] = useState<{ path: string; name: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const show = (e: Event) => {
      setError("");
      setProject((e as CustomEvent<{ path: string; name: string }>).detail);
    };
    window.addEventListener("lemlio-delete-project", show);
    return () => window.removeEventListener("lemlio-delete-project", show);
  }, []);
  return (
    <Dialog
      open={!!project}
      onOpenChange={(value) => {
        if (!busy && !value) setProject(undefined);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {project?.name}?</DialogTitle>
          <DialogDescription>
            The project folder and its files will move to the Windows Recycle
            Bin. Existing Drive backups are kept.
          </DialogDescription>
        </DialogHeader>
        <p className="break-all text-muted-foreground text-xs">
          {project?.path}
        </p>
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => setProject(undefined)}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={async () => {
              if (!project) return;
              setBusy(true);
              setError("");
              try {
                const doc = useDocumentStore.getState();
                if (doc.projectRoot === project.path) {
                  if (
                    doc.isCompiling ||
                    useCodexChatStore.getState().tabs.some((t) => t.isStreaming)
                  )
                    throw new Error(
                      "Stop the agent and wait for compilation to finish before deleting this project.",
                    );
                  await doc.saveAllFiles();
                  if (useDocumentStore.getState().files.some((f) => f.isDirty))
                    throw new Error(
                      "Save your changes before deleting this project.",
                    );
                }
                await invoke("delete_project", { projectPath: project.path });
                if (useDocumentStore.getState().projectRoot === project.path)
                  useDocumentStore.getState().closeProject();
                useProjectStore.getState().forgetProject(project.path);
                forgetDriveProject(project.path);
                window.dispatchEvent(new Event("project-library-changed"));
                setProject(undefined);
              } catch (e) {
                setError(String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Moving to Recycle Bin…" : "Move to Recycle Bin"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
