import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { backupProject } from "@/lib/collaboration/runtime";
import {
  SharedProject,
  fromBase64,
  toBase64,
} from "@/lib/collaboration/document";
it("merges the offline and Drive histories before uploading and binds the reviewed heads", async () => {
  const id = "60d9bab8-130b-4cd5-b995-059de7b05f29";
  const cloud = new SharedProject(id, "Cloud writer");
  cloud.initialize("Paper", "cloud-id", [
    { path: "main.tex", text: "Introduction.\nEnding." },
  ]);
  const offline = new SharedProject(id, "Offline writer");
  offline.load(cloud.encode());
  const file = offline.fileAt("main.tex")!;
  offline.text(file).insert(0, "Offline contribution. ");
  cloud.text(file).insert(cloud.text(file).length, " Cloud contribution.");
  let state = toBase64(offline.encode()),
    files = offline.materialize().files;
  const hash = () =>
    createHash("sha256").update(fromBase64(state)).digest("hex");
  vi.mocked(invoke).mockClear();
  vi.mocked(invoke).mockImplementation(async (command, args: any = {}) => {
    if (command === "collaboration_load")
      return {
        enabled: true,
        manifest: { id, title: "Paper", driveProjectId: "cloud-id" },
        settings: {},
        state,
        stateHash: hash(),
        files,
        baseline: files,
      };
    if (command === "collaboration_inventory")
      return { files, baseline: files };
    if (command === "collaboration_persist") {
      expect(args.expectedHash).toBe(hash());
      state = args.state;
      return hash();
    }
    if (command === "collaboration_materialize") {
      files = args.files;
      return { conflicts: [] };
    }
    if (command === "drive_collaboration_updates")
      return {
        heads: [
          {
            id: "drive-new-head",
            hash: "reviewed-archive-hash",
            state: toBase64(cloud.encode()),
          },
        ],
      };
    if (command === "drive_backup_project") {
      const merged = new SharedProject(id, "Check");
      merged.load(fromBase64(state));
      expect(merged.text(file).toString()).toContain("Offline contribution");
      expect(merged.text(file).toString()).toContain("Cloud contribution");
      expect(files.find((f) => f.path === "main.tex")?.text).toBe(
        merged.text(file).toString(),
      );
      merged.destroy();
      expect(args.collaborationHeads).toEqual([
        { id: "drive-new-head", hash: "reviewed-archive-hash" },
      ]);
      return { lastBackup: 123, sourceRevision: "merged" };
    }
    return undefined;
  });
  try {
    expect(
      await backupProject({
        projectPath: "C:/Generated-Collaboration-Drive-Test",
      }),
    ).toEqual({ lastBackup: 123, sourceRevision: "merged" });
  } finally {
    cloud.destroy();
    offline.destroy();
  }
});
