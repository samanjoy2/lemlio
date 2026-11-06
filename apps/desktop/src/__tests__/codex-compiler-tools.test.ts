import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { compilerMainFile, runCompilerTool } from "@/lib/codex-compiler-tools";
import { useDocumentStore } from "@/stores/document-store";
import { useSettingsStore } from "@/stores/settings-store";
import { getMupdfClient } from "@/lib/mupdf/mupdf-client";
vi.mock("@/lib/mupdf/mupdf-client", () => ({ getMupdfClient: vi.fn() }));
const pdf = new TextEncoder().encode("%PDF-1.7 demo");
beforeEach(() => {
  vi.mocked(invoke).mockReset();
  useDocumentStore.setState({
    projectRoot: "C:/Paper",
    mainFileId: "main.tex",
    files: [],
    isCompiling: false,
    refreshFiles: vi.fn(async () => {}),
  });
  useSettingsStore.setState({ compilerBackend: "tectonic" });
  vi.mocked(invoke).mockResolvedValue(pdf.slice().buffer);
  vi.mocked(readTextFile).mockResolvedValue(
    "LaTeX Warning: Reference missing\n on input line 5\n",
  );
});
it("uses the editor's selected main file and bundled compiler, then returns real errors without reusing an old preview", async () => {
  useDocumentStore.setState({ mainFileId: "sections/paper.tex" });
  const ok = await runCompilerTool({
    tool: "lemlio_compile",
    projectPath: "C:/Paper",
  });
  expect(ok.success).toBe(true);
  expect(invoke).toHaveBeenCalledWith("compile_latex", {
    projectDir: "C:/Paper",
    mainFile: "sections/paper.tex",
    useTexlive: false,
  });
  expect(JSON.stringify(ok)).toContain("Reference missing");
  vi.mocked(invoke).mockRejectedValue("LaTeX Error: Missing document");
  const failed = await runCompilerTool({
    tool: "lemlio_compile",
    projectPath: "C:/Paper",
  });
  expect(failed.success).toBe(false);
  expect(JSON.stringify(failed)).toContain("Missing document");
  expect(
    (
      await runCompilerTool({
        tool: "lemlio_view_pdf_page",
        projectPath: "C:/Paper",
      })
    ).success,
  ).toBe(false);
});
it("rejects other projects, path traversal, and dirty edits before running the compiler", async () => {
  expect(
    (await runCompilerTool({ tool: "lemlio_compile", projectPath: "C:/Other" }))
      .success,
  ).toBe(false);
  for (const name of [
    "../secret.tex",
    "C:/secret.tex",
    "/tmp/secret.tex",
    "figures/image.png",
    "a/../../main.tex",
    "\\\\server\\share.tex",
  ])
    expect(() => compilerMainFile(name, "main.tex")).toThrow();
  useDocumentStore.setState({
    files: [
      {
        id: "main.tex",
        name: "main.tex",
        relativePath: "main.tex",
        absolutePath: "C:/Paper/main.tex",
        type: "tex",
        isDirty: true,
      },
    ],
  });
  expect(
    (await runCompilerTool({ tool: "lemlio_compile", projectPath: "C:/Paper" }))
      .success,
  ).toBe(false);
  expect(invoke).not.toHaveBeenCalled();
});
it("returns the selected compiled PDF page as a bounded image and closes its document", async () => {
  const close = vi.fn(async () => {});
  const render = vi.fn(async () => new Uint8Array([137, 80, 78, 71]).buffer);
  vi.mocked(getMupdfClient).mockReturnValue({
    openDocument: vi.fn(async () => 4),
    countPages: vi.fn(async () => 2),
    getPageSize: vi.fn(async () => ({ width: 600, height: 800 })),
    renderThumbnail: render,
    closeDocument: close,
  } as unknown as ReturnType<typeof getMupdfClient>);
  await runCompilerTool({ tool: "lemlio_compile", projectPath: "C:/Paper" });
  const result = await runCompilerTool({
    tool: "lemlio_view_pdf_page",
    projectPath: "C:/Paper",
    arguments: { page: 2 },
  });
  expect(result.success).toBe(true);
  expect(result.contentItems[1]).toEqual({
    type: "inputImage",
    imageUrl: "data:image/png;base64,iVBORw==",
  });
  expect(render).toHaveBeenCalledWith(4, 1, 450);
  expect(close).toHaveBeenCalledWith(4);
  expect(
    (
      await runCompilerTool({
        tool: "lemlio_view_pdf_page",
        projectPath: "C:/Paper",
        arguments: { page: 3 },
      })
    ).success,
  ).toBe(false);
});
it("honors the optional system compiler and rejects non-PDF compiler responses", async () => {
  useSettingsStore.setState({ compilerBackend: "texlive" });
  vi.mocked(invoke).mockResolvedValue(
    new TextEncoder().encode("not a PDF").buffer,
  );
  expect(
    (await runCompilerTool({ tool: "lemlio_compile", projectPath: "C:/Paper" }))
      .success,
  ).toBe(false);
  expect(invoke).toHaveBeenCalledWith(
    "compile_latex",
    expect.objectContaining({ useTexlive: true }),
  );
});
