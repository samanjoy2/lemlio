import { describe, expect, it } from "vitest";
import { backupSummary } from "@/lib/backup-summary";

const minutesAgo = (n: number) => Date.now() / 1000 - n * 60;

describe("backup summary on a project card", () => {
  it("says when it was last backed up and from which device", () => {
    const s = backupSummary({
      lastBackup: minutesAgo(5),
      deviceName: "Windows PC 3af2",
    });
    expect(s?.tone).toBe("ok");
    expect(s?.text).toMatch(/^Backed up .*minutes ago from Windows PC 3af2$/);
  });
  it("says when a newer version from another device is waiting", () => {
    const s = backupSummary({
      lastBackup: minutesAgo(5),
      incoming: true,
      deviceName: "Mac 91ab",
    });
    expect(s).toMatchObject({
      tone: "incoming",
      text: "Newer version from Mac 91ab",
    });
  });
  it("flags a version that changed on two devices", () => {
    const s = backupSummary({
      conflict: { name: "x", deviceName: "Mac 91ab" },
    });
    expect(s).toMatchObject({
      tone: "attention",
      text: "Changed here and on Mac 91ab",
    });
  });
  it("shows progress and waiting states, and nothing when there is nothing to say", () => {
    expect(backupSummary({ uploading: true })?.text).toBe("Backing up…");
    expect(backupSummary({ pending: true })?.text).toBe("Backup waiting");
    expect(
      backupSummary({ lastBackup: minutesAgo(1), pending: true })?.text,
    ).toMatch(/^Changes waiting · Backed up/);
    expect(backupSummary({})).toBeNull();
  });
});
