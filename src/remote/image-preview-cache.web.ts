import { imageDimensions, imageDetailRegion, previewDimensions, requirePreviewDimensions, type ImageDimensions, type ImagePixelRegion } from './image-dimensions';

export type ImageVariant = 'thumbnail' | 'preview' | 'detail';
export type ManagedImageResource = { uri: string; width: number; height: number; originalWidth: number; originalHeight: number; region?: ImagePixelRegion; release?: () => void };
type Entry = { resource: ManagedImageResource; bytes: number; readers: number; used: number };
const entries = new Map<string, Entry>(), flights = new Map<string, { promise: Promise<Entry>; controller: AbortController; consumers: number }>();
let processing: Promise<unknown> = Promise.resolve();
const cancelled = () => new Error('图片预览已取消');
export function releaseInactiveImageMemory(): void {
  for (const [key, entry] of entries) if (!entry.readers) { URL.revokeObjectURL(entry.resource.uri); entries.delete(key); }
}
export function serializeImageProcessing<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const next = processing.then(() => { if (signal?.aborted) throw cancelled(); return run(); }, () => { if (signal?.aborted) throw cancelled(); return run(); });
  processing = next.catch(() => undefined); return next;
}
async function readSource(uri: string, signal?: AbortSignal): Promise<Blob> {
  // Web fixtures use same-origin SVGs; picked browser images use blob URIs.
  // They never go through Native FileSystem and are never uploaded here.
  const response = await fetch(uri, { credentials: 'omit', redirect: 'error', signal });
  if (!response.ok) throw new Error('原图片已不可用');
  const length = Number(response.headers.get('content-length'));
  if (length > 8 * 1024 * 1024) throw new Error('图片文件超过预览限制');
  if (!response.body) throw new Error('浏览器不能安全读取图片');
  const reader = response.body.getReader(), parts: Uint8Array<ArrayBuffer>[] = []; let bytes = 0;
  try {
    for (;;) {
      const result = await reader.read(); if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > 8 * 1024 * 1024) throw new Error('图片文件超过预览限制');
      parts.push(new Uint8Array(result.value));
    }
  } finally { await reader.cancel().catch(() => undefined); }
  return new Blob(parts, { type: response.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream' });
}
async function dimensions(blob: Blob): Promise<ImageDimensions> {
  const header = new Uint8Array(await blob.slice(0, 256 * 1024).arrayBuffer());
  const raster = imageDimensions(header);
  if (raster) return requirePreviewDimensions(raster);
  if (blob.type !== 'image/svg+xml') return requirePreviewDimensions(undefined);
  const text = await blob.text(), doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const svg = doc.documentElement;
  if (svg.localName !== 'svg' || doc.querySelector('parsererror')) throw new Error('图片格式无效');
  const box = svg.getAttribute('viewBox')?.trim().split(/[ ,]+/).map(Number);
  const width = Number(svg.getAttribute('width')?.replace(/px$/, '')) || box?.[2];
  const height = Number(svg.getAttribute('height')?.replace(/px$/, '')) || box?.[3];
  if (!width || !height || !Number.isFinite(width) || !Number.isFinite(height)) throw new Error('SVG 缺少有界尺寸');
  return requirePreviewDimensions({ width: Math.ceil(width), height: Math.ceil(height), mime: 'image/png' });
}
export async function inspectLocalImage(uri: string): Promise<ImageDimensions> { return dimensions(await readSource(uri)); }
function sweep(additional: number) {
  let bytes = [...entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
  for (const [key, entry] of [...entries].sort((a, b) => a[1].used - b[1].used)) {
    if (entry.readers || bytes + additional <= 64 * 1024 * 1024 && entry.used + 7 * 86400_000 > Date.now()) continue;
    URL.revokeObjectURL(entry.resource.uri); entries.delete(key); bytes -= entry.bytes;
  }
  if (bytes + additional > 64 * 1024 * 1024) throw new Error('图片预览缓存已满，请关闭部分图片');
}
async function create(uri: string, variant: ImageVariant, signal: AbortSignal, requestedRegion?: ImagePixelRegion): Promise<Entry> {
  const blob = await readSource(uri, signal), original = await dimensions(blob);
  const region = variant === 'detail' ? imageDetailRegion(original, requestedRegion) : undefined, target = previewDimensions(region ?? original, variant);
  const objectURI = URL.createObjectURL(blob), image = new globalThis.Image();
  const canvas = document.createElement('canvas');
  try {
    if (signal.aborted) throw cancelled();
    await new Promise<void>((resolve, reject) => { const abort = () => { image.src = ''; reject(cancelled()); }; signal.addEventListener('abort', abort, { once: true });
      image.onload = () => { signal.removeEventListener('abort', abort); resolve(); }; image.onerror = () => { signal.removeEventListener('abort', abort); reject(new Error('图片解码失败')); }; image.src = objectURI; });
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 16_000_000) throw new Error('图片超过预览像素限制');
    canvas.width = target.width; canvas.height = target.height;
    const context = canvas.getContext('2d'); if (!context) throw new Error('浏览器图片处理不可用');
    if (region) context.drawImage(image, region.originX, region.originY, region.width, region.height, 0, 0, target.width, target.height);
    else context.drawImage(image, 0, 0, target.width, target.height);
    const result = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('图片预览生成失败')), original.mime === 'image/jpeg' ? 'image/jpeg' : 'image/png', variant === 'thumbnail' ? .65 : variant === 'detail' ? 1 : .82));
    if (signal.aborted) throw cancelled();
    sweep(result.size);
    return { resource: { uri: URL.createObjectURL(result), ...target, originalWidth: original.width, originalHeight: original.height, ...(region ? { region } : {}) }, bytes: result.size, readers: 0, used: Date.now() };
  } finally { image.onload = image.onerror = null; image.src = ''; URL.revokeObjectURL(objectURI); canvas.width = canvas.height = 0; }
}
export function managedImagePreview(uri: string, variant: ImageVariant, signal?: AbortSignal, region?: ImagePixelRegion): Promise<ManagedImageResource> {
  if (signal?.aborted) return Promise.reject(cancelled());
  const key = JSON.stringify([uri, variant, region]);
  const ready = entries.get(key);
  let flight = flights.get(key);
  if (!ready && (!flight || flight.controller.signal.aborted)) {
    const controller = new AbortController(), created = { controller, consumers: 0, promise: Promise.resolve({} as Entry) };
    created.promise = serializeImageProcessing(() => create(uri, variant, controller.signal, region), controller.signal).then(entry => { entries.set(key, entry); return entry; }).finally(() => { if (flights.get(key) === created) flights.delete(key); });
    flights.set(key, created); flight = created;
  }
  const joined = flight; if (!ready && joined) joined.consumers++;
  return new Promise((resolve, reject) => {
    let done = false;
    const leave = () => { if (!ready && joined && --joined.consumers === 0) joined.controller.abort(); };
    const abort = () => { if (!done) { done = true; signal?.removeEventListener('abort', abort); leave(); reject(cancelled()); } };
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve(ready ?? joined!.promise).then(entry => {
      signal?.removeEventListener('abort', abort); if (done) return;
      if (signal?.aborted) { abort(); return; }
      done = true; leave(); entry.readers++; entry.used = Date.now(); let released = false;
      resolve({ ...entry.resource, release: () => { if (released) return; released = true; entry.readers--; entry.used = Date.now(); } });
    }, error => { signal?.removeEventListener('abort', abort); if (!done) { done = true; leave(); reject(error); } });
  });
}
