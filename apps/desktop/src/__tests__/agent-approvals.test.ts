import { beforeEach, describe, expect, it, vi } from "vitest";
import { approvalMessage, approvalsFromDenials } from "@/lib/agent-approvals";
import { useAgentPermissions } from "@/stores/agent-permissions-store";

vi.mock("@/stores/document-store", () => ({
  hasPdfData: () => false,
  useDocumentStore: { getState: vi.fn(() => ({})) },
}));
vi.mock("@/stores/history-store", () => ({
  useHistoryStore: { getState: vi.fn(() => ({ createSnapshot: vi.fn() })) },
}));

describe("what the assistant was refused", () => {
  it("becomes a card with an exact allow rule for shell commands", () => {
    const approvals = approvalsFromDenials([
      {
        tool_name: "PowerShell",
        tool_use_id: "t1",
        tool_input: {
          command: "aclpubcheck --paper_type long latex/acl_latex.pdf",
        },
      },
      {
        tool_name: "Bash",
        tool_use_id: "t2",
        tool_input: { command: "ls latex" },
      },
    ]);
    expect(approvals.map((a) => a.rule)).toEqual([
      "PowerShell(aclpubcheck --paper_type long latex/acl_latex.pdf)",
      "Bash(ls latex)",
    ]);
    expect(approvals[0].summary).toContain("PowerShell");
  });

  it("lists, but cannot allow, anything that is not a plain command", () => {
    const [edit, multi] = approvalsFromDenials([
      {
        tool_name: "Edit",
        tool_use_id: "a",
        tool_input: { file_path: "C:/other/file.tex" },
      },
      {
        tool_name: "Bash",
        tool_use_id: "b",
        tool_input: { command: "echo 1\nrm -rf x" },
      },
    ]);
    expect(edit.rule).toBeUndefined();
    expect(edit.summary).toBe("Use Edit on C:/other/file.tex");
    expect(multi.rule).toBeUndefined();
  });

  it("ignores junk and repeats", () => {
    expect(approvalsFromDenials(undefined)).toEqual([]);
    expect(approvalsFromDenials([null, {}, { tool_name: 5 }])).toEqual([]);
    const twice = approvalsFromDenials([
      { tool_name: "Bash", tool_use_id: "1", tool_input: { command: "ls" } },
      { tool_name: "Bash", tool_use_id: "2", tool_input: { command: "ls" } },
    ]);
    expect(twice).toHaveLength(1);
  });

  it("is reported back to the assistant in plain words", () => {
    const text = approvalMessage(
      approvalsFromDenials([
        { tool_name: "Bash", tool_use_id: "1", tool_input: { command: "ls" } },
      ]),
    );
    expect(text).toContain("I allowed this");
    expect(text).toContain("Run in the terminal: ls");
  });
});

describe("commands allowed for a project", () => {
  beforeEach(() => useAgentPermissions.setState({ always: {} }));
  it("are remembered per project, without repeats, and can be cleared", () => {
    const store = useAgentPermissions.getState();
    store.add("C:\\Projects\\Paper", ["Bash(ls)"]);
    store.add("c:/projects/paper", ["Bash(ls)", "Bash(pwd)"]);
    expect(
      useAgentPermissions.getState().rulesFor("C:/Projects/Paper"),
    ).toEqual(["Bash(ls)", "Bash(pwd)"]);
    expect(useAgentPermissions.getState().rulesFor("C:/Other")).toEqual([]);
    expect(useAgentPermissions.getState().rulesFor(null)).toEqual([]);
    store.clear("C:/Projects/Paper");
    expect(
      useAgentPermissions.getState().rulesFor("C:/Projects/Paper"),
    ).toEqual([]);
  });
});
