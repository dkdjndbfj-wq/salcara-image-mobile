import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { Platform } from 'react-native';

import type { RemoteImage } from './attachment-chunks';

export { MAX_REMOTE_IMAGES, type RemoteImage } from './attachment-chunks';
const MAX_SIDE = 1600;

async function shrink(asset: { uri: string; width?: number; height?: number }): Promise<RemoteImage> {
  const side = Math.max(asset.width ?? 0, asset.height ?? 0);
  const resize = side > MAX_SIDE ? ((asset.width ?? 0) >= (asset.height ?? 0) ? { width: MAX_SIDE } : { height: MAX_SIDE }) : undefined;
  const out = await manipulateAsync(asset.uri, resize ? [{ resize }] : [], { compress: 0.72, format: SaveFormat.JPEG, base64: true });
  if (!out.base64) throw new Error('图片处理失败');
  return { uri: out.uri, base64: out.base64, mime: 'image/jpeg', width: out.width, height: out.height };
}

export async function pickRemoteImages(source: 'gallery' | 'camera', remaining: number): Promise<RemoteImage[]> {
  if (remaining <= 0) return [];
  if (source === 'camera') {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) throw new Error('需要相机权限才能拍照');
    const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1 });
    return result.canceled ? [] : [await shrink(result.assets[0])];
  }
  if (Platform.OS !== 'ios') {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) throw new Error('需要相册权限才能选择图片');
  }
  const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: remaining > 1, selectionLimit: remaining, quality: 1 });
  if (result.canceled) return [];
  return Promise.all(result.assets.slice(0, remaining).map(shrink));
}
