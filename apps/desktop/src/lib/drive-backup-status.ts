import { projectPathKey } from "./project-catalog";

const KEY = "lemlio-drive-project-status";
export const DRIVE_UPDATED = "lemlio-drive-updated";
export interface ProjectDriveStatus {
  lastBackup?: number;
  sourceRevision?: string;
  pending?: boolean;
  error?: string;
  paused?: boolean;
  conflict?: { name: string; modifiedTime?: string; remoteHash?: string };
}
const uploading = new Set<string>();
function read(): Record<string, ProjectDriveStatus> {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "{}");
  } catch {
    return {};
  }
}
export function projectDriveStatus(path: string) {
  const key = projectPathKey(path);
  return { ...read()[key], uploading: uploading.has(key) };
}
export function updateDriveBackup(
  path: string,
  stage: "pending" | "uploading" | "saved" | "failed",
  result?: { lastBackup?: number; sourceRevision?: string; error?: string },
) {
  const key = projectPathKey(path);
  const statuses = read();
  const previous = statuses[key] || {};
  let conflict = previous.conflict;
  if (stage === "failed" && result?.error?.startsWith("DRIVE_CONFLICT:")) {
    try {
      conflict = JSON.parse(result.error.slice("DRIVE_CONFLICT:".length));
    } catch {}
  }
  if (stage === "saved") conflict = undefined;
  if (stage === "uploading") uploading.add(key);
  else uploading.delete(key);
  statuses[key] = {
    lastBackup:
      stage === "saved"
        ? (result?.lastBackup ?? Date.now() / 1000)
        : previous.lastBackup,
    pending: stage !== "saved",
    sourceRevision:
      stage === "saved" ? result?.sourceRevision : previous.sourceRevision,
    paused: stage === "saved" ? false : previous.paused,
    conflict,
    error:
      stage === "failed"
        ? conflict
          ? "The Drive ZIP changed outside Lemlio. Choose which backup to keep."
          : result?.error
        : undefined,
  };
  localStorage.setItem(KEY, JSON.stringify(statuses));
  window.dispatchEvent(new Event(DRIVE_UPDATED));
  if (stage === "saved" && result?.sourceRevision)
    window.dispatchEvent(
      new CustomEvent("lemlio-drive-confirmed", {
        detail: { path, ...result },
      }),
    );
}

export function pauseDriveProject(path: string, paused: boolean) {
  const statuses = read();
  const key = projectPathKey(path);
  statuses[key] = { ...statuses[key], paused };
  localStorage.setItem(KEY, JSON.stringify(statuses));
  window.dispatchEvent(new Event(DRIVE_UPDATED));
}

export function resetDriveBackupStatus() {
  uploading.clear();
  localStorage.removeItem(KEY);
  localStorage.removeItem("lemlio-drive-backup-error");
  localStorage.removeItem("lemlio-drive-layout");
  window.dispatchEvent(new Event(DRIVE_UPDATED));
}

export function forgetDriveProject(path: string) {
  const statuses = read();
  delete statuses[projectPathKey(path)];
  uploading.delete(projectPathKey(path));
  localStorage.setItem(KEY, JSON.stringify(statuses));
  window.dispatchEvent(
    new CustomEvent("lemlio-project-deleted", { detail: path }),
  );
  window.dispatchEvent(new Event(DRIVE_UPDATED));
}

export function driveRelativeTime(timestamp: number, now = Date.now()) {
  const seconds = Math.max(0, Math.floor(now / 1000 - timestamp));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hr ago`;
  return `${Math.floor(seconds / 86400)} days ago`;
}
