import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { CodexRequests } from "@/components/codex-chat/codex-requests";
import { runCompilerTool } from "@/lib/codex-compiler-tools";
vi.mock("@/lib/codex-compiler-tools", () => ({
  runCompilerTool: vi.fn(async () => ({
    success: true,
    contentItems: [{ type: "inputText", text: "Compiled" }],
  })),
}));
it("executes host compiler requests and responds without presenting an unsupported approval dialog", async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  let callback: (event: any) => void = () => {};
  vi.mocked(listen).mockImplementation(async (name, fn) => {
    if (name === "codex-request") callback = fn as typeof callback;
    return () => {};
  });
  const element = document.createElement("div");
  const root = createRoot(element);
  try {
    await act(async () => root.render(<CodexRequests />));
    await act(async () =>
      callback({
        payload: {
          id: 12,
          method: "item/tool/call",
          tab_id: "test",
          params: {
            threadId: "thread",
            tool: "lemlio_compile",
            arguments: {},
            projectPath: "C:/Paper",
          },
        },
      }),
    );
    expect(runCompilerTool).toHaveBeenCalledWith({
      tool: "lemlio_compile",
      arguments: {},
      projectPath: "C:/Paper",
    });
    expect(invoke).toHaveBeenCalledWith("respond_codex_request", {
      requestId: 12,
      result: {
        success: true,
        contentItems: [{ type: "inputText", text: "Compiled" }],
      },
    });
    expect(element.textContent).toBe("");
  } finally {
    await act(async () => root.unmount());
  }
});
