import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { PdfFindBar } from "@/components/workspace/preview/pdf-reader-tools";
const { search } = vi.hoisted(() => ({ search: vi.fn() }));
vi.mock("@/lib/mupdf/mupdf-client", () => ({
  getMupdfClient: () => ({ searchDocument: search }),
}));

it("searches the PDF, cycles exact hits with Enter, and refreshes after recompilation", async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  const hits = [
    { page: 1, boxes: [{ x: 20, y: 40, w: 30, h: 10 }] },
    { page: 3, boxes: [{ x: 20, y: 80, w: 30, h: 10 }] },
  ];
  search.mockResolvedValue(hits);
  const results = vi.fn(),
    jump = vi.fn(),
    close = vi.fn();
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  const render = (docId: number) => (
    <PdfFindBar
      docId={docId}
      onResults={results}
      onJump={jump}
      onClose={close}
    />
  );
  try {
    await act(async () => root.render(render(1)));
    const input = el.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "research");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(search).toHaveBeenCalledWith(1, "research");
    expect(el.textContent).toContain("1 / 2");
    expect(jump).toHaveBeenLastCalledWith(hits[0]);
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(jump).toHaveBeenLastCalledWith(hits[1]);
    expect(el.textContent).toContain("2 / 2");
    search.mockResolvedValue([]);
    await act(async () => root.render(render(2)));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(search).toHaveBeenLastCalledWith(2, "research");
    expect(el.textContent).toContain("No matches");
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(close).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    el.remove();
    vi.useRealTimers();
  }
});
