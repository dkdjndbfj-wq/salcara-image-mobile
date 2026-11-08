type MockImageFile = { bytes: Uint8Array; size?: number; readBytes?: Uint8Array; afterReadSize?: number };
const mockImages = new Map<string, MockImageFile>();
const mockSave = jest.fn();
const mockShare = jest.fn();
const mockFileConstructed = jest.fn();
const mockRead = jest.fn();
const mockClose = jest.fn();
const mockDeleted = jest.fn();
const mockCreated = jest.fn();
let mockNextId = 0;

jest.mock('../domain-utils', () => ({ createId: () => `export-${++mockNextId}` }));
jest.mock('../storage/files', () => ({
  saveToGallery: (...args: unknown[]) => mockSave(...args),
  shareImage: (...args: unknown[]) => mockShare(...args),
  deleteLocalFile: (uri: string) => { mockDeleted(uri); mockImages.delete(uri); },
}));
jest.mock('expo-file-system', () => {
  const join = (parts: (string | { uri: string })[]) => parts.map((part, index) => {
    const uri = typeof part === 'string' ? part : part.uri;
    return index ? uri.replace(/^\/+|\/+$/g, '') : uri.replace(/\/+$/, '');
  }).join('/');
  class Directory {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) { this.uri = join(parts); }
    create() {}
  }
  class File {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) { this.uri = join(parts); mockFileConstructed(this.uri); }
    get exists() { return mockImages.has(this.uri); }
    get size() { const item = mockImages.get(this.uri); return item?.size ?? item?.bytes.length ?? 0; }
    create() { mockCreated(this.uri); mockImages.set(this.uri, { bytes: new Uint8Array() }); }
    write(bytes: Uint8Array) { mockImages.set(this.uri, { bytes: new Uint8Array(bytes) }); }
    open(mode: string) {
      const uri = this.uri;
      return {
        readBytes: (maximum: number) => {
          mockRead(uri, maximum, mode);
          const item = mockImages.get(uri)!;
          if (item.afterReadSize !== undefined) item.size = item.afterReadSize;
          return (item.readBytes ?? item.bytes).slice(0, maximum);
        },
        close: () => mockClose(uri),
      };
    }
  }
  return { Directory, File, FileMode: { ReadOnly: 'r' }, Paths: { cache: { uri: 'file:///app/cache/' }, document: { uri: 'file:///app/documents/' } } };
});

import { exportRemoteImage, imageExportFailure } from '../remote/image-export';
import { MAX_ATTACHMENT_BYTES } from '../remote/attachment-ref';

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const jpeg = new Uint8Array([255, 216, 255, 0]);
const webp = new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80, 0]);
const inline = (mime: string, bytes: Uint8Array) => `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
const signal = () => new AbortController().signal;

beforeEach(() => {
  jest.clearAllMocks();
  mockSave.mockReset().mockResolvedValue(undefined); mockShare.mockReset().mockResolvedValue(undefined);
  mockImages.clear(); mockNextId = 0;
});

test.each([
  ['image/png', 'png', png], ['image/jpeg', 'jpg', jpeg], ['image/webp', 'webp', webp],
] as const)('shares inline %s through a bounded local file with its actual MIME', async (mime, extension, bytes) => {
  const active = signal();
  mockShare.mockImplementation(async (uri: string) => { expect(mockImages.get(uri)?.bytes).toEqual(bytes); });
  await exportRemoteImage(inline(mime, bytes), 'share', active);
  const uri = `file:///app/cache/salcara-remote-exports/image-export-1.${extension}`;
  expect(mockShare).toHaveBeenCalledWith(uri, { mimeType: mime, signal: active });
  // Native chooser completion does not guarantee the receiver consumed it.
  expect(mockDeleted).not.toHaveBeenCalled();
  expect(mockImages.get(uri)?.bytes).toEqual(bytes);
});

test('saving an inline image keeps its temporary file until the system action completes', async () => {
  let finish!: () => void;
  mockSave.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
  const controller = new AbortController();
  const saving = exportRemoteImage(inline('image/png', png), 'save', controller.signal);
  const uri = mockSave.mock.calls[0][0] as string;
  expect(mockImages.has(uri)).toBe(true);
  controller.abort();
  expect(mockImages.has(uri)).toBe(true);
  finish(); await saving;
  expect(mockDeleted).toHaveBeenCalledWith(uri);
});

test('a failed system share preserves its exported copy if native sharing may already have exposed it', async () => {
  const source = 'file:///app/documents/source.png'; mockImages.set(source, { bytes: png });
  mockShare.mockRejectedValue(new Error('native share failed'));
  await expect(exportRemoteImage(inline('image/png', png), 'share', signal())).rejects.toThrow('native share failed');
  expect(mockImages.get(source)?.bytes).toEqual(png);
  expect(mockImages.has('file:///app/cache/salcara-remote-exports/image-export-1.png')).toBe(true);
  expect(mockDeleted).not.toHaveBeenCalled();
});

test.each(['file:///app/cache/remote/image.png', 'file:///app/documents/remote/image.png'])('saving an already-authorized local image leaves its source intact: %s', async uri => {
  mockImages.set(uri, { bytes: png }); const active = signal();
  await exportRemoteImage(uri, 'save', active);
  expect(mockSave).toHaveBeenCalledWith(uri, { signal: active });
  expect(mockRead).toHaveBeenCalledWith(uri, png.length + 1, 'r');
  expect(mockClose).toHaveBeenCalledWith(uri);
  expect(mockImages.get(uri)?.bytes).toEqual(png);
  expect(mockCreated).not.toHaveBeenCalled(); expect(mockDeleted).not.toHaveBeenCalled();
});

