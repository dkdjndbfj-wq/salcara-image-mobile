import { Directory, File, Paths } from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
import * as Sharing from 'expo-sharing';

import { createId } from '../domain-utils';

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

export class RemoteImageDownloadError extends Error {
  constructor(public readonly remoteImageUrl: string) {
    super('图片已生成，但连接图片服务器失败。请切换网络后点击“重新下载”，不会重复生成或扣费。');
    this.name = 'RemoteImageDownloadError';
  }
}

export async function downloadPng(url: string, signal?: AbortSignal): Promise<string> {
  ensureDirectories();
  const destination = new File(imageDirectory, `${createId()}.png`);
  for (let attempt = 0; attempt <= DOWNLOAD_RETRY_DELAYS_MS.length; attempt += 1) {
    if (signal?.aborted) throw createAbortError();
    try {
      const downloaded = await File.downloadFileAsync(url, destination, {
        idempotent: true,
        signal,
        headers: {
          Accept: 'image/png,image/jpeg,image/webp,image/*;q=0.9,*/*;q=0.5',
          'User-Agent': 'Salcara-Image-Android/1.1.1',
        },
      });
      if (!downloaded.exists || (downloaded.size ?? 0) === 0) {
        throw new Error('Downloaded image is empty');
      }
      return downloaded.uri;
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw error;
      if (attempt < DOWNLOAD_RETRY_DELAYS_MS.length) {
        await delay(DOWNLOAD_RETRY_DELAYS_MS[attempt], signal);
      }
    }
  }

  throw new RemoteImageDownloadError(url);
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

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
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
  const permission = await MediaLibrary.requestPermissionsAsync();
  if (!permission.granted) throw new Error('需要相册权限才能保存图片');
  await MediaLibrary.saveToLibraryAsync(uri);
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
