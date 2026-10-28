import { describe, expect, it } from "vitest";
import {
  buildProjectCatalog,
  type ImportedProject,
} from "@/lib/project-catalog";

describe("home project catalog", () => {
  it("combines imported and local projects while keeping import metadata and latest activity", () => {
    const imported: ImportedProject = {
      name: "Research paper",
      path: "C:\\Projects\\Paper",
      mainFile: "main.tex",
      fileCount: 12,
      texFileCount: 2,
      conversationCount: 1,
    };
    const catalog = buildProjectCatalog(
      [imported],
      [
        { name: "Paper", path: "c:/projects/paper", lastOpened: 100 },
        { name: "Local CV", path: "C:/Projects/CV", lastOpened: 20 },
      ],
      [{ name: "Paper", path: "C:/Projects/Paper/", lastOpened: 200 }],
    );
    expect(catalog).toHaveLength(2);
    expect(catalog[0]).toMatchObject({
      name: "Research paper",
      lastOpened: 200,
      imported: true,
      mainFile: "main.tex",
      fileCount: 12,
      category: "Papers",
    });
    expect(catalog[1]).toMatchObject({
      name: "Local CV",
      imported: false,
      category: "CVs",
    });
  });
  it("does not merge distinct case-sensitive local paths", () => {
    expect(
      buildProjectCatalog(
        [],
        [
          { name: "A", path: "/work/Paper", lastOpened: 1 },
          { name: "B", path: "/work/paper", lastOpened: 2 },
        ],
        [],
      ),
    ).toHaveLength(2);
  });
});
