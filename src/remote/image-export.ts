import { Directory, File, FileMode, Paths } from 'expo-file-system';

import { createId } from '../domain-utils';
import { deleteLocalFile, saveToGallery, shareImage } from '../storage/files';
import { attachmentBytes, attachmentMagic, MAX_ATTACHMENT_BYTES } from './attachment-ref';

export type RemoteImageAction = 'save' | 'share';
type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp';
type ExportImage = { uri: string; mime: ImageMime; dispose: () => void };
class ImageExportError extends Error {}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) {
    const error = new Error('图片操作已取消');
    error.name = 'AbortError';
    throw error;
  }
}

function localPath(uri: string): string | undefined {
  if (!/^file:\/\/\//i.test(uri) || uri.length > 4096 || /[\\\r\n\u0000]/.test(uri)) return undefined;
  try {
    // URL normalizes dot segments. Validate them before normalization so a
    // crafted encoded path never resolves to a different local image.
    const originalPath = decodeURIComponent(uri.slice(7).split(/[?#]/, 1)[0]);
    if (originalPath.split('/').some(part => part === '.' || part === '..')) return undefined;
    const parsed = new URL(uri);
    if (parsed.hostname || parsed.search || parsed.hash) return undefined;
    const path = decodeURIComponent(parsed.pathname);
    if (/[\\%\r\n\u0000]/.test(path) || path.split('/').some(part => part === '.' || part === '..')) return undefined;
    return path;
  } catch { return undefined; }
}

/** The viewer receives already-materialized, authorized attachment files.
 * Never turn a Hub URL, signed lease, or arbitrary filesystem path into a new
 * download route or share it as text with another application. */
function ownedImagePath(uri: string): boolean {
  const path = localPath(uri);
  return Boolean(path && [Paths.cache.uri, Paths.document.uri].some(root => {
    const parent = localPath(root);
    return parent && path.startsWith(`${parent.replace(/\/+$/, '')}/`);
  }));
}

function imageMime(bytes: Uint8Array): ImageMime {
  for (const mime of ['image/png', 'image/jpeg', 'image/webp'] as const) {
    if (attachmentMagic(bytes, mime)) return mime;
  }
  throw new ImageExportError('图片内容无效，请重新打开图片');
}

function writeExport(bytes: Uint8Array, mime: ImageMime, signal: AbortSignal): ExportImage {
  const directory = new Directory(Paths.cache, 'salcara-remote-exports');
  directory.create({ idempotent: true, intermediates: true });
  const file = new File(directory, `image-${createId()}.${mime === 'image/jpeg' ? 'jpg' : mime.slice(6)}`);
  try {
    file.create({ overwrite: false, intermediates: true });
    file.write(bytes);
    assertActive(signal);
    return { uri: file.uri, mime, dispose: () => deleteLocalFile(file.uri) };
  } catch (error) {
    deleteLocalFile(file.uri);
    throw error;
  }
}

function prepareImage(uri: string, action: RemoteImageAction, signal: AbortSignal): ExportImage {
  assertActive(signal);
  if (/^data:/i.test(uri)) {
    // Check the entire URI before parsing/copying a potentially large payload.
    if (uri.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 32) throw new ImageExportError('图片太大（最大 8 MB）');
    const data = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/i.exec(uri);
    if (!data) throw new ImageExportError('图片数据无效，请重新打开图片');
    let bytes: Uint8Array;
    try { bytes = attachmentBytes(data[2]); } catch { throw new ImageExportError('图片数据无效或超过 8 MB'); }
    const mime = imageMime(bytes);
    if (mime !== data[1].toLowerCase()) throw new ImageExportError('图片内容和类型不符');
    return writeExport(bytes, mime, signal);
  }
  if (!ownedImagePath(uri)) throw new ImageExportError('请先在对话中读取图片，再保存或分享');
  const file = new File(uri);
  const size = file.size ?? 0;
  if (!file.exists || !Number.isSafeInteger(size) || size <= 0) throw new ImageExportError('图片已不在手机上，请重新打开图片');
  if (size > MAX_ATTACHMENT_BYTES) throw new ImageExportError('图片太大（最大 8 MB）');
  const handle = file.open(FileMode.ReadOnly);
  let bytes: Uint8Array;
  try { bytes = handle.readBytes(size + 1); } finally { handle.close(); }
  if (bytes.length !== size || file.size !== size) throw new ImageExportError('图片内容已变更，请重新打开图片');
  assertActive(signal);
  const mime = imageMime(bytes);
  // Sharing grants another app access to this path. A dedicated copy remains
  // readable even if the original attachment cache is subsequently removed.
  return action === 'share' ? writeExport(bytes, mime, signal) : { uri: file.uri, mime, dispose: () => undefined };
}

/** Uses the same system gallery/share functions as ordinary chat. The original
 * attachment cache is never moved or deleted. Android's chooser result does not
 * mean the receiving app has finished reading its FileProvider URI, so shared
 * copies remain in OS-managed cache. Gallery-only temporary files can be removed
 * once the save operation returns. */
export async function exportRemoteImage(uri: string, action: RemoteImageAction, signal: AbortSignal): Promise<void> {
  const image = prepareImage(uri, action, signal);
  let handedToShare = false;
  try {
    assertActive(signal);
    if (action === 'save') await saveToGallery(image.uri, { signal });
    else { handedToShare = true; await shareImage(image.uri, { mimeType: image.mime, signal }); }
  } finally { if (!handedToShare) image.dispose(); }
}

export function imageExportFailure(error: unknown, action: RemoteImageAction): string {
  if (error instanceof ImageExportError) return error.message;
  const message = error instanceof Error ? error.message : '';
  if (message === '需要允许“保存图片”权限才能写入系统相册。') return '请允许保存图片到相册';
  if (message === '相册保存权限已被关闭，请到系统设置中允许 Salcara AI 保存图片。') return '请在系统设置中允许保存图片';
  if (message === '当前设备不支持系统分享') return message;
  // Native failures can include source paths or authenticated URLs. Keep
  // those details out of the global toast and any external share target.
  return action === 'save' ? '保存失败，请稍后重试' : '分享失败，请稍后重试';
}
