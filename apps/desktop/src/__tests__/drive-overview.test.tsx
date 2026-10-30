import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { DriveBackupOverview } from "@/components/drive-backup-overview";
import {
  projectDriveStatus,
  pauseDriveProject,
  updateDriveBackup,
} from "@/lib/drive-backup-status";
import { useSettingsStore } from "@/stores/settings-store";
import { useDocumentStore } from "@/stores/document-store";

const projects = [
  { path: "C:/Paper", name: "Paper" },
  { path: "C:/CV", name: "CV" },
];
async function mount() {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  useSettingsStore.setState({ autoDriveBackup: true });
  vi.mocked(invoke).mockClear();
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "drive_status"
      ? { connected: true }
      : { lastBackup: 123, sourceRevision: "new-pc" },
  );
  const element = document.createElement("div");
  document.body.appendChild(element);
  const root = createRoot(element);
  return {
    element,
    root,
    render: () =>
      act(async () => root.render(<DriveBackupOverview projects={projects} />)),
    close: async () => {
      await act(async () => root.unmount());
      element.remove();
    },
  };
}
it("only claims all projects are backed up when every PC version is confirmed", async () => {
  const ui = await mount();
  try {
    updateDriveBackup(projects[0].path, "saved", {
      lastBackup: Date.now() / 1000,
      sourceRevision: "pc-a",
    });
    await ui.render();
    expect(ui.element.textContent).toContain("1 of 2 projects backed up");
    await act(async () =>
      updateDriveBackup(projects[1].path, "saved", {
        lastBackup: Date.now() / 1000,
        sourceRevision: "pc-b",
      }),
    );
    expect(ui.element.textContent).toContain(
      "All 2 projects backed up to Drive",
    );
    await act(async () => updateDriveBackup(projects[1].path, "pending"));
    expect(ui.element.textContent).not.toContain("All 2 projects backed up");
  } finally {
    await ui.close();
  }
});
it("keeping the Drive version pauses uploads and never changes the PC document", async () => {
  const ui = await mount();
  try {
    useDocumentStore.setState({ content: "PC source stays here" });
    updateDriveBackup("C:/Paper", "failed", {
      error: 'DRIVE_CONFLICT:{"name":"Paper.zip","remoteHash":"remote-edit"}',
    });
    await ui.render();
    await act(async () =>
      [...ui.element.querySelectorAll("button")]
        .find((b) => b.textContent === "Review")!
        .click(),
    );
    await act(async () =>
      [...document.querySelectorAll("button")]
        .find((b) => b.textContent?.includes("Pause uploads only"))!
        .click(),
    );
    expect(projectDriveStatus("C:/Paper").paused).toBe(true);
    expect(invoke).not.toHaveBeenCalledWith(
      "drive_backup_project",
      expect.anything(),
    );
    expect(useDocumentStore.getState().content).toBe("PC source stays here");
  } finally {
    await ui.close();
  }
});
it("replacing a conflict requires the specific reviewed remote checksum", async () => {
  const ui = await mount();
  try {
    updateDriveBackup("C:/Paper", "failed", {
      error: 'DRIVE_CONFLICT:{"name":"Paper.zip","remoteHash":"reviewed-edit"}',
    });
    await ui.render();
    await act(async () =>
      [...ui.element.querySelectorAll("button")]
        .find((b) => b.textContent === "Review")!
        .click(),
    );
    await act(async () =>
      [...document.querySelectorAll("button")]
        .find((b) => b.textContent?.includes("Use PC version"))!
        .click(),
    );
    expect(invoke).toHaveBeenCalledWith("drive_backup_project", {
      projectPath: "C:/Paper",
      expectedRemoteHash: "reviewed-edit",
    });
    expect(projectDriveStatus("C:/Paper")).toMatchObject({
      sourceRevision: "new-pc",
      lastBackup: 123,
      paused: false,
    });
    expect(projectDriveStatus("C:/Paper").conflict).toBeUndefined();
  } finally {
    await ui.close();
  }
});

it("downloads the reviewed Drive version into a new project while pausing the old folder", async () => {
  const ui = await mount();
  try {
    vi.mocked(invoke).mockImplementation(async (command) =>
      command === "drive_status"
        ? { connected: true }
        : {
            path: "C:/Restored Paper",
            lastBackup: 123,
            sourceRevision: "drive-source",
          },
    );
    useDocumentStore.setState({ content: "Unsaved PC edits" });
    updateDriveBackup("C:/Paper", "failed", {
      error: 'DRIVE_CONFLICT:{"name":"Paper.zip","remoteHash":"reviewed-edit"}',
    });
    await ui.render();
    await act(async () =>
      [...ui.element.querySelectorAll("button")]
        .find((b) => b.textContent === "Review")!
        .click(),
    );
    await act(async () =>
      [...document.querySelectorAll("button")]
        .find((b) => b.textContent?.includes("Download Drive version"))!
        .click(),
    );
    expect(invoke).toHaveBeenCalledWith("drive_download_conflict", {
      projectPath: "C:/Paper",
      expectedRemoteHash: "reviewed-edit",
    });
    expect(projectDriveStatus("C:/Paper").paused).toBe(true);
    expect(projectDriveStatus("C:/Restored Paper").sourceRevision).toBe(
      "drive-source",
    );
    expect(useDocumentStore.getState().content).toBe("Unsaved PC edits");
  } finally {
    await ui.close();
  }
});

it("a late background upload cannot undo the user's pause, including verbatim Windows paths", () => {
  localStorage.clear();
  pauseDriveProject("C:/Paper", true);
  updateDriveBackup("\\\\?\\C:\\Paper", "saved", {
    lastBackup: 123,
    sourceRevision: "late-upload",
  });
  expect(projectDriveStatus("C:/Paper").paused).toBe(true);
  expect(projectDriveStatus("C:/Paper").sourceRevision).toBe("late-upload");
});
