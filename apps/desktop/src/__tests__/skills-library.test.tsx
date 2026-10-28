import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { SkillsLibrary } from "@/components/skills-library";

describe("home skills library", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    vi.mocked(invoke).mockReset();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  it("shows installed skills without installation or download actions", async () => {
    vi.mocked(invoke).mockResolvedValue([
      {
        id: "scientific-writing",
        folder: "scientific-writing",
        name: "Scientific Writing",
        description: "Write papers",
        domain: "Academic writing",
      },
      {
        id: "citation-management",
        folder: "citation-management",
        name: "Citation Management",
        description: "Check citations",
        domain: "Academic writing",
      },
    ]);
    await act(async () => root.render(<SkillsLibrary />));
    expect(container.textContent).toContain("2 ready for Codex");
    expect(container.textContent).toContain("Scientific Writing");
    expect(
      [...container.querySelectorAll("button")].map(
        (button) => button.textContent,
      ),
    ).toEqual(["View skills"]);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("list_installed_skills", {
      projectPath: null,
    });
  });
  it("shows an empty library without prompting to install anything", async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    await act(async () => root.render(<SkillsLibrary />));
    expect(container.textContent).toContain("0 ready for Codex");
    expect(container.textContent).not.toMatch(/download|install/i);
  });
});
