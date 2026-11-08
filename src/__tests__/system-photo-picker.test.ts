const mockLibraryPermission = jest.fn(), mockCameraPermission = jest.fn(), mockLibrary = jest.fn(), mockCamera = jest.fn();
jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: (...args: unknown[]) => mockLibraryPermission(...args),
  requestCameraPermissionsAsync: (...args: unknown[]) => mockCameraPermission(...args),
  launchImageLibraryAsync: (...args: unknown[]) => mockLibrary(...args),
  launchCameraAsync: (...args: unknown[]) => mockCamera(...args),
  UIImagePickerPreferredAssetRepresentationMode: { Compatible: 'compatible' },
}));
jest.mock('expo-image-manipulator', () => ({ manipulateAsync: jest.fn(), SaveFormat: { JPEG: 'jpeg', PNG: 'png' } }));
jest.mock('../storage/files', () => ({ fileSize: jest.fn(), persistReference: jest.fn(), deleteLocalFile: jest.fn() }));
jest.mock('../remote/image-preview-cache', () => ({ inspectLocalImage: jest.fn(), serializeImageProcessing: jest.fn() }));
import { Platform } from 'react-native';
import { pickFromGallery, takePhoto } from '../image-inputs';
import { pickAvatar } from '../companion/avatar';
import { pickRemoteImages } from '../remote/attachments';

const originalOS = Platform.OS;
beforeEach(() => {
  jest.clearAllMocks();
  mockLibraryPermission.mockResolvedValue({ granted: false, canAskAgain: false });
  mockCameraPermission.mockResolvedValue({ granted: false, canAskAgain: false });
  mockLibrary.mockResolvedValue({ canceled: true, assets: null });
  mockCamera.mockResolvedValue({ canceled: true, assets: null });
});
afterEach(() => { Object.defineProperty(Platform, 'OS', { configurable: true, value: originalOS }); });

test.each(['android', 'ios'])('%s photo selection still works without broad library access in every entry point', async (os) => {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: os });
  await expect(pickFromGallery(2)).resolves.toEqual([]);
  await expect(pickAvatar('library')).resolves.toBeNull();
  await expect(pickRemoteImages('gallery', 2)).resolves.toEqual([]);
  expect(mockLibrary).toHaveBeenCalledTimes(3);
  expect(mockLibraryPermission).not.toHaveBeenCalled();
  expect(mockCameraPermission).not.toHaveBeenCalled();
});

test('denied camera permission blocks capture and propagates recovery metadata in every entry point', async () => {
  for (const pick of [() => takePhoto(), () => pickAvatar('camera'), () => pickRemoteImages('camera', 1)]) {
    await expect(pick()).rejects.toMatchObject({ permission: 'camera', canAskAgain: false });
  }
  expect(mockCameraPermission).toHaveBeenCalledTimes(3);
  expect(mockCamera).not.toHaveBeenCalled();
});

test('after granting camera permission, cancelling the system camera returns no attachment', async () => {
  mockCameraPermission.mockResolvedValue({ granted: true });
  await expect(takePhoto()).resolves.toEqual([]);
  await expect(pickAvatar('camera')).resolves.toBeNull();
  await expect(pickRemoteImages('camera', 1)).resolves.toEqual([]);
  expect(mockCamera).toHaveBeenCalledTimes(3);
});
