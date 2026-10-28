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
      compilerBackend: "texlive",
      setCompilerBackend: (backend) => set({ compilerBackend: backend }),
    }),
    {
      name: "prismpro-settings",
      version: 1,
      // Switch existing installations to the user's requested system compiler.
      // Later explicit choices, including Tectonic, remain persisted at version 1.
      migrate: () => ({ compilerBackend: "texlive" as const }),
    },
  ),
);
