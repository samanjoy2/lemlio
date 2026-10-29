import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useProjectCatalog } from "@/hooks/use-project-catalog";
import { useProjectStore } from "@/stores/project-store";

function Library() {
  const { projects, loading } = useProjectCatalog();
  return (
    <div>{loading ? "Loading" : projects.map((p) => p.name).join(",")}</div>
  );
}
it("discovers folders on a background refresh without reopening or duplicate rows", async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  useProjectStore.setState({ knownProjects: [], recentProjects: [] });
  let found = false;
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "project_titles"
      ? {}
      : {
          projects: found
            ? [
                {
                  path: "C:/Imports/Paper",
                  name: "New paper",
                  mainFile: "main.tex",
                },
              ]
            : [],
        },
  );
  const element = document.createElement("div");
  const root = createRoot(element);
  const changed = vi.fn();
  window.addEventListener("project-library-changed", changed);
  try {
    await act(async () => root.render(<Library />));
    expect(element.textContent).toBe("");
    found = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(element.textContent).toBe("New paper");
    expect(changed).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(element.textContent).toBe("New paper");
    expect(changed).toHaveBeenCalledTimes(1);
  } finally {
    window.removeEventListener("project-library-changed", changed);
    await act(async () => root.unmount());
    vi.useRealTimers();
  }
});
