const mockRequestPermissionsAsync = jest.fn();
const mockCreateAsset = jest.fn();

jest.mock('expo-media-library', () => ({
  requestPermissionsAsync: (...args: unknown[]) => mockRequestPermissionsAsync(...args),
  Asset: { create: (...args: unknown[]) => mockCreateAsset(...args) },
}));

jest.mock('expo-file-system', () => {
  class Directory {
    create = jest.fn();
  }
  class File {
    uri: string;
    exists = true;
    size = 128;
    constructor(uri: string) {
      this.uri = uri;
    }
  }
  return { Directory, File, Paths: { document: 'file:///documents' } };
});

jest.mock('expo-sharing', () => ({}));

import { saveToGallery } from '../storage/files';

describe('gallery saving', () => {
  beforeEach(() => {
    mockRequestPermissionsAsync.mockReset();
    mockCreateAsset.mockReset();
  });

  test('uses write-only photo permission and the Expo 57 Asset API', async () => {
    mockRequestPermissionsAsync.mockResolvedValue({ granted: true, canAskAgain: true });
    mockCreateAsset.mockResolvedValue({ id: 'content://saved' });

    await saveToGallery('file:///documents/generated.png');

    expect(mockRequestPermissionsAsync).toHaveBeenCalledWith(true, ['photo']);
    expect(mockCreateAsset).toHaveBeenCalledWith('file:///documents/generated.png');
  });

  test('explains how to recover when permission cannot be requested again', async () => {
    mockRequestPermissionsAsync.mockResolvedValue({ granted: false, canAskAgain: false });

    await expect(saveToGallery('file:///documents/generated.png')).rejects.toThrow('系统设置');
    expect(mockCreateAsset).not.toHaveBeenCalled();
  });
});
