import { expect, it } from "vitest";
import { SharedProject, validSharedPath } from "@/lib/collaboration/document";
import * as Y from "yjs";

const id = "48b69ae1-ea1a-4718-8fc5-385757d4b8b5";
function pair() {
  const a = new SharedProject(id, "Alex"),
    b = new SharedProject(id, "Jordan");
  a.initialize("Paper", "drive-project", [
    { path: "main.tex", text: "Hello research.\nReferences follow." },
    { path: "figs/chart.png", data: "AAEC/w==" },
  ]);
  b.load(a.encode());
  return { a, b, file: a.fileAt("main.tex")! };
}
it("merges offline work into an older Drive-backed peer without using upload time", () => {
  const { a, b, file } = pair();
  const oldDrive = a.encode();
  b.setText(
    file,
    "Hello research.\nAn offline contribution.\nReferences follow.",
  );
  // An old backup is applied after the offline edit, including after a restart.
  const restarted = new SharedProject(id, "Jordan restarted");
  restarted.load(b.encode());
  restarted.load(oldDrive);
  expect(restarted.text(file).toString()).toContain("offline contribution");
  a.load(restarted.encode());
  expect(a.text(file).toString()).toBe(restarted.text(file).toString());
  expect(a.meta.get("driveProjectId")).toBe("drive-project");
  a.destroy();
  b.destroy();
  restarted.destroy();
});
it("converges concurrent offline edits in either delivery order and deduplicates repeats", () => {
  const { a, b, file } = pair();
  a.setText(file, "Hello careful research.\nReferences follow.");
  b.setText(file, "Hello research.\nReferences follow.\nJordan's ending.");
  const left = a.encode(),
    right = b.encode();
  a.load(right);
  b.load(left);
  a.load(right);
  b.load(left);
  expect(a.text(file).toString()).toBe(b.text(file).toString());
  expect(a.text(file).toString()).toContain("careful research");
  expect(a.text(file).toString()).toContain("Jordan's ending");
  a.destroy();
  b.destroy();
});
it("allows either peer to become the host with its own durable replica", () => {
  const { a, b, file } = pair();
  b.setText(file, "Jordan works while Alex is away.");
  const c = new SharedProject(id, "New collaborator");
  c.load(b.encode()); // B hosts without contacting A or Drive.
  c.text(file).insert(
    c.text(file).length,
    " New collaborator adds a sentence.",
  );
  a.load(c.encode());
  b.load(a.encode());
  expect(a.text(file).toString()).toBe(b.text(file).toString());
  expect(a.text(file).toString()).toContain("New collaborator");
  a.destroy();
  b.destroy();
  c.destroy();
});
it("keeps competing binary replacements for review and records an explicit resolution", () => {
  const { a, b } = pair(),
    file = a.fileAt("figs/chart.png")!;
  a.replaceBinary(file, "AQID");
  b.replaceBinary(file, "BAUG");
  const left = a.encode(),
    right = b.encode();
  a.load(right);
  b.load(left);
  const conflict = a.materialize().conflicts[0];
  expect(conflict.versions).toHaveLength(2);
  expect(new Set(conflict.versions.map((v) => v.data))).toEqual(
    new Set(["AQID", "BAUG"]),
  );
  expect(a.materialize().files.some((f) => f.path === "figs/chart.png")).toBe(
    false,
  );
  const selected = conflict.versions.find((v) => v.data === "BAUG")!;
  a.resolve(file, selected, true);
  b.load(a.encode());
  expect(b.materialize().conflicts).toEqual([]);
  expect(
    b.materialize().files.find((f) => f.path === "figs/chart.png")?.data,
  ).toBe("BAUG");
  a.destroy();
  b.destroy();
});
it("prunes superseded asset payloads while preserving a late offline branch", () => {
  const { a, b } = pair(),
    file = a.fileAt("figs/chart.png")!;
  a.replaceBinary(file, "AQID");
  a.encode();
  const original = [...a.records.values()].find(
    (v) => v.file === file && !v.parents.length,
  )!;
  expect(original.data).toBeUndefined();
  b.rename(file, "figs/renamed.png");
  a.load(b.encode());
  const conflict = a.materialize().conflicts.find((c) => c.file === file)!;
  expect(new Set(conflict.versions.map((v) => v.data))).toEqual(
    new Set(["AQID", "AAEC/w=="]),
  );
  a.destroy();
  b.destroy();
});
it("preserves edits that arrive concurrently with a deletion", () => {
  const { a, b, file } = pair();
  a.remove(file);
  b.text(file).insert(0, "Offline writing. ");
  a.load(b.encode());
  const conflict = a.materialize().conflicts.find((c) => c.file === file)!;
  expect(conflict.reason).toContain("deleted");
  expect(a.text(file).toString()).toContain("Offline writing");
  a.resolve(file, conflict.versions[0], true);
  expect(
    a.materialize().files.find((f) => f.path === "main.tex")?.text,
  ).toContain("Offline writing");
  b.load(a.encode());
  expect(b.materialize().conflicts).toEqual([]);
  a.destroy();
  b.destroy();
});
it("merges a rename with edits to the same stable file identity", () => {
  const { a, b, file } = pair();
  a.rename(file, "paper.tex");
  b.text(file).insert(0, "A new introduction. ");
  a.load(b.encode());
  b.load(a.encode());
  expect(a.materialize().conflicts).toEqual([]);
  expect(
    b.materialize().files.find((f) => f.path === "paper.tex")?.text,
  ).toContain("new introduction");
  a.destroy();
  b.destroy();
});
it("detects two unrelated files created at the same path and concurrent renames", () => {
  const { a, b, file } = pair();
  a.rename(file, "paper.tex");
  b.rename(file, "draft.tex");
  a.add({ path: "notes.tex", text: "Alex notes" });
  b.add({ path: "notes.tex", text: "Jordan notes" });
  a.load(b.encode());
  expect(a.materialize().conflicts).toHaveLength(2);
  const count = a.records.size;
  expect(
    a.reconcile(
      [{ path: "paper.tex", text: a.text(file).toString() }],
      [{ path: "main.tex", text: a.text(file).toString() }],
    ),
  ).toEqual([]);
  expect(a.records.size).toBe(count);
  expect([...a.records.values()].some((v) => v.path === "draft.tex")).toBe(
    true,
  );
  a.destroy();
  b.destroy();
});
it("keeps a rename or deletion concurrent with edits arriving during disk I/O", () => {
  const { a, b, file } = pair();
  const planned = a.plan(file, {
    path: "main.tex",
    kind: "text",
    deleted: true,
  });
  b.text(file).insert(0, "An edit arriving during the file operation. ");
  a.load(b.encode());
  a.commit(planned);
  expect(
    a.materialize().conflicts.some((c) => c.reason.includes("deleted")),
  ).toBe(true);
  a.destroy();
  b.destroy();
});
it("reconciles external offline text edits and recognizes filesystem renames", () => {
  const { a, b, file } = pair();
  const baseline = a.materialize().files;
  const disk = baseline.map((f) =>
    f.path === "main.tex" ? { path: "renamed.tex", text: f.text } : f,
  );
  expect(a.reconcile(disk, baseline)).toEqual([]);
  expect(a.fileAt("renamed.tex")).toBe(file);
  const next = a.materialize().files;
  expect(
    a.reconcile(
      next.map((f) =>
        f.path === "renamed.tex"
          ? { path: f.path, text: "Changed offline outside Lemlio" }
          : f,
      ),
      next,
    ),
  ).toEqual([]);
  b.load(a.encode());
  expect(b.text(file).toString()).toBe("Changed offline outside Lemlio");
  a.destroy();
  b.destroy();
});
it("reports unexpected disk divergence instead of overwriting either history", () => {
  const { a, b, file } = pair();
  const baseline = a.materialize().files;
  a.setText(file, "New shared text");
  expect(
    a.reconcile(
      baseline.map((f) =>
        f.path === "main.tex"
          ? { path: f.path, text: "Unrelated disk edit" }
          : f,
      ),
      baseline,
    ),
  ).toEqual(["main.tex"]);
  expect(a.text(file).toString()).toBe("New shared text");
  a.destroy();
  b.destroy();
});
it("normalizes Windows line endings before binding editor positions", () => {
  const project = new SharedProject(id, "Windows writer");
  project.initialize("Paper", "drive", [
    { path: "main.tex", text: "First line.\r\nSecond line.\r\n" },
  ]);
  const file = project.fileAt("main.tex")!;
  expect(project.text(file).toString()).toBe("First line.\nSecond line.\n");
  project.text(file).insert(12, "An insertion. ");
  const replica = new SharedProject(id, "Mac writer");
  replica.load(project.encode());
  expect(replica.text(file).toString()).toBe(project.text(file).toString());
  const baseline = project.materialize().files;
  expect(
    project.reconcile(
      baseline.map((f) => ({
        path: f.path,
        text: f.text!.replace(/\n/g, "\r\n"),
      })),
      baseline,
    ),
  ).toEqual([]);
  expect(project.text(file).toString()).not.toContain("\r");
  project.destroy();
  replica.destroy();
});
it("rejects foreign histories and credential/traversal paths before modifying a replica", () => {
  const { a, b } = pair(),
    before = a.encode();
  const other = new SharedProject(
    "7b4cd42d-42cf-484e-84c5-f30bd4388ec9",
    "Other",
  );
  other.initialize("Other", "other", [
    { path: "main.tex", text: "Other project" },
  ]);
  expect(() => a.load(other.encode())).toThrow("different project");
  for (const path of [
    "../secret",
    "/secret",
    "a\\b",
    "Keys/key.json",
    ".env",
    "CON.txt",
    "client_secret_test.json",
  ])
    expect(validSharedPath(path)).toBe(false);
  const bad = new Y.Doc();
  Y.applyUpdate(bad, b.encode());
  const records = bad.getMap("versions"),
    key = [...records.keys()][0];
  records.set(key, { ...(records.get(key) as object), path: "../secret" });
  expect(() => a.load(Y.encodeStateAsUpdate(bad))).toThrow(
    "Invalid shared file",
  );
  expect(a.encode()).toEqual(before);
  bad.destroy();
  a.destroy();
  b.destroy();
  other.destroy();
});
