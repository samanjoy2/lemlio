import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useDriveBackup } from "@/hooks/use-drive-backup";
import { useSettingsStore } from "@/stores/settings-store";
import {
  updateDriveBackup,
  pauseDriveProject,
} from "@/lib/drive-backup-status";
function BackupListener() {
  useDriveBackup();
  return null;
}
it("detects externally changed PC files and migrates older folder backups to ZIP", async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  useSettingsStore.setState({ autoDriveBackup: true });
  localStorage.setItem("lemlio-drive-layout", "folders-v1");
  updateDriveBackup("C:/Imported", "saved", {
    lastBackup: 100,
    sourceRevision: "old",
  });
  vi.mocked(invoke).mockClear();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "list_imported_projects")
      return { projects: [{ path: "C:/Imported" }] };
    if (command === "drive_project_revision") return "external-edit";
    if (command === "drive_status") return { connected: true };
    return { lastBackup: 200, sourceRevision: "external-edit" };
  });
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<BackupListener />));
    expect(invoke).toHaveBeenCalledWith("drive_backup_project", {
      projectPath: "C:/Imported",
    });
    expect(localStorage.getItem("lemlio-drive-layout")).toBe("zip-v2");
  } finally {
    await act(async () => root.unmount());
  }
});
it("does not retry projects with unresolved conflicts or a kept Drive copy", async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  useSettingsStore.setState({ autoDriveBackup: true });
  updateDriveBackup("C:/Paper", "failed", {
    error: 'DRIVE_CONFLICT:{"remoteHash":"edited"}',
  });
  updateDriveBackup("C:/Paused", "saved", { lastBackup: 100 });
  pauseDriveProject("C:/Paused", true);
  localStorage.setItem(
    "lemlio-drive-pending",
    JSON.stringify([
      { path: "C:/Paper", version: "1" },
      { path: "C:/Paused", version: "2" },
    ]),
  );
  vi.mocked(invoke).mockClear();
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "drive_status" ? { connected: true } : { projects: [] },
  );
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<BackupListener />));
    expect(invoke).not.toHaveBeenCalledWith(
      "drive_backup_project",
      expect.anything(),
    );
  } finally {
    await act(async () => root.unmount());
  }
});
it("automatically backs up newly imported projects without a manual save", async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  useSettingsStore.setState({ autoDriveBackup: true });
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "list_imported_projects")
      return { projects: [{ path: "C:/Imported" }] };
    if (command === "drive_status") return { connected: true };
    return { lastBackup: 1234567890 };
  });
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<BackupListener />));
    expect(invoke).toHaveBeenCalledWith("drive_backup_project", {
      projectPath: "C:/Imported",
    });
    expect(JSON.parse(localStorage.getItem("lemlio-drive-pending")!)).toEqual(
      [],
    );
    expect(localStorage.getItem("lemlio-drive-project-status")).toContain(
      "1234567890",
    );
  } finally {
    await act(async () => root.unmount());
  }
});
it("retains offline backups across retries and clears them only after upload succeeds", async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  localStorage.clear();
  useSettingsStore.setState({ autoDriveBackup: true });
  localStorage.setItem(
    "lemlio-drive-pending",
    JSON.stringify([{ path: "C:/Papers/One", version: "saved-1" }]),
  );
  let connected = false;
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "drive_status" ? { connected } : {},
  );
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<BackupListener />));
    expect(
      JSON.parse(localStorage.getItem("lemlio-drive-pending")!),
    ).toHaveLength(1);
    connected = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(invoke).toHaveBeenCalledWith("drive_backup_project", {
      projectPath: "C:/Papers/One",
    });
    expect(JSON.parse(localStorage.getItem("lemlio-drive-pending")!)).toEqual(
      [],
    );
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
  }
});

it("keeps a failed project queued while backing up other projects", async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  useSettingsStore.setState({ autoDriveBackup: true });
  localStorage.setItem(
    "lemlio-drive-pending",
    JSON.stringify([
      { path: "C:/Missing", version: "one" },
      { path: "C:/Available", version: "two" },
    ]),
  );
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "drive_status") return { connected: true };
    if ((args as { projectPath?: string })?.projectPath === "C:/Missing")
      throw new Error("Folder unavailable");
    return {};
  });
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<BackupListener />));
    expect(invoke).toHaveBeenCalledWith("drive_backup_project", {
      projectPath: "C:/Available",
    });
    expect(JSON.parse(localStorage.getItem("lemlio-drive-pending")!)).toEqual([
      { path: "C:/Missing", version: "one" },
    ]);
  } finally {
    await act(async () => root.unmount());
  }
});
