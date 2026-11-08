import { Directory, File, FileMode, Paths } from 'expo-file-system';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { reserveAttachmentCache, retainCachedAttachment, touchCachedAttachment } from './attachment-cache-policy';
import { imageDimensions, imageDetailRegion, previewDimensions, requirePreviewDimensions, type ImageDimensions, type ImagePixelRegion } from './image-dimensions';

export type ImageVariant = 'thumbnail' | 'preview' | 'detail';
export type ManagedImageResource = { uri: string; width: number; height: number; originalWidth: number; originalHeight: number; region?: ImagePixelRegion; release?: () => void };
const hash = (value: string) => bytesToHex(sha256(new TextEncoder().encode(value)));
const cancelled = () => new Error('图片预览已取消');
export function releaseInactiveImageMemory(): void { /* Native cache contains files only, no decoded images. */ }
const flights = new Map<string, { promise: Promise<ManagedImageResource>; controller: AbortController; consumers: number }>();
let work: Promise<unknown> = Promise.resolve();
/** Native decode/resize work is serialized across thumbnails and composer input. */
export function serializeImageProcessing<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const next = work.then(() => { if (signal?.aborted) throw cancelled(); return run(); }, () => { if (signal?.aborted) throw cancelled(); return run(); });
  work = next.catch(() => undefined); return next;
}
export function inspectLocalImage(uri: string): ImageDimensions {
  if (!/^(file|content):\/\//i.test(uri)) throw new Error('图片不是本地文件');
  const source = new File(uri), handle = source.open(FileMode.ReadOnly);
  try { return requirePreviewDimensions(imageDimensions(handle.readBytes(256 * 1024))); }
  finally { handle.close(); }
}
async function createPreview(uri: string, variant: ImageVariant, signal: AbortSignal, requestedRegion?: ImagePixelRegion): Promise<ManagedImageResource> {
  const source = new File(uri);
  if (!source.exists || !source.size) throw new Error('原图片已不可用，请重新读取');
  if (source.size > 8 * 1024 * 1024 && !/-(?:thumbnail|preview|detail)-v1-/.test(source.name)) throw new Error('图片文件超过预览限制，原文件已保留');
  const input = inspectLocalImage(uri), region = variant === 'detail' ? imageDetailRegion(input, requestedRegion) : undefined;
  const target = previewDimensions(region ?? input, variant);
  const root = new Directory(Paths.cache, 'salcara-remote-attachments');
  const parent = uri.startsWith(`${root.uri.replace(/\/$/, '')}/`) ? source.parentDirectory : new Directory(root, hash(uri).slice(0, 32));
  const identity = /^att_[a-f0-9]{32}/.exec(source.name)?.[0] ?? `att_${hash(uri).slice(0, 32)}`;
  const key = hash(JSON.stringify([uri, source.size, source.modificationTime, variant, 'v1', ...(region ? [region] : [])]));
  const png = input.mime !== 'image/jpeg', suffix = png ? 'png' : 'jpg';
  const file = new File(parent, `${identity}-${variant}-v1-${key}.${suffix}`);
  if (signal.aborted) throw cancelled();
  if (file.exists && file.size) {
    const cached = inspectLocalImage(file.uri);
    if (cached.width === target.width && cached.height === target.height) {
      touchCachedAttachment(file.uri);
      return { uri: file.uri, width: cached.width, height: cached.height, originalWidth: input.width, originalHeight: input.height, ...(region ? { region } : {}) };
    }
  }
  // PNG preserves transparent diagrams. Reserve its worst case RGBA output,
  // including the temporary file, instead of relying on JPEG compression.
  const release = await reserveAttachmentCache(target.width * target.height * 4 + 128 * 1024);
  let temporary: File | undefined;
  try {
    if (signal.aborted) throw cancelled();
    const out = await manipulateAsync(uri, [...(region ? [{ crop: region }] : []), { resize: target }], { compress: variant === 'thumbnail' ? .65 : variant === 'detail' ? 1 : .82, format: png ? SaveFormat.PNG : SaveFormat.JPEG });
    temporary = new File(out.uri);
    if (signal.aborted) throw cancelled();
    if (!temporary.exists || !temporary.size || temporary.size > target.width * target.height * 4 + 128 * 1024 || out.width * out.height > 4_000_000 || out.width !== target.width || out.height !== target.height) throw new Error('图片预览尺寸超出安全范围');
    parent.create({ intermediates: true, idempotent: true });
    await temporary.move(file, { overwrite: true });
    temporary = undefined;
    if (signal.aborted) { if (file.exists) file.delete(); throw cancelled(); }
    touchCachedAttachment(file.uri);
    return { uri: file.uri, width: out.width, height: out.height, originalWidth: input.width, originalHeight: input.height, ...(region ? { region } : {}) };
  } finally {
    release();
    try { if (temporary?.exists && temporary.uri !== uri) temporary.delete(); } catch { /* only generated temporary output */ }
  }
}
/** Each consumer can cancel independently; the last one also cancels queued work. */
export function managedImagePreview(uri: string, variant: ImageVariant, signal?: AbortSignal, region?: ImagePixelRegion): Promise<ManagedImageResource> {
  if (signal?.aborted) return Promise.reject(cancelled());
  const key = JSON.stringify([uri, variant, region]);
  let flight = flights.get(key);
  if (!flight || flight.controller.signal.aborted) {
    const controller = new AbortController();
    const created = { controller, consumers: 0, promise: Promise.resolve({} as ManagedImageResource) };
    created.promise = serializeImageProcessing(async () => { const release = retainCachedAttachment(uri);
      try { return await createPreview(uri, variant, controller.signal, region); } finally { release(); }
    }, controller.signal).finally(() => { if (flights.get(key) === created) flights.delete(key); });
    flights.set(key, created); flight = created;
  }
  const joined = flight; joined.consumers++;
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (value?: ManagedImageResource, error?: unknown) => {
      if (finished) return; finished = true; signal?.removeEventListener('abort', abort);
      joined.consumers--; if (!joined.consumers) joined.controller.abort();
      if (error) reject(error); else resolve(value!);
    };
    const abort = () => finish(undefined, cancelled());
    signal?.addEventListener('abort', abort, { once: true });
    joined.promise.then(value => finish(value), error => finish(undefined, error));
    if (signal?.aborted) abort();
  });
}
