import { Directory, File, Paths } from 'expo-file-system';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { Platform } from 'react-native';

import { createId } from '../domain-utils';
import { deleteLocalFile } from '../storage/files';
import { SystemPermissionError } from '../system-permissions';

/** Character avatars: a square crop from the gallery or camera, kept small and private to the app. */

let avatarDirectory: Directory | undefined;
function getAvatarDirectory(): Directory {
  if (Platform.OS === 'web') throw new Error('头像本地保存仅支持移动端');
  return avatarDirectory ??= new Directory(Paths.document, 'avatars');
}

export async function pickAvatar(source: 'library' | 'camera'): Promise<string | null> {
  // System photo pickers grant selected-item access without library permission.
  if (source === 'camera') {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) throw new SystemPermissionError('camera', permission.canAskAgain !== false);
  }
  const result = source === 'camera'
    ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 1 })
    : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 1 });
  if (result.canceled || !result.assets[0]) return null;
  const asset = result.assets[0];
  // Centre-crop again in case the picker ignored the aspect ratio, then shrink to a crisp 512px square.
  const side = Math.min(asset.width || 512, asset.height || 512);
  const actions = asset.width && asset.height && asset.width !== asset.height
    ? [{ crop: { originX: Math.round((asset.width - side) / 2), originY: Math.round((asset.height - side) / 2), width: side, height: side } }, { resize: { width: 512, height: 512 } }]
    : [{ resize: { width: 512, height: 512 } }];
  const output = await manipulateAsync(asset.uri, actions, { compress: 0.88, format: SaveFormat.JPEG });
  const directory = getAvatarDirectory();
  directory.create({ idempotent: true, intermediates: true });
  const destination = new File(directory, `${createId()}.jpg`);
  await new File(output.uri).copy(destination, { overwrite: true });
  deleteLocalFile(output.uri);
  return destination.uri;
}

/** Removes an avatar file that is no longer used (only files the app created). */
export function deleteAvatar(uri: string | null | undefined): void {
  if (uri && uri.includes('/avatars/')) deleteLocalFile(uri);
}
