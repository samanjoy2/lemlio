import { describe, expect, it } from "vitest";
import { ACCENTS, accentCss, applyAppearance } from "@/lib/appearance";
import {
  EDITOR_THEMES,
  editorThemeExtensions,
} from "@/components/workspace/editor/apple-editor-theme";
import { useSettingsStore } from "@/stores/settings-store";

describe("appearance", () => {
  it("writes the accent for light and dark mode and the editor size", () => {
    applyAppearance("purple", 17);
    const css = document.getElementById("lemlio-appearance")?.textContent ?? "";
    expect(css).toContain(`--primary:${ACCENTS.purple.light}`);
    expect(css).toContain(`.dark{--primary:${ACCENTS.purple.dark}`);
    expect(css).toContain("--editor-font-size:17px");
    applyAppearance("blue", 14);
    expect(document.querySelectorAll("#lemlio-appearance")).toHaveLength(1);
  });
  it("falls back to blue for an unknown accent", () => {
    expect(accentCss("nope" as never)).toContain(ACCENTS.blue.light);
  });
  it("offers every editor theme in light and dark", () => {
    for (const name of Object.keys(
      EDITOR_THEMES,
    ) as (keyof typeof EDITOR_THEMES)[]) {
      expect(editorThemeExtensions(name, false)).toHaveLength(2);
      expect(editorThemeExtensions(name, true)).toHaveLength(2);
    }
    // An old saved value never breaks the editor.
    expect(editorThemeExtensions("gone" as never, true)).toHaveLength(2);
  });
  it("keeps the editor text size readable", () => {
    const set = useSettingsStore.getState().setEditorFontSize;
    set(3);
    expect(useSettingsStore.getState().editorFontSize).toBe(11);
    set(99);
    expect(useSettingsStore.getState().editorFontSize).toBe(22);
  });
});
