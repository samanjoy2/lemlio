import { invoke } from "@tauri-apps/api/core";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { useDocumentStore } from "@/stores/document-store";
import { useSettingsStore } from "@/stores/settings-store";
import { projectPathKey } from "./project-catalog";
import { getMupdfClient } from "./mupdf/mupdf-client";

type Content =
  | { type: "inputText"; text: string }
  | { type: "inputImage"; imageUrl: string };
export type CompilerToolResult = { success: boolean; contentItems: Content[] };
export type CompilerToolRequest = {
  tool: string;
  arguments?: unknown;
  projectPath?: string;
};
const snapshots = new Map<string, { main: string; pdf: Uint8Array }>();
const text = (value: unknown): Content => ({
  type: "inputText",
  text: typeof value === "string" ? value : JSON.stringify(value),
});

export function compilerMainFile(value: unknown, fallback: string) {
  const name = value === undefined ? fallback : value;
  if (typeof name !== "string")
    throw new Error("main_file must be a relative .tex or .ltx filename");
  const normalized = name.replace(/\\/g, "/");
  if (
    !/\.(tex|ltx)$/i.test(normalized) ||
    normalized.startsWith("/") ||
    normalized.includes(":") ||
    normalized.split("/").some((p) => !p || p === "." || p === "..")
  )
    throw new Error("Choose a .tex or .ltx file inside the open project");
  return normalized;
}

function activeProject(path?: string) {
  const doc = useDocumentStore.getState();
  if (
    !path ||
    !doc.projectRoot ||
    projectPathKey(path) !== projectPathKey(doc.projectRoot)
  )
    throw new Error(
      "This chat's project is no longer open. Open it before compiling or viewing its PDF.",
    );
  return doc;
}

async function render(pdf: Uint8Array, page: number): Promise<Content[]> {
  const client = getMupdfClient();
  const id = await client.openDocument(new Uint8Array(pdf).buffer);
  try {
    const pages = await client.countPages(id);
    if (!Number.isInteger(page) || page < 1 || page > pages)
      throw new Error(`Choose a page from 1 to ${pages}`);
    const size = await client.getPageSize(id, page - 1);
    if (!(size.width > 0 && size.height > 0))
      throw new Error("Invalid PDF page dimensions");
    // The existing renderer uses a 2x scale. Bound both dimensions to 1200px.
    const width = Math.min(600, (600 * size.width) / size.height);
    const bytes = new Uint8Array(
      await client.renderThumbnail(id, page - 1, width),
    );
    if (bytes.length > 5 * 1024 * 1024)
      throw new Error("Rendered page exceeds the 5 MB preview limit");
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192)
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return [
      text({
        page,
        pages,
        note: "Rendered from the last successful agent compilation. Recompile after source changes.",
      }),
      { type: "inputImage", imageUrl: `data:image/png;base64,${btoa(binary)}` },
    ];
  } finally {
    await client.closeDocument(id).catch(() => {});
  }
}

export async function runCompilerTool(
  request: CompilerToolRequest,
): Promise<CompilerToolResult> {
  try {
    const doc = activeProject(request.projectPath);
    const root = doc.projectRoot!;
    const key = projectPathKey(root);
    const args = request.arguments ?? {};
    if (typeof args !== "object" || args === null || Array.isArray(args))
      throw new Error("Tool arguments must be an object");
    const options = args as { main_file?: unknown; page?: unknown };
    if (request.tool === "lemlio_view_pdf_page") {
      const snapshot = snapshots.get(key);
      if (!snapshot)
        throw new Error(
          "Run lemlio_compile successfully first. Old editor previews are not used as verification.",
        );
      return {
        success: true,
        contentItems: await render(
          snapshot.pdf,
          options.page === undefined ? 1 : Number(options.page),
        ),
      };
    }
    if (request.tool !== "lemlio_compile")
      throw new Error("Unknown Lemlio compiler tool");
    snapshots.delete(key);
    if (doc.isCompiling)
      throw new Error(
        "The editor is compiling. Wait for it to finish, then retry lemlio_compile.",
      );
    if (doc.files.some((f) => f.isDirty))
      throw new Error(
        "The editor has unsaved changes. Wait for autosave or ask the user to save before retrying.",
      );
    await doc.refreshFiles();
    const current = activeProject(root);
    if (current.isCompiling || current.files.some((f) => f.isDirty))
      throw new Error(
        "The editor changed or started compiling. Wait for autosave/compilation and retry.",
      );
    const main = compilerMainFile(options.main_file, current.mainFileId);
    const useTexlive =
      useSettingsStore.getState().compilerBackend === "texlive";
    current.setIsCompiling(true);
    current.setPendingRecompile(false);
    try {
      const data = await invoke<ArrayBuffer>("compile_latex", {
        projectDir: root,
        mainFile: main,
        useTexlive,
      });
      const pdf = new Uint8Array(data);
      if (
        pdf.length < 5 ||
        new TextDecoder().decode(pdf.subarray(0, 5)) !== "%PDF-"
      )
        throw new Error("Compiler did not return a PDF");
      activeProject(root).setPdfData(pdf, main);
      snapshots.set(key, { main, pdf });
      while (snapshots.size > 2)
        snapshots.delete(snapshots.keys().next().value!);
      let warnings: string | null = null;
      const log = `${root}/.prism/build/${main.replace(/\.(tex|ltx)$/i, ".log")}`;
      try {
        const lines = (await readTextFile(log)).split(/\r?\n/);
        warnings = lines
          .filter(
            (line, i) =>
              /warning|overfull|underfull/i.test(line) ||
              /warning/i.test(lines[i - 1] || ""),
          )
          .slice(0, 60)
          .join("\n")
          .slice(0, 8000);
      } catch {
        /* Compilation success comes from native output, independently of log availability. */
      }
      return {
        success: true,
        contentItems: [
          text({
            compiled: true,
            compiler: useTexlive ? "System LaTeX" : "Tectonic (bundled)",
            main_file: main,
            pdf_bytes: pdf.length,
            warnings,
            note: "Use lemlio_view_pdf_page to inspect the rendered layout. Compilation alone does not verify visual layout.",
          }),
        ],
      };
    } catch (error) {
      if (
        useDocumentStore.getState().projectRoot &&
        projectPathKey(useDocumentStore.getState().projectRoot!) === key
      )
        useDocumentStore.getState().setCompileError(String(error), main);
      throw error;
    } finally {
      if (
        useDocumentStore.getState().projectRoot &&
        projectPathKey(useDocumentStore.getState().projectRoot!) === key
      )
        useDocumentStore.getState().setIsCompiling(false);
    }
  } catch (error) {
    return {
      success: false,
      contentItems: [text(String(error).slice(0, 16000))],
    };
  }
}