test.each([['image/jpeg', 'jpg', jpeg], ['image/webp', 'webp', webp]] as const)('sharing uses content MIME %s even if the cached file has a different extension', async (mime, extension, bytes) => {
  const uri = 'file:///app/cache/image.png'; mockImages.set(uri, { bytes });
  const active = signal(); await exportRemoteImage(uri, 'share', active);
  const copy = `file:///app/cache/salcara-remote-exports/image-export-1.${extension}`;
  expect(mockShare).toHaveBeenCalledWith(copy, { mimeType: mime, signal: active });
  mockImages.delete(uri);
  expect(mockImages.get(copy)?.bytes).toEqual(bytes);
  expect(mockDeleted).not.toHaveBeenCalled();
});

test.each([
  'https://hub.example/attachment?lease=private-secret',
  'https://user:password@hub.example/image.png',
  'content://media/images/1',
  'file:///other-app/image.png',
  'file:///app/cache-sibling/image.png',
  'file://remote-host/app/cache/image.png',
  'file:///app/cache/image.png?lease=private-secret',
  'file:///app/cache/image.png#fragment',
  'file:///app/cache/../documents/image.png',
  'file:///app/cache/%2e%2e/documents/image.png',
  'file:///app/cache/%252e%252e/image.png',
  'file:///app/cache/%5cimage.png',
] )('rejects unowned or ambiguous sources before touching the filesystem: %s', async uri => {
  const error = await exportRemoteImage(uri, 'share', signal()).catch(value => value);
  expect(error).toBeInstanceOf(Error);
  expect(imageExportFailure(error, 'share')).not.toMatch(/private-secret|password|hub\.example/);
  expect(mockFileConstructed).not.toHaveBeenCalled(); expect(mockRead).not.toHaveBeenCalled();
  expect(mockSave).not.toHaveBeenCalled(); expect(mockShare).not.toHaveBeenCalled();
});

test.each([
  'data:image/png;base64,not-valid-base64!',
  'data:image/png;base64,A===',
  'data:image/png;base64,',
  'data:image/svg+xml;base64,PHN2Zz4=',
  'data:image/png;base64,PGh0bWw+',
  inline('image/jpeg', png),
])('rejects invalid or mismatched inline image content', async uri => {
  await expect(exportRemoteImage(uri, 'save', signal())).rejects.toThrow();
  expect(mockCreated).not.toHaveBeenCalled(); expect(mockSave).not.toHaveBeenCalled();
});

test('checks encoded size before making a temporary file or opening a system sheet', async () => {
  const uri = `data:image/png;base64,${'A'.repeat(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 32)}`;
  await expect(exportRemoteImage(uri, 'save', signal())).rejects.toThrow('8 MB');
  expect(mockCreated).not.toHaveBeenCalled(); expect(mockSave).not.toHaveBeenCalled();
});

test.each([0, -1, Number.NaN, MAX_ATTACHMENT_BYTES + 1])('rejects invalid file size %s before reading it', async size => {
  const uri = 'file:///app/cache/image.png'; mockImages.set(uri, { bytes: png, size });
  await expect(exportRemoteImage(uri, 'save', signal())).rejects.toThrow();
  expect(mockRead).not.toHaveBeenCalled(); expect(mockSave).not.toHaveBeenCalled();
});

test('a missing cache file tells the user to reopen it without deleting unrelated files', async () => {
  await expect(exportRemoteImage('file:///app/cache/missing.png', 'save', signal())).rejects.toThrow('重新打开图片');
  expect(mockRead).not.toHaveBeenCalled(); expect(mockDeleted).not.toHaveBeenCalled();
});

test.each([
  { bytes: png, readBytes: png.slice(0, 4) },
  { bytes: png, readBytes: new Uint8Array([...png, 0]) },
  { bytes: png, afterReadSize: png.length + 1 },
])('rejects a file that changes while validating and closes the handle', async item => {
  const uri = 'file:///app/cache/image.png'; mockImages.set(uri, item);
  await expect(exportRemoteImage(uri, 'save', signal())).rejects.toThrow('图片内容已变更');
  expect(mockClose).toHaveBeenCalledWith(uri); expect(mockSave).not.toHaveBeenCalled(); expect(mockDeleted).not.toHaveBeenCalled();
});

test('cancelled actions never read or create image files', async () => {
  const controller = new AbortController(); controller.abort();
  await expect(exportRemoteImage(inline('image/png', png), 'save', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  await expect(exportRemoteImage('file:///app/cache/image.png', 'share', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(mockFileConstructed).not.toHaveBeenCalled(); expect(mockSave).not.toHaveBeenCalled(); expect(mockShare).not.toHaveBeenCalled();
});

test('native failure messages cannot leak local paths, signed URLs, or provider credentials', () => {
  const error = new Error('file:///app/cache/private.png https://hub.example/?lease=secret password=private');
  expect(imageExportFailure(error, 'save')).toBe('保存失败，请稍后重试');
  expect(imageExportFailure(error, 'share')).toBe('分享失败，请稍后重试');
  expect(imageExportFailure(new Error('相册保存权限已被关闭，请到系统设置中允许 Salcara AI 保存图片。'), 'save')).toBe('请在系统设置中允许保存图片');
});
