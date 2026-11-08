import * as DocumentPicker from 'expo-document-picker';

export { decodePreviewBytes, encodePreviewBytes, PREVIEW_TRANSFER_LIMIT } from './preview-transfer-bytes';
import { decodePreviewBytes, PREVIEW_TRANSFER_LIMIT } from './preview-transfer-bytes';
export async function pickPreviewUpload(): Promise<{ name: string; bytes: Uint8Array } | null> {
  const result = await DocumentPicker.getDocumentAsync({ multiple: false, copyToCacheDirectory: true });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if ((asset.size ?? 0) > PREVIEW_TRANSFER_LIMIT) throw new Error('请选择不超过 8 MB 的文件');
  const { File } = await import('expo-file-system');
  const file = new File(asset.uri);
  if (file.size > PREVIEW_TRANSFER_LIMIT) throw new Error('请选择不超过 8 MB 的文件');
  const bytes = decodePreviewBytes(await file.base64());
  if (bytes.length > PREVIEW_TRANSFER_LIMIT) throw new Error('请选择不超过 8 MB 的文件');
  return { name: asset.name, bytes };
}
export async function savePreviewDownload(name: string, bytes: Uint8Array): Promise<void> {
  const { File, Directory, Paths } = await import('expo-file-system');
  const Sharing = await import('expo-sharing');
  if (!await Sharing.isAvailableAsync()) throw new Error('此设备暂不支持保存或分享下载文件');
  const directory = new Directory(Paths.cache, `web-download-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  directory.create();
  const file = new File(directory, name);
  try { file.write(bytes); await Sharing.shareAsync(file.uri, { dialogTitle: '保存网页下载文件' }); }
  finally { directory.delete(); }
}
