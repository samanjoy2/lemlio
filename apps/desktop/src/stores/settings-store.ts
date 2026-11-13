import { create } from "zustand";
import { persist } from "zustand/middleware";

type CompilerBackend = "tectonic" | "texlive";
export type AgentProvider = "codex" | "claude";

interface SettingsState {
  agentProvider: AgentProvider;
  setAgentProvider: (provider: AgentProvider) => void;
  compilerBackend: CompilerBackend;
  autoCompile: boolean;
  autoDriveBackup: boolean;
  skipCloseWhenBackedUp: boolean;
  setSkipCloseWhenBackedUp: (value: boolean) => void;
  setAutoDriveBackup: (value: boolean) => void;
  setAutoCompile: (value: boolean) => void;
  setCompilerBackend: (backend: CompilerBackend) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      agentProvider: "codex",
      setAgentProvider: (agentProvider) => set({ agentProvider }),
      autoCompile: true,
      autoDriveBackup: true,
      skipCloseWhenBackedUp: false,
      setSkipCloseWhenBackedUp: (skipCloseWhenBackedUp) =>
        set({ skipCloseWhenBackedUp }),
      setAutoDriveBackup: (autoDriveBackup) => set({ autoDriveBackup }),
      setAutoCompile: (autoCompile) => set({ autoCompile }),
      compilerBackend: "tectonic",
      setCompilerBackend: (backend) => set({ compilerBackend: backend }),
    }),
    {
      name: "lemlio-settings",
      version: 1,
      migrate: () => ({ compilerBackend: "tectonic" as const }),
    },
  ),
);
