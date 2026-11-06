import type { StructuredTextData } from "./types";
/** MuPDF 1.27 emits flat lines; older versions emitted spans/characters. */
export function normalizeStructuredText(raw: any): StructuredTextData {
  return {
    blocks: (raw?.blocks || [])
      .filter((b: any) => b.type === "text")
      .map((block: any) => ({
        type: "text",
        bbox: block.bbox,
        lines: (block.lines || []).map((line: any) => {
          const spans = line.spans || [];
          const first = spans[0];
          const font = line.font || first?.font || {};
          return {
            bbox: line.bbox || { x: 0, y: 0, w: 0, h: 0 },
            wmode: line.wmode || 0,
            x: line.x ?? line.bbox?.x ?? 0,
            y:
              line.y ??
              first?.chars?.[0]?.origin?.y ??
              (line.bbox?.y || 0) + (line.bbox?.h || 0),
            text:
              typeof line.text === "string"
                ? line.text
                : spans
                    .map((s: any) =>
                      (s.chars || []).map((c: any) => c.c).join(""),
                    )
                    .join(""),
            font: {
              name: font.name || "",
              family: font.family || "serif",
              size: font.size || first?.size || 12,
              weight: font.weight || "normal",
              style: font.style || "normal",
            },
          };
        }),
      })),
  };
}
