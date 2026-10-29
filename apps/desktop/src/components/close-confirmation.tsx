import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { CloudCheckIcon, CloudAlertIcon, LoaderCircleIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { useDocumentStore } from "@/stores/document-store";
import { useProjectStore } from "@/stores/project-store";
import { useCodexChatStore } from "@/stores/codex-chat-store";
import { useSettingsStore } from "@/stores/settings-store";
import { updateDriveBackup } from "@/lib/drive-backup-status";
import { projectPathKey, type ProjectCatalogData } from "@/lib/project-catalog";

export type CloseBackupSummary = {
  allBackedUp: boolean;
  connected: boolean;
  error?: string;
  projects: { path: string; status: string; lastBackup?: number }[];
};
function activeWork() {
  return (
    useDocumentStore.getState().isCompiling ||
    useCodexChatStore.getState().isStreaming ||
    useCodexChatStore.getState().tabs.some((t) => t.isStreaming)
  );
}
export function CloseConfirmation() {
  const [open, setOpen] = useState(false);
  const opened = useRef(false);
  const allowed = useRef(false);
  const [checking, setChecking] = useState(false);
  const [summary, setSummary] = useState<CloseBackupSummary>();
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const skip = useSettingsStore((s) => s.skipCloseWhenBackedUp);
  const setSkip = useSettingsStore((s) => s.setSkipCloseWhenBackedUp);
  const compiling = useDocumentStore((s) => s.isCompiling);
  const streaming = useCodexChatStore(
    (s) => s.isStreaming || s.tabs.some((t) => t.isStreaming),
  );
  const dirty = useDocumentStore((s) => s.files.some((f) => f.isDirty));
  const close = async () => {
    allowed.current = true;
    try {
      await getCurrentWindow().close();
    } catch (e) {
      allowed.current = false;
      setError(String(e));
    }
  };
  const check = async () => {
    await useDocumentStore.getState().saveAllFiles();
    if (useDocumentStore.getState().files.some((f) => f.isDirty))
      throw Error(
        "Some edits could not be saved on this PC. Keep Lemlio open and save them before closing.",
      );
    const library = await invoke<ProjectCatalogData>("list_imported_projects");
    const paths = [
      ...(library?.projects || []).map((p) => p.path),
      ...useProjectStore.getState().knownProjects.map((p) => p.path),
      useDocumentStore.getState().projectRoot,
    ].filter((p): p is string => !!p);
    const unique = [
      ...new Map(paths.map((p) => [projectPathKey(p), p])).values(),
    ];
    const result = await invoke<CloseBackupSummary>("drive_backup_summary", {
      projectPaths: unique,
    });
    setSummary(result);
    return result;
  };
  const request = async () => {
    if (opened.current) return;
    opened.current = true;
    setOpen(true);
    setChecking(true);
    setSummary(undefined);
    setError("");
    setMessage("Saving files and checking Drive backups…");
    try {
      const result = await check();
      if (
        result.allBackedUp &&
        useSettingsStore.getState().skipCloseWhenBackedUp &&
        !activeWork()
      )
        await close();
    } catch (e) {
      setError(String(e));
    } finally {
      setChecking(false);
      setMessage("");
    }
  };
  const requestRef = useRef(request);
  requestRef.current = request;
  useEffect(() => {
    let disposed = false;
    const listening = getCurrentWindow().onCloseRequested((event) => {
      if (allowed.current) return;
      event.preventDefault();
      if (!disposed) void requestRef.current();
    });
    return () => {
      disposed = true;
      void listening.then((stop) => stop());
    };
  }, []);
  const complete = summary?.allBackedUp && !error && !dirty;
  const count =
    summary?.projects.filter((p) => p.status === "saved").length || 0;
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!checking && !value) {
          opened.current = false;
          setOpen(false);
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {checking
              ? "Preparing to close Lemlio"
              : complete
                ? "Everything is saved and backed up"
                : "Check your backups before closing"}
          </DialogTitle>
          <DialogDescription>
            {checking
              ? message
              : complete
                ? summary?.projects.length
                  ? `All ${summary.projects.length} PC project versions are confirmed in Drive.`
                  : "There are no local projects to back up."
                : "Files saved on this PC stay here. Pending uploads stop when Lemlio closes and retry the next time you open it."}
          </DialogDescription>
        </DialogHeader>
        {checking ? (
          <div className="flex items-center gap-2 py-2 text-muted-foreground text-sm">
            <LoaderCircleIcon className="size-4 animate-spin" />
            {message}
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            {summary && (
              <p className="flex items-center gap-2">
                {complete ? (
                  <CloudCheckIcon className="size-5 text-primary" />
                ) : (
                  <CloudAlertIcon className="size-5 text-amber-500" />
                )}
                {count} of {summary.projects.length} projects confirmed in Drive
              </p>
            )}
            {(error || summary?.error) && (
              <p role="alert" className="text-destructive">
                {error || summary?.error}
              </p>
            )}
            {summary?.projects.some((p) => p.status !== "saved") && (
              <ul className="max-h-40 space-y-1 overflow-auto text-muted-foreground text-xs">
                {summary.projects
                  .filter((p) => p.status !== "saved")
                  .map((p) => (
                    <li key={p.path}>
                      {p.path.split(/[/\\]/).pop()} ·{" "}
                      {p.status === "conflict"
                        ? "Drive version changed; review in Settings"
                        : "Backup pending"}
                    </li>
                  ))}
              </ul>
            )}
            {(compiling || streaming) && (
              <p className="text-amber-600 dark:text-amber-400">
                {streaming
                  ? "The agent is still working. Closing will stop it."
                  : "PDF compilation is still running."}
              </p>
            )}
            {complete && (
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={skip}
                  onChange={(e) => setSkip(e.target.checked)}
                />
                Don't ask again when everything is saved and backed up
              </label>
            )}
          </div>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="outline"
            disabled={checking}
            onClick={() => {
              opened.current = false;
              setOpen(false);
            }}
          >
            Keep Lemlio open
          </Button>
          {!complete && summary?.connected && !error && (
            <Button
              variant="outline"
              disabled={checking || streaming || compiling}
              onClick={async () => {
                setChecking(true);
                setError("");
                try {
                  for (const [index, p] of summary.projects
                    .filter((p) => p.status !== "saved")
                    .entries()) {
                    setMessage(`Backing up project ${index + 1}…`);
                    updateDriveBackup(p.path, "uploading");
                    try {
                      const result = await invoke<{
                        lastBackup: number;
                        sourceRevision: string;
                      }>("drive_backup_project", { projectPath: p.path });
                      updateDriveBackup(p.path, "saved", result);
                    } catch (e) {
                      updateDriveBackup(p.path, "failed", { error: String(e) });
                      throw e;
                    }
                  }
                  const result = await check();
                  if (result.allBackedUp && !activeWork()) await close();
                } catch (e) {
                  setError(
                    String(e).startsWith("DRIVE_CONFLICT:")
                      ? "A Drive backup changed. Keep Lemlio open and review the conflict in Google Drive settings."
                      : String(e),
                  );
                } finally {
                  setChecking(false);
                  setMessage("");
                }
              }}
            >
              Back up and close
            </Button>
          )}
          <Button
            disabled={checking}
            variant={dirty ? "destructive" : "default"}
            onClick={() =>
              void (async () => {
                if (!complete) {
                  await close();
                  return;
                }
                setChecking(true);
                setMessage("Confirming the latest saved versions…");
                try {
                  const result = await check();
                  if (result.allBackedUp) await close();
                } catch (e) {
                  setError(String(e));
                } finally {
                  setChecking(false);
                  setMessage("");
                }
              })()
            }
          >
            {complete
              ? "Close Lemlio"
              : dirty
                ? "Close without saving"
                : error
                  ? "Close anyway"
                  : "Close with pending backups"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
