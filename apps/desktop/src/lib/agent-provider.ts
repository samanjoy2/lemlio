import { useSettingsStore, type AgentProvider } from "@/stores/settings-store";

/** Tauri commands that differ per AI provider. Events are shared. */
const COMMANDS = {
  checkStatus: { codex: "check_codex_status", claude: "check_claude_status" },
  login: { codex: "login_codex", claude: "login_claude" },
  listModels: { codex: "list_codex_models", claude: "list_claude_models" },
  execute: { codex: "execute_codex_code", claude: "execute_claude_code" },
  resume: { codex: "resume_codex_code", claude: "resume_claude_code" },
  cancel: {
    codex: "cancel_codex_execution",
    claude: "cancel_claude_execution",
  },
  listSessions: {
    codex: "list_codex_sessions",
    claude: "list_claude_sessions",
  },
  loadHistory: {
    codex: "load_session_history",
    claude: "load_claude_session_history",
  },
} as const;

export type AgentCommand = keyof typeof COMMANDS;

export const AGENT_LABELS: Record<AgentProvider, string> = {
  codex: "Codex",
  claude: "Claude",
};

/** Cheapest model per provider; used until the user picks another one. */
export const DEFAULT_MODELS: Record<AgentProvider, string> = {
  codex: "gpt-6-luna",
  claude: "haiku",
};

export function currentProvider(): AgentProvider {
  return useSettingsStore.getState().agentProvider;
}

export function agentCommand(
  name: AgentCommand,
  provider: AgentProvider = currentProvider(),
): string {
  return COMMANDS[name][provider];
}
