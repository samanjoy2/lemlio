import { beforeEach, describe, expect, it } from "vitest";
import { useSettingsStore } from "@/stores/settings-store";

describe("LaTeX compiler preference", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({ compilerBackend: "tectonic" });
  });
  it("uses bundled Tectonic for a fresh installation", () => {
    expect(useSettingsStore.getInitialState().compilerBackend).toBe("tectonic");
  });
  it("migrates old settings to bundled Tectonic", async () => {
    localStorage.setItem(
      "lemlio-settings",
      JSON.stringify({ state: { compilerBackend: "texlive" }, version: 0 }),
    );
    await useSettingsStore.persist.rehydrate();
    expect(useSettingsStore.getState().compilerBackend).toBe("tectonic");
  });
  it("keeps an explicit optional system compiler choice", async () => {
    localStorage.setItem(
      "lemlio-settings",
      JSON.stringify({ state: { compilerBackend: "texlive" }, version: 1 }),
    );
    await useSettingsStore.persist.rehydrate();
    expect(useSettingsStore.getState().compilerBackend).toBe("texlive");
  });
});
