import { useEffect, useState } from "react";

import { invoke } from "@tauri-apps/api/core";

import { CloudCheckIcon, CloudAlertIcon } from "lucide-react";

import { toast } from "sonner";

import { Button } from "./ui/button";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

import {
  DRIVE_UPDATED,
  driveRelativeTime,
  pauseDriveProject,
  projectDriveStatus,
  updateDriveBackup,
} from "@/lib/drive-backup-status";

import type { ProjectRecord, ProjectCatalogData } from "@/lib/project-catalog";

import { projectPathKey } from "@/lib/project-catalog";

import { useProjectStore } from "@/stores/project-store";

import { useSettingsStore } from "@/stores/settings-store";

export function DriveBackupOverview({
  projects: supplied,
}: {
  projects?: Pick<ProjectRecord, "path" | "name">[];
}) {
  const [loaded, setLoaded] = useState<Pick<ProjectRecord, "path" | "name">[]>(
    [],
  );

  const [connected, setConnected] = useState(false);

  const [, redraw] = useState(0);

  const [review, setReview] = useState<Pick<ProjectRecord, "path" | "name">>();

  const [busy, setBusy] = useState(false);

  const [error, setError] = useState("");

  const auto = useSettingsStore((s) => s.autoDriveBackup);

  useEffect(() => {
    let disposed = false;

    const refresh = () => {
      redraw((n) => n + 1);

      void invoke<{ connected: boolean }>("drive_status")

        .then((s) => {
          if (!disposed) setConnected(s.connected);
        })

        .catch(() => {});
    };

    refresh();

    const timer = setInterval(refresh, 15000);

    window.addEventListener(DRIVE_UPDATED, refresh);

    if (!supplied)
      void invoke<ProjectCatalogData>("list_imported_projects")

        .then((data) => {
          if (!disposed)
            setLoaded([
              ...(data?.projects || []),

              ...useProjectStore.getState().knownProjects,
            ]);
        })

        .catch(() => {});

    return () => {
      disposed = true;

      clearInterval(timer);

      window.removeEventListener(DRIVE_UPDATED, refresh);
    };
  }, [supplied]);

  const projects = [
    ...new Map(
      (supplied || loaded).map((p) => [projectPathKey(p.path), p]),
    ).values(),
  ];

  if (!connected || !projects.length) return null;

  const rows = projects.map((p) => ({
    ...p,

    status: projectDriveStatus(p.path),
  }));

  const saved = rows.filter(
    (p) =>
      p.status.lastBackup &&
      p.status.sourceRevision &&
      !p.status.pending &&
      !p.status.error &&
      !p.status.paused &&
      !p.status.uploading,
  );

  const attention = rows.filter(
    (p) => p.status.conflict || p.status.paused || p.status.error,
  );

  const complete = saved.length === rows.length;

  const oldest = saved.length
    ? Math.min(...saved.map((p) => p.status.lastBackup!))
    : undefined;

  const Icon = complete ? CloudCheckIcon : CloudAlertIcon;

  return (
    <section
      className="mb-5 rounded-xl border border-border bg-card px-4 py-3"
      aria-label="Google Drive backup overview"
    >
      <div className="flex items-start gap-3">
        <Icon
          size={19}
          className={
            complete
              ? "mt-0.5 shrink-0 text-primary"
              : "mt-0.5 shrink-0 text-muted-foreground"
          }
        />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-sm" role="status">
            {complete
              ? `All ${rows.length} projects backed up to Drive`
              : `${saved.length} of ${rows.length} projects backed up${attention.length ? ` · ${attention.length} need attention` : " · Backup pending"}`}
          </p>
          <p className="mt-1 text-muted-foreground text-xs">
            {!auto ? "Automatic backup is paused. " : ""}
            {oldest
              ? `Latest checked PC versions saved ${driveRelativeTime(oldest)}. `
              : ""}
            PC files are the source. One ZIP per project; local changes are
            checked every minute while Lemlio is open.
          </p>
          <details className="mt-2 text-xs">
            <summary className="cursor-pointer text-muted-foreground">
              Project backup details
            </summary>
            <ul className="mt-2 space-y-2">
              {rows.map((p) => (
                <li
                  key={p.path}
                  className="flex flex-wrap items-center justify-between gap-2"
                >
                  <span className="min-w-0 truncate" title={p.path}>
                    {p.name}
                  </span>
                  <span className="flex items-center gap-2 text-muted-foreground">
                    {p.status.paused
                      ? "Local backup paused"
                      : p.status.conflict
                        ? "Drive version changed"
                        : p.status.uploading
                          ? "Uploading ZIP…"
                          : p.status.error
                            ? "Backup failed"
                            : p.status.pending || !p.status.sourceRevision
                              ? "Pending"
                              : p.status.lastBackup
                                ? `Saved ${driveRelativeTime(p.status.lastBackup)}`
                                : "No backup yet"}
                    {(p.status.conflict || p.status.paused) && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 text-xs"
                        onClick={() => {
                          setError("");

                          setReview(p);
                        }}
                      >
                        Review
                      </Button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        </div>
      </div>
      <Dialog
        open={!!review}
        onOpenChange={(value) => {
          if (!busy && !value) setReview(undefined);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Resolve the Drive conflict</DialogTitle>
            <DialogDescription>
              {review?.name}: choose which version to use. Downloading the Drive
              version creates a new local project and pauses the old local copy.
              Your existing folder is kept for recovery.
            </DialogDescription>
          </DialogHeader>
          {review && (
            <div className="space-y-3 text-sm">
              <p>
                Drive changed:{" "}
                {projectDriveStatus(review.path).conflict?.modifiedTime
                  ? new Date(
                      projectDriveStatus(review.path).conflict!.modifiedTime!,
                    ).toLocaleString()
                  : "Unknown time"}
              </p>
              <p className="break-all text-muted-foreground text-xs">
                PC folder: {review.path}
              </p>
              <Button
                disabled={busy}
                onClick={async () => {
                  setBusy(true);

                  setError("");

                  try {
                    updateDriveBackup(review.path, "uploading");

                    const result = await invoke<{
                      lastBackup: number;

                      sourceRevision: string;
                    }>("drive_backup_project", {
                      projectPath: review.path,

                      expectedRemoteHash: projectDriveStatus(review.path)
                        .conflict?.remoteHash,
                    });

                    updateDriveBackup(review.path, "saved", result);

                    window.dispatchEvent(new Event("lemlio-drive-connected"));

                    setReview(undefined);
                  } catch (e) {
                    updateDriveBackup(review.path, "failed", {
                      error: String(e),
                    });

                    setError(
                      String(e).startsWith("DRIVE_CONFLICT:")
                        ? "The Drive ZIP changed again. Review the updated version before replacing it."
                        : String(e),
                    );
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy
                  ? "Uploading PC version…"
                  : "Use PC version · Replace Drive ZIP"}
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  pauseDriveProject(review.path, true);

                  setReview(undefined);
                }}
              >
                Pause uploads only · Keep local files
              </Button>
              <Button
                variant="outline"
                disabled={
                  busy ||
                  !review ||
                  !projectDriveStatus(review.path).conflict?.remoteHash
                }
                onClick={async () => {
                  const previous = projectDriveStatus(review.path).paused;

                  setBusy(true);
                  setError("");

                  pauseDriveProject(review.path, true);

                  try {
                    const result = await invoke<{
                      path: string;
                      lastBackup: number;
                      sourceRevision: string;
                    }>("drive_download_conflict", {
                      projectPath: review.path,

                      expectedRemoteHash: projectDriveStatus(review.path)
                        .conflict!.remoteHash,
                    });

                    updateDriveBackup(result.path, "saved", result);

                    window.dispatchEvent(new Event("project-library-changed"));

                    window.dispatchEvent(new Event("lemlio-drive-connected"));

                    toast.success(
                      "Drive version downloaded as a new local project",
                      {
                        description: result.path,

                        action: {
                          label: "Open folder",
                          onClick: () => {
                            void invoke("open_project_folder", {
                              projectPath: result.path,
                            });
                          },
                        },
                      },
                    );

                    setReview(undefined);
                  } catch (e) {
                    pauseDriveProject(review.path, !!previous);
                    setError(String(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Download Drive version · Keep old local copy
              </Button>
              <p className="text-muted-foreground text-xs">
                Pause uploads only does not download anything. After
                downloading, open the new project from your library; its edits
                update the same Drive ZIP.
              </p>
              {error && (
                <p role="alert" className="text-destructive">
                  {error}
                </p>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
