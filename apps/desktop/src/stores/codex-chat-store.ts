import { useProjectGroups } from "./project-groups-store";
import { useCollaborationStore } from "@/lib/collaboration/runtime";
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useDocumentStore, hasPdfData } from "./document-store";
import { buildProjectContext, getPreviewPage } from "@/lib/agent-context";
import { useHistoryStore } from "./history-store";
import { useSettingsStore } from "./settings-store";
import {
  agentCommand,
  DEFAULT_MODELS,
  currentProvider,
} from "@/lib/agent-provider";
import { createLogger } from "@/lib/debug/logger";

const log = createLogger("codex");

/** Convert a character offset to 1-based line:col */
export function offsetToLineCol(
  content: string,
  offset: number,
): { line: number; col: number } {
  const before = content.slice(0, offset);
  const lines = before.split("\n");
  return { line: lines.length, col: lines[lines.length - 1].length + 1 };
}

// ─── Types ───

export interface ContentBlock {
  type: "text" | "tool_use" | "tool_result" | "thinking";
  // text block
  text?: string;
  // tool_use block
  id?: string;
  name?: string;
  input?: any;
  // tool_result block
  tool_use_id?: string;
  content?: any;
  is_error?: boolean;
  // thinking block
  thinking?: string;
  signature?: string;
}

export interface CodexStreamMessage {
  id?: string;
  type: "system" | "assistant" | "user" | "result";
  subtype?: string;
  session_id?: string;
  model?: string;
  cwd?: string;
  tools?: string[];
  message?: {
    content?: ContentBlock[];
    usage?: { input_tokens: number; output_tokens: number };
  };
  usage?: { input_tokens: number; output_tokens: number };
  cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  result?: string;
  is_error?: boolean;
  num_turns?: number;
}

// ─── Tab Types ───

export interface TabDraft {
  input: string;
  pinnedContexts: {
    label: string;
    filePath: string;
    selectedText: string;
    imageDataUrl?: string;
  }[];
}

export interface TabState {
  cancelled?: boolean;
  id: string;
  title: string;
  sessionId: string | null;
  messages: CodexStreamMessage[];
  isStreaming: boolean;
  error: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  draft: TabDraft;
}

/** Fields that are projected from the active tab to top-level state */
const TAB_FIELDS = [
  "sessionId",
  "messages",
  "isStreaming",
  "error",
  "totalInputTokens",
  "totalOutputTokens",
] as const;

function makeDefaultTab(id: string): TabState {
  return {
    id,
    title: "New Chat",
    sessionId: null,
    messages: [],
    isStreaming: false,
    error: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    draft: { input: "", pinnedContexts: [] },
  };
}

let tabCounter = 0;
function nextTabId(): string {
  return `tab-${++tabCounter}`;
}

/**
 * Update a specific tab in `tabs[]` and, if that tab is the active tab,
 * also project the changed fields to top-level state for consumer compatibility.
 */
function applyTabUpdate(
  state: CodexChatState,
  tabId: string,
  updates: Partial<TabState>,
): Partial<CodexChatState> {
  const newTabs = state.tabs.map((t) =>
    t.id === tabId ? { ...t, ...updates } : t,
  );
  const result: Partial<CodexChatState> = { tabs: newTabs };
  if (tabId === state.activeTabId) {
    for (const key of TAB_FIELDS) {
      if (key in updates) {
        (result as any)[key] = (updates as any)[key];
      }
    }
  }
  return result;
}

// ─── State Interface ───

const DEFAULT_TAB_ID = nextTabId();

interface CodexChatState {
  // ── Projected fields (from active tab — read by consumers) ──
  messages: CodexStreamMessage[];
  sessionId: string | null;
  isStreaming: boolean;
  error: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;

  // ── Tab state ──
  tabs: TabState[];
  activeTabId: string;

  /** Deferred prompt to send once the workspace is ready (set by project wizard) */
  pendingInitialPrompt: string | null;
  setPendingInitialPrompt: (prompt: string | null) => void;
  consumePendingInitialPrompt: () => string | null;

