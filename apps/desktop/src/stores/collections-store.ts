import { create } from "zustand";
import { persist } from "zustand/middleware";
import { projectPathKey } from "@/lib/project-catalog";

export interface Collection {
  id: string;
  name: string;
}

export const MAX_COLLECTION_NAME = 40;

/** A trimmed name, or an explanation of why it cannot be used. */
export function validateCollectionName(
  name: string,
  collections: Collection[],
  ignoreId?: string,
): { name: string } | { error: string } {
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (!trimmed) return { error: "Enter a name for the collection." };
  if (trimmed.length > MAX_COLLECTION_NAME)
    return {
      error: `Use ${MAX_COLLECTION_NAME} characters or fewer.`,
    };
  const taken = collections.some(
    (c) => c.id !== ignoreId && c.name.toLowerCase() === trimmed.toLowerCase(),
  );
  if (taken) return { error: "You already have a collection with that name." };
  return { name: trimmed };
}

interface CollectionsState {
  collections: Collection[];
  /** Collection id -> keys (see `projectPathKey`) of the projects in it. */
  members: Record<string, string[]>;
  create: (name: string) => { id: string } | { error: string };
  rename: (id: string, name: string) => { ok: true } | { error: string };
  remove: (id: string) => void;
  toggle: (id: string, projectPath: string) => void;
  add: (id: string, projectPath: string) => void;
  forgetProject: (projectPath: string) => void;
}

let counter = 0;
const newId = () =>
  `c-${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 6)}`;

export const useCollectionsStore = create<CollectionsState>()(
  persist(
    (set, get) => ({
      collections: [],
      members: {},
      create: (name) => {
        const checked = validateCollectionName(name, get().collections);
        if ("error" in checked) return checked;
        const id = newId();
        set((state) => ({
          collections: [...state.collections, { id, name: checked.name }],
          members: { ...state.members, [id]: [] },
        }));
        return { id };
      },
      rename: (id, name) => {
        const checked = validateCollectionName(name, get().collections, id);
        if ("error" in checked) return checked;
        set((state) => ({
          collections: state.collections.map((c) =>
            c.id === id ? { ...c, name: checked.name } : c,
          ),
        }));
        return { ok: true };
      },
      remove: (id) =>
        set((state) => {
          const { [id]: _removed, ...members } = state.members;
          return {
            collections: state.collections.filter((c) => c.id !== id),
            members,
          };
        }),
      toggle: (id, projectPath) =>
        set((state) => {
          const key = projectPathKey(projectPath);
          const current = state.members[id] ?? [];
          return {
            members: {
              ...state.members,
              [id]: current.includes(key)
                ? current.filter((item) => item !== key)
                : [...current, key],
            },
          };
        }),
      add: (id, projectPath) =>
        set((state) => {
          const key = projectPathKey(projectPath);
          const current = state.members[id] ?? [];
          return current.includes(key)
            ? state
            : { members: { ...state.members, [id]: [...current, key] } };
        }),
      forgetProject: (projectPath) =>
        set((state) => {
          const key = projectPathKey(projectPath);
          return {
            members: Object.fromEntries(
              Object.entries(state.members).map(([id, keys]) => [
                id,
                keys.filter((item) => item !== key),
              ]),
            ),
          };
        }),
    }),
    { name: "lemlio-collections", version: 1 },
  ),
);

/** The collections a project belongs to. */
export function collectionsOf(
  state: Pick<CollectionsState, "collections" | "members">,
  projectPath: string,
): Collection[] {
  const key = projectPathKey(projectPath);
  return state.collections.filter((c) => state.members[c.id]?.includes(key));
}
