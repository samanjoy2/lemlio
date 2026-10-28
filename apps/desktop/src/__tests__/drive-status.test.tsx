import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { DriveStatus } from "@/components/drive-status";
import {
  updateDriveBackup,
  driveRelativeTime,
} from "@/lib/drive-backup-status";
import { useSettingsStore } from "@/stores/settings-store";

it("shows confirmed backup times only for the project that was uploaded", async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  useSettingsStore.setState({ autoDriveBackup: true });
  vi.mocked(invoke).mockResolvedValue({
    connected: true,
    lastBackup: Date.now() / 1000,
  });
  const element = document.createElement("div");
  const root = createRoot(element);
  try {
    updateDriveBackup("C:/One", "saved", {
      lastBackup: Date.now() / 1000 - 120,
    });
    await act(async () => root.render(<DriveStatus projectPath="C:/One" />));
    expect(element.textContent).toContain("Saved to Drive 2 min ago");
    await act(async () => root.render(<DriveStatus projectPath="C:/Two" />));
    expect(element.textContent).toContain("No backup yet");
    await act(async () => updateDriveBackup("C:/Two", "pending"));
    expect(element.textContent).toContain("Drive backup pending");
    await act(async () => updateDriveBackup("C:/Two", "uploading"));
    expect(element.textContent).toContain("Saving to Drive");
    await act(async () =>
      updateDriveBackup("C:/Two", "failed", { error: "Offline" }),
    );
    expect(element.textContent).toContain("Will retry");
    await act(async () => updateDriveBackup("C:/Two", "saved"));
    expect(element.textContent).toContain("Saved to Drive just now");
    const opened = vi.fn();
    window.addEventListener("lemlio-open-settings", opened);
    try {
      await act(async () => element.querySelector("button")!.click());
      expect(opened.mock.calls[0][0].detail).toBe("Google Drive");
    } finally {
      window.removeEventListener("lemlio-open-settings", opened);
    }
  } finally {
    await act(async () => root.unmount());
  }
});

it("formats older backup ages", () => {
  expect(driveRelativeTime(0, 7200000)).toBe("2 hr ago");
  expect(driveRelativeTime(0, 172800000)).toBe("2 days ago");
});
