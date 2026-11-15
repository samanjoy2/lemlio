export const DEFAULT_AGENTS_MD = `# Lemlio LaTeX Project

Academic writing workspace powered by Lemlio. You are assisting with a LaTeX document project.

## Environment

- **LaTeX Engine**: Tectonic (handles packages and fonts automatically — no manual \`tlmgr\` needed)
- **Python**: Do not create a virtual environment in this project. Extra tools the user added (Lemlio → AI tools) live in one shared environment and are already on PATH.
- **Build Directory**: \`.prism/build/\` (persistent, do not modify directly)
- **Version History**: \`.prismpro/\` (automatic snapshots, do not modify)

## Project Structure

\`\`\`
.
├── main.tex              # Primary document (or custom-named .tex)
├── references.bib        # Bibliography (if applicable)
├── attachments/           # Reference files (PDFs, images, data)
└── figures/               # Generated figures and plots
\`\`\`

## Commands

\`\`\`bash
# LaTeX is compiled automatically by Lemlio — no manual build commands needed.
\`\`\`

## Writing Guidelines

- Edit \`.tex\` files directly. Lemlio auto-compiles and shows a live PDF preview.
- Use \`\\input{filename}\` or \`\\include{filename}\` to split large documents into multiple files.
- Place images in a \`figures/\` directory and reference with \`\\includegraphics{figures/name}\`.
- For bibliography, add entries to \`references.bib\` and cite with \`\\cite{key}\`.
- When adding new packages, add \`\\usepackage{pkg}\` to the preamble — Tectonic installs them automatically.

## Figures

When generating figures with Python, always:
1. Save to \`figures/<descriptive-name>.pdf\` (vector) or \`.png\` (raster, 300 dpi)
2. Add corresponding \`\\includegraphics\` in the \`.tex\` file
3. Use publication-quality formatting (proper labels, legends, font sizes)

## Gotchas

- Tectonic uses XeTeX and supports Unicode. TeX Live engine directives apply only when using the TeX Live backend.
- Do NOT create or modify files in \`.prism/\` or \`.prismpro/\`, and do not create a \`.venv/\` — these are managed automatically.
- When modifying LaTeX, ensure matching \`\\begin{}\` / \`\\end{}\` pairs — mismatches cause hard-to-debug compile errors.
- Large tables and figures should use \`\\begin{table}[htbp]\` / \`\\begin{figure}[htbp]\` for proper float placement.
- If the user provides reference files in \`attachments/\`, review them before writing — they contain key context.
`;
