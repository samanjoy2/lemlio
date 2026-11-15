import { formatDistanceToNow } from "date-fns";
import type { ProjectDriveStatus } from "@/lib/drive-backup-status";

export type BackupTone = "ok" | "incoming" | "attention" | "quiet";
export interface BackupSummary {
  tone: BackupTone;
  text: string;
  /** Longer wording for the tooltip. */
  detail: string;
}

/**
 * One short line about a project's backup, for its card: how recent the last
 * backup is, which device made it, and whether a newer version from another
 * PC is waiting. Returns null when there is nothing to say yet.
 */
export function backupSummary(
  status: ProjectDriveStatus & { uploading?: boolean },
  now: Date = new Date(),
): BackupSummary | null {
  const device = status.deviceName;
  const ago = status.lastBackup
    ? formatDistanceToNow(new Date(status.lastBackup * 1000), {
        addSuffix: true,
      })
    : null;
  if (status.conflict || (status.error && status.error.includes("review"))) {
    const other = status.conflict?.deviceName ?? device;
    return {
      tone: "attention",
      text: other ? `Changed here and on ${other}` : "Changed on two devices",
      detail:
        "Both versions changed. Open the project to choose which to keep.",
    };
  }
  if (status.incoming) {
    return {
      tone: "incoming",
      text: device
        ? `Newer version from ${device}`
        : "Newer version from another device",
      detail:
        "Another device saved a newer version. It replaces this one when you update.",
    };
  }
  if (status.uploading)
    return {
      tone: "quiet",
      text: "Backing up…",
      detail: "Saving a backup of this project.",
    };
  if (status.error)
    return {
      tone: "attention",
      text: "Backup failed, will retry",
      detail: status.error,
    };
  if (status.paused)
    return {
      tone: "quiet",
      text: ago ? `Backup paused · last ${ago}` : "Backup paused",
      detail: "Automatic backup is paused for this project.",
    };
  if (ago) {
    return {
      tone: status.pending ? "quiet" : "ok",
      text: `${status.pending ? "Changes waiting · " : ""}Backed up ${ago}${device ? ` from ${device}` : ""}`,
      detail: status.pending
        ? "Newer edits will be backed up shortly."
        : `This is the latest version. Last backup ${new Date(status.lastBackup! * 1000).toLocaleString()}${device ? ` from ${device}` : ""}.`,
    };
  }
  if (status.pending)
    return {
      tone: "quiet",
      text: "Backup waiting",
      detail: "This project has not been backed up yet.",
    };
  void now;
  return null;
}
