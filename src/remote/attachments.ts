import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { Platform } from 'react-native';
import { File } from 'expo-file-system';

import type { RemoteImage } from './attachment-chunks';
import { inspectLocalImage, serializeImageProcessing } from './image-preview-cache';
import { previewDimensions } from './image-dimensions';
import { SystemPermissionError } from '../system-permissions';

export { MAX_REMOTE_IMAGES, type RemoteImage, type RemoteImageMime } from './attachment-chunks';
const MAX_SIDE = 1600;
function discardPreparedImage(uri: string): void {
  try { if (Platform.OS === 'web') { if (uri.startsWith('blob:')) URL.revokeObjectURL(uri); }
    else { const file = new File(uri); if (file.exists) file.delete(); } } catch { /* generated temporary output only */ }
}

export async function prepareRemoteImage(asset: { uri: string; width?: number; height?: number }): Promise<RemoteImage> {
  return serializeImageProcessing(async () => {
    const dimensions = await inspectLocalImage(asset.uri);
    const out = await manipulateAsync(asset.uri, [{ resize: previewDimensions(dimensions, 'preview') }], { compress: 0.72, format: SaveFormat.JPEG, base64: true });
    if (!out.base64 || out.width * out.height > 4_000_000 || Math.max(out.width, out.height) > MAX_SIDE) {
      if (out.uri !== asset.uri) discardPreparedImage(out.uri);
      throw new Error('图片处理失败或超出预览尺寸');
    }
    return { uri: out.uri, base64: out.base64, mime: 'image/jpeg', width: out.width, height: out.height };
  });
}

export async function pickRemoteImages(source: 'gallery' | 'camera', remaining: number): Promise<RemoteImage[]> {
  if (remaining <= 0) return [];
  if (source === 'camera') {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) throw new SystemPermissionError('camera', permission.canAskAgain !== false);
    const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1 });
    return result.canceled ? [] : [await prepareRemoteImage(result.assets[0])];
  }
  // Android and iOS system pickers authorize only the chosen photos.
  const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: remaining > 1, selectionLimit: remaining, quality: 1,
    preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible });
  if (result.canceled) return [];
  const images: RemoteImage[] = [];
  const sources = new Set(result.assets.map(asset => asset.uri));
  try { for (const asset of result.assets.slice(0, remaining)) images.push(await prepareRemoteImage(asset)); return images; }
  catch (error) { for (const image of images) if (!sources.has(image.uri)) discardPreparedImage(image.uri); throw error; }
}