  /** Pending attachments from external sources (e.g. PDF capture) */
  pendingAttachments: {
    label: string;
    filePath: string;
    selectedText: string;
    imageDataUrl?: string;
  }[];
  addPendingAttachment: (attachment: {
    label: string;
    filePath: string;
    selectedText: string;
    imageDataUrl?: string;
  }) => void;
  consumePendingAttachments: () => {
    label: string;
    filePath: string;
    selectedText: string;
    imageDataUrl?: string;
  }[];

  /** Currently selected model (passed per-prompt to Codex CLI) */
  selectedModel: string;
  setSelectedModel: (model: string) => void;

  /** Empty values preserve the user's Codex configuration. */
  effortLevel: string;
  setEffortLevel: (level: string) => void;

  // Actions
  sendPrompt: (
    userPrompt: string,
    contextOverride?: {
      label: string;
      filePath: string;
      selectedText: string;
      /** User-attached screenshots as PNG/JPEG data URLs. */
      images?: string[];
    },
  ) => Promise<void>;
  cancelExecution: () => Promise<void>;
  clearMessages: () => void;
  newSession: () => void;
  resumeSession: (sessionId: string) => Promise<void>;

  // Tab actions
  createTab: () => string;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  saveDraft: (tabId: string, draft: TabDraft) => void;

  /** True when any tab is streaming */
  anyStreaming: () => boolean;

  // Internal actions (called by event hook, routed by tabId)
  _appendMessage: (tabId: string, msg: CodexStreamMessage) => void;
  _setSessionId: (tabId: string, id: string) => void;
  _setStreaming: (tabId: string, streaming: boolean) => void;
  _setError: (tabId: string, error: string | null) => void;
  _cancelledByUser: boolean;
}

// ─── Store ───

// Codex keeps the legacy key; other providers get a suffix.
function modelKey(provider: string) {
  return provider === "codex" ? "lemlio-model" : `lemlio-model-${provider}`;
}
function savedModel(provider: "codex" | "claude") {
  return localStorage.getItem(modelKey(provider)) || DEFAULT_MODELS[provider];
}

