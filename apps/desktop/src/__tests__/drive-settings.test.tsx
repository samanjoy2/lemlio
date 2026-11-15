import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-shell";
import { DriveSettings } from "@/components/drive-settings";

vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));

const base = {
  provider: null,
  configured: false,
  connected: false,
  pending: false,
  needsReconnect: false,
  error: null,
  lastBackup: null,
  account: null,
  dropboxReady: true,
  dropboxSupported: true,
  appKeyConfigured: true,
  builtInAppKey: true,
  ownAppKey: false,
  redirectUris: [
    "http://127.0.0.1:53682",
    "http://127.0.0.1:53683",
    "http://127.0.0.1:53684",
    "http://127.0.0.1:53685",
  ],
  permissions: [
    "account_info.read",
    "files.metadata.read",
    "files.metadata.write",
    "files.content.read",
    "files.content.write",
  ],
  folderPath: null,
  suggestions: [],
};

async function mount(status: Record<string, unknown>) {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "drive_status") return { ...base, ...status };
    if (command === "drive_dropbox_connect")
      return "https://www.dropbox.com/oauth2/authorize?x=1";
    return undefined;
  });
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  await act(async () => root.render(<DriveSettings />));
  return {
    element,
    close: async () => {
      await act(async () => root.unmount());
      element.remove();
    },
  };
}
const button = (element: HTMLElement, text: string) =>
  [...element.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(text),
  );

afterEach(() => vi.mocked(open).mockReset());

it("offers Connect Dropbox first and opens the browser when pressed", async () => {
  const ui = await mount({});
  try {
    const connect = button(ui.element, "Connect Dropbox")!;
    expect(connect.disabled).toBe(false);
    expect(ui.element.textContent).not.toContain("Google");
    await act(async () => connect.click());
    expect(invoke).toHaveBeenCalledWith("drive_dropbox_connect");
    expect(open).toHaveBeenCalledWith(
      "https://www.dropbox.com/oauth2/authorize?x=1",
    );
  } finally {
    await ui.close();
  }
});

it("says clearly that Dropbox is not set up when no app key exists", async () => {
  const ui = await mount({
    dropboxReady: false,
    appKeyConfigured: false,
    builtInAppKey: false,
  });
  try {
    expect(button(ui.element, "Connect Dropbox")!.disabled).toBe(true);
    expect(ui.element.textContent).toContain("not set up in this build");
    expect(ui.element.textContent).toContain("synced folder");
  } finally {
    await ui.close();
  }
});

it("shows the connected account and lets the user disconnect", async () => {
  const ui = await mount({
    provider: "dropbox",
    configured: true,
    connected: true,
    account: { id: "dbid:1", name: "Sam Writer", email: "sam@example.com" },
  });
  try {
    expect(ui.element.textContent).toContain("Connected as Sam Writer");
    expect(ui.element.textContent).toContain("sam@example.com");
    expect(button(ui.element, "Connect Dropbox")).toBeUndefined();
    await act(async () => button(ui.element, "Disconnect")!.click());
    expect(invoke).toHaveBeenCalledWith("drive_disconnect");
  } finally {
    await ui.close();
  }
});

it("asks to reconnect when Dropbox revoked the connection, without touching backups", async () => {
  const ui = await mount({
    provider: "dropbox",
    configured: true,
    connected: false,
    needsReconnect: true,
    account: { id: "dbid:1", name: "Sam Writer", email: "sam@example.com" },
  });
  try {
    expect(ui.element.textContent).toContain("sign in again");
    expect(button(ui.element, "Reconnect Dropbox")).toBeDefined();
    expect(invoke).not.toHaveBeenCalledWith(
      "drive_reset_backups",
      expect.anything(),
    );
  } finally {
    await ui.close();
  }
});

it("keeps the synced folder as an advanced option", async () => {
  const ui = await mount({
    suggestions: [{ provider: "Dropbox", path: "C:/Users/Sam/Dropbox" }],
  });
  try {
    expect(ui.element.textContent).toContain(
      "Advanced: use a synced folder instead",
    );
    await act(async () => button(ui.element, "Use my Dropbox folder")!.click());
    expect(invoke).toHaveBeenCalledWith("drive_set_folder", {
      folderPath: "C:/Users/Sam/Dropbox",
    });
  } finally {
    await ui.close();
  }
});

const guide = (element: HTMLElement) =>
  [...element.querySelectorAll("details")].find((d) =>
    d.textContent?.includes("Open Dropbox App Console"),
  ) as HTMLDetailsElement;
const type = (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

it("shows the setup guide open, with the exact redirect URIs, while no app key exists", async () => {
  const ui = await mount({
    dropboxReady: false,
    appKeyConfigured: false,
    builtInAppKey: false,
  });
  try {
    const details = guide(ui.element);
    expect(details.open).toBe(true);
    expect(details.textContent).toContain("Advanced: use my own Dropbox app");
    expect(details.textContent).toContain("Scoped access");
    expect(details.textContent).toContain("Allow public clients");
    expect(details.textContent).toContain("Never paste it");
    for (const uri of base.redirectUris)
      expect(details.textContent).toContain(uri);
    for (const permission of base.permissions)
      expect(details.textContent).toContain(permission);
    expect(details.textContent).toContain("500 people");
    expect(button(details, "Test connection")!.disabled).toBe(true);
    await act(async () => button(details, "Open Dropbox App Console")!.click());
    expect(open).toHaveBeenCalledWith(
      "https://www.dropbox.com/developers/apps",
    );
  } finally {
    await ui.close();
  }
});

it("hides the guide behind a plain disclosure when the build includes a Dropbox app", async () => {
  const ui = await mount({});
  try {
    const details = guide(ui.element);
    expect(details.open).toBe(false);
    expect(details.textContent).toContain("Use my own Dropbox app instead");
    expect(details.textContent).toContain("Most people do not need this");
  } finally {
    await ui.close();
  }
});

it("saves only a valid trimmed app key and never sends a secret-looking value", async () => {
  const ui = await mount({
    dropboxReady: false,
    appKeyConfigured: false,
    builtInAppKey: false,
  });
  try {
    const input = ui.element.querySelector<HTMLInputElement>(
      'input[aria-label="Dropbox app key"]',
    )!;
    expect(input.type).toBe("password");
    await act(async () => type(input, "sl.BxQ7-secret_token.value"));
    await act(async () => button(ui.element, "Save key")!.click());
    expect(invoke).not.toHaveBeenCalledWith(
      "drive_set_app_key",
      expect.anything(),
    );
    expect(ui.element.textContent).toContain("Never paste the App secret");
    expect(ui.element.textContent).not.toContain("secret_token");
    await act(async () => type(input, "  abc123def456ghi  "));
    await act(async () => button(ui.element, "Save key")!.click());
    expect(invoke).toHaveBeenCalledWith("drive_set_app_key", {
      appKey: "abc123def456ghi",
    });
  } finally {
    await ui.close();
  }
});

it("lets the user replace, remove and test their own app key", async () => {
  const ui = await mount({ builtInAppKey: false, ownAppKey: true });
  try {
    const details = guide(ui.element);
    expect(details.textContent).toContain("Advanced: use my own Dropbox app");
    expect(button(details, "Replace key")).toBeDefined();
    await act(async () => button(details, "Remove key")!.click());
    expect(invoke).toHaveBeenCalledWith("drive_set_app_key", { appKey: "" });
    await act(async () => button(details, "Test connection")!.click());
    expect(invoke).toHaveBeenCalledWith("drive_dropbox_connect");
  } finally {
    await ui.close();
  }
});
