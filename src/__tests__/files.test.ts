const mockRequestPermissionsAsync = jest.fn();
const mockCreateAsset = jest.fn();
const mockFetch = jest.fn();
const mockNativeDownload = jest.fn();
const mockWriteStream = {};

jest.mock('expo/fetch', () => ({ fetch: (...args: unknown[]) => mockFetch(...args) }));

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
    create = jest.fn();
    delete = jest.fn();
    writableStream = () => mockWriteStream;
    static downloadFileAsync = (...args: unknown[]) => mockNativeDownload(...args);
    constructor(...parts: unknown[]) {
      this.uri = parts.length > 1 ? `file:///documents/${parts[1]}` : String(parts[0]);
    }
  }
  return { Directory, File, Paths: { document: 'file:///documents' } };
});

jest.mock('expo-sharing', () => ({}));

import { downloadPng, RemoteImageDownloadError, saveToGallery } from '../storage/files';

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

describe('image download recovery', () => {
  beforeEach(() => { mockFetch.mockReset(); mockNativeDownload.mockReset(); });
  afterEach(() => jest.useRealTimers());

  test('streams image bytes to disk without buffering a 4K image in JavaScript', async () => {
    const pipeTo = jest.fn().mockResolvedValue(undefined);
    mockFetch.mockResolvedValue({ ok: true, headers: { get: () => 'image/png' }, body: { pipeTo } });
    await expect(downloadPng('https://images.example/image.png')).resolves.toMatch(/^file:\/\/\/documents/);
    expect(pipeTo).toHaveBeenCalledWith(mockWriteStream, { signal: expect.any(AbortSignal) });
    expect(mockNativeDownload).not.toHaveBeenCalled();
  });

  test('preserves the already-generated URL when a user cancels downloading', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(downloadPng('https://images.example/image.png?signature=secret', controller.signal)).rejects.toMatchObject({
      remoteImageUrl: 'https://images.example/image.png?signature=secret', cancelled: true,
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('stops after two download retries and includes host but no signed query in the error', async () => {
    jest.useFakeTimers();
    mockFetch.mockRejectedValue(new Error('Network request failed'));
    mockNativeDownload.mockRejectedValue(new Error('SocketTimeoutException'));
    const task = downloadPng('https://images.example/image.png?signature=secret');
    const assertion = expect(task).rejects.toThrow(RemoteImageDownloadError);
    await jest.runAllTimersAsync();
    await assertion;
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockNativeDownload).toHaveBeenCalledTimes(1);
    await expect(task).rejects.toThrow('images.example');
    await expect(task).rejects.not.toThrow('signature=secret');
  });
});
