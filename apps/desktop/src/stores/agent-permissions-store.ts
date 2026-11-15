import { create } from "zustand";
import { persist } from "zustand/middleware";
import { projectPathKey } from "@/lib/project-catalog";

interface PermissionsState {
  /** Commands the user chose to always allow, per project (keyed by `projectPathKey`). */
  always: Record<string, string[]>;
  add: (projectPath: string, rules: string[]) => void;
  rulesFor: (projectPath: string | null) => string[];
  clear: (projectPath: string) => void;
}

export const useAgentPermissions = create<PermissionsState>()(
  persist(
    (set, get) => ({
      always: {},
      add: (projectPath, rules) =>
        set((state) => {
          const key = projectPathKey(projectPath);
          const merged = [...new Set([...(state.always[key] ?? []), ...rules])];
          return { always: { ...state.always, [key]: merged.slice(-100) } };
        }),
      rulesFor: (projectPath) =>
        projectPath ? (get().always[projectPathKey(projectPath)] ?? []) : [],
      clear: (projectPath) =>
        set((state) => {
          const { [projectPathKey(projectPath)]: _gone, ...rest } =
            state.always;
          return { always: rest };
        }),
    }),
    { name: "lemlio-agent-permissions", version: 1 },
  ),
);
