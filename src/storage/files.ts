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

export async function downloadPng(url: string): Promise<string> {
  ensureDirectories();
  const destination = new File(imageDirectory, `${createId()}.png`);
  const downloaded = await File.downloadFileAsync(url, destination, { idempotent: true });
  return downloaded.uri;
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
