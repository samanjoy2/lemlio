import { invoke } from "@tauri-apps/api/core";

export type ToolKind = "git" | "package" | "command";

/** A user-added tool the AI may run. Mirrors `ToolSpec` in src-tauri/src/tools.rs. */
export interface ToolSpec {
  id: string;
  name: string;
  description: string;
  kind: ToolKind;
  source: string;
  command: string;
  enabled: boolean;
}

export interface InstallPreview {
  steps: string[];
  warning: string;
  needs_uv: boolean;
}

/** Ready-to-add examples. Presets are never installed automatically. */
export const TOOL_PRESETS: Omit<ToolSpec, "id" | "enabled">[] = [
  {
    name: "ACL paper format check",
    description:
      "Checks an ACL-style paper PDF for formatting problems (margins, fonts, anonymity, page limits). Compile the paper first, then run: aclpubcheck --paper_type long <path-to-pdf> (paper_type is long, short or demo). Summarise the reported errors and fix the LaTeX that causes them.",
    kind: "git",
    source: "https://github.com/acl-org/aclpubcheck.git",
    command: "aclpubcheck",
  },
];

/** Same rules as the backend check, for instant feedback in the form. */
export function validateToolForm(
  t: Pick<ToolSpec, "name" | "description" | "kind" | "source" | "command">,
): string | null {
  if (!t.name.trim() || t.name.trim().length > 40)
    return "Give the tool a name of up to 40 characters.";
  if (!t.description.trim())
    return "Describe when the AI should use this tool.";
  if (!t.command.trim() || /[\n\r"`$;&|<>]/.test(t.command))
    return "The command must be one program name or path, without shell characters.";
  const source = t.source.trim();
  if (t.kind === "git" && !/^https:\/\/\S+$/.test(source))
    return "Use an https:// git repository URL.";
  if (
    t.kind === "package" &&
    !/^[A-Za-z0-9][A-Za-z0-9._\-[\],=<>!~]*$/.test(source)
  )
    return "Use a package name such as aclpubcheck or pkg==1.2.";
  return null;
}

export const listTools = () => invoke<ToolSpec[]>("tools_list");