export const useCodexChatStore = create<CodexChatState>()((set, get) => ({
  // Projected fields (initialized from default tab)
  messages: [],
  sessionId: null,
  isStreaming: false,
  error: null,
  _cancelledByUser: false,
  totalInputTokens: 0,
  totalOutputTokens: 0,

  // Tab state
  tabs: [makeDefaultTab(DEFAULT_TAB_ID)],
  activeTabId: DEFAULT_TAB_ID,

  selectedModel: savedModel(currentProvider()),
  setSelectedModel: (model) => {
    localStorage.setItem(modelKey(currentProvider()), model);
    set({ selectedModel: model });
  },

  effortLevel: "",
  setEffortLevel: (level) => set({ effortLevel: level }),

  pendingInitialPrompt: null,
  setPendingInitialPrompt: (prompt) => set({ pendingInitialPrompt: prompt }),
  consumePendingInitialPrompt: () => {
    const { pendingInitialPrompt } = get();
    if (pendingInitialPrompt) {
      set({ pendingInitialPrompt: null });
    }
    return pendingInitialPrompt;
  },

  pendingAttachments: [],
  addPendingAttachment: (attachment) => {
    set((state) => ({
      pendingAttachments: [...state.pendingAttachments, attachment],
    }));
  },
  consumePendingAttachments: () => {
    const { pendingAttachments } = get();
    if (pendingAttachments.length > 0) {
      set({ pendingAttachments: [] });
    }
    return pendingAttachments;
  },

  anyStreaming: () => get().tabs.some((t) => t.isStreaming),

  sendPrompt: async (
    userPrompt: string,
    contextOverride?: {
      label: string;
      filePath: string;
      selectedText: string;
      /** User-attached screenshots as PNG/JPEG data URLs. */
      images?: string[];
    },
  ) => {
    const state = get();
    const { activeTabId } = state;
    if (
      useCollaborationStore.getState().connected ||
      useCollaborationStore.getState().connecting
    ) {
      set((s) =>
        applyTabUpdate(s, activeTabId, {
          error:
            "Choose Work offline in Collaboration before running an agent. Reconnect afterward to merge its edits with your collaborators.",
        }),
      );
      return;
    }
    const activeTab = state.tabs.find((t) => t.id === activeTabId);
    // Guard: prevent sending from a tab that's already streaming
    if (activeTab?.isStreaming) return;

    const { sessionId, selectedModel, effortLevel } = state;

    const sendStart = performance.now();
    log.info("sendPrompt start", {
      sessionId: !!sessionId,
      hasContext: !!contextOverride,
      tab: activeTabId,
    });

    const docState = useDocumentStore.getState();
    const projectPath = docState.projectRoot;
    if (!projectPath) {
      set((s) => applyTabUpdate(s, activeTabId, { error: "No project open" }));
      return;
    }

    const groupScope = useProjectGroups.getState().scope;
    const relatedProjects =
      groupScope?.tabId === activeTabId && groupScope.paths[0] === projectPath
        ? groupScope.paths.slice(1)
        : [];
    // Compute context label for display in chat history
    const activeFile = docState.files.find(
      (f) => f.id === docState.activeFileId,
    );
    let contextLabel: string | null = null;

    if (contextOverride) {
      contextLabel = contextOverride.label;
    } else if (activeFile) {
      const selRange = docState.selectionRange;
      if (selRange && activeFile.content) {
        const content = activeFile.content;
        const startLC = offsetToLineCol(content, selRange.start);
        const endLC = offsetToLineCol(content, selRange.end);
        contextLabel = `@${activeFile.relativePath}:${startLC.line}:${startLC.col}-${endLC.line}:${endLC.col}`;
      }
    }

    // Add user message to the list for display (with context label visible)
    const displayText = contextLabel
      ? `${contextLabel}\n${userPrompt}`
      : userPrompt;
    const userMessage: CodexStreamMessage = {
      type: "user",
      message: {
        content: [{ type: "text", text: displayText }],
      },
    };

    // Auto-set tab title from first prompt
    const isFirstMessage = activeTab && activeTab.messages.length === 0;
    const tabTitle = isFirstMessage
      ? userPrompt.slice(0, 40) + (userPrompt.length > 40 ? "..." : "")
      : undefined;

    set((s) => {
      const tabUpdates: Partial<TabState> = {
        messages: [
          ...(s.tabs.find((t) => t.id === activeTabId)?.messages ?? []),
          userMessage,
        ],
        isStreaming: true,
        cancelled: false,
        error: null,
      };
      if (tabTitle) tabUpdates.title = tabTitle;
      return {
        ...applyTabUpdate(s, activeTabId, tabUpdates),
        _cancelledByUser: false,
      };
    });

    // Flush unsaved edits to disk so Codex reads the latest content
    if (docState.files.some((f) => f.isDirty)) {
      log.debug("saving dirty files...");
      await docState.saveAllFiles();
      log.debug("saveAllFiles done");
    }

    // Snapshot before Codex edit
    if (projectPath) {
      try {
        log.debug("creating snapshot...");
        await useHistoryStore
          .getState()
          .createSnapshot(projectPath, "[codex] Before Codex edit");
        log.debug("snapshot done");
      } catch {
        /* snapshot failure should not block Codex */
      }
    }

    // Build prompt with full context for Codex
    let prompt = userPrompt;
    if (activeFile) {
      const selRange = docState.selectionRange;
      const selectedText =
        selRange && activeFile.content
          ? activeFile.content.slice(selRange.start, selRange.end)
          : null;
      let ctx = `[Currently open file: ${activeFile.relativePath}]`;
      if (contextOverride) {
        ctx += `\n[Selection: ${contextOverride.label}]`;
        ctx += `\n[Selected text:\n${contextOverride.selectedText}\n]`;
      } else if (selectedText && selRange) {
        const content = activeFile.content ?? "";
        const startLC = offsetToLineCol(content, selRange.start);
        const endLC = offsetToLineCol(content, selRange.end);
        ctx += `\n[Selection: @${activeFile.relativePath}:${startLC.line}:${startLC.col}-${endLC.line}:${endLC.col}]`;
        ctx += `\n[Selected text:\n${selectedText}\n]`;
      }
      const extra = buildProjectContext({
        files: (docState.files ?? []).map((f) => f.relativePath),
        compileError: docState.compileError,
        pdfPage: hasPdfData() ? getPreviewPage() : null,
      });
      prompt = `${ctx}${extra ? `\n${extra}` : ""}\n\n${userPrompt}`;
    }
    const images = contextOverride?.images?.length
      ? contextOverride.images
      : undefined;
    if (relatedProjects.length)
      prompt = `Manually selected project group. ${groupScope?.mainPath ? `The main/reference version is ${JSON.stringify(groupScope.mainPath)}. Use it as the reference for common content while preserving intentional variant differences. ` : ""}Work only on the requested common change in these project directories: ${JSON.stringify([projectPath, ...relatedProjects])}. Read each version first. Preserve version-specific content, formatting, and emphasis; do not make all versions identical. Check each affected project separately. Integrated compiler tools target only the open project; use the provided Lemlio terminal fallback for other projects. Summarize changes per project and any skipped items.\n\n${prompt}`;
    log.info("invoking CLI", {
      promptLength: prompt.length,
      mode: sessionId ? "resume" : "new",
      images: images?.length ?? 0,
    });

    try {
      if (sessionId) {
        // Resume existing session
        await invoke(agentCommand("resume"), {
          projectPath,
          relatedProjects,
          images,
          sessionId,
          prompt,
          tabId: activeTabId,
          model: selectedModel,
          effortLevel,
          mainFile: useDocumentStore.getState().mainFileId || null,
          useTexlive: useSettingsStore.getState().compilerBackend === "texlive",
        });
      } else {
        // New session
        await invoke(agentCommand("execute"), {
          projectPath,
          relatedProjects,
          images,
          prompt,
          tabId: activeTabId,
          model: selectedModel,
          effortLevel,
          mainFile: useDocumentStore.getState().mainFileId || null,
          useTexlive: useSettingsStore.getState().compilerBackend === "texlive",
        });
      }
      log.info(
        `sendPrompt complete in ${(performance.now() - sendStart).toFixed(0)}ms`,
      );
    } catch (err: any) {
      log.error(
        `sendPrompt failed after ${(performance.now() - sendStart).toFixed(0)}ms`,
        { error: String(err) },
      );
      set((s) =>
        applyTabUpdate(s, activeTabId, {
          isStreaming: false,
          error: get().tabs.find((tab) => tab.id === activeTabId)?.cancelled
            ? null
            : err?.message || String(err),
        }),
      );
    }
  },

  cancelExecution: async () => {
    const { activeTabId } = get();
    set({ _cancelledByUser: true });
    set((s) => applyTabUpdate(s, activeTabId, { cancelled: true }));
    try {
      await invoke(agentCommand("cancel"), { tabId: activeTabId });
    } catch (error) {
      set((s) =>
        applyTabUpdate(s, activeTabId, {
          isStreaming: false,
          error: String(error),
        }),
      );
    }
  },

  clearMessages: () => {
    const { activeTabId } = get();
    set((s) =>
      applyTabUpdate(s, activeTabId, {
        messages: [],
        error: null,
        totalInputTokens: 0,
        totalOutputTokens: 0,
      }),
    );
  },

  newSession: () => {
    log.info("Starting new session");
    const { activeTabId } = get();
    set((s) =>
      applyTabUpdate(s, activeTabId, {
        messages: [],
        sessionId: null,
        error: null,
        isStreaming: false,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        title: "New Chat",
      }),
    );
  },

  resumeSession: async (sessionId: string) => {
    log.info(`Resuming session: ${sessionId.slice(0, 8)}`);
    const { activeTabId } = get();
    const projectPath = useDocumentStore.getState().projectRoot;

    // Reset state with new session ID
    set((s) =>
      applyTabUpdate(s, activeTabId, {
        messages: [],
        sessionId,
        error: null,
        isStreaming: false,
        totalInputTokens: 0,
        totalOutputTokens: 0,
      }),
    );

    // Load session history from JSONL file
    if (projectPath) {
      try {
        const history = await invoke<any[]>(agentCommand("loadHistory"), {
          projectPath,
          sessionId,
        });

        // Filter to displayable message types and map to CodexStreamMessage
        const messages: CodexStreamMessage[] = [];
        for (const entry of history) {
          const type = entry.type;
          if (type === "user" || type === "assistant" || type === "result") {
            messages.push(entry as CodexStreamMessage);
          }
        }

        set((s) => applyTabUpdate(s, activeTabId, { messages }));
      } catch (err) {
        log.error("Failed to load session history", { error: String(err) });
      }
    }
  },

  // ─── Tab Actions ───

  createTab: () => {
    log.debug("Creating new tab");
    const id = nextTabId();
    const newTab = makeDefaultTab(id);
    set((s) => ({
      tabs: [...s.tabs, newTab],
      activeTabId: id,
      // Project new tab fields to top-level
      messages: newTab.messages,
      sessionId: newTab.sessionId,
      isStreaming: newTab.isStreaming,
      error: newTab.error,
      totalInputTokens: newTab.totalInputTokens,
      totalOutputTokens: newTab.totalOutputTokens,
    }));
    return id;
  },

  closeTab: (tabId: string) => {
    const state = get();
    const tab = state.tabs.find((t) => t.id === tabId);
    // Prevent closing a streaming tab
    if (tab?.isStreaming) return;
    // Prevent closing the last tab
    if (state.tabs.length <= 1) return;

    const idx = state.tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return;

    const newTabs = state.tabs.filter((t) => t.id !== tabId);

    if (tabId === state.activeTabId) {
      // Switch to adjacent tab
      const newIdx = Math.min(idx, newTabs.length - 1);
      const newActive = newTabs[newIdx];
      set({
        tabs: newTabs,
        activeTabId: newActive.id,
        // Project new active tab
        messages: newActive.messages,
        sessionId: newActive.sessionId,
        isStreaming: newActive.isStreaming,
        error: newActive.error,
        totalInputTokens: newActive.totalInputTokens,
        totalOutputTokens: newActive.totalOutputTokens,
      });
    } else {
      set({ tabs: newTabs });
    }
  },

  setActiveTab: (tabId: string) => {
    const state = get();
    if (tabId === state.activeTabId) return;
    const targetTab = state.tabs.find((t) => t.id === tabId);
    if (!targetTab) return;

    // Project the target tab's fields to top-level
    set({
      activeTabId: tabId,
      messages: targetTab.messages,
      sessionId: targetTab.sessionId,
      isStreaming: targetTab.isStreaming,
      error: targetTab.error,
      totalInputTokens: targetTab.totalInputTokens,
      totalOutputTokens: targetTab.totalOutputTokens,
    });
  },

  saveDraft: (tabId: string, draft: TabDraft) => {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, draft } : t)),
    }));
  },

  // ─── Internal Actions (routed by explicit tabId) ───

  _appendMessage: (tabId: string, msg: CodexStreamMessage) => {
    set((state) => {
      let inputDelta = 0;
      let outputDelta = 0;
      const usage = msg.usage || msg.message?.usage;
      if (usage) {
        inputDelta = usage.input_tokens || 0;
        outputDelta = usage.output_tokens || 0;
      }

      const tab = state.tabs.find((t) => t.id === tabId);
      if (!tab) return {};

      return applyTabUpdate(state, tabId, {
        messages:
          msg.id && tab.messages.some((entry) => entry.id === msg.id)
            ? tab.messages.map((entry) => (entry.id === msg.id ? msg : entry))
            : [...tab.messages, msg],
        totalInputTokens: tab.totalInputTokens + inputDelta,
        totalOutputTokens: tab.totalOutputTokens + outputDelta,
      });
    });
  },

  _setSessionId: (tabId: string, id: string) => {
    set((state) => applyTabUpdate(state, tabId, { sessionId: id }));
  },

  _setStreaming: (tabId: string, streaming: boolean) => {
    set((state) => applyTabUpdate(state, tabId, { isStreaming: streaming }));
  },

  _setError: (tabId: string, error: string | null) => {
    set((state) => applyTabUpdate(state, tabId, { error }));
  },
}));

// Each provider keeps its own model choice; switching provider swaps it in.
useSettingsStore.subscribe((state, prev) => {
  if (state.agentProvider === prev.agentProvider) return;
  useCodexChatStore.setState({
    selectedModel: savedModel(state.agentProvider),
    effortLevel: "",
  });
});
