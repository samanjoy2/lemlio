import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import {
  ImportProjectDialog,
  ProjectZipExportButton,
} from "@/components/project-zip-transfer";
import { useDocumentStore } from "@/stores/document-store";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

describe("project ZIP transfers", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    vi.clearAllMocks();
    useDocumentStore.setState({ projectRoot: null, files: [] });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });
  const clickText = async (text: string) => {
    const button = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === text,
    );
    expect(button, text).toBeTruthy();
    await act(async () => button?.click());
  };
  const project = {
    name: "Paper",
    path: "C:/Lemlio/Projects/Imports/Paper",
    mainFile: "latex/main.tex",
    fileCount: 3,
    texFileCount: 1,
    conversationCount: 0,
  };

  it.each([
    "copy",
    "move",
  ] as const)("imports using the explicit %s choice and displays the managed location", async (mode) => {
    vi.mocked(open).mockResolvedValue("C:/Downloads/Paper.zip");
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "project_storage_location") return "C:/Lemlio/Projects";
      return {
        projects: [project],
        storagePath: project.path,
        archivePath:
          mode === "move" ? "C:/Lemlio/Projects/Archives/Paper.zip" : null,
        sourceMoved: mode === "move",
        warning: null,
      };
    });
    const imported = vi.fn();
    const openProject = vi.fn();
    await act(async () =>
      root.render(
        <ImportProjectDialog
          open
          onOpenChange={vi.fn()}
          onImported={imported}
          onOpenProject={openProject}
        />,
      ),
    );
    expect(
      (document.querySelector('input[value="copy"]') as HTMLInputElement)
        .checked,
    ).toBe(true);
    await clickText("Choose ZIP fileSelect a .zip from your computer");
    if (mode === "move")
      await act(async () =>
        (
          document.querySelector('input[value="move"]') as HTMLInputElement
        ).click(),
      );
    await clickText("Import project");
    expect(invoke).toHaveBeenCalledWith("import_project_zip", {
      archivePath: "C:/Downloads/Paper.zip",
      mode,
    });
    expect(imported).toHaveBeenCalledOnce();
    expect(document.body.textContent).toContain(project.path);
    expect(document.body.textContent).toContain(
      mode === "move"
        ? "The original ZIP was moved to"
        : "Your original ZIP is still in its original folder.",
    );
    await clickText("Open project");
    expect(openProject).toHaveBeenCalledWith(project);
  });

  it("saves current edits before exporting, and cancels when saving fails", async () => {
    vi.mocked(save).mockResolvedValue("C:/Backups/Paper.zip");
    const saveFiles = vi
      .spyOn(useDocumentStore.getState(), "saveAllFiles")
      .mockResolvedValue();
    useDocumentStore.setState({
      projectRoot: "C:/Paper",
      files: [
        {
          id: "main.tex",
          name: "main.tex",
          relativePath: "main.tex",
          absolutePath: "C:/Paper/main.tex",
          type: "tex",
          isDirty: true,
          content: "latest changes",
        },
      ],
    });
    await act(async () =>
      root.render(<ProjectZipExportButton projectPath="C:/Paper" />),
    );
    await act(async () => container.querySelector("button")?.click());
    expect(saveFiles).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalledWith(
      "export_project_zip",
      expect.anything(),
    );
    expect(toast.error).toHaveBeenCalledWith(
      "Could not export project",
      expect.objectContaining({
        description: expect.stringContaining("could not be saved"),
      }),
    );
  });

  it("exports the selected project ZIP and reports its destination", async () => {
    vi.mocked(save).mockResolvedValue("C:/Backups/Paper.zip");
    vi.mocked(invoke).mockResolvedValue(3);
    await act(async () =>
      root.render(<ProjectZipExportButton projectPath="C:/Paper" />),
    );
    await act(async () => container.querySelector("button")?.click());
    expect(invoke).toHaveBeenCalledWith("export_project_zip", {
      projectPath: "C:/Paper",
      destination: "C:/Backups/Paper.zip",
    });
    expect(toast.success).toHaveBeenCalledWith("Project exported", {
      description: "3 files saved to C:/Backups/Paper.zip",
    });
  });

  it("does not export when the file picker is cancelled", async () => {
    vi.mocked(save).mockResolvedValue(null);
    await act(async () =>
      root.render(<ProjectZipExportButton projectPath="C:/Paper" />),
    );
    await act(async () => container.querySelector("button")?.click());
    expect(invoke).not.toHaveBeenCalled();
  });
});
