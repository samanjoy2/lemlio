import { act } from "react";
import { createRoot } from "react-dom/client";
import { it, expect, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { ChatComposer } from "@/components/codex-chat/chat-composer";
import { TooltipProvider } from "@/components/ui/tooltip";
vi.mock("border-beam", () => ({ BorderBeam: ({ children }: any) => children }));
it("uses the normal composer controls with a group-specific sender and stop handler", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.mocked(invoke).mockResolvedValue([]);
  const send = vi.fn(async () => {}),
    stop = vi.fn(async () => {});
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <TooltipProvider>
          <ChatComposer isOpen onSubmit={send} placeholder="All CV versions" />
        </TooltipProvider>,
      ),
    );
    const text = host.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(text, "Update the phone number");
      text.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const button = [...host.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Send",
    ) as HTMLButtonElement;
    expect(button).not.toBeNull();
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    expect(send).toHaveBeenCalledWith("Update the phone number");
    await act(async () =>
      root.render(
        <TooltipProvider>
          <ChatComposer isOpen streamingOverride stopOverride={stop} />
        </TooltipProvider>,
      ),
    );
    await act(async () =>
      (
        host.querySelector(
          'button[aria-label="Stop agent"]',
        ) as HTMLButtonElement
      ).click(),
    );
    expect(stop).toHaveBeenCalledOnce();
    expect(
      vi.mocked(invoke).mock.calls.some((c) => c[0] === "execute_codex_code"),
    ).toBe(false);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
