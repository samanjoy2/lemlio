import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-shell";
import { AppUpdates } from "@/components/app-updates";
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn(async () => {}) }));
async function mount() {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const node = document.createElement("div");
  const root = createRoot(node);
  await act(async () => root.render(<AppUpdates />));
  return {
    node,
    root,
    check: async () => {
      await act(async () => node.querySelector("button")!.click());
    },
    close: async () => {
      await act(async () => root.unmount());
    },
  };
}
it("checks the installed version and starts the selected platform's download only on click", async () => {
  vi.mocked(open).mockClear();
  const url =
    "https://github.com/samanjoy2/lemlio/releases/download/lemlio-v1.2.8/Lemlio_1.2.8_Intel.dmg";
  vi.mocked(invoke).mockResolvedValue({
    available: true,
    currentVersion: "1.2.7",
    latestVersion: "1.2.8",
    downloadUrl: url,
    releaseUrl: "https://github.com/samanjoy2/lemlio/releases/latest",
  });
  const ui = await mount();
  try {
    await ui.check();
    expect(ui.node.textContent).toContain("1.2.8 is available");
    expect(open).not.toHaveBeenCalled();
    await act(async () =>
      [...ui.node.querySelectorAll("button")]
        .find((b) => b.textContent?.startsWith("Download"))!
        .click(),
    );
    expect(open).toHaveBeenCalledWith(url);
  } finally {
    await ui.close();
  }
});
it("shows the current version without offering a downgrade", async () => {
  vi.mocked(invoke).mockResolvedValue({
    available: false,
    currentVersion: "1.2.7",
    latestVersion: "1.2.5",
  });
  const ui = await mount();
  try {
    await ui.check();
    expect(ui.node.textContent).toContain("up to date (Lemlio 1.2.7)");
    expect(ui.node.querySelectorAll("button")).toHaveLength(1);
  } finally {
    await ui.close();
  }
});
it("keeps the app usable when GitHub is offline", async () => {
  vi.mocked(invoke).mockRejectedValue("Cannot reach GitHub");
  const ui = await mount();
  try {
    await ui.check();
    expect(ui.node.querySelector('[role="alert"]')?.textContent).toContain(
      "Cannot reach GitHub",
    );
    expect(ui.node.querySelector("button")!.disabled).toBe(false);
  } finally {
    await ui.close();
  }
});
