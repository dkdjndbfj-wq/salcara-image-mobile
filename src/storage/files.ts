import { Directory, File, Paths } from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
import * as Sharing from 'expo-sharing';
import { fetch } from 'expo/fetch';

import { createId } from '../domain-utils';
import { networkFailureMessage, networkHost } from '../api/network';

const imageDirectory = new Directory(Paths.document, 'generated-images');
const referenceDirectory = new Directory(Paths.document, 'reference-images');

function ensureDirectories(): void {
  imageDirectory.create({ idempotent: true, intermediates: true });
  referenceDirectory.create({ idempotent: true, intermediates: true });
}

export function saveBase64Png(base64: string): string {
  ensureDirectories();
  const file = new File(imageDirectory, `${createId()}.png`);
  file.create({ overwrite: true, intermediates: true });
  file.write(base64, { encoding: 'base64' });
  return file.uri;
}

const DOWNLOAD_RETRY_DELAYS_MS = [700, 1_800] as const;

class ImageDownloadHttpError extends Error {
  constructor(public readonly status: number) { super(`HTTP ${status}`); }
}

export class RemoteImageDownloadError extends Error {
  constructor(public readonly remoteImageUrl: string, public readonly cancelled = false, detail?: string) {
    super(cancelled
      ? '图片已生成，下载已暂停。点击“重新下载”继续获取这张图片，不会重复生成或扣费。'
      : `${detail || `图片下载失败（${networkHost(remoteImageUrl)}）`}\n图片已生成，点击“重新下载”只获取原图，不会重复生成或扣费。如果网站可用但此图片域名无法连接，请联系服务商启用图片内嵌返回。`);
    this.name = 'RemoteImageDownloadError';
  }
}

export async function downloadPng(url: string, signal?: AbortSignal): Promise<string> {
  ensureDirectories();
  const destination = new File(imageDirectory, `${createId()}.png`);
  let detail: string | undefined;
  for (let attempt = 0; attempt <= DOWNLOAD_RETRY_DELAYS_MS.length; attempt += 1) {
    if (signal?.aborted) throw new RemoteImageDownloadError(url, true);
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), 90_000);
    try {
      // Use Expo's explicitly selected streaming transport, instead of relying on
      // the global fetch polyfill or buffering a large 4K image entirely in JS.
      // Keep the native downloader as the last non-billable alternate transport.
      const downloaded = attempt === DOWNLOAD_RETRY_DELAYS_MS.length
        ? await File.downloadFileAsync(url, destination, {
            idempotent: true,
            signal: controller.signal,
            headers: imageDownloadHeaders(),
          })
        : await downloadWithFetch(url, destination, controller.signal);
      if (!downloaded.exists || (downloaded.size ?? 0) === 0) {
        throw new Error('Downloaded image is empty');
      }
      return downloaded.uri;
    } catch (error) {
      deleteLocalFile(destination.uri);
      if (signal?.aborted) throw new RemoteImageDownloadError(url, true);
      if (error instanceof ImageDownloadHttpError && [400, 401, 403, 404, 410].includes(error.status)) {
        throw new RemoteImageDownloadError(url, false,
          `图片服务器 ${networkHost(url)} 返回 HTTP ${error.status}，图片地址可能已过期或被拒绝访问。`);
      }
      detail = controller.signal.aborted
        ? `图片下载超时（${networkHost(url)}）。`
        : networkFailureMessage(url, '图片服务器', error);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    try {
      if (attempt < DOWNLOAD_RETRY_DELAYS_MS.length) {
        await delay(DOWNLOAD_RETRY_DELAYS_MS[attempt], signal);
      }
    } catch {
      throw new RemoteImageDownloadError(url, true);
    }
  }

  throw new RemoteImageDownloadError(url, false, detail);
}

function imageDownloadHeaders(): Record<string, string> {
  return {
    Accept: 'image/png,image/jpeg,image/webp,image/*;q=0.9,*/*;q=0.5',
    'User-Agent': 'Salcara-Image-Android',
  };
}

async function downloadWithFetch(url: string, destination: File, signal?: AbortSignal): Promise<File> {
  const response = await fetch(url, { headers: imageDownloadHeaders(), signal, credentials: 'omit' });
  if (!response.ok) throw new ImageDownloadHttpError(response.status);
  const contentType = response.headers.get('content-type')?.split(';')[0].toLowerCase();
  if (contentType && !contentType.startsWith('image/') && contentType !== 'application/octet-stream') {
    throw new Error('图片服务器没有返回图片');
  }
  if (!response.body) throw new Error('Downloaded image is empty');
  destination.create({ overwrite: true, intermediates: true });
  await response.body.pipeTo(destination.writableStream(), { signal });
  return destination;
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function createAbortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

export async function persistReference(uri: string, extension = '.png'): Promise<string> {
  ensureDirectories();
  const source = new File(uri);
  const safeExtension = ['.png', '.jpg', '.jpeg', '.webp'].includes(extension.toLowerCase())
    ? extension.toLowerCase()
    : '.png';
  const destination = new File(referenceDirectory, `${createId()}${safeExtension}`);
  await source.copy(destination, { overwrite: true });
  return destination.uri;
}

export function deleteLocalFile(uri: string | null | undefined): void {
  if (!uri || !uri.startsWith('file://')) return;
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // Cleanup is best effort; callers should not fail user data operations.
  }
}

export async function saveToGallery(uri: string): Promise<void> {
  const file = new File(uri);
  if (!file.exists || (file.size ?? 0) === 0) {
    throw new Error('本地图片文件不存在，请先重新下载图片。');
  }

  // Only request permission to add a photo. Requesting full read access on
  // Android 13+ is unnecessary and can make saving fail after the user chooses
  // limited/denied access.
  const permission = await MediaLibrary.requestPermissionsAsync(true, ['photo']);
  if (!permission.granted) {
    throw new Error(permission.canAskAgain
      ? '需要允许“保存图片”权限才能写入系统相册。'
      : '相册保存权限已被关闭，请到系统设置中允许 Salcara Image 保存图片。');
  }

  try {
    // Expo 57 removed the old saveToLibraryAsync implementation. Asset.create
    // writes through Android MediaStore and works with scoped storage.
    await MediaLibrary.Asset.create(file.uri);
  } catch (error) {
    const detail = error instanceof Error ? error.message : '';
    throw new Error(detail ? `写入系统相册失败：${detail}` : '写入系统相册失败，请检查存储空间后重试。');
  }
}

export async function shareImage(uri: string): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) throw new Error('当前设备不支持系统分享');
  await Sharing.shareAsync(uri, { mimeType: 'image/png', dialogTitle: '分享生成图片' });
}

export function fileSize(uri: string): number {
  try {
    return new File(uri).size ?? 0;
  } catch {
    return 0;
  }
}

export async function fileBase64(uri: string): Promise<string> {
  return new File(uri).base64();
}
