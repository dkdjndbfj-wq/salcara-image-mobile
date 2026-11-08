import * as DocumentPicker from 'expo-document-picker';
// Keep the binary helpers platform-independent without importing native modules eagerly.
export { decodePreviewBytes, encodePreviewBytes, PREVIEW_TRANSFER_LIMIT } from './preview-transfer-bytes';
import { PREVIEW_TRANSFER_LIMIT } from './preview-transfer-bytes';

export async function pickPreviewUpload(): Promise<{ name: string; bytes: Uint8Array } | null> {
  const result = await DocumentPicker.getDocumentAsync({ multiple: false, copyToCacheDirectory: false });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if ((asset.size ?? 0) > PREVIEW_TRANSFER_LIMIT) throw new Error('请选择不超过 8 MB 的文件');
  const blob = asset.file ?? await (await fetch(asset.uri)).blob();
  if (blob.size > PREVIEW_TRANSFER_LIMIT) throw new Error('请选择不超过 8 MB 的文件');
  return { name: asset.name, bytes: new Uint8Array(await blob.arrayBuffer()) };
}
export async function savePreviewDownload(name: string, bytes: Uint8Array): Promise<void> {
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes).buffer]));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
