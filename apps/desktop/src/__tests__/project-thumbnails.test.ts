import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
const pdf = vi.hoisted(() => ({
  openDocument: vi.fn(async (_data: ArrayBuffer) => 1),
  renderThumbnail: vi.fn(
    async () => new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer,
  ),
  closeDocument: vi.fn(async () => {}),
}));
vi.mock("@/lib/mupdf/mupdf-client", () => ({ getMupdfClient: () => pdf }));
import {
  projectThumbnail,
  refreshProjectThumbnail,
} from "@/lib/project-thumbnails";
beforeEach(() => {
  vi.mocked(invoke).mockReset();
  pdf.openDocument.mockClear();
  pdf.renderThumbnail.mockClear();
  pdf.closeDocument.mockClear();
});
it("reuses a persisted image without opening a PDF or compiling", async () => {
  vi.mocked(invoke).mockResolvedValue({
    attempted: true,
    dataUrl: "cached-image",
  });
  expect(await projectThumbnail("C:/Cached", "main.tex", false)).toBe(
    "cached-image",
  );
  expect(pdf.openDocument).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalledWith(
    "project_pdf_preview",
    expect.anything(),
  );
});
it("persists first-time generation and uses it on later home-page mounts", async () => {
  let saved = false;
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "load_project_thumbnail")
      return { attempted: saved, dataUrl: saved ? "saved-image" : null };
    if (command === "project_pdf_preview") return new ArrayBuffer(10);
    saved = true;
    return { attempted: true, dataUrl: "saved-image" };
  });
  await projectThumbnail("C:/First", "main.tex", false);
  await projectThumbnail("C:/First", "main.tex", false);
  expect(pdf.renderThumbnail).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledWith("project_pdf_preview", {
    projectPath: "C:/First",
    mainFile: "main.tex",
    useTexlive: false,
  });
});
it("remembers failed first attempts until an explicit compilation updates the preview", async () => {
  let attempted = false;
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "load_project_thumbnail") return { attempted };
    if (command === "project_pdf_preview") throw Error("Compilation failed");
    attempted = true;
    return { attempted: true, dataUrl: null };
  });
  await projectThumbnail("C:/Failed", "main.tex", false);
  await projectThumbnail("C:/Failed", "main.tex", false);
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === "project_pdf_preview"),
  ).toHaveLength(1);
  await refreshProjectThumbnail("C:/Failed", new Uint8Array([1, 2, 3]));
  expect(pdf.renderThumbnail).toHaveBeenCalledTimes(1);
});
it("renders a copy so thumbnail generation never detaches the PDF viewer's bytes", async () => {
  const data = new Uint8Array([1, 2, 3]);
  vi.mocked(invoke).mockResolvedValue({ attempted: true, dataUrl: "image" });
  await refreshProjectThumbnail("C:/Compile", data);
  expect(pdf.openDocument.mock.calls[0][0]).not.toBe(data.buffer);
  expect([...data]).toEqual([1, 2, 3]);
});
