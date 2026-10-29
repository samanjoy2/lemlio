import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { useSettingsStore } from "@/stores/settings-store";
import { projectPathKey } from "@/lib/project-catalog";
import { type ProjectCatalogData } from "@/lib/project-catalog";
import { useProjectStore } from "@/stores/project-store";
import {
  updateDriveBackup,
  projectDriveStatus,
} from "@/lib/drive-backup-status";
const KEY = "lemlio-drive-pending";
type Pending = { path: string; version: string };
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
    let sequence = 0;
    let warned = false;
    let disposed = false;
    const persist = () =>
      localStorage.setItem(KEY, JSON.stringify([...queue.values()]));
    const failed = (error: unknown) => {
      localStorage.setItem("lemlio-drive-backup-error", String(error));
      if (!warned) {
        toast.error("Google Drive backup will retry", {
          description: String(error),
        });
        warned = true;
      }
    };
    const pump = async () => {
      if (
        disposed ||
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
          try {
            updateDriveBackup(item.path, "uploading");
            const result = await invoke<{ lastBackup?: number }>(
              "drive_backup_project",
              { projectPath: item.path },
            );
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
      if (!path || !useSettingsStore.getState().autoDriveBackup) return;
      queue.set(projectPathKey(path), {
        path,
        version: `${Date.now()}-${++sequence}`,
      });
      persist();
      updateDriveBackup(path, "pending");
      clearTimeout(timer);
      timer = setTimeout(() => void pump(), 15000);
    };
    const discover = async () => {
      if (!useSettingsStore.getState().autoDriveBackup) return;
      try {
        const library = await invoke<ProjectCatalogData>(
          "list_imported_projects",
        );
        if (disposed) return;
        const paths = [
          ...(library?.projects || []).map((p) => p.path),
          ...useProjectStore.getState().knownProjects.map((p) => p.path),
        ];
        const migrateFolders =
          localStorage.getItem("lemlio-drive-layout") !== "folders-v1";
        for (const path of paths) {
          const key = projectPathKey(path);
          if (
            !queue.has(key) &&
            (migrateFolders || !projectDriveStatus(path).lastBackup)
          ) {
            queue.set(key, { path, version: `${Date.now()}-${++sequence}` });
            updateDriveBackup(path, "pending");
          }
        }
        persist();
        localStorage.setItem("lemlio-drive-layout", "folders-v1");
        void pump();
      } catch {
        /* Existing queued backups still retry independently. */
      }
    };
    const connected = () => {
      void discover();
      void pump();
    };
    const retry = setInterval(() => {
      void discover();
      void pump();
    }, 60000);
    void pump();
    window.addEventListener("lemlio-project-saved", saved);
    window.addEventListener("lemlio-drive-connected", connected);
    window.addEventListener("project-library-changed", connected);
    void discover();
    return () => {
      disposed = true;
      clearTimeout(timer);
      clearInterval(retry);
      window.removeEventListener("lemlio-project-saved", saved);
      window.removeEventListener("lemlio-drive-connected", connected);
      window.removeEventListener("project-library-changed", connected);
    };
  }, []);
}
