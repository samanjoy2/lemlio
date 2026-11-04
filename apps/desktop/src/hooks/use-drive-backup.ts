import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { useSettingsStore } from "@/stores/settings-store";
import { projectPathKey } from "@/lib/project-catalog";
import { type ProjectCatalogData } from "@/lib/project-catalog";
import { useProjectStore } from "@/stores/project-store";
import { useDocumentStore } from "@/stores/document-store";
import { useCodexChatStore } from "@/stores/codex-chat-store";
import {
  updateDriveBackup,
  projectDriveStatus,
  markDriveIncoming,
  setDriveSyncing,
  type ProjectDriveStatus,
} from "@/lib/drive-backup-status";
const KEY = "lemlio-drive-pending";
type Pending = { path: string; version: string; rename?: boolean };
export function useDriveBackup() {
  useEffect(() => {
    let initial: Pending[] = [];
    try {
      initial = JSON.parse(localStorage.getItem(KEY) || "[]");
    } catch {}
    const queue = new Map<string, Pending>(
      (Array.isArray(initial) ? initial : [])
        .filter(
          (p) => typeof p.path === "string" && typeof p.version === "string",
        )
        .map((p) => [projectPathKey(p.path), p]),
    );
    for (const item of queue.values()) updateDriveBackup(item.path, "pending");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let uploading = false;
    let discovering = false;
    let sequence = 0;
    let warned = false;
    let disposed = false;
    const persist = () =>
      localStorage.setItem(KEY, JSON.stringify([...queue.values()]));
    const failed = (error: unknown) => {
      const message = String(error).startsWith("DRIVE_CONFLICT:")
        ? "Both versions need review in Google Drive settings. Local files are kept."
        : String(error);
      localStorage.setItem("lemlio-drive-backup-error", message);
      if (!warned) {
        toast.error("Google Drive backup will retry", {
          description: message,
        });
        warned = true;
      }
    };
    const pump = async () => {
      if (
        disposed ||
        discovering ||
        uploading ||
        !queue.size ||
        !useSettingsStore.getState().autoDriveBackup
      )
        return;
      uploading = true;
      try {
        const status = await invoke<{ connected: boolean }>("drive_status");
        if (!status.connected) return;
        for (const [key, item] of [...queue]) {
          if (disposed || !useSettingsStore.getState().autoDriveBackup) break;
          const previous = projectDriveStatus(item.path);
          if (previous.paused || previous.conflict || previous.incoming)
            continue;
          try {
            updateDriveBackup(item.path, "uploading");
            const result = await invoke<{
              lastBackup?: number;
              sourceRevision?: string;
            }>("drive_backup_project", {
              projectPath: item.path,
              ...(item.rename ? { renameBackup: true } : {}),
            });
            updateDriveBackup(item.path, "saved", result);
            if (queue.get(key)?.version === item.version) queue.delete(key);
            else updateDriveBackup(item.path, "pending");
            persist();
          } catch (error) {
            updateDriveBackup(item.path, "failed", { error: String(error) });
            failed(error);
          }
        }
      } catch (error) {
        failed(error);
      } finally {
        if (!queue.size) {
          localStorage.removeItem("lemlio-drive-backup-error");
          warned = false;
        }
        uploading = false;
      }
    };
    const saved = (event: Event) => {
      const path = (event as CustomEvent<string>).detail;
      if (
        !path ||
        (!useSettingsStore.getState().autoDriveBackup &&
          event.type !== "lemlio-project-renamed")
      )
        return;
      queue.set(projectPathKey(path), {
        path,
        version: `${Date.now()}-${++sequence}`,
        rename:
          event.type === "lemlio-project-renamed" ||
          queue.get(projectPathKey(path))?.rename,
      });
      persist();
      updateDriveBackup(path, "pending");
      clearTimeout(timer);
      timer = setTimeout(() => void pump(), 15000);
    };
    const discover = async () => {
      if (!useSettingsStore.getState().autoDriveBackup || discovering) return;
      discovering = true;
      try {
        const library = await invoke<ProjectCatalogData>(
          "list_imported_projects",
        );
        if (disposed) return;
        const paths = [
          ...(library?.projects || []).map((p) => p.path),
          ...useProjectStore.getState().knownProjects.map((p) => p.path),
        ];
        const migrateArchives =
          localStorage.getItem("lemlio-drive-layout") !== "zip-v3";
        for (const path of new Set(paths)) {
          const key = projectPathKey(path);
          const previous = projectDriveStatus(path);
          if (previous.paused) continue;
          let changed = false;
          try {
            const revision = await invoke<string>("drive_project_revision", {
              projectPath: path,
            });
            if (disposed) return;
            changed =
              typeof revision === "string" &&
              revision !== previous.sourceRevision;
          } catch {
            /* Missing folders are reported by their pending upload. */
          }
          if (
            !queue.has(key) &&
            (migrateArchives || changed || !previous.lastBackup)
          ) {
            queue.set(key, { path, version: `${Date.now()}-${++sequence}` });
            updateDriveBackup(path, "pending");
          }
        }
        persist();
        const versions = new Map(
          [...queue].map(([key, item]) => [key, item.version]),
        );
        const observedStatuses = new Map(
          paths.map((path) => [
            projectPathKey(path),
            JSON.stringify(projectDriveStatus(path)),
          ]),
        );
        const verification = await invoke<{
          connected: boolean;
          projects: {
            path: string;
            status: string;
            lastBackup?: number;
            sourceRevision?: string;
            conflict?: ProjectDriveStatus["conflict"];
          }[];
        }>("drive_backup_summary", { projectPaths: paths }).catch(
          () => undefined,
        );
        if (disposed) return;
        if (verification?.connected)
          for (const row of verification.projects || []) {
            const current = projectDriveStatus(row.path);
            const key = projectPathKey(row.path);
            if (
              current.paused ||
              current.uploading ||
              JSON.stringify(current) !== observedStatuses.get(key)
            )
              continue;
            if (row.status === "incoming" && row.conflict?.remoteHash) {
              markDriveIncoming(row.path, row.conflict);
              // Never replace files beneath an editor, compiler or active agent.
              // Closed projects can fast-forward safely; open ones show an update action.
              const doc = useDocumentStore.getState();
              if (doc.projectRoot && projectPathKey(doc.projectRoot) === key)
                continue;
              if (useCodexChatStore.getState().tabs.some((t) => t.isStreaming))
                continue;
              setDriveSyncing(row.path, true);
              try {
                const result = await invoke<{
                  lastBackup: number;
                  sourceRevision: string;
                  deviceName?: string;
                }>("drive_sync_project", {
                  projectPath: row.path,
                  expectedRemoteHash: row.conflict.remoteHash,
                });
                queue.delete(key);
                updateDriveBackup(row.path, "saved", result);
                window.dispatchEvent(new Event("project-library-changed"));
              } catch (error) {
                // Re-check the baseline next time; a local edit may have arrived.
                localStorage.setItem(
                  "lemlio-drive-backup-error",
                  String(error),
                );
              } finally {
                setDriveSyncing(row.path, false);
              }
            } else if (row.status === "conflict" && row.conflict)
              updateDriveBackup(row.path, "failed", {
                error: `DRIVE_CONFLICT:${JSON.stringify(row.conflict)}`,
              });
            else if (
              row.status === "saved" &&
              row.sourceRevision &&
              !current.uploading &&
              !queue.get(key)?.rename &&
              (!queue.has(key) || queue.get(key)?.version === versions.get(key))
            ) {
              queue.delete(key);
              updateDriveBackup(row.path, "saved", row);
            } else if (row.status === "pending" && !queue.has(key)) {
              queue.set(key, {
                path: row.path,
                version: `${Date.now()}-${++sequence}`,
              });
              updateDriveBackup(row.path, "pending");
            }
          }
        persist();
        localStorage.setItem("lemlio-drive-layout", "zip-v3");
      } catch {
        /* Existing queued backups still retry independently. */
      } finally {
        discovering = false;
        void pump();
      }
    };
    const connected = () => {
      void discover();
    };
    const deleted = (event: Event) => {
      queue.delete(projectPathKey((event as CustomEvent<string>).detail));
      persist();
    };
    const confirmed = (event: Event) => {
      const result = (
        event as CustomEvent<{ path: string; sourceRevision: string }>
      ).detail;
      const key = projectPathKey(result.path);
      const item = queue.get(key);
      if (!item || item.rename) return;
      void invoke<string>("drive_project_revision", {
        projectPath: result.path,
      })
        .then((revision) => {
          if (
            !disposed &&
            revision === result.sourceRevision &&
            queue.get(key)?.version === item.version
          ) {
            queue.delete(key);
            persist();
          }
        })
        .catch(() => {});
    };
    const retry = setInterval(() => {
      void discover();
    }, 60000);
    window.addEventListener("lemlio-project-saved", saved);
    window.addEventListener("lemlio-project-renamed", saved);
    window.addEventListener("lemlio-drive-connected", connected);
    window.addEventListener("project-library-changed", connected);
    window.addEventListener("lemlio-project-deleted", deleted);
    window.addEventListener("lemlio-drive-confirmed", confirmed);
    window.addEventListener("focus", connected);
    void discover();
    return () => {
      disposed = true;
      clearTimeout(timer);
      clearInterval(retry);
      window.removeEventListener("lemlio-project-saved", saved);
      window.removeEventListener("lemlio-project-renamed", saved);
      window.removeEventListener("lemlio-drive-connected", connected);
      window.removeEventListener("project-library-changed", connected);
      window.removeEventListener("lemlio-project-deleted", deleted);
      window.removeEventListener("lemlio-drive-confirmed", confirmed);
      window.removeEventListener("focus", connected);
    };
  }, []);
}
