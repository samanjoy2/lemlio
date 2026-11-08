import { it, expect, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { runGroupEdit, finalizeGroupEdit } from "@/lib/project-group-actions";
import { useProjectGroups } from "@/stores/project-groups-store";
import { useDocumentStore } from "@/stores/document-store";
import { useCodexChatStore } from "@/stores/codex-chat-store";
import {
  activeCollaboration,
  reconcileCollaborationSource,
  activateCollaboration,
} from "@/lib/collaboration/runtime";
vi.mock("@/lib/collaboration/runtime", () => ({
  activeCollaboration: vi.fn(),
  reconcileCollaborationSource: vi.fn(async () => {}),
  activateCollaboration: vi.fn(async () => {}),
  useCollaborationStore: { getState: () => ({ connected: true }) },
}));
it("pauses the live replica, prepares shared histories, and starts one scoped group turn", async () => {
  const disconnect = vi.fn(async () => {});
  vi.mocked(activeCollaboration).mockReturnValue({
    path: "C:/A",
    disconnect,
  } as any);
  const original = useCodexChatStore.getState().sendPrompt;
  const send = vi.fn(async () => {});
  useCodexChatStore.setState({ tabs: [], sendPrompt: send });
  useDocumentStore.setState({
    projectRoot: "C:/A",
    files: [],
    isCompiling: false,
    saveAllFiles: async () => {},
  });
  vi.mocked(invoke).mockImplementation(async (cmd) =>
    cmd === "history_list" ? [{ id: "before" }] : undefined,
  );
  try {
    await runGroupEdit(
      ["C:/A", "C:/B"],
      "Update contact",
      undefined,
      undefined,
      "C:/A",
    );
    expect(disconnect).toHaveBeenCalledOnce();
    expect(reconcileCollaborationSource).toHaveBeenCalledWith("C:/B");
    expect(activateCollaboration).toHaveBeenCalledWith("C:/A");
    expect(send).toHaveBeenCalled();
    const scope = useProjectGroups.getState().scope!;
    expect(scope.paths).toEqual(["C:/A", "C:/B"]);
    expect(scope.mainPath).toBe("C:/A");
    vi.mocked(reconcileCollaborationSource).mockClear();
    await finalizeGroupEdit(scope.tabId);
    expect(reconcileCollaborationSource).toHaveBeenCalledTimes(2);
  } finally {
    useCodexChatStore.setState({ sendPrompt: original });
  }
});
it("attempts every project's final history even when one cannot be saved", async () => {
  useProjectGroups.setState({
    scope: { tabId: "group", paths: ["C:/A", "C:/B"] },
  });
  vi.mocked(reconcileCollaborationSource).mockClear();
  vi.mocked(reconcileCollaborationSource).mockRejectedValueOnce(
    Error("Disk full"),
  );
  await expect(finalizeGroupEdit("group")).rejects.toThrow("Disk full");
  expect(reconcileCollaborationSource).toHaveBeenCalledWith("C:/B");
});
