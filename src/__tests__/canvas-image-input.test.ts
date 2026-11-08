import { prepareCanvasImageInput } from '../remote/canvas-image-input';
import type { CanvasImage } from '../remote/conversation-images';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const mockInfo = jest.fn(), mockRead = jest.fn(), mockVerify = jest.fn(), mockConvert = jest.fn(), mockGetSize = jest.fn();
jest.mock('expo-file-system/legacy', () => ({ getInfoAsync: (...args: unknown[]) => mockInfo(...args), readAsStringAsync: (...args: unknown[]) => mockRead(...args), EncodingType: { Base64: 'base64' } }));
jest.mock('expo-image-manipulator', () => ({ manipulateAsync: (...args: unknown[]) => mockConvert(...args), SaveFormat: { PNG: 'png' } }));
jest.mock('../remote/queued-image-files', () => ({ verifyManagedQueuedImage: (...args: unknown[]) => mockVerify(...args) }));
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native'), replacement = Object.create(actual);
  Object.defineProperty(replacement, 'Image', { value: { getSize: (...args: unknown[]) => mockGetSize(...args) } });
  return replacement;
});
jest.mock('../storage/database', () => ({ getSetting: jest.fn(), setSetting: jest.fn() }));

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const jpeg = new Uint8Array([255, 216, 255, 0]);
const webp = new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80, 0]);
const encoded = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const data = (mime = 'image/png', bytes = png) => `data:${mime};base64,${encoded(bytes)}`;
const image = (patch: Partial<CanvasImage> = {}): CanvasImage => ({ id: 'image-1', messageId: 'message-1', name: '图片1', uri: data(), width: 800, height: 500, role: 'assistant', ...patch });
const active = () => ({ isCurrent: () => true });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }

beforeEach(() => {
  jest.clearAllMocks();
  mockInfo.mockResolvedValue({ exists: true, isDirectory: false, size: png.length });
  mockRead.mockResolvedValue(encoded(png)); mockVerify.mockResolvedValue(undefined);
  mockConvert.mockResolvedValue({ base64: encoded(png), uri: 'file:///cache/raster.png', width: 800, height: 500 });
  mockGetSize.mockImplementation((_uri, success) => { success(800, 500); });
});

test.each([['image/png', png], ['image/jpeg', jpeg], ['image/webp', webp]] as const)('keeps original %s bytes and dimensions without recompression', async (mime, bytes) => {
  const uri = data(mime, bytes);
  await expect(prepareCanvasImageInput([image({ uri })], active())).resolves.toEqual([{ uri, base64: encoded(bytes), mime, width: 800, height: 500 }]);
  expect(mockConvert).not.toHaveBeenCalled(); expect(mockRead).not.toHaveBeenCalled(); expect(mockGetSize).not.toHaveBeenCalled();
});

test('local originals are bounded and checked against the displayed attachment hash before handoff', async () => {
  const ref = { id: 'att_1', mime: 'image/png', size: png.length, sha256: bytesToHex(sha256(png)) };
  const uri = 'file:///app/cache/original.png';
  await expect(prepareCanvasImageInput([image({ uri, ref })], active())).resolves.toEqual([{ uri, base64: encoded(png), mime: 'image/png', width: 800, height: 500 }]);
  expect(mockVerify).toHaveBeenCalledWith(uri, 'image/png', encoded(png));
  await expect(prepareCanvasImageInput([image({ uri, ref: { ...ref, sha256: 'a'.repeat(64) } })], active())).rejects.toThrow('原文件已变化');
});

test('reads missing dimensions using the image API and deduplicates only the same revision', async () => {
  const original = image({ width: undefined, height: undefined });
  const result = await prepareCanvasImageInput([original, original], active());
  expect(result).toHaveLength(1); expect(result[0]).toMatchObject({ width: 800, height: 500 });
  expect(mockGetSize).toHaveBeenCalledTimes(1);
  await expect(prepareCanvasImageInput(Array.from({ length: 5 }, (_, index) => image({ revision: String(index) })), active())).rejects.toThrow('最多添加 4 张');
});

test.each([undefined, 'https://example.com/image.png', 'http://localhost/private.png', 'javascript:alert(1)'])('does not replace missing or remote image bytes with a textual reference: %s', async uri => {
  await expect(prepareCanvasImageInput([image({ uri })], active())).rejects.toThrow(/原图尚未/);
  expect(mockInfo).not.toHaveBeenCalled(); expect(mockRead).not.toHaveBeenCalled(); expect(mockGetSize).not.toHaveBeenCalled(); expect(mockConvert).not.toHaveBeenCalled();
});

test('rejects oversized, changed, or mislabelled content before adding any image', async () => {
  mockInfo.mockResolvedValueOnce({ exists: true, isDirectory: false, size: 8 * 1024 * 1024 + 1 });
  await expect(prepareCanvasImageInput([image({ uri: 'file:///cache/large.png' })], active())).rejects.toThrow('最大 8 MB');
  expect(mockRead).not.toHaveBeenCalled();
  mockInfo.mockResolvedValueOnce({ exists: true, isDirectory: false, size: png.length + 1 });
  await expect(prepareCanvasImageInput([image({ uri: 'file:///cache/changed.png' })], active())).rejects.toThrow('发生变化');
  await expect(prepareCanvasImageInput([image({ uri: data('image/jpeg', png) })], active())).rejects.toThrow('类型不符');
  await expect(prepareCanvasImageInput([image({ uri: 'data:image/png;base64,not-a-valid-image' })], active())).rejects.toThrow();
});

test('inline SVG references are converted to real PNG bytes with the same aspect ratio', async () => {
  const uri = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><rect width="800" height="500" fill="#eee"/></svg>');
  await expect(prepareCanvasImageInput([image({ uri })], active())).resolves.toEqual([{ uri: data(), base64: encoded(png), mime: 'image/png', width: 800, height: 500 }]);
  expect(mockConvert).toHaveBeenCalledWith(uri, [], { format: 'png', base64: true, compress: 1 });
  const external = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg><image href="https://example.com/a.png"/></svg>');
  await expect(prepareCanvasImageInput([image({ uri: external })], active())).rejects.toThrow('外部内容');
  expect(mockConvert).toHaveBeenCalledTimes(1);
});

test('a source switch during byte reading never returns the old images', async () => {
  let current = true; const pending = deferred<string>(); mockRead.mockReturnValueOnce(pending.promise);
  const result = prepareCanvasImageInput([image({ uri: 'file:///cache/pending.png' })], { isCurrent: () => current });
  await Promise.resolve(); current = false; pending.resolve(encoded(png));
  await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  expect(mockVerify).not.toHaveBeenCalled();
});

test('aborting dimension lookup or conversion preserves an all-or-nothing handoff', async () => {
  const controller = new AbortController(); mockGetSize.mockImplementationOnce(() => undefined);
  const result = prepareCanvasImageInput([image({ width: undefined, height: undefined })], { ...active(), signal: controller.signal });
  controller.abort(); await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  const converted = deferred<{ base64: string; width: number; height: number; uri: string }>(); mockConvert.mockReturnValueOnce(converted.promise);
  const second = new AbortController();
  const result2 = prepareCanvasImageInput([image({ uri: 'data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E' })], { ...active(), signal: second.signal });
  await Promise.resolve(); second.abort(); converted.resolve({ base64: encoded(png), width: 800, height: 500, uri: 'file:///cache/png' });
  await expect(result2).rejects.toMatchObject({ name: 'AbortError' });
});
