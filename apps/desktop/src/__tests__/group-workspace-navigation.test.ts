import { useProjectGroups } from "@/stores/project-groups-store";
import { expect, it, vi } from "vitest";
import {
  switchGroupProject,
  stopGroupAgent,
} from "@/lib/project-group-actions";
import { useDocumentStore } from "@/stores/document-store";
import { useCodexChatStore } from "@/stores/codex-chat-store";
it("saves the current version before opening the next tab", async () => {
  const steps: string[] = [];
  useCodexChatStore.setState({ tabs: [] });
  useDocumentStore.setState({
    projectRoot: "C:/A",
    files: [],
    isCompiling: false,
    saveAllFiles: async () => {
      steps.push("saved");
    },
    openProject: async (path) => {
      steps.push(path);
    },
  });
  await switchGroupProject("C:/B");
  expect(steps).toEqual(["saved", "C:/B"]);
});
it("keeps the current version open when edits cannot save", async () => {
  const open = vi.fn();
  useDocumentStore.setState({
    projectRoot: "C:/A",
    isCompiling: false,
    files: [{ id: "main.tex", isDirty: true }] as any,
    saveAllFiles: async () => {},
    openProject: open,
  });
  await expect(switchGroupProject("C:/B")).rejects.toThrow(
    "could not be saved",
  );
  expect(open).not.toHaveBeenCalled();
});
it("blocks switching versions while compiling", async () => {
  useDocumentStore.setState({ isCompiling: true });
  await expect(switchGroupProject("C:/B")).rejects.toThrow(
    "compiler or stop the agent",
  );
});

it("stops the group agent even when a different chat is selected", async () => {
  const chat = useCodexChatStore.getState();
  const first = chat.createTab();
  const second = useCodexChatStore.getState().createTab();
  useCodexChatStore.getState()._setStreaming(first, true);
  const original = useCodexChatStore.getState().cancelExecution;
  const cancel = vi.fn(async () => {});
  useCodexChatStore.setState({ cancelExecution: cancel });
  useProjectGroups.setState({
    scope: { tabId: first, paths: ["C:/A", "C:/B"] },
  });
  try {
    await stopGroupAgent();
    expect(useCodexChatStore.getState().activeTabId).toBe(first);
    expect(cancel).toHaveBeenCalledOnce();
  } finally {
    useCodexChatStore.setState({ cancelExecution: original });
    useCodexChatStore.getState().closeTab(first);
    useCodexChatStore.getState().closeTab(second);
  }
});
