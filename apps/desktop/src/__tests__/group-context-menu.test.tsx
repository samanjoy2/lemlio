import { act } from "react";
import { createRoot } from "react-dom/client";
import { it, expect, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { ProjectGroupWorkspace } from "@/components/project-group-workspace";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useProjectGroups } from "@/stores/project-groups-store";
import { useDocumentStore } from "@/stores/document-store";
vi.mock("border-beam", () => ({ BorderBeam: ({ children }: any) => children }));
vi.mock("@/hooks/use-project-catalog", () => ({
  useProjectCatalog: () => ({
    projects: [
      { path: "C:/A", name: "CV A" },
      { path: "C:/B", name: "CV B" },
    ],
  }),
}));
it("offers mention, main version, and membership removal without deleting the project", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  useProjectGroups.setState({
    activeGroupId: "cv",
    groups: [{ id: "cv", name: "CVs", paths: ["C:/A", "C:/B"] }],
    review: [],
  });
  useDocumentStore.setState({
    projectRoot: "C:/A",
    files: [],
    isCompiling: false,
  });
  vi.mocked(invoke).mockClear();
  vi.mocked(invoke).mockResolvedValue([]);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const menu = async (text: string) => {
    const tab = [...host.querySelectorAll('[role="tab"]')].find((b) =>
      b.textContent?.startsWith("CV A"),
    )!;
    await act(async () =>
      tab.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          button: 2,
          clientX: 100,
          clientY: 100,
        }),
      ),
    );
    const item = [...document.querySelectorAll('[role="menuitem"]')].find(
      (b) => b.textContent === text,
    ) as HTMLElement;
    expect(item).toBeTruthy();
    await act(async () => item.click());
  };
  try {
    await act(async () =>
      root.render(
        <TooltipProvider>
          <ProjectGroupWorkspace>
            <div>Editor</div>
          </ProjectGroupWorkspace>
        </TooltipProvider>,
      ),
    );
    await menu("Mention in chat");
    expect(document.body.textContent).toContain("@project CV A");
    await menu("Set as main version");
    expect(useProjectGroups.getState().groups[0].mainPath).toBe("C:/A");
    await menu("Remove from group");
    expect(useProjectGroups.getState().groups[0].paths).toEqual(["C:/B"]);
    expect(useDocumentStore.getState().projectRoot).toBe("C:/A");
    expect(
      vi
        .mocked(invoke)
        .mock.calls.some((c) =>
          /delete|trash|remove_file|execute_codex/.test(String(c[0])),
        ),
    ).toBe(false);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
