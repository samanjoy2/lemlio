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
  setDriveSyncing,
} from "@/lib/drive-backup-status";

import type { ProjectRecord, ProjectCatalogData } from "@/lib/project-catalog";

import { projectPathKey } from "@/lib/project-catalog";

import { useProjectStore } from "@/stores/project-store";

import { useDocumentStore } from "@/stores/document-store";

import { useCodexChatStore } from "@/stores/codex-chat-store";

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
  const [reviewHash, setReviewHash] = useState<string>();

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
      !p.status.uploading &&
      !p.status.incoming,
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
      className="drive-overview mb-6 rounded-xl border border-border bg-card p-4"
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
              ? `All ${rows.length} projects up to date in Drive`
              : `${saved.length} of ${rows.length} projects backed up${attention.length ? ` · ${attention.length} need attention` : " · Backup pending"}`}
          </p>
          <p className="mt-1 text-muted-foreground text-xs">
            {!auto ? "Automatic backup is paused. " : ""}
            {oldest
              ? `Latest checked versions saved ${driveRelativeTime(oldest)}. `
              : ""}
            Changes sync between your devices every minute while Lemlio is open.
            If both copies change, you choose which to keep.
          </p>
          <details className="mt-2 text-xs">
            <summary className="cursor-pointer text-muted-foreground">
              Project revisions
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
                    {p.status.incoming
                      ? `Update from ${p.status.deviceName || "another device"}`
                      : p.status.paused
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
                    {(p.status.conflict ||
                      p.status.paused ||
                      p.status.incoming) && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 text-xs"
                        onClick={() => {
                          setError("");

                          setReviewHash(p.status.conflict?.remoteHash);
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
            <DialogTitle>
              {review && projectDriveStatus(review.path).incoming
                ? "Update from another device"
                : "Review project versions"}
            </DialogTitle>
            <DialogDescription>
              {review?.name}:{" "}
              {review && projectDriveStatus(review.path).incoming
                ? "Your local source is unchanged. You can get the newer revision safely. "
                : "Choose which version to use. "}
              Downloading the Drive version creates a new local project and
              pauses the old local copy. Your existing folder is kept for
              recovery.
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
              {(projectDriveStatus(review.path).conflict?.versions?.length ||
                0) > 1 && (
                <label className="grid gap-2 text-sm">
                  Drive revision
                  <select
                    className="h-9 rounded-lg border bg-background px-3"
                    value={reviewHash}
                    onChange={(e) => setReviewHash(e.target.value)}
                  >
                    {projectDriveStatus(review.path).conflict?.versions?.map(
                      (v) => (
                        <option key={v.remoteHash} value={v.remoteHash}>
                          {v.deviceName || "Other device"} ·{" "}
                          {v.modifiedTime
                            ? new Date(v.modifiedTime).toLocaleString()
                            : v.remoteHash.slice(0, 8)}
                        </option>
                      ),
                    )}
                  </select>
                </label>
              )}
              {projectDriveStatus(review.path).incoming && (
                <Button
                  disabled={busy}
                  onClick={async () => {
                    const doc = useDocumentStore.getState();

                    const wasOpen =
                      !!doc.projectRoot &&
                      projectPathKey(doc.projectRoot) ===
                        projectPathKey(review.path);

                    if (
                      (wasOpen &&
                        (doc.files.some((f) => f.isDirty) ||
                          doc.isCompiling)) ||
                      useCodexChatStore
                        .getState()
                        .tabs.some((t) => t.isStreaming)
                    ) {
                      setError(
                        "Save your edits and wait for the compiler and agent to finish first",
                      );

                      return;
                    }

                    setBusy(true);
                    setError("");
                    setDriveSyncing(review.path, true);

                    if (wasOpen) doc.closeProject();

                    try {
                      const result = await invoke<{
                        lastBackup: number;
                        sourceRevision: string;
                        deviceName?: string;
                      }>("drive_sync_project", {
                        projectPath: review.path,
                        expectedRemoteHash:
                          reviewHash ||
                          projectDriveStatus(review.path).conflict!.remoteHash,
                      });

                      updateDriveBackup(review.path, "saved", result);

                      window.dispatchEvent(
                        new Event("project-library-changed"),
                      );

                      setReview(undefined);

                      toast.success("Latest revision downloaded", {
                        description:
                          "The previous source is kept in a recovery folder beside your project",
                      });
                    } catch (e) {
                      setError(String(e));
                    } finally {
                      setDriveSyncing(review.path, false);
                      setBusy(false);

                      if (wasOpen)
                        await useDocumentStore
                          .getState()
                          .openProject(review.path);
                    }
                  }}
                >
                  {busy ? "Getting revision…" : "Get latest revision"}
                </Button>
              )}
              {projectDriveStatus(review.path).conflict?.deviceName && (
                <p className="text-muted-foreground text-xs">
                  Saved on{" "}
                  {projectDriveStatus(review.path).conflict?.deviceName}
                </p>
              )}
              {(projectDriveStatus(review.path).conflict?.branches || 0) >
                1 && (
                <p className="text-sm">
                  These devices saved competing revisions. Choosing a version
                  keeps both original ZIPs in Drive history.
                </p>
              )}
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

                      expectedRemoteHash:
                        reviewHash ||
                        projectDriveStatus(review.path).conflict?.remoteHash,
                    });

                    updateDriveBackup(review.path, "saved", result);

                    pauseDriveProject(review.path, false);

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
                      syncError?: string;
                    }>("drive_download_conflict", {
                      projectPath: review.path,

                      expectedRemoteHash:
                        reviewHash ||
                        projectDriveStatus(review.path).conflict!.remoteHash,
                    });

                    updateDriveBackup(result.path, "saved", result);
                    if (result.syncError)
                      updateDriveBackup(result.path, "failed", {
                        error: result.syncError,
                      });

                    window.dispatchEvent(new Event("project-library-changed"));

                    window.dispatchEvent(new Event("lemlio-drive-connected"));

                    toast.success(
                      result.syncError
                        ? "Drive version downloaded; sync needs review"
                        : "Drive version downloaded as a new local project",

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
