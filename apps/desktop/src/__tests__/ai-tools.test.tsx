import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { TOOL_PRESETS, validateToolForm } from "@/lib/tools";
import { buildProjectContext } from "@/lib/agent-context";
import { ToolsLibrary } from "@/components/tools-library";

describe("tool validation", () => {
  it("accepts the aclpubcheck preset and nothing is installed by default", () => {
    const preset = TOOL_PRESETS[0];
    expect(preset.source).toBe("https://github.com/acl-org/aclpubcheck.git");
    expect(validateToolForm(preset)).toBeNull();
  });

  it("rejects unsafe sources and commands", () => {
    const base = { ...TOOL_PRESETS[0] };
    expect(
      validateToolForm({ ...base, source: "git@github.com:a/b.git" }),
    ).toMatch(/https/);
    expect(
      validateToolForm({ ...base, kind: "package", source: "--index-url=x" }),
    ).toMatch(/package/);
    expect(validateToolForm({ ...base, command: "a && b" })).toMatch(/command/);
    expect(validateToolForm({ ...base, description: " " })).toMatch(/Describe/);
  });
});

describe("project context", () => {
  it("is bounded and mentions the useful state", () => {
    const files = Array.from({ length: 100 }, (_, i) => `f${i}.tex`);
    const text = buildProjectContext({
      activeFile: "main.tex",
      selection: "main.tex:1:1-1:5",
      compileError: "x".repeat(5000),
      files,
      pdfPage: 3,
    });
    expect(text).toContain("PDF preview page: 3");
    expect(text).toContain("40 more");
    expect(text.length).toBeLessThan(2500);
  });
});

describe("ToolsLibrary", () => {
  it("shows exactly what will run and installs only after confirmation", async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation((async (cmd: string) => {
      if (cmd === "tools_list") return [];
      if (cmd === "tools_preview")
        return {
          steps: ["uv venv env", "uv pip install git+https://x"],
          warning: "Third-party code",
          needs_uv: true,
        };
      if (cmd === "check_uv_status") return { installed: true };
      return undefined;
    }) as never);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const click = async (label: string) => {
      const button = [...container.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === label,
      );
      expect(button, label).toBeTruthy();
      await act(async () => button!.click());
    };
    await act(async () => root.render(<ToolsLibrary />));
    await click("ACL paper format check");
    await act(async () => {
      container.querySelector("form")!.requestSubmit();
    });
    expect(container.textContent).toContain("uv pip install git+https");
    expect(invoke).not.toHaveBeenCalledWith("tools_install", expect.anything());
    await click("Install and add");
    expect(invoke).toHaveBeenCalledWith(
      "tools_install",
      expect.objectContaining({
        spec: expect.objectContaining({ command: "aclpubcheck" }),
      }),
    );
    await act(async () => root.unmount());
    container.remove();
  });
});
