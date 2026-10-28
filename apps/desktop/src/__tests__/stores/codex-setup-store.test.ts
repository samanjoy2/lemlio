import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useCodexSetupStore } from "@/stores/codex-setup-store";

describe("Codex connection setup", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    useCodexSetupStore.setState({
      status: "checking",
      error: null,
      version: null,
      accountEmail: null,
      isLoggingIn: false,
    });
  });
  it("accepts an existing Codex ChatGPT sign-in", async () => {
    vi.mocked(invoke).mockResolvedValue({
      installed: true,
      authenticated: true,
      version: "codex-cli",
      account_email: "writer@example.com",
    });
    await useCodexSetupStore.getState().checkStatus();
    expect(invoke).toHaveBeenCalledWith("check_codex_status");
    expect(useCodexSetupStore.getState()).toMatchObject({
      status: "ready",
      accountEmail: "writer@example.com",
    });
  });
  it("shows installation instructions when Codex is absent", async () => {
    vi.mocked(invoke).mockResolvedValue({
      installed: false,
      authenticated: false,
      version: null,
      account_email: null,
    });
    await useCodexSetupStore.getState().checkStatus();
    expect(useCodexSetupStore.getState().status).toBe("not-installed");
  });
  it("requests ChatGPT sign-in when Codex is installed but signed out", async () => {
    vi.mocked(invoke).mockResolvedValue({
      installed: true,
      authenticated: false,
      version: "codex-cli",
      account_email: null,
    });
    await useCodexSetupStore.getState().checkStatus();
    expect(useCodexSetupStore.getState().status).toBe("not-authenticated");
  });
  it("surfaces backend failures and recovers on refresh", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("Connection failed"));
    await useCodexSetupStore.getState().checkStatus();
    expect(useCodexSetupStore.getState()).toMatchObject({
      status: "error",
      error: "Error: Connection failed",
    });
    vi.mocked(invoke).mockResolvedValue({
      installed: true,
      authenticated: true,
      version: "codex-cli",
      account_email: null,
    });
    await useCodexSetupStore.getState().checkStatus();
    expect(useCodexSetupStore.getState()).toMatchObject({
      status: "ready",
      error: null,
    });
  });
});
