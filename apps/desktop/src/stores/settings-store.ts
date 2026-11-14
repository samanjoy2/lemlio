import { create } from "zustand";
import { persist } from "zustand/middleware";

type CompilerBackend = "tectonic" | "texlive";
export type AgentProvider = "codex" | "claude";
export type AccentName =
  | "blue"
  | "purple"
  | "pink"
  | "red"
  | "orange"
  | "green"
  | "teal"
  | "graphite";
export type EditorThemeName = "xcode" | "github" | "solarized" | "dracula";

interface SettingsState {
  accent: AccentName;
  setAccent: (accent: AccentName) => void;
  editorTheme: EditorThemeName;
  setEditorTheme: (theme: EditorThemeName) => void;
  editorFontSize: number;
  setEditorFontSize: (size: number) => void;
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
      accent: "blue",
      setAccent: (accent) => set({ accent }),
      editorTheme: "xcode",
      setEditorTheme: (editorTheme) => set({ editorTheme }),
      editorFontSize: 14,
      setEditorFontSize: (size) =>
        set({ editorFontSize: Math.min(22, Math.max(11, Math.round(size))) }),
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
