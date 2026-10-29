import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CloudIcon, CloudOffIcon, LoaderCircleIcon } from "lucide-react";
import {
  DRIVE_UPDATED,
  driveRelativeTime,
  projectDriveStatus,
} from "@/lib/drive-backup-status";
import { useSettingsStore } from "@/stores/settings-store";
import { useDocumentStore } from "@/stores/document-store";

export function DriveStatus({ projectPath }: { projectPath?: string | null }) {
  const [connection, setConnection] = useState<{
    connected: boolean;
    pending: boolean;
    lastBackup?: number;
  }>();
  const [, redraw] = useState(0);
  const auto = useSettingsStore((s) => s.autoDriveBackup);
  const dirty = useDocumentStore(
    (s) =>
      !!projectPath &&
      s.projectRoot === projectPath &&
      s.files.some((f) => f.isDirty),
  );
  useEffect(() => {
    let disposed = false;
    const refresh = () => {
      redraw((n) => n + 1);
      void invoke<{
        connected: boolean;
        pending: boolean;
        lastBackup?: number;
      }>("drive_status")
        .then((status) => {
          if (!disposed) setConnection(status);
        })
        .catch(() => {
          if (!disposed) setConnection(undefined);
        });
    };
    refresh();
    const timer = setInterval(refresh, 15000);
    window.addEventListener(DRIVE_UPDATED, refresh);
    window.addEventListener("focus", refresh);
    window.addEventListener("lemlio-drive-connected", refresh);
    return () => {
      disposed = true;
      clearInterval(timer);
      window.removeEventListener(DRIVE_UPDATED, refresh);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("lemlio-drive-connected", refresh);
    };
  }, []);
  const project = projectPath ? projectDriveStatus(projectPath) : undefined;
  let label = "Google Drive · Connect";
  if (connection?.pending) label = "Google Drive · Signing in…";
  else if (connection?.connected) {
    if (!projectPath) label = "Google Drive connected";
    else if (project?.uploading) label = "Saving to Drive…";
    else if (project?.error) label = "Drive backup failed · Will retry";
    else if (!auto) label = "Drive auto-backup paused";
    else if (dirty || project?.pending) label = "Drive backup pending";
    else if (project?.lastBackup)
      label = `Saved to Drive ${driveRelativeTime(project.lastBackup)}`;
    else label = "Drive connected · No backup yet";
  }
  const Icon = project?.uploading
    ? LoaderCircleIcon
    : connection?.connected
      ? CloudIcon
      : CloudOffIcon;
  const detail = project?.lastBackup
    ? `Last backup of this project: ${new Date(project.lastBackup * 1000).toLocaleString()}. `
    : "";
  return (
    <button
      type="button"
      className={
        projectPath
          ? "flex w-full shrink-0 items-center gap-2 border-t px-3 py-1.5 text-left text-muted-foreground text-xs hover:bg-muted"
          : "home-connection-row"
      }
      title={`${detail}${project?.error || "Open Google Drive settings"}`}
      onClick={() =>
        window.dispatchEvent(
          new CustomEvent("lemlio-open-settings", { detail: "Google Drive" }),
        )
      }
    >
      {projectPath ? (
        <>
          <Icon
            size={15}
            className={project?.uploading ? "animate-spin" : undefined}
          />
          <span aria-live="polite">{label}</span>
        </>
      ) : (
        <>
          <span className="home-connection-icon">
            <Icon size={15} />
          </span>
          <span className="home-connection-name">Google Drive</span>
          <span
            aria-live="polite"
            className={
              connection?.connected
                ? "home-connection-badge is-connected"
                : "home-connection-badge"
            }
          >
            {connection?.connected
              ? "Connected"
              : connection?.pending
                ? "Signing in"
                : "Connect"}
          </span>
        </>
      )}
    </button>
  );
}
