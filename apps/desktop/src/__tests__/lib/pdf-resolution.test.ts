import { expect, it } from "vitest";
import { pageRenderDpi } from "@/lib/mupdf/render-resolution";
it("supersamples normal and fractional display scales", () => {
  expect(pageRenderDpi(595, 842, 1, 1)).toBe(144);
  expect(pageRenderDpi(595, 842, 1, 1.25)).toBe(180);
  expect(pageRenderDpi(595, 842, 0.8, 1.5)).toBeCloseTo(172.8);
});
it("bounds memory and canvas dimensions at high zoom", () => {
  const dpi = pageRenderDpi(595, 842, 4, 3);
  expect(595 * 842 * (dpi / 72) ** 2).toBeLessThanOrEqual(12_000_001);
  expect((842 * dpi) / 72).toBeLessThanOrEqual(8192);
});
