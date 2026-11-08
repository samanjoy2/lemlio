import { it, expect, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useProjectGroups } from "@/stores/project-groups-store";
import { useProjectStore } from "@/stores/project-store";
import { useCodexChatStore } from "@/stores/codex-chat-store";
import { useDocumentStore } from "@/stores/document-store";
import { buildProjectCatalog } from "@/lib/project-catalog";
it("registers a clone ahead of previously opened library projects", () => {
  useProjectStore.setState({ recentProjects: [], knownProjects: [] });
  useProjectStore.getState().addRecentProject("C:/CV original");
  useProjectStore.getState().addRecentProject("C:/CV clone");
  const s = useProjectStore.getState();
  const projects = buildProjectCatalog(
    [],
    s.knownProjects,
    s.recentProjects,
  ).sort((a, b) => b.lastOpened - a.lastOpened);
  expect(projects[0].path).toBe("C:/CV clone");
});
it("saves only explicitly chosen members and edits membership without duplicating groups", () => {
  useProjectGroups.setState({ groups: [], scope: null });
  useProjectGroups
    .getState()
    .save({ id: "cv", name: "CVs", paths: ["C:/A", "C:/B"] });
  useProjectGroups
    .getState()
    .save({ id: "cv", name: "CV variants", paths: ["C:/A", "C:/C"] });
  expect(useProjectGroups.getState().groups).toEqual([
    { id: "cv", name: "CV variants", paths: ["C:/A", "C:/C"] },
  ]);
  expect(useProjectGroups.getState().scope).toBeNull();
});
it("scopes group access to its chosen chat, keeping ordinary chats single-project", async () => {
  vi.mocked(invoke).mockResolvedValue(undefined);
  useDocumentStore.setState({
    projectRoot: "C:/A",
    files: [],
    activeFileId: "",
  });
  const first = useCodexChatStore.getState().createTab();
  useProjectGroups.setState({
    scope: { tabId: first, paths: ["C:/A", "C:/B"] },
  });
  await useCodexChatStore.getState().sendPrompt("Update phone number");
  expect(invoke).toHaveBeenCalledWith(
    "execute_codex_code",
    expect.objectContaining({
      relatedProjects: ["C:/B"],
      prompt: expect.stringContaining("Preserve version-specific content"),
    }),
  );
  vi.mocked(invoke).mockClear();
  useCodexChatStore.getState().createTab();
  await useCodexChatStore.getState().sendPrompt("Edit this one only");
  expect(invoke).toHaveBeenCalledWith(
    "execute_codex_code",
    expect.objectContaining({ relatedProjects: [] }),
  );
  useProjectGroups.setState({ scope: null });
});
