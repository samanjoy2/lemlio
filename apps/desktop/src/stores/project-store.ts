import { create } from "zustand";
import { persist } from "zustand/middleware";
import { projectPathKey, type ProjectRecord } from "@/lib/project-catalog";

type RecentProject = ProjectRecord;

interface ProjectState {
  recentProjects: RecentProject[];
  knownProjects: RecentProject[];
  starredPaths: string[];
  toggleStarred: (path: string) => void;
  /** Projects tucked away from the normal lists. Nothing is deleted or stopped. */
  archivedPaths: string[];
  toggleArchived: (path: string) => void;
  lastProjectFolder: string | null;
  addRecentProject: (path: string) => void;
  removeRecentProject: (path: string) => void;
  forgetProject: (path: string) => void;
  setLastProjectFolder: (path: string) => void;
}

const MAX_RECENT = 10;

export const useProjectStore = create<ProjectState>()(
  persist(
    (set) => ({
      recentProjects: [],
      knownProjects: [],
      starredPaths: [],
      archivedPaths: [],
      lastProjectFolder: null,

      setLastProjectFolder: (path) => set({ lastProjectFolder: path }),
      toggleArchived: (path) =>
        set((state) => {
          const key = projectPathKey(path);
          return {
            archivedPaths: state.archivedPaths.includes(key)
              ? state.archivedPaths.filter((item) => item !== key)
              : [...state.archivedPaths, key],
          };
        }),
      toggleStarred: (path) =>
        set((state) => {
          const key = projectPathKey(path);
          return {
            starredPaths: state.starredPaths.includes(key)
              ? state.starredPaths.filter((item) => item !== key)
              : [...state.starredPaths, key],
          };
        }),

      addRecentProject: (path) => {
        const name = path.split(/[/\\]/).pop() || path;
        set((state) => {
          const key = projectPathKey(path);
          const filtered = state.recentProjects.filter(
            (p) => projectPathKey(p.path) !== key,
          );
          const lastOpened = Math.max(
            Date.now(),
            ...state.recentProjects.map((p) => p.lastOpened + 1),
          );
          const project = { path, name, lastOpened };
          return {
            knownProjects: [
              project,
              ...state.knownProjects.filter(
                (p) => projectPathKey(p.path) !== key,
              ),
            ],
            recentProjects: [project, ...filtered].slice(0, MAX_RECENT),
          };
        });
      },

      removeRecentProject: (path) => {
        set((state) => ({
          recentProjects: state.recentProjects.filter(
            (p) => projectPathKey(p.path) !== projectPathKey(path),
          ),
        }));
      },
      forgetProject: (path) =>
        set((state) => {
          const key = projectPathKey(path);
          return {
            knownProjects: state.knownProjects.filter(
              (p) => projectPathKey(p.path) !== key,
            ),
            recentProjects: state.recentProjects.filter(
              (p) => projectPathKey(p.path) !== key,
            ),
            starredPaths: state.starredPaths.filter((p) => p !== key),
            archivedPaths: state.archivedPaths.filter((p) => p !== key),
            lastProjectFolder:
              state.lastProjectFolder &&
              projectPathKey(state.lastProjectFolder) === key
                ? null
                : state.lastProjectFolder,
          };
        }),
    }),
    {
      name: "prismpro-projects",
      version: 1,
      migrate: (value) => {
        const state = value as Partial<ProjectState>;
        return {
          recentProjects: state.recentProjects ?? [],
          knownProjects: state.knownProjects ?? state.recentProjects ?? [],
          starredPaths: state.starredPaths ?? [],
          archivedPaths: state.archivedPaths ?? [],
          lastProjectFolder: state.lastProjectFolder ?? null,
        };
      },
    },
  ),
);
