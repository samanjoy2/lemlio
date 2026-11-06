import { expect, it } from "vitest";
import { normalizeStructuredText } from "@/lib/mupdf/text-data";

it("keeps MuPDF 1.27 flat text, font size and baseline for selection", () => {
  const result = normalizeStructuredText({
    blocks: [
      {
        type: "text",
        bbox: { x: 20, y: 30, w: 80, h: 12 },
        lines: [
          {
            bbox: { x: 20, y: 30, w: 80, h: 12 },
            x: 20,
            y: 40,
            text: "Readable PDF",
            font: {
              name: "LMSans",
              size: 10,
              family: "sans-serif",
              weight: "bold",
            },
          },
        ],
      },
      { type: "image" },
    ],
  });
  expect(result.blocks).toHaveLength(1);
  expect(result.blocks[0].lines[0]).toMatchObject({
    text: "Readable PDF",
    x: 20,
    y: 40,
    font: { size: 10, weight: "bold" },
  });
});

it("still accepts older span/character output and empty documents", () => {
  const result = normalizeStructuredText({
    blocks: [
      {
        type: "text",
        lines: [
          {
            bbox: { x: 2, y: 3, w: 30, h: 12 },
            spans: [
              {
                font: { name: "Serif", size: 9 },
                chars: [{ c: "A", origin: { y: 12 } }, { c: "B" }],
              },
            ],
          },
        ],
      },
    ],
  });
  expect(result.blocks[0].lines[0]).toMatchObject({
    text: "AB",
    y: 12,
    font: { size: 9 },
  });
  expect(normalizeStructuredText(null)).toEqual({ blocks: [] });
});
