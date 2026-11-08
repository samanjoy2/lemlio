import { create } from "zustand";
import { persist } from "zustand/middleware";
export interface ProjectGroup {
  id: string;
  name: string;
  paths: string[];
}
interface GroupsState {
  activeGroupId: string | null;
  groups: ProjectGroup[];
  review: { path: string; snapshot: string }[];
  scope: { tabId: string; paths: string[] } | null;
  save: (group: ProjectGroup) => void;
  remove: (id: string) => void;
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
      remove: (id) =>
        set((s) => ({ groups: s.groups.filter((g) => g.id !== id) })),
    }),
    {
      name: "lemlio-project-groups",
      partialize: (s) => ({ groups: s.groups, review: s.review }),
    },
  ),
);
