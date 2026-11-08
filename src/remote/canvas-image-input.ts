import * as FileSystem from 'expo-file-system/legacy';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { Image } from 'react-native';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { attachmentBytes, attachmentMagic, MAX_ATTACHMENT_BYTES } from './attachment-ref';
import { MAX_REMOTE_IMAGES, type RemoteImage, type RemoteImageMime } from './attachment-chunks';
import { canvasImageKey, type CanvasImage } from './conversation-images';
import { verifyManagedQueuedImage } from './queued-image-files';

export interface CanvasImageInputGuard { isCurrent: () => boolean; signal?: AbortSignal }
const MAX_BASE64 = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4;
const supported = ['image/png', 'image/jpeg', 'image/webp'] as const;
function dimensions(width: unknown, height: unknown): width is number {
  return Number.isSafeInteger(width) && Number(width) > 0 && Number(width) <= 20_000
    && Number.isSafeInteger(height) && Number(height) > 0 && Number(height) <= 20_000;
}
function guard(options: CanvasImageInputGuard) {
  if (options.signal?.aborted || !options.isCurrent()) {
    const error = new Error('电脑或会话已切换，图片批注尚未添加'); error.name = 'AbortError'; throw error;
  }
}
function decode(base64: string): { bytes: Uint8Array; mime: RemoteImageMime } {
  if (base64.length > MAX_BASE64) throw new Error('图片太大（每张最大 8 MB），批注仍保留在画布');
  const bytes = attachmentBytes(base64), mime = supported.find(value => attachmentMagic(bytes, value));
  if (!mime) throw new Error('图片内容无效，请重新读取原图');
  return { bytes, mime };
}
async function imageSize(uri: string, image: CanvasImage, options: CanvasImageInputGuard) {
  if (dimensions(image.width, image.height)) return { width: image.width, height: image.height! };
  const size = await new Promise<{ width: number; height: number }>((resolve, reject) => {
    const abort = () => { cleanup(); reject(Object.assign(new Error('图片操作已取消'), { name: 'AbortError' })); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('图片尺寸读取超时，请重新打开原图')); }, 15_000);
    const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); };
    options.signal?.addEventListener('abort', abort, { once: true });
    try { Image.getSize(uri, (width, height) => { cleanup(); resolve({ width, height }); }, () => { cleanup(); reject(new Error('图片无法解码，请重新读取原图')); }); }
    catch { cleanup(); reject(new Error('图片无法解码，请重新读取原图')); }
  });
  guard(options);
  if (!dimensions(size.width, size.height)) throw new Error('图片尺寸无效，批注仍保留在画布');
  return size;
}
function verifySource(image: CanvasImage, bytes: Uint8Array, mime: string) {
  if (image.ref && (image.ref.mime.toLowerCase() !== mime || image.ref.size !== undefined && image.ref.size !== bytes.length
    || image.ref.sha256 && bytesToHex(sha256(bytes)) !== image.ref.sha256)) throw new Error('图片原文件已变化，请重新读取后确认批注');
}

/** Uses only image bytes already loaded by this conversation; never fetches a URL. */
export async function prepareCanvasImageInput(images: readonly CanvasImage[], options: CanvasImageInputGuard): Promise<RemoteImage[]> {
  guard(options);
  const unique = [...new Map(images.map(image => [canvasImageKey(image), { ...image, ref: image.ref ? { ...image.ref } : undefined }])).values()];
  if (!unique.length) throw new Error('没有可添加的图片，请先添加批注');
  if (unique.length > MAX_REMOTE_IMAGES) throw new Error(`每次最多添加 ${MAX_REMOTE_IMAGES} 张图片，请分批添加批注`);
  const output: RemoteImage[] = [];
  // Read sequentially so the native decoder never materializes four originals at once.
  for (const image of unique) {
    guard(options);
    const uri = image.uri;
    if (!uri) throw new Error(`“${image.name}”的原图尚未载入，请打开图片后重试；批注已保留`);
    let base64: string, sourceURI = uri, convertedSize: { width: number; height: number } | undefined;
    let decoded: ReturnType<typeof decode> | undefined;
    if (/^data:image\/svg\+xml[;,]/i.test(uri)) {
      if (uri.length > 1_500_000) throw new Error('矢量图片太大，请先导出为 PNG 后添加');
      const embedded = /^data:image\/svg\+xml(?:;charset=utf-8)?(;base64)?,(.*)$/is.exec(uri);
      if (!embedded) throw new Error('矢量图片格式无效');
      let source: string;
      try { source = embedded[1] ? new TextDecoder().decode(attachmentBytes(embedded[2], 1024 * 1024)) : decodeURIComponent(embedded[2]); }
      catch { throw new Error('矢量图片格式无效'); }
      // The native converter must not follow external resources embedded in SVG.
      if (!/<svg\b/i.test(source) || /<!DOCTYPE|<!ENTITY|<script\b|<foreignObject\b|<iframe\b|<image\b|\b(?:href|src)\s*=|@import|url\(\s*[^#\s]/i.test(source)) throw new Error('该矢量图片引用了外部内容，请先导出为 PNG 后添加');
      const size = await imageSize(uri, image, options); guard(options);
      const resize = Math.max(size.width, size.height) > 1600 ? [{ resize: size.width >= size.height ? { width: 1600 } : { height: 1600 } }] : [];
      const converted = await manipulateAsync(uri, resize, { format: SaveFormat.PNG, base64: true, compress: 1 }); guard(options);
      if (!converted.base64 || !dimensions(converted.width, converted.height)) throw new Error('矢量图片转换失败，批注已保留');
      base64 = converted.base64; convertedSize = { width: converted.width, height: converted.height };
      sourceURI = `data:image/png;base64,${base64}`;
    } else if (/^data:/i.test(uri)) {
      if (uri.length > MAX_BASE64 + 64) throw new Error('图片太大（每张最大 8 MB），批注仍保留在画布');
      const embedded = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/i.exec(uri);
      if (!embedded) throw new Error('图片格式不支持，请先转换为 PNG、JPEG 或 WebP');
      base64 = embedded[2];
      decoded = decode(base64);
      if (decoded.mime !== embedded[1].toLowerCase()) throw new Error('图片内容和类型不符');
    } else if (/^(?:file|content):\/\//i.test(uri) && uri.length <= 4096 && !/[\r\n\u0000]/.test(uri)) {
      const info = await FileSystem.getInfoAsync(uri); guard(options);
      if (!info.exists || info.isDirectory || !Number.isSafeInteger(info.size) || info.size <= 0) throw new Error('原图已不存在或尚未读取完整，请重新打开图片');
      if (info.size > MAX_ATTACHMENT_BYTES) throw new Error('图片太大（每张最大 8 MB），批注仍保留在画布');
      base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 }); guard(options);
      decoded = decode(base64);
      if (decoded.bytes.length !== info.size) throw new Error('原图读取期间发生变化，请重新打开图片');
      await verifyManagedQueuedImage(uri, decoded.mime, base64); guard(options);
    } else throw new Error('原图尚未下载到本会话，请打开图片读取完成后重试；批注已保留');
    const { bytes, mime } = decoded ?? decode(base64);
    if (!convertedSize) verifySource(image, bytes, mime);
    const size = convertedSize ?? await imageSize(sourceURI, image, options); guard(options);
    output.push({ uri: sourceURI, base64, mime, ...size });
  }
  guard(options);
  return output;
}
