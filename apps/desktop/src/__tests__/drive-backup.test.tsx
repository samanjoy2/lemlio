import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useDriveBackup } from "@/hooks/use-drive-backup";
import { useSettingsStore } from "@/stores/settings-store";
import { useDocumentStore } from "@/stores/document-store";
import { useCodexChatStore } from "@/stores/codex-chat-store";
import {
  updateDriveBackup,
  pauseDriveProject,
  projectDriveStatus,
} from "@/lib/drive-backup-status";
function BackupListener() {
  useDriveBackup();
  return null;
}
it.each([
  false,
  true,
])("fast-forwards a closed untouched project, but defers an open editor (open=%s)", async (open) => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  useSettingsStore.setState({ autoDriveBackup: true });
  useDocumentStore.setState({
    projectRoot: open ? "C:/Paper" : null,
    files: [],
  });
  useCodexChatStore.setState({ tabs: [] });
  updateDriveBackup("C:/Paper", "saved", {
    lastBackup: 100,
    sourceRevision: "base",
  });
  vi.mocked(invoke).mockClear();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "list_imported_projects")
      return { projects: [{ path: "C:/Paper" }] };
    if (command === "drive_project_revision") return "base";
    if (command === "drive_backup_summary")
      return {
        connected: true,
        projects: [
          {
            path: "C:/Paper",
            status: "incoming",
            conflict: {
              name: "Paper.zip",
              remoteHash: "mac-version",
              deviceName: "Mac abc123",
            },
          },
        ],
      };
    if (command === "drive_sync_project")
      return {
        lastBackup: 200,
        sourceRevision: "new-base",
        deviceName: "Mac abc123",
      };
    return { connected: true };
  });
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<BackupListener />));
    if (open) {
      expect(projectDriveStatus("C:/Paper").incoming).toBe(true);
      expect(invoke).not.toHaveBeenCalledWith(
        "drive_sync_project",
        expect.anything(),
      );
    } else {
      expect(invoke).toHaveBeenCalledWith("drive_sync_project", {
        projectPath: "C:/Paper",
        expectedRemoteHash: "mac-version",
      });
      expect(projectDriveStatus("C:/Paper").sourceRevision).toBe("new-base");
      expect(projectDriveStatus("C:/Paper").incoming).toBeUndefined();
    }
    expect(invoke).not.toHaveBeenCalledWith(
      "drive_backup_project",
      expect.anything(),
    );
  } finally {
    await act(async () => root.unmount());
    useDocumentStore.setState({ projectRoot: null });
  }
});
it("detects another device's Drive changes without editing or uploading the PC copy", async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  useSettingsStore.setState({ autoDriveBackup: true });
  localStorage.setItem("lemlio-drive-layout", "zip-v3");
  updateDriveBackup("C:/Idle", "saved", {
    lastBackup: 100,
    sourceRevision: "pc-original",
  });
  vi.mocked(invoke).mockClear();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "list_imported_projects")
      return { projects: [{ path: "C:/Idle" }] };
    if (command === "drive_project_revision") return "pc-original";
    if (command === "drive_backup_summary")
      return {
        connected: true,
        projects: [
          {
            path: "C:/Idle",
            status: "conflict",
            conflict: { name: "Paper.zip", remoteHash: "other-device" },
          },
        ],
      };
    return { connected: true };
  });
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<BackupListener />));
    expect(projectDriveStatus("C:/Idle").conflict?.remoteHash).toBe(
      "other-device",
    );
    expect(invoke).not.toHaveBeenCalledWith(
      "drive_backup_project",
      expect.anything(),
    );
    expect(invoke).not.toHaveBeenCalledWith(
      "drive_restore_project",
      expect.anything(),
    );
  } finally {
    await act(async () => root.unmount());
  }
});
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
    expect(localStorage.getItem("lemlio-drive-layout")).toBe("zip-v3");
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

