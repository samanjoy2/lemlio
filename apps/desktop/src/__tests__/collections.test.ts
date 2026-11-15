import { beforeEach, describe, expect, it } from "vitest";
import {
  ArchiveIcon,
  BriefcaseIcon,
  FolderIcon,
  GraduationCapIcon,
  PresentationIcon,
} from "lucide-react";
import { collectionIcon } from "@/lib/collection-icons";
import {
  collectionsOf,
  useCollectionsStore,
  validateCollectionName,
} from "@/stores/collections-store";
import { useProjectStore } from "@/stores/project-store";

describe("collection icons", () => {
  it("are chosen from the words in the name", () => {
    expect(collectionIcon("My Thesis")).toBe(GraduationCapIcon);
    expect(collectionIcon("Job applications")).toBe(BriefcaseIcon);
    expect(collectionIcon("conference POSTERS")).toBe(PresentationIcon);
    expect(collectionIcon("Old stuff")).toBe(ArchiveIcon);
  });
  it("fall back to a plain folder when nothing fits", () => {
    expect(collectionIcon("Zebra")).toBe(FolderIcon);
    expect(collectionIcon("")).toBe(FolderIcon);
  });
  it("match whole words only", () => {
    // "cover" is a letter, but "discovery" is not.
    expect(collectionIcon("discovery")).toBe(FolderIcon);
  });
});

describe("collections", () => {
  beforeEach(() =>
    useCollectionsStore.setState({ collections: [], members: {} }),
  );

  it("are created, renamed and deleted by the user", () => {
    const store = useCollectionsStore.getState();
    const created = store.create("  Thesis   chapters ");
    expect("id" in created).toBe(true);
    if (!("id" in created)) return;
    expect(useCollectionsStore.getState().collections[0].name).toBe(
      "Thesis chapters",
    );
    expect(store.rename(created.id, "Papers")).toEqual({ ok: true });
    expect(useCollectionsStore.getState().collections[0].name).toBe("Papers");
    store.remove(created.id);
    expect(useCollectionsStore.getState().collections).toEqual([]);
    expect(useCollectionsStore.getState().members).toEqual({});
  });

  it("reject empty, long and duplicate names", () => {
    const store = useCollectionsStore.getState();
    expect("error" in store.create("   ")).toBe(true);
    expect("error" in store.create("x".repeat(41))).toBe(true);
    store.create("Grants");
    expect("error" in store.create("grants")).toBe(true);
    const list = useCollectionsStore.getState().collections;
    // Renaming a collection to its own name is fine.
    expect(validateCollectionName("Grants", list, list[0].id)).toEqual({
      name: "Grants",
    });
  });

  it("hold a project in several collections without touching the project", () => {
    const store = useCollectionsStore.getState();
    const a = store.create("A");
    const b = store.create("B");
    if (!("id" in a) || !("id" in b)) throw new Error("create failed");
    store.toggle(a.id, "C:\\Projects\\Paper");
    store.add(b.id, "c:/projects/paper");
    store.add(b.id, "c:/projects/paper");
    const state = useCollectionsStore.getState();
    expect(
      collectionsOf(state, "C:/Projects/Paper").map((c) => c.name),
    ).toEqual(["A", "B"]);
    expect(state.members[b.id]).toHaveLength(1);
    store.toggle(a.id, "C:\\Projects\\Paper");
    expect(
      collectionsOf(useCollectionsStore.getState(), "C:/Projects/Paper"),
    ).toHaveLength(1);
  });
});

describe("archiving a project", () => {
  beforeEach(() => useProjectStore.setState({ archivedPaths: [] }));

  it("is reversible and does not forget the project", () => {
    useProjectStore.setState({
      knownProjects: [{ path: "C:/p/Paper", name: "Paper", lastOpened: 1 }],
    });
    const store = useProjectStore.getState();
    store.toggleArchived("C:\\p\\Paper");
    expect(useProjectStore.getState().archivedPaths).toEqual(["c:/p/paper"]);
    expect(useProjectStore.getState().knownProjects).toHaveLength(1);
    store.toggleArchived("c:/p/paper");
    expect(useProjectStore.getState().archivedPaths).toEqual([]);
  });

  it("is dropped when the project is forgotten", () => {
    const store = useProjectStore.getState();
    store.toggleArchived("C:/p/Paper");
    store.forgetProject("C:/p/Paper");
    expect(useProjectStore.getState().archivedPaths).toEqual([]);
  });
});
