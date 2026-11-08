import type { ImagePixelRegion } from './image-dimensions';

/** Quantized overscan avoids decoding a new tile for each small drag movement. */
export function canvasDetailRegion(source: { width: number; height: number }, viewport: { width: number; height: number }, geometry: { left: number; top: number; zoom: number }): ImagePixelRegion | undefined {
  if (![source.width, source.height, viewport.width, viewport.height, geometry.left, geometry.top, geometry.zoom].every(Number.isFinite)
    || source.width < 1 || source.height < 1 || viewport.width <= 1 || viewport.height <= 1 || geometry.zoom <= 0) return;
  const edge = (value: number, limit: number, end = false) => Math.max(0, Math.min(limit, (end ? Math.ceil(value / 64) : Math.floor(value / 64)) * 64));
  const originX = edge(-geometry.left / geometry.zoom - 64, source.width), originY = edge(-geometry.top / geometry.zoom - 64, source.height);
  const right = edge((viewport.width - geometry.left) / geometry.zoom + 64, source.width, true), bottom = edge((viewport.height - geometry.top) / geometry.zoom + 64, source.height, true);
  if (right <= originX || bottom <= originY) return;
  return { originX, originY, width: right - originX, height: bottom - originY };
}
