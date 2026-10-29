import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  DriveRestoreDialog,
  requestDriveRestore,
} from "@/components/drive-restore-dialog";
import { useDocumentStore } from "@/stores/document-store";
import { projectDriveStatus } from "@/lib/drive-backup-status";

it("downloads only explicitly selected backups and keeps the PC document unchanged", async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  useDocumentStore.setState({ content: "Existing PC source" });
  let restored = false;
  vi.mocked(invoke).mockClear();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "drive_list_backups")
      return {
        projects: [
          {
            id: "missing",
            name: "Paper",
            localPath: restored ? "C:/Restored/Paper" : null,
          },
          { id: "linked", name: "CV", localPath: "C:/Existing/CV" },
        ],
      };
    if (command === "drive_restore_project") {
      expect(args).toEqual({ archiveId: "missing" });
      restored = true;
      return {
        path: "C:/Restored/Paper",
        lastBackup: 123,
        sourceRevision: "restored-version",
      };
    }
    return null;
  });
  const element = document.createElement("div");
  document.body.appendChild(element);
  const root = createRoot(element);
  try {
    await act(async () => root.render(<DriveRestoreDialog />));
    expect(invoke).not.toHaveBeenCalledWith(
      "drive_restore_project",
      expect.anything(),
    );
    await act(async () => requestDriveRestore());
    const checks = [
      ...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ];
    expect(checks[1].disabled).toBe(true);
    await act(async () => checks[0].click());
    expect(invoke).not.toHaveBeenCalledWith(
      "drive_restore_project",
      expect.anything(),
    );
    await act(async () =>
      [...document.querySelectorAll("button")]
        .find((b) => b.textContent === "Restore selected projects")!
        .click(),
    );
    expect(invoke).toHaveBeenCalledWith("drive_restore_project", {
      archiveId: "missing",
    });
    expect(useDocumentStore.getState().content).toBe("Existing PC source");
    expect(projectDriveStatus("C:/Restored/Paper")).toMatchObject({
      lastBackup: 123,
      sourceRevision: "restored-version",
      pending: false,
    });
    expect(document.body.textContent).toContain("1 projects restored");
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});
