import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { AgentStopButton } from "@/components/codex-chat/agent-stop-button";
import { useCodexChatStore } from "@/stores/codex-chat-store";
it("stops the active agent without cancelling another chat", async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.mocked(invoke).mockResolvedValue(undefined);
  const first = useCodexChatStore.getState().createTab();
  const second = useCodexChatStore.getState().createTab();
  useCodexChatStore.getState()._setStreaming(first, true);
  useCodexChatStore.getState()._setStreaming(second, true);
  useCodexChatStore.getState().setActiveTab(first);
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<AgentStopButton />));
  expect(container.textContent).toBe("Stop agent");
  await act(async () => container.querySelector("button")?.click());
  expect(invoke).toHaveBeenCalledWith("cancel_codex_execution", {
    tabId: first,
  });
  expect(
    useCodexChatStore.getState().tabs.find((t) => t.id === second)?.cancelled,
  ).toBeFalsy();
  await act(async () => {
    useCodexChatStore.getState()._setStreaming(first, false);
  });
  expect(container.querySelector("button")).toBeNull();
  await act(async () => root.unmount());
  useCodexChatStore.getState().closeTab(first);
  useCodexChatStore.getState().closeTab(second);
});
