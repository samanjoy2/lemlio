import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { getMupdfClient } from "./mupdf/mupdf-client";
import { projectPathKey } from "./project-catalog";

export const THUMBNAIL_UPDATED = "lemlio-thumbnail-updated";
type Thumbnail = { attempted: boolean; dataUrl?: string | null };
const pending = new Map<string, Promise<string | null>>();
let generation = 0;
export const thumbnailGeneration = () =>
  (generation = Math.max(Date.now(), generation + 1));

async function store(path: string, png: ArrayBuffer | null, startedAt: number) {
  const saved = await invoke<Thumbnail>("save_project_thumbnail", {
    projectPath: path,
    png: png ? Array.from(new Uint8Array(png)) : null,
    startedAt,
  });
  void emit(THUMBNAIL_UPDATED, path).catch(() => {});
  return saved.dataUrl || null;
}
async function render(path: string, data: ArrayBuffer, startedAt: number) {
  const client = getMupdfClient();
  let doc: number | undefined;
  try {
    doc = await client.openDocument(data);
    return await store(
      path,
      await client.renderThumbnail(doc, 0, 400),
      startedAt,
    );
  } finally {
    if (doc !== undefined) await client.closeDocument(doc).catch(() => {});
  }
}
export async function cachedProjectThumbnail(path: string) {
  return invoke<Thumbnail>("load_project_thumbnail", { projectPath: path });
}
export function projectThumbnail(
  path: string,
  mainFile: string | null | undefined,
  useTexlive: boolean,
  onGenerate?: () => void,
) {
  const key = projectPathKey(path);
  const existing = pending.get(key);
  if (existing) return existing;
  const startedAt = thumbnailGeneration();
  const job = (async () => {
    const cached = await cachedProjectThumbnail(path);
    if (cached.attempted) return cached.dataUrl || null;
    onGenerate?.();
    try {
      const data = await invoke<ArrayBuffer>("project_pdf_preview", {
        projectPath: path,
        mainFile: mainFile || null,
        useTexlive,
      });
      return await render(path, data, startedAt);
    } catch {
      return store(path, null, startedAt);
    }
  })().finally(() => {
    if (pending.get(key) === job) pending.delete(key);
  });
  pending.set(key, job);
  return job;
}
export function refreshProjectThumbnail(
  path: string,
  pdf: Uint8Array,
  startedAt = thumbnailGeneration(),
) {
  return render(path, new Uint8Array(pdf).buffer, startedAt);
}
export function failedProjectThumbnail(
  path: string,
  startedAt = thumbnailGeneration(),
) {
  return store(path, null, startedAt);
}