it("ignores a stale conflict check after the user successfully chooses the PC version", async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  useSettingsStore.setState({ autoDriveBackup: true });
  localStorage.setItem("lemlio-drive-layout", "zip-v3");
  updateDriveBackup("C:/Paper", "saved", {
    lastBackup: 100,
    sourceRevision: "pc",
  });
  let finish!: (value: unknown) => void;
  const response = new Promise((resolve) => {
    finish = resolve;
  });
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "list_imported_projects")
      return { projects: [{ path: "C:/Paper" }] };
    if (command === "drive_project_revision") return "pc";
    if (command === "drive_backup_summary") return response;
    return { connected: true };
  });
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<BackupListener />));
    await act(async () => {
      updateDriveBackup("C:/Paper", "saved", {
        lastBackup: 200,
        sourceRevision: "pc",
      });
      finish({
        connected: true,
        projects: [
          {
            path: "C:/Paper",
            status: "conflict",
            conflict: { name: "Paper.zip", remoteHash: "outdated" },
          },
        ],
      });
    });
    expect(projectDriveStatus("C:/Paper").conflict).toBeUndefined();
    expect(projectDriveStatus("C:/Paper").lastBackup).toBe(200);
  } finally {
    await act(async () => root.unmount());
  }
});

it("backs up a rename even when source files are unchanged, and keeps it through a later edit", async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  localStorage.clear();
  useSettingsStore.setState({ autoDriveBackup: true });
  localStorage.setItem("lemlio-drive-layout", "zip-v3");
  updateDriveBackup("C:/Paper", "saved", {
    lastBackup: 100,
    sourceRevision: "same-content",
  });
  let connected = false;
  vi.mocked(invoke).mockClear();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "list_imported_projects")
      return { projects: [{ path: "C:/Paper" }] };
    if (command === "drive_project_revision") return "same-content";
    if (command === "drive_backup_summary")
      return {
        connected: true,
        projects: [
          {
            path: "C:/Paper",
            status: "saved",
            lastBackup: 100,
            sourceRevision: "same-content",
          },
        ],
      };
    if (command === "drive_backup_project")
      return { lastBackup: 200, sourceRevision: "same-content" };
    return { connected };
  });
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<BackupListener />));
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("lemlio-project-renamed", { detail: "C:/Paper" }),
      );
      window.dispatchEvent(
        new CustomEvent("lemlio-project-saved", { detail: "C:/Paper" }),
      );
      window.dispatchEvent(new Event("project-library-changed"));
    });
    expect(
      JSON.parse(localStorage.getItem("lemlio-drive-pending")!)[0].rename,
    ).toBe(true);
    connected = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    expect(invoke).toHaveBeenCalledWith("drive_backup_project", {
      projectPath: "C:/Paper",
      renameBackup: true,
    });
    expect(JSON.parse(localStorage.getItem("lemlio-drive-pending")!)).toEqual(
      [],
    );
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
  }
});

it("does not refresh Drive on focus and throttles remote checks while saved edits upload promptly", async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  localStorage.clear();
  localStorage.setItem("lemlio-drive-layout", "zip-v3");
  useSettingsStore.setState({ autoDriveBackup: true });
  useDocumentStore.setState({ projectRoot: null, files: [] });
  updateDriveBackup("C:/Frequency", "saved", {
    lastBackup: 100,
    sourceRevision: "base",
  });
  vi.mocked(invoke).mockClear();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "list_imported_projects")
      return { projects: [{ path: "C:/Frequency" }] };
    if (command === "drive_project_revision") return "base";
    if (command === "drive_backup_summary")
      return { connected: true, projects: [], availableProjects: [] };
    if (command === "drive_backup_project")
      return { lastBackup: 200, sourceRevision: "saved-edit" };
    return { connected: true };
  });
  const root = createRoot(document.createElement("div"));
  const remoteCalls = () =>
    vi
      .mocked(invoke)
      .mock.calls.filter(([name]) => name === "drive_backup_summary").length;
  try {
    await act(async () => root.render(<BackupListener />));
    expect(remoteCalls()).toBe(1);
    await act(async () => {
      for (let i = 0; i < 5; i++) window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(120000);
    });
    expect(remoteCalls()).toBe(1);
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("lemlio-project-saved", { detail: "C:/Frequency" }),
      );
      await vi.advanceTimersByTimeAsync(15000);
    });
    expect(invoke).toHaveBeenCalledWith("drive_backup_project", {
      projectPath: "C:/Frequency",
    });
    expect(remoteCalls()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(165000);
    });
    expect(remoteCalls()).toBe(2);
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
  }
});
