import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-shell";
import { agentCommand, currentProvider } from "@/lib/agent-provider";
import { useSettingsStore } from "./settings-store";

interface CodexStatus {
  installed: boolean;
  authenticated: boolean;
  version: string | null;
  account_email: string | null;
}
interface CodexSetupState {
  status:
    | "checking"
    | "not-installed"
    | "not-authenticated"
    | "ready"
    | "error";
  isLoggingIn: boolean;
  error: string | null;
  version: string | null;
  accountEmail: string | null;
  checkStatus: () => Promise<void>;
  login: () => Promise<void>;
  finishLogin: (success: boolean) => void;
}
export const useCodexSetupStore = create<CodexSetupState>((set, get) => ({
  status: "checking",
  isLoggingIn: false,
  error: null,
  version: null,
  accountEmail: null,
  checkStatus: async () => {
    set({ status: "checking", error: null });
    try {
      const result = await invoke<CodexStatus>(agentCommand("checkStatus"));
      set({
        status: !result.installed
          ? "not-installed"
          : result.authenticated
            ? "ready"
            : "not-authenticated",
        version: result.version,
        accountEmail: result.account_email,
      });
    } catch (error) {
      set({ status: "error", error: String(error) });
    }
  },
  login: async () => {
    set({ isLoggingIn: true, error: null });
    try {
      const url = await invoke<string>(agentCommand("login"));
      // Claude Code opens the sign-in page in the browser itself.
      if (currentProvider() === "codex") await open(url);
    } catch (error) {
      set({ isLoggingIn: false, error: String(error) });
    }
  },
  finishLogin: (success) => {
    set({
      isLoggingIn: false,
      error: success
        ? null
        : currentProvider() === "claude"
          ? "Sign-in failed. Run claude auth login in a terminal, then refresh."
          : "Sign-in failed. Run codex login in a terminal, then refresh.",
    });
    if (success) void get().checkStatus();
  },
}));

// The connection status belongs to one provider; re-check when it changes.
useSettingsStore.subscribe((state, prev) => {
  if (state.agentProvider !== prev.agentProvider)
    void useCodexSetupStore.getState().checkStatus();
});
