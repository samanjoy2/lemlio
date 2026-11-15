import { describe, expect, it } from "vitest";
import {
  formatVersionDate,
  shortVersion,
  templateState,
  type TemplatePack,
} from "@/lib/templates";
import { getTemplateById, getTemplateSkeleton } from "@/lib/template-registry";

const pack = (over: Partial<TemplatePack> = {}): TemplatePack => ({
  id: "acl",
  name: "ACL",
  description: "",
  repo: "acl-org/acl-style-files",
  url: "https://github.com/acl-org/acl-style-files",
  mainFile: "acl_latex.tex",
  tags: [],
  installed: null,
  latest: null,
  updateAvailable: false,
  checkedAt: null,
  ...over,
});
const version = (sha: string) => ({
  sha,
  committedAt: "2026-06-29T11:47:20-04:00",
  message: "msg",
});

describe("template update state", () => {
  it("tells apart: not downloaded, outdated, current and not yet compared", () => {
    expect(templateState(pack())).toBe("missing");
    expect(
      templateState(
        pack({
          installed: { ...version("aaaaaaa"), fetchedAt: 1 },
          latest: version("bbbbbbb"),
          updateAvailable: true,
        }),
      ),
    ).toBe("update");
    expect(
      templateState(
        pack({
          installed: { ...version("aaaaaaa"), fetchedAt: 1 },
          latest: version("aaaaaaa"),
        }),
      ),
    ).toBe("current");
    expect(
      templateState(
        pack({ installed: { ...version("aaaaaaa"), fetchedAt: 1 } }),
      ),
    ).toBe("unchecked");
  });
  it("shows commits the way GitHub does", () => {
    expect(shortVersion("d5adc823ff0f80f98c80405ca0ab66c68e684409")).toBe(
      "d5adc82",
    );
    expect(formatVersionDate("not a date")).toBe("");
    expect(formatVersionDate("2026-06-29T11:47:20-04:00")).toMatch(/2026/);
  });
});

describe("the only built-in document", () => {
  it("is the blank starting file for 'start from scratch'", () => {
    const blank = getTemplateById("blank");
    expect(blank?.mainFileName).toBe("main.tex");
    expect(getTemplateSkeleton(blank!)).toContain("\\begin{document}");
    // The old built-in templates are gone.
    expect(getTemplateById("paper-standard")).toBeUndefined();
  });
});
