import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { CloseConfirmation } from "@/components/close-confirmation";
import { useSettingsStore } from "@/stores/settings-store";
import { useDocumentStore } from "@/stores/document-store";
import { useProjectStore } from "@/stores/project-store";
import { useCodexChatStore } from "@/stores/codex-chat-store";

const native = vi.hoisted(() => ({
  handler: undefined as
    | undefined
    | ((event: { preventDefault: () => void }) => void),
  close: vi.fn(async () => {}),
  stop: vi.fn(),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    close: native.close,
    onCloseRequested: vi.fn(async (handler) => {
      native.handler = handler;
      return native.stop;
    }),
  }),
}));
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  native.close.mockClear();
  native.handler = undefined;
  useSettingsStore.setState({ skipCloseWhenBackedUp: false });
  useDocumentStore.setState({
    files: [],
    projectRoot: "C:/Paper",
    isCompiling: false,
    saveAllFiles: vi.fn(async () => {}),
  });
  useProjectStore.setState({ knownProjects: [] });
  useCodexChatStore.setState({ tabs: [] });
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "list_imported_projects"
      ? { projects: [{ path: "C:/Paper" }] }
      : {
          allBackedUp: true,
          connected: true,
          projects: [{ path: "C:/Paper", status: "saved" }],
        },
  );
});
async function mount() {
  const element = document.createElement("div");
  document.body.appendChild(element);
  const root = createRoot(element);
  await act(async () => root.render(<CloseConfirmation />));
  return {
    root,
    async close() {
      await act(async () => root.unmount());
      element.remove();
    },
    async request() {
      const preventDefault = vi.fn();
      await act(async () => native.handler!({ preventDefault }));
      expect(preventDefault).toHaveBeenCalled();
    },
  };
}
it("shows a verified close confirmation and remembers the safe-only checkbox", async () => {
  const ui = await mount();
  try {
    await ui.request();
    expect(document.body.textContent).toContain(
      "Everything is saved and backed up",
    );
    expect(native.close).not.toHaveBeenCalled();
    await act(async () => {
      const checkbox = document.querySelector<HTMLInputElement>(
        'input[type="checkbox"]',
      )!;
      checkbox.click();
    });
    expect(useSettingsStore.getState().skipCloseWhenBackedUp).toBe(true);
    await act(async () =>
      [...document.querySelectorAll("button")]
        .find((b) => b.textContent === "Close Lemlio")!
        .click(),
    );
    expect(native.close).toHaveBeenCalledTimes(1);
  } finally {
    await ui.close();
  }
});
it("skips confirmation only when every current PC version is confirmed", async () => {
  useSettingsStore.setState({ skipCloseWhenBackedUp: true });
  const ui = await mount();
  try {
    await ui.request();
    expect(native.close).toHaveBeenCalledTimes(1);
  } finally {
    await ui.close();
  }
});
it("still warns about pending or offline backups when skipping safe closes is enabled", async () => {
  useSettingsStore.setState({ skipCloseWhenBackedUp: true });
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "list_imported_projects"
      ? { projects: [] }
      : {
          allBackedUp: false,
          connected: false,
          error: "Offline",
          projects: [{ path: "C:/Paper", status: "pending" }],
        },
  );
  const ui = await mount();
  try {
    await ui.request();
    expect(native.close).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Backup pending");
    expect(document.body.textContent).toContain("Offline");
    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
  } finally {
    await ui.close();
  }
});
it("never silently closes over unsaved edits or active work", async () => {
  useSettingsStore.setState({ skipCloseWhenBackedUp: true });
  useDocumentStore.setState({ isCompiling: true });
  const ui = await mount();
  try {
    await ui.request();
    expect(native.close).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("compilation is still running");
  } finally {
    await ui.close();
  }
});
it("retains unsaved edits and ignores the skip preference after a save failure", async () => {
  useSettingsStore.setState({ skipCloseWhenBackedUp: true });
  useDocumentStore.setState({
    files: [
      {
        id: "main.tex",
        name: "main.tex",
        relativePath: "main.tex",
        absolutePath: "C:/Paper/main.tex",
        type: "tex",
        content: "unsaved",
        isDirty: true,
      },
    ],
  });
  const ui = await mount();
  try {
    await ui.request();
    expect(native.close).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("could not be saved");
    expect(document.body.textContent).toContain("Close without saving");
  } finally {
    await ui.close();
  }
});
