/** Reads dimensions only. No image decoder runs before this bound is checked. */
export interface ImageDimensions { width: number; height: number; mime: 'image/png' | 'image/jpeg' | 'image/webp'; animated?: boolean }
export const MAX_SOURCE_PIXELS = 16_000_000;
export const MAX_PREVIEW_PIXELS = 4_000_000;
// A 1600 × 1600 base plus one detail tile still fits the reduced 16 MiB budget.
export const MAX_DETAIL_PIXELS = 1_500_000;
/** Source-pixel coordinates, never display or normalized coordinates. */
export interface ImagePixelRegion { originX: number; originY: number; width: number; height: number }
export function imageDetailRegion(source: Pick<ImageDimensions, 'width' | 'height'>, region?: ImagePixelRegion): ImagePixelRegion {
  if (!region || !Object.values(region).every(Number.isSafeInteger) || region.originX < 0 || region.originY < 0 || region.width < 1 || region.height < 1
    || region.originX + region.width > source.width || region.originY + region.height > source.height) throw new Error('高清查看区域无效');
  return { originX: region.originX, originY: region.originY, width: region.width, height: region.height };
}
const be16 = (b: Uint8Array, i: number) => b[i] * 256 + b[i + 1];
const be32 = (b: Uint8Array, i: number) => b[i] * 16777216 + b[i + 1] * 65536 + b[i + 2] * 256 + b[i + 3];
const le24 = (b: Uint8Array, i: number) => b[i] + b[i + 1] * 256 + b[i + 2] * 65536;
const ascii = (b: Uint8Array, i: number, value: string) => [...value].every((letter, offset) => b[i + offset] === letter.charCodeAt(0));
export function imageDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.length >= 26 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)
    && be32(bytes, 8) === 13 && ascii(bytes, 12, 'IHDR')) {
    let animated = false, imageData = false;
    for (let at = 33; at + 12 <= bytes.length;) {
      if (ascii(bytes, at + 4, 'acTL')) { animated = true; break; }
      if (ascii(bytes, at + 4, 'IDAT')) { imageData = true; break; }
      const length = be32(bytes, at); if (at + 12 + length <= at) break; at += 12 + length;
    }
    // Animation control precedes IDAT. If a long ancillary chunk hides that
    // boundary beyond the bounded header read, do not start a native decoder.
    if (!animated && !imageData) return;
    return valid({ width: be32(bytes, 16), height: be32(bytes, 20), mime: 'image/png', ...(animated ? { animated } : {}) });
  }
  if (bytes.length >= 12 && ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) {
    for (let at = 12; at + 8 <= bytes.length;) {
      const size = bytes[at + 4] + bytes[at + 5] * 256 + bytes[at + 6] * 65536 + bytes[at + 7] * 16777216;
      const p = at + 8;
      if (ascii(bytes, at, 'VP8X') && size >= 10 && p + 10 <= bytes.length) return valid({ width: 1 + le24(bytes, p + 4), height: 1 + le24(bytes, p + 7), mime: 'image/webp', ...(bytes[p] & 2 ? { animated: true } : {}) });
      if (ascii(bytes, at, 'VP8L') && size >= 5 && p + 5 <= bytes.length && bytes[p] === 0x2f) return valid({
        width: 1 + bytes[p + 1] + ((bytes[p + 2] & 0x3f) << 8),
        height: 1 + (bytes[p + 2] >> 6) + (bytes[p + 3] << 2) + ((bytes[p + 4] & 0x0f) << 10), mime: 'image/webp' });
      if (ascii(bytes, at, 'VP8 ') && size >= 10 && p + 10 <= bytes.length && bytes[p + 3] === 0x9d && bytes[p + 4] === 1 && bytes[p + 5] === 0x2a)
        return valid({ width: (bytes[p + 6] | bytes[p + 7] << 8) & 0x3fff, height: (bytes[p + 8] | bytes[p + 9] << 8) & 0x3fff, mime: 'image/webp' });
      if (size < 0 || at + 8 + size <= at) return;
      at += 8 + size + (size % 2);
    }
    return;
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2, orientation = 1;
    while (at + 4 <= bytes.length) {
      if (bytes[at++] !== 0xff) return;
      while (at < bytes.length && bytes[at] === 0xff) at++;
      const marker = bytes[at++];
      if (marker === 0xda || marker === 0xd9) return;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      if (at + 2 > bytes.length) return;
      const length = be16(bytes, at);
      if (length < 2 || at + length > bytes.length) return;
      if (marker === 0xe1 && length >= 16 && ascii(bytes, at + 2, 'Exif\u0000\u0000')) orientation = exifOrientation(bytes.subarray(at + 8, at + length));
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8)
        return valid({ width: be16(bytes, at + (orientation >= 5 ? 3 : 5)), height: be16(bytes, at + (orientation >= 5 ? 5 : 3)), mime: 'image/jpeg' });
      at += length;
    }
  }
}
function exifOrientation(bytes: Uint8Array): number {
  if (bytes.length < 8) return 1;
  const little = ascii(bytes, 0, 'II'); if (!little && !ascii(bytes, 0, 'MM')) return 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(2, little) !== 42) return 1;
  const start = view.getUint32(4, little); if (start + 2 > bytes.length) return 1;
  const count = Math.min(view.getUint16(start, little), 512);
  for (let n = 0; n < count; n++) {
    const at = start + 2 + n * 12; if (at + 12 > bytes.length) return 1;
    if (view.getUint16(at, little) === 0x112 && view.getUint16(at + 2, little) === 3 && view.getUint32(at + 4, little) === 1) {
      const value = view.getUint16(at + 8, little); return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}
function valid(value: ImageDimensions): ImageDimensions | undefined {
  return Number.isSafeInteger(value.width) && Number.isSafeInteger(value.height) && value.width > 0 && value.height > 0 ? value : undefined;
}
export function requirePreviewDimensions(value: ImageDimensions | undefined): ImageDimensions {
  if (!value) throw new Error('无法安全读取图片尺寸，请在电脑查看原文件');
  if (value.animated) throw new Error('动态图片保留原文件，暂不自动生成预览');
  if (value.width * value.height > MAX_SOURCE_PIXELS) throw new Error('图片超过 1600 万像素，原文件已保留，请在电脑查看或缩小后预览');
  return value;
}
export function previewDimensions(value: Pick<ImageDimensions, 'width' | 'height'>, variant: 'thumbnail' | 'preview' | 'detail') {
  const limit = variant === 'thumbnail' ? 512 : variant === 'detail' ? 4096 : 1600;
  const scale = Math.min(1, limit / Math.max(value.width, value.height), Math.sqrt((variant === 'detail' ? MAX_DETAIL_PIXELS : MAX_PREVIEW_PIXELS) / (value.width * value.height)));
  return { width: Math.max(1, Math.floor(value.width * scale)), height: Math.max(1, Math.floor(value.height * scale)) };
}
