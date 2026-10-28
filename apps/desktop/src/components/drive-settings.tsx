import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as chooseFile } from "@tauri-apps/plugin-dialog";
import { open } from "@tauri-apps/plugin-shell";
import { Button } from "./ui/button";
import { ActivityOrb } from "./activity-feedback";
import { updateDriveBackup, DRIVE_UPDATED } from "@/lib/drive-backup-status";
import { useSettingsStore } from "@/stores/settings-store";
import { useDocumentStore } from "@/stores/document-store";
import { useProjectStore } from "@/stores/project-store";
import { projectPathKey, type ProjectCatalogData } from "@/lib/project-catalog";

interface DriveStatus {
  configured: boolean;
  connected: boolean;
  pending: boolean;
  error: string | null;
  lastBackup: number | null;
  folderUrl: string | null;
}
export function DriveSettings() {
  const previousConnection = useRef(false);
  const [status, setStatus] = useState<DriveStatus>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const auto = useSettingsStore((s) => s.autoDriveBackup);
  const setAuto = useSettingsStore((s) => s.setAutoDriveBackup);
  const refresh = () =>
    invoke<DriveStatus>("drive_status")
      .then((value) => {
        setStatus(value);
        if (value.connected && !previousConnection.current)
          window.dispatchEvent(new Event("lemlio-drive-connected"));
        previousConnection.current = value.connected;
      })
      .catch((e) => setError(String(e)));
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, []);
  const configure = async () => {
    try {
      const path = await chooseFile({
        title: "Choose Desktop OAuth client JSON",
        multiple: false,
        filters: [{ name: "Google OAuth JSON", extensions: ["json"] }],
      });
      if (typeof path !== "string") return;
      await invoke("drive_configure", { clientPath: path });
      window.dispatchEvent(new Event(DRIVE_UPDATED));
      setMessage("OAuth configuration saved locally.");
      setError("");
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };
  const connect = async () => {
    try {
      setError("");
      const url = await invoke<string>("drive_connect");
      await open(url);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };
  const backup = async (all: boolean) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      let paths: string[] = [];
      if (all) {
        const library = await invoke<ProjectCatalogData>(
          "list_imported_projects",
        );
        paths = [
          ...library.projects.map((p) => p.path),
          ...useProjectStore.getState().knownProjects.map((p) => p.path),
        ];
        const seen = new Set<string>();
        paths = paths.filter((p) => {
          const key = projectPathKey(p);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      } else if (useDocumentStore.getState().projectRoot) {
        await useDocumentStore.getState().saveAllFiles();
        if (useDocumentStore.getState().files.some((f) => f.isDirty))
          throw new Error("Save your changes before backing up.");
        paths = [useDocumentStore.getState().projectRoot!];
      }
      if (!paths.length)
        throw new Error("No projects are available to back up.");
      for (let i = 0; i < paths.length; i++) {
        setMessage(`Backing up project ${i + 1} of ${paths.length}…`);
        updateDriveBackup(paths[i], "uploading");
        try {
          const result = await invoke<{ lastBackup?: number }>(
            "drive_backup_project",
            { projectPath: paths[i] },
          );
          updateDriveBackup(paths[i], "saved", result);
        } catch (error) {
          updateDriveBackup(paths[i], "failed", { error: String(error) });
          throw error;
        }
      }
      setMessage(`${paths.length} project backups saved in Google Drive.`);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4">
      <h3 className="font-medium">Google Drive account</h3>
      <p>
        Connect your account to save versioned project ZIPs in a{" "}
        <strong>Lemlio Backups</strong> folder in your Drive.
      </p>
      <div className="space-y-3 rounded-lg border p-4">
        <strong className="block">1. Choose your OAuth JSON</strong>
        <p className="text-muted-foreground text-xs">
          Each installation can use its own Google Desktop OAuth client. Choose
          the JSON file downloaded from Google Cloud. It is copied into local
          app settings, outside your projects. Configuration files are excluded
          from Git and backups; sign-in tokens stay in Windows Credential
          Manager. Authorization requests go directly to Google.
        </p>
        <Button variant="outline" onClick={configure}>
          {status?.configured
            ? "Replace local OAuth JSON"
            : "Choose OAuth JSON"}
        </Button>
        <details className="text-xs">
          <summary className="cursor-pointer">How to create the JSON</summary>
          <ol className="mt-3 list-decimal space-y-2 pl-5">
            <li>
              Create a Google Cloud project named Lemlio and enable Google Drive
              API.
            </li>
            <li>
              Configure Google Auth Platform with your app name and support
              email. For personal testing, add your Google account as a test
              user.
            </li>
            <li>
              Add the non-sensitive scope
              https://www.googleapis.com/auth/drive.file.
            </li>
            <li>
              Create an OAuth client with type Desktop app, download its JSON,
              then choose it here.
            </li>
          </ol>
          <Button
            className="mt-3"
            variant="outline"
            onClick={() =>
              open(
                "https://console.cloud.google.com/apis/library/drive.googleapis.com",
              )
            }
          >
            Open Google Cloud setup
          </Button>
        </details>
      </div>
      <div className="space-y-3 rounded-lg border p-4">
        <strong className="block">2. Connect Google Drive</strong>
        {status?.pending ? (
          <>
            <ActivityOrb compact label="Waiting for Google sign-in…" />
            <Button
              variant="outline"
              onClick={async () => {
                await invoke("drive_cancel");
                await refresh();
              }}
            >
              Cancel sign-in
            </Button>
          </>
        ) : status?.connected ? (
          <>
            <p className="text-emerald-700 dark:text-emerald-400">Connected</p>
            <Button
              variant="outline"
              onClick={async () => {
                try {
                  await invoke("drive_disconnect");
                  window.dispatchEvent(new Event(DRIVE_UPDATED));
                  await refresh();
                } catch (e) {
                  setError(String(e));
                }
              }}
            >
              Disconnect
            </Button>
          </>
        ) : (
          <Button disabled={!status?.configured} onClick={connect}>
            Connect Google Drive
          </Button>
        )}
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={auto}
            onChange={(e) => setAuto(e.target.checked)}
          />
          Back up automatically after saving
        </label>
        <p className="text-muted-foreground text-xs">
          Automatic backups run after a short pause in saving while Lemlio is
          open and connected. Existing projects can be backed up together below.
          Failed uploads keep your local files and can be retried. Each backup
          is a new ZIP; older backups remain until you remove them in Drive.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={
            !status?.connected ||
            busy ||
            !useDocumentStore.getState().projectRoot
          }
          onClick={() => backup(false)}
        >
          Back up open project
        </Button>
        <Button
          variant="outline"
          disabled={!status?.connected || busy}
          onClick={() => backup(true)}
        >
          Back up all projects
        </Button>
        {status?.folderUrl && (
          <Button variant="outline" onClick={() => open(status.folderUrl!)}>
            Open backup folder
          </Button>
        )}
      </div>
      {busy && <ActivityOrb compact label={message || "Preparing backup…"} />}
      {!busy && message && (
        <p role="status" className="text-xs">
          {message}
        </p>
      )}
      {status?.lastBackup && (
        <p className="text-muted-foreground text-xs">
          Last backup: {new Date(status.lastBackup * 1000).toLocaleString()}
        </p>
      )}
      {localStorage.getItem("lemlio-drive-backup-error") && (
        <p role="alert" className="text-destructive text-xs">
          Automatic backup is queued for retry:{" "}
          {localStorage.getItem("lemlio-drive-backup-error")}
        </p>
      )}
      {(error || status?.error) && (
        <p role="alert" className="text-destructive text-xs">
          {error || status?.error}
        </p>
      )}
      <p className="text-muted-foreground text-xs">
        Standard Drive API use has no extra API fee and uses your existing
        storage. A Google OAuth app in Testing may require periodic
        reconnection. You can also use Drive for desktop folder sync instead.
      </p>
    </div>
  );
}
