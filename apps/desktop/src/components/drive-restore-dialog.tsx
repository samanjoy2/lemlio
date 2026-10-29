import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CloudDownloadIcon, LoaderCircleIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { updateDriveBackup } from "@/lib/drive-backup-status";

type Backup = {
  id: string;
  name: string;
  modifiedTime?: string;
  size?: string;
  localPath?: string;
};
export function DriveRestoreDialog() {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<Backup[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const load = async () => {
    setBusy(true);
    setError("");
    setMessage("Looking for project ZIPs in your Drive…");
    try {
      const result = await invoke<{ projects: Backup[] }>("drive_list_backups");
      setProjects(result.projects);
      setSelected([]);
      setMessage(
        result.projects.length
          ? ""
          : "No Lemlio ZIP backups were found. Use the same Google account and OAuth project as your previous device.",
      );
    } catch (e) {
      setError(String(e));
      setMessage("");
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    const show = () => {
      setOpen(true);
      void load();
    };
    window.addEventListener("lemlio-restore-drive", show);
    return () => window.removeEventListener("lemlio-restore-drive", show);
  }, []);
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!busy) setOpen(value);
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Restore projects from Google Drive</DialogTitle>
          <DialogDescription>
            On a new device, choose the ZIP backups you want to download. Each
            restores into a new local project folder. Existing local folders are
            kept. The restored local copy then becomes your working source.
          </DialogDescription>
        </DialogHeader>
        {!busy && projects.length > 0 && (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                setSelected(
                  projects.filter((p) => !p.localPath).map((p) => p.id),
                )
              }
            >
              Select all missing projects
            </Button>
            <ul className="max-h-72 space-y-2 overflow-auto">
              {projects.map((p) => (
                <li key={p.id}>
                  <label className="flex items-start gap-3 rounded-lg border border-border px-3 py-2">
                    <input
                      type="checkbox"
                      className="mt-1"
                      disabled={!!p.localPath}
                      checked={selected.includes(p.id)}
                      onChange={(e) =>
                        setSelected((current) =>
                          e.target.checked
                            ? [...current, p.id]
                            : current.filter((id) => id !== p.id),
                        )
                      }
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{p.name}</span>
                      <span className="text-muted-foreground text-xs">
                        {p.localPath
                          ? "Already on this device"
                          : p.modifiedTime
                            ? `Backed up ${new Date(p.modifiedTime).toLocaleString()}`
                            : "Drive ZIP backup"}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </>
        )}
        {busy && (
          <p className="flex items-center gap-2 text-muted-foreground text-sm">
            <LoaderCircleIcon className="size-4 animate-spin" />
            {message}
          </p>
        )}
        {!busy && message && (
          <p role="status" className="text-sm">
            {message}
          </p>
        )}
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setOpen(false);
              window.dispatchEvent(
                new CustomEvent("lemlio-open-settings", {
                  detail: "Google Drive",
                }),
              );
            }}
          >
            Google Drive settings
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => setOpen(false)}
          >
            Close
          </Button>
          <Button
            disabled={busy || !selected.length}
            onClick={async () => {
              setBusy(true);
              setError("");
              let restored = 0;
              try {
                for (const [index, id] of selected.entries()) {
                  setMessage(
                    `Downloading and verifying project ${index + 1} of ${selected.length}…`,
                  );
                  const result = await invoke<{
                    path: string;
                    lastBackup: number;
                    sourceRevision: string;
                  }>("drive_restore_project", { archiveId: id });
                  updateDriveBackup(result.path, "saved", result);
                  setSelected((current) =>
                    current.filter((value) => value !== id),
                  );
                  setProjects((current) =>
                    current.map((project) =>
                      project.id === id
                        ? { ...project, localPath: result.path }
                        : project,
                    ),
                  );
                  restored++;
                }
                window.dispatchEvent(new Event("project-library-changed"));
                window.dispatchEvent(new Event("lemlio-drive-connected"));
                await load();
                setMessage(
                  `${restored} projects restored. You can open them from the project library.`,
                );
              } catch (e) {
                setError(String(e));
                setMessage(
                  `${restored} projects restored. Existing PC files were kept.`,
                );
                window.dispatchEvent(new Event("project-library-changed"));
              } finally {
                setBusy(false);
              }
            }}
          >
            <CloudDownloadIcon size={15} />
            Restore selected projects
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
export function requestDriveRestore() {
  window.dispatchEvent(new Event("lemlio-restore-drive"));
}
