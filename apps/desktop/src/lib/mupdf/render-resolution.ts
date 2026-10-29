/** Render two samples per physical screen pixel, with bounded canvas memory. */
export function pageRenderDpi(
  width: number,
  height: number,
  zoom: number,
  deviceScale: number,
) {
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const dpr = Number.isFinite(deviceScale) && deviceScale > 0 ? deviceScale : 1;
  const wanted = Math.max(2, 2 * dpr);
  const areaLimit = Math.sqrt(
    12_000_000 / Math.max(1, width * height * scale * scale),
  );
  const edgeLimit = 8192 / Math.max(1, width * scale, height * scale);
  return 72 * scale * Math.min(wanted, areaLimit, edgeLimit);
}
