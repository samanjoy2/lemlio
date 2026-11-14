// The only built-in document: the blank starting file used by "Start from scratch".
// Real templates (ACL, IEEE, ...) are official packs downloaded on request; see
// lib/templates.ts and src-tauri/src/templates.rs.

export interface TemplateDefinition {
  id: string;
  name: string;
  documentClass: string;
  mainFileName: string;
  content: string;
  /** Whether a references.bib file should be created beside the main file. */
  hasBibliography: boolean;
}

const BLANK: TemplateDefinition = {
  id: "blank",
  name: "Blank Document",
  documentClass: "article",
  mainFileName: "main.tex",
  hasBibliography: false,
  content: `\\documentclass[12pt]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}

\\begin{document}

% Start writing here.

\\end{document}
`,
};

export const BIB_TEMPLATE = `% Add your references here
% Example:
% @article{key,
%   author  = {Author Name},
%   title   = {Article Title},
%   journal = {Journal Name},
%   year    = {2024},
% }
`;

export function getTemplateById(id: string): TemplateDefinition | undefined {
  return id === BLANK.id ? BLANK : undefined;
}

/**
 * The preamble with an empty document body: what a new project starts from.
 */
export function getTemplateSkeleton(template: TemplateDefinition): string {
  const marker = "\\begin{document}";
  const idx = template.content.indexOf(marker);
  if (idx === -1) return template.content;
  const preamble = template.content.slice(0, idx).trimEnd();
  return `${preamble}

\\begin{document}

\\mbox{} % Placeholder — content will be generated based on your description.

\\end{document}
`;
}
