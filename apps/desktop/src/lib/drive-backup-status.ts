import { projectPathKey } from "./project-catalog";

const KEY = "lemlio-drive-project-status";
export const DRIVE_UPDATED = "lemlio-drive-updated";
export interface ProjectDriveStatus {
  lastBackup?: number;
  pending?: boolean;
  error?: string;
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
  result?: { lastBackup?: number; error?: string },
) {
  const key = projectPathKey(path);
  const statuses = read();
  const previous = statuses[key] || {};
  if (stage === "uploading") uploading.add(key);
  else uploading.delete(key);
  statuses[key] = {
    lastBackup:
      stage === "saved"
        ? (result?.lastBackup ?? Date.now() / 1000)
        : previous.lastBackup,
    pending: stage !== "saved",
    error: stage === "failed" ? result?.error : undefined,
  };
  localStorage.setItem(KEY, JSON.stringify(statuses));
  window.dispatchEvent(new Event(DRIVE_UPDATED));
}

export function driveRelativeTime(timestamp: number, now = Date.now()) {
  const seconds = Math.max(0, Math.floor(now / 1000 - timestamp));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hr ago`;
  return `${Math.floor(seconds / 86400)} days ago`;
}
