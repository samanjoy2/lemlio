import { describe, it, expect, beforeEach } from "vitest";
import { useProjectStore } from "@/stores/project-store";

describe("useProjectStore", () => {
  beforeEach(() => {
    // Reset the store between tests
    useProjectStore.setState({
      recentProjects: [],
      knownProjects: [],
      starredPaths: [],
      lastProjectFolder: null,
    });
  });

  describe("addRecentProject", () => {
    it("adds a project with extracted name", () => {
      useProjectStore.getState().addRecentProject("/Users/dev/my-thesis");
      const { recentProjects } = useProjectStore.getState();
      expect(recentProjects).toHaveLength(1);
      expect(recentProjects[0].path).toBe("/Users/dev/my-thesis");
      expect(recentProjects[0].name).toBe("my-thesis");
    });

    it("moves duplicate to front and deduplicates", () => {
      const store = useProjectStore.getState();
      store.addRecentProject("/a");
      store.addRecentProject("/b");
      store.addRecentProject("/a");
      const { recentProjects } = useProjectStore.getState();
      expect(recentProjects).toHaveLength(2);
      expect(recentProjects[0].path).toBe("/a");
      expect(recentProjects[1].path).toBe("/b");
    });

    it("limits to MAX_RECENT (10) entries", () => {
      const store = useProjectStore.getState();
      for (let i = 0; i < 12; i++) {
        store.addRecentProject(`/project-${i}`);
      }
      const { recentProjects } = useProjectStore.getState();
      expect(recentProjects).toHaveLength(10);
      // Most recent should be first
      expect(recentProjects[0].path).toBe("/project-11");
      expect(useProjectStore.getState().knownProjects).toHaveLength(12);
    });

    it("extracts name from path correctly", () => {
      useProjectStore.getState().addRecentProject("/a/b/c/deep-folder");
      expect(useProjectStore.getState().recentProjects[0].name).toBe(
        "deep-folder",
      );
    });

    it("uses full path as name if no segments", () => {
      useProjectStore.getState().addRecentProject("standalone");
      expect(useProjectStore.getState().recentProjects[0].name).toBe(
        "standalone",
      );
    });
  });

  describe("removeRecentProject", () => {
    it("removes a project by path", () => {
      const store = useProjectStore.getState();
      store.addRecentProject("/a");
      store.addRecentProject("/b");
      store.removeRecentProject("/a");
      const { recentProjects } = useProjectStore.getState();
      expect(recentProjects).toHaveLength(1);
      expect(recentProjects[0].path).toBe("/b");
      expect(useProjectStore.getState().knownProjects).toHaveLength(2);
    });
  });

  it("deduplicates Windows paths across recent projects and favorites", () => {
    const store = useProjectStore.getState();
    store.addRecentProject("C:\\Research\\Paper");
    store.addRecentProject("c:/research/paper");
    expect(useProjectStore.getState().knownProjects).toHaveLength(1);
    expect(useProjectStore.getState().recentProjects).toHaveLength(1);
    store.toggleStarred("C:\\Research\\Paper");
    expect(useProjectStore.getState().starredPaths).toEqual([
      "c:/research/paper",
    ]);
    store.toggleStarred("c:/research/paper/");
    expect(useProjectStore.getState().starredPaths).toEqual([]);
  });

  it("preserves existing recent projects when upgrading saved settings", async () => {
    const recent = [{ path: "/existing", name: "existing", lastOpened: 123 }];
    const migrate = useProjectStore.persist.getOptions().migrate;
    const migrated = await migrate?.(
      { recentProjects: recent, lastProjectFolder: "/parent" },
      0,
    );
    expect(migrated).toMatchObject({
      recentProjects: recent,
      knownProjects: recent,
      starredPaths: [],
      lastProjectFolder: "/parent",
    });
  });
});
