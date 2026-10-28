import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { useSettingsStore } from "@/stores/settings-store";
import { projectPathKey } from "@/lib/project-catalog";
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
            await invoke("drive_backup_project", { projectPath: item.path });
            if (queue.get(key)?.version === item.version) queue.delete(key);
            persist();
          } catch (error) {
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
      clearTimeout(timer);
      timer = setTimeout(() => void pump(), 15000);
    };
    const connected = () => void pump();
    const retry = setInterval(() => void pump(), 60000);
    void pump();
    window.addEventListener("lemlio-project-saved", saved);
    window.addEventListener("lemlio-drive-connected", connected);
    return () => {
      disposed = true;
      clearTimeout(timer);
      clearInterval(retry);
      window.removeEventListener("lemlio-project-saved", saved);
      window.removeEventListener("lemlio-drive-connected", connected);
    };
  }, []);
}
