import { describe, expect, it, vi } from "vitest";

vi.mock("@/stores/document-store", () => ({
  hasPdfData: () => false,
  useDocumentStore: { getState: vi.fn(() => ({})) },
}));
vi.mock("@/stores/history-store", () => ({
  useHistoryStore: { getState: vi.fn(() => ({ createSnapshot: vi.fn() })) },
}));

import { useCodexChatStore } from "@/stores/codex-chat-store";
import { useSettingsStore } from "@/stores/settings-store";

describe("switching the AI assistant", () => {
  it("forgets session ids, which only the assistant that made them can resume", () => {
    useSettingsStore.setState({ agentProvider: "codex" });
    const tab = useCodexChatStore.getState().tabs[0];
    useCodexChatStore.setState({
      sessionId: "codex-thread-1",
      tabs: [{ ...tab, sessionId: "codex-thread-1" }],
    });

    useSettingsStore.setState({ agentProvider: "claude" });

    const state = useCodexChatStore.getState();
    expect(state.sessionId).toBeNull();
    expect(state.tabs.every((t) => t.sessionId === null)).toBe(true);
    useSettingsStore.setState({ agentProvider: "codex" });
  });
});
