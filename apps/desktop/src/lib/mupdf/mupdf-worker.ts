import { normalizeStructuredText } from "./text-data";
import type { PdfSearchHit } from "./types";
import type { PDFDocument } from "mupdf";

type MupdfModule = typeof import("mupdf");

type MupdfWasmModuleConfig = {
  locateFile?: (path: string) => string;
};

const wasmModuleConfig = ((
  globalThis as typeof globalThis & {
    $libmupdf_wasm_Module?: MupdfWasmModuleConfig;
  }
).$libmupdf_wasm_Module ??= {});

// In Vite dev, requests for /node_modules/.../mupdf-wasm.wasm can fall back to
// index.html. Pointing MuPDF at Vite's @fs URL keeps worker startup on the
// actual binary during local development without changing packaged builds.
if (import.meta.env.DEV) {
  const devWasmUrl = `/@fs/${__MUPDF_WASM_FS_PATH__}`;
  wasmModuleConfig.locateFile = (path: string) => {
    if (path.endsWith("mupdf-wasm.wasm")) {
      return devWasmUrl;
    }
    return path;
  };
}

const mupdf: MupdfModule = await import("mupdf");

const documentMap = new Map<number, PDFDocument>();
let nextDocId = 1;

const methods: Record<string, (...args: any[]) => any> = {};

methods.openDocument = (buffer: ArrayBuffer, magic: string): number => {
  const docId = nextDocId++;
  const doc = mupdf.Document.openDocument(
    buffer,
    magic,
  ) as unknown as PDFDocument;
  documentMap.set(docId, doc);
  return docId;
};

methods.closeDocument = (docId: number): void => {
  const doc = documentMap.get(docId);
  if (doc) {
    documentMap.delete(docId);
    doc.destroy();
  }
};

methods.countPages = (docId: number): number => {
  const doc = documentMap.get(docId)!;
  return doc.countPages();
};

methods.getPageSize = (
  docId: number,
  pageIndex: number,
): { width: number; height: number } => {
  const doc = documentMap.get(docId)!;
  const page = doc.loadPage(pageIndex);
  const bounds = page.getBounds();
  page.destroy();
  return {
    width: bounds[2] - bounds[0],
    height: bounds[3] - bounds[1],
  };
};

methods.getAllPageSizes = (
  docId: number,
): { width: number; height: number }[] => {
  const doc = documentMap.get(docId)!;
  const count = doc.countPages();
  const sizes: { width: number; height: number }[] = [];
  for (let i = 0; i < count; i++) {
    const page = doc.loadPage(i);
    const bounds = page.getBounds();
    sizes.push({
      width: bounds[2] - bounds[0],
      height: bounds[3] - bounds[1],
    });
    page.destroy();
  }
  return sizes;
};

methods.drawPage = (
  docId: number,
  pageIndex: number,
  dpi: number,
): ImageData => {
  const doc = documentMap.get(docId)!;
  const page = doc.loadPage(pageIndex);
  const scale = dpi / 72;
  const matrix = mupdf.Matrix.scale(scale, scale);
  // alpha=false so the PDF's white background is rendered opaquely (RGB, 3 bytes/pixel)
  const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
  const w = pixmap.getWidth();
  const h = pixmap.getHeight();
  const rgb = pixmap.getPixels();
  // Convert RGB (3 bytes/pixel) → RGBA (4 bytes/pixel) for ImageData
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
    rgba[j] = rgb[i];
    rgba[j + 1] = rgb[i + 1];
    rgba[j + 2] = rgb[i + 2];
    rgba[j + 3] = 255; // fully opaque
  }
  pixmap.destroy();
  page.destroy();
  return new ImageData(rgba, w, h);
};

methods.getPageText = (docId: number, pageIndex: number): unknown => {
  const doc = documentMap.get(docId)!;
  const page = doc.loadPage(pageIndex);
  const stext = page.toStructuredText("preserve-whitespace");
  const raw = JSON.parse(stext.asJSON());

  const result = normalizeStructuredText(raw);
  stext.destroy();
  page.destroy();
  return result;
};

methods.searchDocument = (docId: number, query: string): PdfSearchHit[] => {
  const doc = documentMap.get(docId)!;
  const hits: PdfSearchHit[] = [];
  if (!query.trim()) return hits;
  for (let index = 0; index < doc.countPages() && hits.length < 2000; index++) {
    const page = doc.loadPage(index);
    try {
      for (const quads of page.search(query, 2000 - hits.length)) {
        hits.push({
          page: index + 1,
          boxes: quads.map((q) => {
            const xs = [q[0], q[2], q[4], q[6]],
              ys = [q[1], q[3], q[5], q[7]];
            return {
              x: Math.min(...xs),
              y: Math.min(...ys),
              w: Math.max(...xs) - Math.min(...xs),
              h: Math.max(...ys) - Math.min(...ys),
            };
          }),
        });
      }
    } finally {
      page.destroy();
    }
  }
  return hits;
};

methods.getPageLinks = (docId: number, pageIndex: number): unknown[] => {
  const doc = documentMap.get(docId)!;
  const page = doc.loadPage(pageIndex);
  const links = page.getLinks();
  const result = links.map((link: any) => {
    const bounds = link.getBounds();
    const uri: string = link.getURI() || "";
    const isExternal: boolean = link.isExternal?.() ?? uri.startsWith("http");
    let href: string;
    if (isExternal) {
      href = uri;
    } else {
      try {
        const resolved = doc.resolveLink(uri) as any;
        if (typeof resolved === "number") {
          href = `#page=${resolved + 1}`;
        } else if (resolved && typeof resolved.page === "number") {
          href = `#page=${resolved.page + 1}`;
        } else {
          href = uri;
        }
      } catch {
        href = uri;
      }
    }
    return {
      x: bounds[0],
      y: bounds[1],
      w: bounds[2] - bounds[0],
      h: bounds[3] - bounds[1],
      href,
      isExternal,
    };
  });
  for (const link of links) link.destroy();
  page.destroy();
  return result;
};

methods.renderThumbnail = (
  docId: number,
  pageIndex: number,
  targetWidth: number,
): ArrayBuffer => {
  const doc = documentMap.get(docId)!;
  const page = doc.loadPage(pageIndex);
  const bounds = page.getBounds();
  const pageWidth = bounds[2] - bounds[0];
  const retinaScale = 2;
  const scale = (targetWidth * retinaScale) / pageWidth;
  const matrix = mupdf.Matrix.scale(scale, scale);
  const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
  const png = new Uint8Array(pixmap.asPNG());
  pixmap.destroy();
  page.destroy();
  return png.buffer as ArrayBuffer;
};

// RPC message handler
self.onmessage = (event: MessageEvent) => {
  const [func, id, args] = event.data as [string, number, unknown[]];
  try {
    const result = methods[func](...args);
    if (result instanceof ImageData) {
      postMessage(["RESULT", id, result], { transfer: [result.data.buffer] });
    } else if (result instanceof ArrayBuffer) {
      postMessage(["RESULT", id, result], { transfer: [result] });
    } else {
      postMessage(["RESULT", id, result]);
    }
  } catch (error: any) {
    postMessage(["ERROR", id, { name: error.name, message: error.message }]);
  }
};

postMessage(["INIT", 0, Object.keys(methods)]);
