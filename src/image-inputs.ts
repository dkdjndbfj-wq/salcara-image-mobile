import * as DocumentPicker from 'expo-document-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { File } from 'expo-file-system';
import { Image } from 'react-native';

import type { ReferenceImage } from './domain';
import { createId } from './domain-utils';
import { fileSize, persistReference } from './storage/files';

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_MASK_SIDE = 2048;
const VALID_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

type InputAsset = {
  uri: string;
  name?: string | null;
  mimeType?: string | null;
  fileSize?: number | null;
  width?: number;
  height?: number;
};

export async function pickFromGallery(remaining: number): Promise<ReferenceImage[]> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) throw new Error('需要相册权限才能选择参考图');
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: remaining > 1,
    selectionLimit: remaining,
    quality: 1,
  });
  if (result.canceled) return [];
  return Promise.all(
    result.assets.slice(0, remaining).map((asset) =>
      prepareAsset({
        uri: asset.uri,
        name: asset.fileName,
        mimeType: asset.mimeType,
        fileSize: asset.fileSize,
        width: asset.width,
        height: asset.height,
      }),
    ),
  );
}

export async function takePhoto(): Promise<ReferenceImage[]> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) throw new Error('需要相机权限才能拍摄参考图');
  const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1 });
  if (result.canceled) return [];
  const asset = result.assets[0];
  return [
    await prepareAsset({
      uri: asset.uri,
      name: asset.fileName,
      mimeType: asset.mimeType,
      fileSize: asset.fileSize,
      width: asset.width,
      height: asset.height,
    }),
  ];
}

export async function pickFromFiles(remaining: number): Promise<ReferenceImage[]> {
  const result = await DocumentPicker.getDocumentAsync({
    type: VALID_MIME_TYPES as unknown as string[],
    multiple: remaining > 1,
    copyToCacheDirectory: true,
  });
  if (result.canceled) return [];
  return Promise.all(
    result.assets.slice(0, remaining).map((asset) =>
      prepareAsset({ uri: asset.uri, name: asset.name, mimeType: asset.mimeType, fileSize: asset.size }),
    ),
  );
}

export async function createReferenceFromGenerated(uri: string): Promise<ReferenceImage> {
  return prepareAsset({ uri, name: 'generated-reference.png', mimeType: 'image/png', fileSize: fileSize(uri) });
}

/** Convert an image returned by the general file picker to a supported,
 * private reference asset (PNG/JPEG/WebP). This also handles HEIC/GIF and
 * oversized images instead of relabelling their bytes as PNG. */
export async function prepareReferenceFromAttachment(asset: { uri: string; name: string; mimeType: string; size: number }): Promise<ReferenceImage> {
  return prepareAsset({ uri: asset.uri, name: asset.name, mimeType: asset.mimeType, fileSize: asset.size });
}

export async function prepareReferenceForMask(image: ReferenceImage): Promise<ReferenceImage> {
  const dimensions = image.width && image.height
    ? { width: image.width, height: image.height }
    : await getImageSize(image.uri);
  const knownMaxSide = Math.max(dimensions.width, dimensions.height);
  if (image.mimeType === 'image/png' && knownMaxSide <= MAX_MASK_SIDE) return { ...image, ...dimensions };

  const resize = knownMaxSide > MAX_MASK_SIDE
    ? dimensions.width >= dimensions.height
      ? { width: MAX_MASK_SIDE }
      : { height: MAX_MASK_SIDE }
    : undefined;
  const result = await manipulateAsync(image.uri, resize ? [{ resize }] : [], { format: SaveFormat.PNG });
  const persistedUri = await persistReference(result.uri, '.png');
  return {
    ...image,
    uri: persistedUri,
    name: `${image.name.replace(/\.[^.]+$/, '')}-mask-source.png`,
    mimeType: 'image/png',
    size: fileSize(persistedUri),
    width: result.width,
    height: result.height,
  };
}

function getImageSize(uri: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    Image.getSize(uri, (width, height) => resolve({ width, height }), () => reject(new Error('无法读取主图尺寸')));
  });
}

async function prepareAsset(asset: InputAsset): Promise<ReferenceImage> {
  let mimeType = normalizeMimeType(asset.mimeType, asset.name, asset.uri);
  let sourceUri = asset.uri;
  let size = asset.fileSize ?? fileSize(sourceUri);
  let width = asset.width;
  let height = asset.height;
  const supportedInput = isSupportedInput(asset.mimeType, asset.name, asset.uri);

  if (size > MAX_FILE_BYTES || !supportedInput) {
    const maxSide = Math.max(width ?? 0, height ?? 0);
    const resize = maxSide > 2048
      ? width && height && width >= height
        ? { width: 2048 }
        : { height: 2048 }
      : undefined;
    const result = await manipulateAsync(
      sourceUri,
      resize ? [{ resize }] : [],
      { compress: 0.86, format: SaveFormat.JPEG },
    );
    sourceUri = result.uri;
    mimeType = 'image/jpeg';
    width = result.width;
    height = result.height;
    size = new File(sourceUri).size ?? 0;
    if (size > MAX_FILE_BYTES) throw new Error('图片压缩后仍超过 20MB，请选择更小的图片');
  }

  const extension = mimeType === 'image/png' ? '.png' : mimeType === 'image/webp' ? '.webp' : '.jpg';
  const persistedUri = await persistReference(sourceUri, extension);
  return {
    id: createId(),
    uri: persistedUri,
    name: asset.name || `reference-${Date.now()}${extension}`,
    mimeType,
    size: new File(persistedUri).size ?? size,
    width,
    height,
  };
}

function isSupportedInput(mimeType?: string | null, name?: string | null, uri?: string): boolean {
  const normalized = mimeType?.toLowerCase();
  if (VALID_MIME_TYPES.includes(normalized as (typeof VALID_MIME_TYPES)[number])) return true;
  const value = `${name ?? ''} ${uri ?? ''}`.toLowerCase();
  return /\.(png|jpe?g|webp)(?:\?|\s|$)/.test(value);
}

function normalizeMimeType(mimeType?: string | null, name?: string | null, uri?: string): ReferenceImage['mimeType'] {
  const normalized = mimeType?.toLowerCase();
  if (normalized === 'image/png' || normalized === 'image/jpeg' || normalized === 'image/webp') return normalized;
  const value = `${name ?? ''} ${uri ?? ''}`.toLowerCase();
  if (value.includes('.png')) return 'image/png';
  if (value.includes('.webp')) return 'image/webp';
  return 'image/jpeg';
}
