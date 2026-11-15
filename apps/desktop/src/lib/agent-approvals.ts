/**
 * When Claude Code is refused something (it runs without a terminal, so it cannot ask),
 * its final message lists the refusals. Lemlio turns them into a card the user can
 * answer, then continues with exactly those commands allowed.
 */
export interface Approval {
  id: string;
  /** What the assistant wanted, in words. */
  summary: string;
  /** The allow-list entry that would permit exactly this command, if it can be allowed. */
  rule?: string;
}

const MAX_SUMMARY = 300;
const MAX_RULE = 500;

interface Denial {
  tool_name?: unknown;
  tool_use_id?: unknown;
  tool_input?: {
    command?: unknown;
    file_path?: unknown;
    description?: unknown;
  };
}

/** The approvals described by a `result` message's `permission_denials`, newest last. */
export function approvalsFromDenials(denials: unknown): Approval[] {
  if (!Array.isArray(denials)) return [];
  const seen = new Set<string>();
  const out: Approval[] = [];
  for (const raw of denials as Denial[]) {
    const tool = typeof raw?.tool_name === "string" ? raw.tool_name : "";
    if (!tool) continue;
    const input = raw.tool_input ?? {};
    const command =
      typeof input.command === "string" ? input.command.trim() : "";
    let summary: string;
    let rule: string | undefined;
    if ((tool === "Bash" || tool === "PowerShell") && command) {
      summary = `Run in ${tool === "Bash" ? "the terminal" : "PowerShell"}: ${command}`;
      if (!command.includes("\n") && command.length <= MAX_RULE)
        rule = `${tool}(${command})`;
    } else if (typeof input.file_path === "string") {
      summary = `Use ${tool} on ${input.file_path}`;
    } else {
      summary = `Use ${tool}`;
    }
    const key = rule ?? summary;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: typeof raw.tool_use_id === "string" ? raw.tool_use_id : key,
      summary:
        summary.length > MAX_SUMMARY
          ? `${summary.slice(0, MAX_SUMMARY)}…`
          : summary,
      rule,
    });
  }
  return out.slice(0, 10);
}

/** What the user is told the assistant has been allowed to do. */
export function approvalMessage(approvals: Approval[]): string {
  const lines = approvals.map((a) => `- ${a.summary}`).join("\n");
  return `I allowed this, so you can go ahead:\n${lines}\nPlease continue with what you were doing.`;
}
