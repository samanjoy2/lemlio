/** PDF page currently shown in the preview (kept by the preview component). */
let previewPage = 1;
export const setPreviewPage = (page: number) => {
  previewPage = page;
};
export const getPreviewPage = () => previewPage;

export interface ProjectContextInput {
  activeFile?: string | null;
  /** 1-based cursor/selection label, e.g. "main.tex:12:1-12:20". */
  selection?: string | null;
  compileError?: string | null;
  files: string[];
  pdfPage?: number | null;
}

/** Compact, bounded description of the editor state sent with every prompt. */
export function buildProjectContext(input: ProjectContextInput): string {
  const lines: string[] = [];
  if (input.activeFile)
    lines.push(`[Currently open file: ${input.activeFile}]`);
  if (input.selection) lines.push(`[Cursor/selection: ${input.selection}]`);
  if (input.pdfPage) lines.push(`[PDF preview page: ${input.pdfPage}]`);
  if (input.compileError)
    lines.push(
      `[Last compile error (tail):\n${input.compileError.slice(-1500)}\n]`,
    );
  if (input.files.length) {
    const shown = input.files.slice(0, 60);
    const more = input.files.length - shown.length;
    lines.push(
      `[Project files: ${shown.join(", ")}${more > 0 ? `, … ${more} more` : ""}]`,
    );
  }
  return lines.join("\n");
}
