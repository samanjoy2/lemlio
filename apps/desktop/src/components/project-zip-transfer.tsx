import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  ArchiveIcon,
  CheckIcon,
  DownloadIcon,
  Loader2Icon,
  UploadIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useDocumentStore } from "@/stores/document-store";
import { projectPathKey, type ImportedProject } from "@/lib/project-catalog";

export interface ZipImportResult {
  projects: ImportedProject[];
  storagePath: string;
  archivePath: string | null;
  sourceMoved: boolean;
  warning: string | null;
}

export function ImportProjectDialog({
  open: visible,
  onOpenChange,
  onImported,
  onOpenProject,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
  onOpenProject: (project: ImportedProject) => Promise<void>;
}) {
  const [archivePath, setArchivePath] = useState("");
  const [mode, setMode] = useState<"copy" | "move">("copy");
  const [storage, setStorage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ZipImportResult | null>(null);
  useEffect(() => {
    if (!visible) return;
    setArchivePath("");
    setMode("copy");
    setError(null);
    setResult(null);
    void invoke<string>("project_storage_location")
      .then(setStorage)
      .catch((error) => setError(String(error)));
  }, [visible]);
  const chooseZip = async () => {
    try {
      const chosen = await open({
        title: "Import a project ZIP",
        multiple: false,
        filters: [{ name: "ZIP project", extensions: ["zip"] }],
      });
      if (typeof chosen === "string") {
        setArchivePath(chosen);
        setError(null);
      }
    } catch (error) {
      setError(String(error));
    }
  };
  const importZip = async () => {
    if (!archivePath) return;
    setBusy(true);
    setError(null);
    try {
      const imported = await invoke<ZipImportResult>("import_project_zip", {
        archivePath,
        mode,
      });
      setResult(imported);
      onImported();
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={visible}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {result ? "Your project is in Lemlio" : "Import a project ZIP"}
          </DialogTitle>
          <DialogDescription>
            {result
              ? `${result.projects.length} ${result.projects.length === 1 ? "project was" : "projects were"} added to All projects.`
              : "Choose an exported LaTeX project. Its files and folders stay together."}
          </DialogDescription>
        </DialogHeader>
        {result ? (
          <div className="space-y-4 text-sm">
            <div className="flex items-center gap-2">
              <CheckIcon className="size-4 text-emerald-600" />
              Import complete
            </div>
            <div className="rounded-lg border bg-muted/30 p-3">
              <p className="text-muted-foreground text-xs">Project saved in</p>
              <p className="mt-1 select-text break-all text-xs">
                {result.storagePath}
              </p>
            </div>
            {result.sourceMoved ? (
              <p className="text-muted-foreground text-xs">
                The original ZIP was moved to{" "}
                <span className="select-text break-all">
                  {result.archivePath}
                </span>
                .
              </p>
            ) : (
              <p className="text-muted-foreground text-xs">
                Your original ZIP is still in its original folder.
              </p>
            )}
            {result.warning && (
              <p
                role="alert"
                className="text-amber-700 text-xs dark:text-amber-400"
              >
                {result.warning}
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-5">
            <button
              type="button"
              className="flex w-full items-center gap-3 rounded-lg border border-dashed p-4 text-left hover:bg-muted/40"
              disabled={busy}
              onClick={chooseZip}
            >
              <ArchiveIcon className="size-6 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <strong className="block truncate font-medium text-sm">
                  {archivePath.split(/[/\\]/).pop() || "Choose ZIP file"}
                </strong>
                <span className="mt-1 block truncate text-muted-foreground text-xs">
                  {archivePath || "Select a .zip from your computer"}
                </span>
              </span>
              <UploadIcon className="size-4 shrink-0" />
            </button>
            <fieldset disabled={busy} className="space-y-2">
              <legend className="mb-2 font-medium text-sm">
                What should happen to the ZIP?
              </legend>
              <label className="flex cursor-pointer gap-3 rounded-lg border p-3">
                <input
                  type="radio"
                  name="zip-import-mode"
                  value="copy"
                  checked={mode === "copy"}
                  onChange={() => setMode("copy")}
                  className="mt-1"
                />
                <span>
                  <strong className="block font-medium text-sm">
                    Copy project · keep original ZIP
                  </strong>
                  <span className="mt-1 block text-muted-foreground text-xs leading-relaxed">
                    Extract the project into Lemlio. Your original ZIP stays
                    where it is.
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer gap-3 rounded-lg border p-3">
                <input
                  type="radio"
                  name="zip-import-mode"
                  value="move"
                  checked={mode === "move"}
                  onChange={() => setMode("move")}
                  className="mt-1"
                />
                <span>
                  <strong className="block font-medium text-sm">
                    Move ZIP into Lemlio
                  </strong>
                  <span className="mt-1 block text-muted-foreground text-xs leading-relaxed">
                    Extract the project, then move the ZIP into
                    Projects/Archives. It is removed from its original folder
                    only after import and verification succeed.
                  </span>
                </span>
              </label>
            </fieldset>
            <div className="rounded-lg bg-muted/40 p-3 text-xs">
              <p className="text-muted-foreground">
                Imported projects are kept inside
              </p>
              <p className="mt-1 select-text break-all">
                {storage
                  ? `${storage.replace(/[/\\]$/, "")}/Imports`
                  : "Lemlio’s Projects/Imports folder"}
              </p>
            </div>
            {error && (
              <p role="alert" className="text-destructive text-xs">
                {error}
              </p>
            )}
          </div>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            {result ? "Done" : "Cancel"}
          </Button>
          {result ? (
            result.projects.length === 1 && (
              <Button
                onClick={async () => {
                  await onOpenProject(result.projects[0]);
                  onOpenChange(false);
                }}
              >
                Open project
              </Button>
            )
          ) : (
            <Button disabled={!archivePath || busy} onClick={importZip}>
              {busy ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : (
                <UploadIcon className="size-4" />
              )}
              {busy ? "Importing…" : "Import project"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function useProjectZipExport() {
  const [exportingPath, setExportingPath] = useState<string | null>(null);
  const exportZip = async (projectPath: string, name: string) => {
    if (exportingPath) return;
    try {
      const destination = await save({
        title: "Export project as ZIP",
        defaultPath: `${name.replace(/[<>:"/\\|?*]/g, "_")}.zip`,
        filters: [{ name: "ZIP project", extensions: ["zip"] }],
      });
      if (!destination) return;
      setExportingPath(projectPath);
      if (
        projectPathKey(useDocumentStore.getState().projectRoot ?? "") ===
        projectPathKey(projectPath)
      ) {
        await useDocumentStore.getState().saveAllFiles();
        if (useDocumentStore.getState().files.some((file) => file.isDirty))
          throw new Error(
            "Some changes could not be saved. Save your files before exporting.",
          );
      }
      const fileCount = await invoke<number>("export_project_zip", {
        projectPath,
        destination,
      });
      toast.success("Project exported", {
        description: `${fileCount} files saved to ${destination}`,
      });
    } catch (error) {
      toast.error("Could not export project", { description: String(error) });
    } finally {
      setExportingPath(null);
    }
  };
  return { exportingPath, exportZip };
}

export function ProjectZipExportButton({
  projectPath,
}: {
  projectPath: string | null;
}) {
  const { exportingPath, exportZip } = useProjectZipExport();
  if (!projectPath) return null;
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-6"
      title="Export project ZIP"
      aria-label="Export project ZIP"
      disabled={!!exportingPath}
      onClick={() =>
        exportZip(projectPath, projectPath.split(/[/\\]/).pop() || "project")
      }
    >
      {exportingPath ? (
        <Loader2Icon className="size-3.5 animate-spin" />
      ) : (
        <DownloadIcon className="size-3.5" />
      )}
    </Button>
  );
}
