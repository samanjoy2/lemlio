import { create } from "zustand";
import { persist } from "zustand/middleware";
export interface ProjectGroup {
  id: string;
  name: string;
  paths: string[];
  mainPath?: string;
}
interface GroupsState {
  activeGroupId: string | null;
  groups: ProjectGroup[];
  review: { path: string; snapshot: string }[];
  scope: { tabId: string; paths: string[]; mainPath?: string } | null;
  save: (group: ProjectGroup) => void;
  remove: (id: string) => void;
  moveMember: (id: string, from: string, to: string) => void;
  setMain: (id: string, path: string) => void;
  removeMember: (id: string, path: string) => void;
}
export const useProjectGroups = create<GroupsState>()(
  persist(
    (set) => ({
      activeGroupId: null,
      groups: [],
      review: [],
      scope: null,
      save: (group) =>
        set((s) => ({
          groups: [...s.groups.filter((g) => g.id !== group.id), group],
        })),
      moveMember: (id, from, to) =>
        set((s) => ({
          groups: s.groups.map((g) => {
            if (
              g.id !== id ||
              from === to ||
              !g.paths.includes(from) ||
              !g.paths.includes(to)
            )
              return g;
            const paths = [...g.paths];
            paths.splice(paths.indexOf(from), 1);
            paths.splice(g.paths.indexOf(to), 0, from);
            return { ...g, paths };
          }),
        })),
      setMain: (id, path) =>
        set((s) => ({
          groups: s.groups.map((g) =>
            g.id === id && g.paths.includes(path)
              ? { ...g, mainPath: path }
              : g,
          ),
        })),
      removeMember: (id, path) =>
        set((s) => ({
          groups: s.groups.map((g) =>
            g.id === id
              ? {
                  ...g,
                  paths: g.paths.filter((p) => p !== path),
                  mainPath: g.mainPath === path ? undefined : g.mainPath,
                }
              : g,
          ),
        })),
      remove: (id) =>
        set((s) => ({ groups: s.groups.filter((g) => g.id !== id) })),
    }),
    {
      name: "lemlio-project-groups",
      partialize: (s) => ({ groups: s.groups, review: s.review }),
    },
  ),
);

export function groupProjectPaths(group: ProjectGroup): string[] {
  return group.mainPath && group.paths.includes(group.mainPath)
    ? [group.mainPath, ...group.paths.filter((path) => path !== group.mainPath)]
    : group.paths;
}
