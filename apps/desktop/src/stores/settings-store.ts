import { create } from "zustand";
import { persist } from "zustand/middleware";

type CompilerBackend = "tectonic" | "texlive";

interface SettingsState {
  compilerBackend: CompilerBackend;
  autoCompile: boolean;
  autoDriveBackup: boolean;
  setAutoDriveBackup: (value: boolean) => void;
  setAutoCompile: (value: boolean) => void;
  setCompilerBackend: (backend: CompilerBackend) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      autoCompile: true,
      autoDriveBackup: true,
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
