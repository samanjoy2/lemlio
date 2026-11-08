import { createHash } from "node:crypto";
import { it, expect, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  SharedProject,
  toBase64,
  fromBase64,
} from "@/lib/collaboration/document";
import { reconcileCollaborationSource } from "@/lib/collaboration/runtime";
it("records an offline agent edit in a closed shared project's existing history without Drive", async () => {
  const id = "60d9bab8-130b-4cd5-b995-059de7b05f29";
  const project = new SharedProject(id, "Writer");
  project.initialize("CV", "drive-key", [
    { path: "main.tex", text: "Old contact" },
  ]);
  const file = project.fileAt("main.tex")!;
  let state = toBase64(project.encode());
  let baseline = [{ path: "main.tex", text: "Old contact" }];
  let files = [{ path: "main.tex", text: "New contact from group agent" }];
  const hash = () =>
    createHash("sha256").update(fromBase64(state)).digest("hex");
  vi.mocked(invoke).mockClear();
  vi.mocked(invoke).mockImplementation(async (command, args: any = {}) => {
    if (command === "collaboration_load")
      return {
        enabled: true,
        manifest: { id, title: "CV", driveProjectId: "drive-key" },
        settings: {},
        state,
        stateHash: hash(),
        files,
        baseline,
      };
    if (command === "collaboration_inventory") return { files, baseline };
    if (command === "collaboration_persist") {
      expect(args.expectedHash).toBe(hash());
      state = args.state;
      return hash();
    }
    if (command === "collaboration_materialize") {
      files = args.files;
      baseline = args.files;
      return { conflicts: [] };
    }
    return undefined;
  });
  try {
    await reconcileCollaborationSource("C:/Generated-Shared-Group-Reconcile");
    const verified = new SharedProject(id, "Verifier");
    verified.load(fromBase64(state));
    expect(verified.text(file).toString()).toBe("New contact from group agent");
    expect(verified.meta.get("driveProjectId")).toBe("drive-key");
    expect(
      vi
        .mocked(invoke)
        .mock.calls.some((c) => String(c[0]).startsWith("drive_")),
    ).toBe(false);
    verified.destroy();
  } finally {
    project.destroy();
  }
});
