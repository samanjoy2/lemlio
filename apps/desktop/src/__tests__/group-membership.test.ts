import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  useProjectGroups,
  groupProjectPaths,
} from "@/stores/project-groups-store";
it("removes only group membership, leaving the project and unrelated groups intact", () => {
  vi.mocked(invoke).mockClear();
  useProjectGroups.setState({
    groups: [
      { id: "cv", name: "CVs", paths: ["A", "B"], mainPath: "A" },
      { id: "other", name: "Other", paths: ["A", "C"] },
    ],
  });
  useProjectGroups.getState().removeMember("cv", "A");
  expect(useProjectGroups.getState().groups[0].paths).toEqual(["B"]);
  expect(useProjectGroups.getState().groups[0].mainPath).toBeUndefined();
  expect(useProjectGroups.getState().groups[1].paths).toEqual(["A", "C"]);
  expect(invoke).not.toHaveBeenCalled();
});
it("keeps visual order independent from the designated main version", () => {
  useProjectGroups.setState({
    groups: [{ id: "cv", name: "CVs", paths: ["A", "B", "C"] }],
  });
  useProjectGroups.getState().setMain("cv", "B");
  useProjectGroups.getState().moveMember("cv", "A", "C");
  const group = useProjectGroups.getState().groups[0];
  expect(group.paths).toEqual(["B", "C", "A"]);
  expect(group.mainPath).toBe("B");
  useProjectGroups.getState().moveMember("cv", "B", "A");
  const changed = useProjectGroups.getState().groups[0];
  expect(changed.paths).toEqual(["C", "A", "B"]);
  expect(groupProjectPaths(changed)).toEqual(["B", "C", "A"]);
  expect(
    JSON.parse(localStorage.getItem("lemlio-project-groups")!).state.groups[0]
      .paths,
  ).toEqual(["C", "A", "B"]);
  useProjectGroups.getState().setMain("cv", "not-a-member");
  expect(useProjectGroups.getState().groups[0].mainPath).toBe("B");
});
