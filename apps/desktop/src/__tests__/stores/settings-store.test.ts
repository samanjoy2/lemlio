import { beforeEach, describe, expect, it } from "vitest";
import { useSettingsStore } from "@/stores/settings-store";

describe("system LaTeX compiler preference", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({ compilerBackend: "texlive" });
  });
  it("migrates the previous Tectonic default to the installed system compiler", async () => {
    localStorage.setItem(
      "prismpro-settings",
      JSON.stringify({ state: { compilerBackend: "tectonic" }, version: 0 }),
    );
    await useSettingsStore.persist.rehydrate();
    expect(useSettingsStore.getState().compilerBackend).toBe("texlive");
  });
  it("keeps an explicit Tectonic choice after migration", async () => {
    localStorage.setItem(
      "prismpro-settings",
      JSON.stringify({ state: { compilerBackend: "tectonic" }, version: 1 }),
    );
    await useSettingsStore.persist.rehydrate();
    expect(useSettingsStore.getState().compilerBackend).toBe("tectonic");
  });
});
