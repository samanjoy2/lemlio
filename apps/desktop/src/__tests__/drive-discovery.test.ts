import { expect, it, vi } from "vitest";
import { toast } from "sonner";
import {
  availableDriveProjects,
  dismissDriveDiscoveries,
  publishDriveDiscoveries,
  reviewDriveProjects,
} from "@/lib/drive-discovery";

it("offers missing projects once by project identity, excludes local ones and never downloads silently", () => {
  localStorage.clear();
  const info = vi.spyOn(toast, "info").mockReturnValue("notice");
  const review = vi.fn();
  window.addEventListener("lemlio-restore-drive", review);
  try {
    publishDriveDiscoveries([
      { id: "snapshot-1", projectId: "paper", name: "Paper" },
      { id: "local", name: "Local", localPath: "C:/Local" },
    ]);
    expect(availableDriveProjects()).toHaveLength(1);
    expect(info).toHaveBeenCalledTimes(1);
    expect(review).not.toHaveBeenCalled();
    publishDriveDiscoveries([
      { id: "snapshot-2", projectId: "paper", name: "Renamed paper" },
    ]);
    expect(info).toHaveBeenCalledTimes(1);
    reviewDriveProjects();
    expect(review).toHaveBeenCalledTimes(1);
    dismissDriveDiscoveries();
    expect(availableDriveProjects()).toEqual([]);
    publishDriveDiscoveries([
      { id: "snapshot-3", projectId: "paper", name: "Paper" },
    ]);
    expect(info).toHaveBeenCalledTimes(1);
    publishDriveDiscoveries([]);
    expect(availableDriveProjects()).toEqual([]);
  } finally {
    info.mockRestore();
    window.removeEventListener("lemlio-restore-drive", review);
  }
});
