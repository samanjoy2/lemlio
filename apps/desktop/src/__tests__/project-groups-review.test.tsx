import { TooltipProvider } from "@/components/ui/tooltip";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { it, expect, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { ProjectGroupWorkspace } from "@/components/project-group-workspace";
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
it("reviews both chosen projects together without starting an agent", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  useDocumentStore.setState({ files: [] });
  useProjectGroups.setState({
    activeGroupId: "cv",
    groups: [{ id: "cv", name: "My CVs", paths: ["C:/A", "C:/B"] }],
    review: [
      { path: "C:/A", snapshot: "before-a" },
      { path: "C:/B", snapshot: "before-b" },
    ],
  });
  vi.mocked(invoke).mockClear();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "history_list") return [{ id: "after" }];
    if (command === "history_diff")
      return [
        {
          file_path: "main.tex",
          status: "modified",
          old_content: "Old number",
          new_content: "New number",
        },
      ];
    return undefined;
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <TooltipProvider>
          <ProjectGroupWorkspace>
            <div>Project editor</div>
          </ProjectGroupWorkspace>
        </TooltipProvider>,
      ),
    );
    const review = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Review changes",
    )!;
    expect(review).toBeTruthy();
    await act(async () => review.click());
    expect(document.body.textContent).toContain("CV A");
    expect(document.body.textContent).toContain("CV B");
    expect(document.body.textContent).toContain("Before");
    expect(document.body.textContent).toContain("New number");
    expect(
      vi.mocked(invoke).mock.calls.filter((c) => c[0] === "history_diff"),
    ).toHaveLength(2);
    expect(
      vi.mocked(invoke).mock.calls.some((c) => c[0] === "execute_codex_code"),
    ).toBe(false);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
