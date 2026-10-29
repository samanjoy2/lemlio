import { expect, it, vi } from "vitest";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { writeTexFileContent } from "@/lib/tauri/fs";
import { useDocumentStore } from "@/stores/document-store";

it("serializes saves so an older autosave cannot finish after the close-time save", async () => {
  let release!: () => void;
  vi.mocked(writeTextFile).mockReset();
  vi.mocked(writeTextFile)
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValue(undefined);
  const first = writeTexFileContent("C:/SaveOrder/main.tex", "older");
  const last = writeTexFileContent("C:/SaveOrder/main.tex", "latest");
  await Promise.resolve();
  await Promise.resolve();
  expect(writeTextFile).toHaveBeenCalledTimes(1);
  release();
  await Promise.all([first, last]);
  expect(vi.mocked(writeTextFile).mock.calls.map(([, value]) => value)).toEqual(
    ["older", "latest"],
  );
});
it("does not mark newer edits as saved when a previous save completes", async () => {
  let release!: () => void;
  vi.mocked(writeTextFile).mockReset();
  vi.mocked(writeTextFile).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  useDocumentStore.setState({
    projectRoot: "C:/Race",
    activeFileId: "main.tex",
    files: [
      {
        id: "main.tex",
        name: "main.tex",
        relativePath: "main.tex",
        absolutePath: "C:/Race/main.tex",
        type: "tex",
        content: "first",
        isDirty: true,
      },
    ],
  });
  const saving = useDocumentStore.getState().saveAllFiles();
  await Promise.resolve();
  await Promise.resolve();
  useDocumentStore.getState().updateFileContent("main.tex", "newer");
  release();
  await saving;
  expect(useDocumentStore.getState().files[0]).toMatchObject({
    content: "newer",
    isDirty: true,
  });
});
