import { toJpeg } from "html-to-image";
import { getCurrentPdfBytes } from "@/stores/document-store";
import { getMupdfClient } from "./mupdf/mupdf-client";
import { getPreviewPage } from "./agent-context";

/**
 * Screenshot of this app's own window contents, rendered from the page itself.
 * It cannot see other windows or the desktop. Only called from a user click.
 */
export async function captureAppScreenshot(): Promise<string> {
  const url = await toJpeg(document.body, {
    quality: 0.85,
    pixelRatio: 1,
    cacheBust: false,
    backgroundColor: getComputedStyle(document.body).backgroundColor,
  });
  if (!url.startsWith("data:image/jpeg;base64,") || url.length < 200)
    throw new Error("The window could not be captured");
  return url;
}

/** Renders the PDF page currently open in the preview. */
export async function capturePdfPage(): Promise<{
  dataUrl: string;
  page: number;
}> {
  const pdf = getCurrentPdfBytes();
  if (!pdf) throw new Error("Compile the project first to have a PDF page.");
  const client = getMupdfClient();
  const id = await client.openDocument(new Uint8Array(pdf).buffer);
  try {
    const pages = await client.countPages(id);
    const page = Math.min(Math.max(1, getPreviewPage()), pages);
    const size = await client.getPageSize(id, page - 1);
    const width = Math.min(700, (700 * size.width) / size.height);
    const bytes = new Uint8Array(
      await client.renderThumbnail(id, page - 1, width),
    );
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192)
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return { dataUrl: `data:image/png;base64,${btoa(binary)}`, page };
  } finally {
    await client.closeDocument(id).catch(() => {});
  }
}
