import { backupProject } from "@/lib/collaboration/runtime";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as chooseFolder } from "@tauri-apps/plugin-dialog";
import { open as openLink } from "@tauri-apps/plugin-shell";
import { Button } from "./ui/button";
import { ActivityOrb } from "./activity-feedback";
import { DriveDiscoveryNotice } from "./drive-discovery-notice";
import { DropboxSetupGuide } from "./dropbox-setup-guide";
import { Switch } from "./panelui/switch";
import { DriveBackupOverview } from "./drive-backup-overview";
import { requestDriveRestore } from "./drive-restore-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import {
  updateDriveBackup,
  resetDriveBackupStatus,
  DRIVE_UPDATED,
} from "@/lib/drive-backup-status";
import { useSettingsStore } from "@/stores/settings-store";
import { useDocumentStore } from "@/stores/document-store";
import { useProjectStore } from "@/stores/project-store";
import { projectPathKey, type ProjectCatalogData } from "@/lib/project-catalog";

interface BackupStatus {
  provider: "dropbox" | "folder" | null;
  configured: boolean;
  connected: boolean;
  pending: boolean;
  needsReconnect: boolean;
  error: string | null;
  lastBackup: number | null;
  account: { id: string; name: string; email: string } | null;
  dropboxReady: boolean;
  dropboxSupported: boolean;
  appKeyConfigured: boolean;
  builtInAppKey: boolean;
  ownAppKey: boolean;
  redirectUris: string[];
  permissions: string[];
  folderPath: string | null;
  suggestions?: { provider: string; path: string }[];
}
export function DriveSettings() {
  const previousConnection = useRef(false);
  const [status, setStatus] = useState<BackupStatus>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [resetOpen, setResetOpen] = useState(false);
  const [codeMode, setCodeMode] = useState(false);
  const [code, setCode] = useState("");
  const auto = useSettingsStore((s) => s.autoDriveBackup);
  const setAuto = useSettingsStore((s) => s.setAutoDriveBackup);
  const refresh = () =>
    invoke<BackupStatus>("drive_status")
      .then((value) => {
        setStatus(value);
        if (value.connected && !previousConnection.current) {
          setCodeMode(false);
          window.dispatchEvent(new Event("lemlio-drive-connected"));
        }
        previousConnection.current = value.connected;
      })
      .catch((e) => setError(String(e)));
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, []);
  const connectDropbox = async () => {
    try {
      setError("");
      setCodeMode(false);
      const url = await invoke<string>("drive_dropbox_connect");
      await openLink(url);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };
  const connectWithCode = async () => {
    try {
      setError("");
      const url = await invoke<string>("drive_dropbox_connect_manual");
      setCodeMode(true);
      await openLink(url);
    } catch (e) {
      setError(String(e));
    }
  };
  const submitCode = async () => {
    try {
      setError("");
      await invoke("drive_dropbox_submit_code", { code });
      setCode("");
      setCodeMode(false);
      window.dispatchEvent(new Event(DRIVE_UPDATED));
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };
  const useFolder = async (folderPath: string) => {
    try {
      setError("");
      await invoke("drive_set_folder", { folderPath });
      window.dispatchEvent(new Event(DRIVE_UPDATED));
      setMessage("Backup folder saved.");
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };
  const pickFolder = async () => {
    const path = await chooseFolder({
      title: "Choose your Dropbox folder (or any synced folder)",
      directory: true,
      multiple: false,
    });
    if (typeof path === "string") await useFolder(path);
  };
  const disconnect = async () => {
    try {
      await invoke("drive_disconnect");
      window.dispatchEvent(new Event(DRIVE_UPDATED));
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
          const result = await backupProject<{
            lastBackup?: number;
            sourceRevision?: string;
          }>({ projectPath: paths[i] });
          updateDriveBackup(paths[i], "saved", result);
        } catch (error) {
          updateDriveBackup(paths[i], "failed", { error: String(error) });
          throw error;
        }
      }
      setMessage(`${paths.length} project backups saved.`);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const viaDropbox = status?.provider === "dropbox";
  const signedIn = viaDropbox && status?.connected;
  return (
    <div className="space-y-4">
      <h3 className="font-medium">Backup</h3>
      <p>
        Lemlio saves versioned project ZIPs and keeps your computers in sync.
        Every revision is kept; nothing is overwritten.
      </p>
      <div className="space-y-3 rounded-lg border p-4">
        <strong className="block">Dropbox</strong>
        {!status?.dropboxSupported ? (
          <p className="text-muted-foreground text-xs">
            Dropbox sign-in is available in the Windows and macOS apps. On this
            computer, use a synced folder under Advanced.
          </p>
        ) : signedIn ? (
          <>
            <p className="text-emerald-700 dark:text-emerald-400">
              Connected
              {status?.account?.name || status?.account?.email
                ? ` as ${status.account.name || status.account.email}`
                : ""}
            </p>
            {status?.account?.email && status.account.name && (
              <p className="text-muted-foreground text-xs">
                {status.account.email}
              </p>
            )}
            <p className="text-muted-foreground text-xs">
              Backups are stored in the Lemlio app folder of your Dropbox (Apps
              → Lemlio). Lemlio can only see that folder.
            </p>
            <Button variant="outline" onClick={() => void disconnect()}>
              Disconnect
            </Button>
          </>
        ) : status?.pending ? (
          <>
            <ActivityOrb compact label="Waiting for Dropbox sign-in…" />
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={async () => {
                  await invoke("drive_cancel");
                  await refresh();
                }}
              >
                Cancel
              </Button>
              <Button variant="ghost" onClick={() => void connectWithCode()}>
                Use a code instead
              </Button>
            </div>
          </>
        ) : (
          <>
            {viaDropbox && status?.needsReconnect && (
              <p role="alert" className="text-destructive text-xs">
                Dropbox needs you to sign in again. Your backups are safe.
              </p>
            )}
            <Button
              disabled={!status?.dropboxReady}
              onClick={() => void connectDropbox()}
            >
              {viaDropbox && status?.needsReconnect
                ? "Reconnect Dropbox"
                : "Connect Dropbox"}
            </Button>
            {status && !status.dropboxReady && (
              <p className="text-muted-foreground text-xs">
                Dropbox sign-in is not set up in this build yet. Follow the
                setup guide below (one time), or use a synced folder.
              </p>
            )}
            {status?.dropboxReady && (
              <p className="text-muted-foreground text-xs">
                Your browser opens Dropbox to approve access to one app folder.
                Lemlio never sees your password.
              </p>
            )}
            {status?.dropboxReady && !codeMode && (
              <Button variant="ghost" onClick={() => void connectWithCode()}>
                Browser did not return to Lemlio? Use a code
              </Button>
            )}
          </>
        )}
        {codeMode && (
          <div className="space-y-2">
            <p className="text-muted-foreground text-xs">
              Approve access on Dropbox, then paste the code it shows here.
            </p>
            <div className="flex flex-wrap gap-2">
              <input
                className="h-9 min-w-0 flex-1 rounded-lg border bg-background px-3"
                aria-label="Dropbox code"
                value={code}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setCode(e.target.value)}
              />
              <Button disabled={!code.trim()} onClick={() => void submitCode()}>
                Connect
              </Button>
            </div>
          </div>
        )}
        <label htmlFor="drive-auto-sync" className="flex items-center gap-2">
          <Switch
            size="sm"
            id="drive-auto-sync"
            checked={auto}
            onCheckedChange={setAuto}
            label="Sync automatically"
          />
          Sync automatically
        </label>
        <p className="text-muted-foreground text-xs">
          Saved changes are written after a short pause. Every five minutes,
          unchanged closed projects receive newer revisions from your other
          computers, replacing the project in place and keeping the previous
          files in a recovery folder. Open projects wait for review. If both
          copies changed, you choose which version to keep. Each revision is a
          separate ZIP, so earlier revisions remain and use Dropbox storage.
        </p>
      </div>
      {status && (
        <DropboxSetupGuide
          status={status}
          onChanged={refresh}
          onTest={connectDropbox}
        />
      )}
      <details
        className="rounded-lg border p-4"
        open={status?.provider === "folder"}
      >
        <summary className="cursor-pointer font-medium">
          Advanced: use a synced folder instead
        </summary>
        <div className="mt-3 space-y-3">
          <p className="text-muted-foreground text-xs">
            Works offline and needs no sign-in. Lemlio writes a Lemlio Backups
            folder inside the folder you choose, and the Dropbox app (or another
            sync app) syncs it.
          </p>
          {status?.provider === "folder" && status.connected && (
            <>
              <p className="text-emerald-700 dark:text-emerald-400">
                Connected
              </p>
              <p className="break-all text-muted-foreground text-xs">
                {status.folderPath}
              </p>
            </>
          )}
          {status?.provider !== "folder" &&
            status?.suggestions?.map((folder) => (
              <Button
                key={folder.path}
                variant="outline"
                className="block h-auto whitespace-normal text-left"
                onClick={() => void useFolder(folder.path)}
              >
                Use my {folder.provider} folder
                <span className="block break-all font-normal text-xs opacity-80">
                  {folder.path}
                </span>
              </Button>
            ))}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => void pickFolder()}>
              {status?.provider === "folder"
                ? "Change folder…"
                : "Choose a folder…"}
            </Button>
            {status?.provider === "folder" && (
              <Button variant="outline" onClick={() => void disconnect()}>
                Disconnect
              </Button>
            )}
          </div>
        </div>
      </details>
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
        {status?.provider === "folder" &&
          status.folderPath &&
          status.connected && (
            <Button
              variant="outline"
              onClick={() =>
                void invoke("open_project_folder", {
                  projectPath: status.folderPath,
                }).catch((e) => setError(String(e)))
              }
            >
              Open backup folder
            </Button>
          )}
      </div>
      <DriveDiscoveryNotice />
      <DriveBackupOverview />
      <Button
        variant="outline"
        disabled={!status?.connected || busy}
        onClick={requestDriveRestore}
      >
        Restore projects from backup
      </Button>
      {status?.connected && (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => setResetOpen(true)}
        >
          Reset backups
        </Button>
      )}
      <Dialog
        open={resetOpen}
        onOpenChange={(value) => {
          if (!busy) setResetOpen(value);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset backups?</DialogTitle>
            <DialogDescription>
              The current Lemlio Backups folder is renamed (for example "Lemlio
              Backups (reset 20260101-120000)") and kept in your Dropbox, then a
              fresh empty folder is created for project ZIPs. Nothing is
              deleted. Your local projects stay as they are.
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setResetOpen(false)}
            >
              Cancel
            </Button>
            <Button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  await invoke("drive_reset_backups");
                  resetDriveBackupStatus();
                  window.dispatchEvent(new Event("lemlio-drive-connected"));
                  setMessage(
                    "Fresh backup folder created. Automatic backup will rebuild it from your projects.",
                  );
                  setResetOpen(false);
                  await refresh();
                } catch (e) {
                  setError(String(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Resetting…" : "Rename old folder & reset"}
            </Button>
          </div>
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
        </DialogContent>
      </Dialog>
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
        Dropbox’s free plan includes 2 GB. Projects are small, but every backup
        adds a revision, so check your Dropbox storage if you keep many large
        projects.
      </p>
    </div>
  );
}
