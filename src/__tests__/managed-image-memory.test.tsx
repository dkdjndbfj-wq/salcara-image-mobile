import React from 'react';
import { act, render, waitFor } from '@testing-library/react-native';
import { Image } from 'react-native';
import { imageDimensions, previewDimensions, requirePreviewDimensions } from '../remote/image-dimensions';
import { inspectLocalImage, managedImagePreview, serializeImageProcessing } from '../remote/image-preview-cache';
import { managedImageWorkingSetBytes, reserveDecodedImage, useManagedImage } from '../remote/useManagedImage';

const mockFiles = new Map<string, Uint8Array>();
const mockListeners = new Map<string, (value?: string) => void>();
let mockProcessed = 0, mockProcessing = 0, mockMaximum = 0, mockGate: (() => Promise<void>) | undefined;
let mockActions: Array<{ crop?: { originX:number;originY:number;width:number;height:number }; resize?: { width:number;height:number } }> = [];
function mockPNG(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(45); bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer); view.setUint32(8, 13); bytes.set([73, 72, 68, 82], 12); view.setUint32(16, width); view.setUint32(20, height); bytes[24] = 8; bytes[25] = 6; bytes.set([73, 68, 65, 84], 37); return bytes;
}
jest.mock('../remote/attachment-cache-policy', () => ({ reserveAttachmentCache: async () => () => undefined, retainCachedAttachment: () => () => undefined, touchCachedAttachment: () => undefined }));
jest.mock('react-native', () => {
  const original = jest.requireActual('react-native');
  const mocked = Object.create(original); Object.defineProperty(mocked, 'AppState', { value: { currentState: 'active', addEventListener: (kind: string, listener: (value?: string) => void) => {
    mockListeners.set(kind, listener); return { remove: () => mockListeners.delete(kind) };
  } } }); return mocked;
});
jest.mock('expo-file-system', () => {
  class File {
    uri: string;
    constructor(...parts: Array<string | { uri: string }>) { this.uri = parts.map(part => typeof part === 'string' ? part.replace(/\/$/, '') : part.uri.replace(/\/$/, '')).join('/'); }
    get exists() { return mockFiles.has(this.uri); }
    get name() { return this.uri.split('/').at(-1)!; }
    get size() { return mockFiles.get(this.uri)?.length ?? 0; }
    get modificationTime() { return 10; }
    get parentDirectory() { return new Directory(this.uri.slice(0, this.uri.lastIndexOf('/'))); }
    open() { let at = 0; return { readBytes: (count: number) => { const bytes = mockFiles.get(this.uri); if (!bytes) throw new Error('missing'); const part = bytes.slice(at, at + count); at += part.length; return part; }, close: () => undefined }; }
    async move(file: File) { mockFiles.set(file.uri, mockFiles.get(this.uri)!); mockFiles.delete(this.uri); }
    delete() { mockFiles.delete(this.uri); }
  }
  class Directory extends File { create() {} }
  return { File, Directory, FileMode: { ReadOnly: 'r' }, Paths: { cache: 'file://cache' } };
});
jest.mock('expo-image-manipulator', () => ({ SaveFormat: { PNG: 'png', JPEG: 'jpeg' }, manipulateAsync: async (_uri: string, actions: typeof mockActions) => {
  mockProcessed++; mockProcessing++; mockMaximum = Math.max(mockMaximum, mockProcessing);
  mockActions=actions;
  await mockGate?.(); const target = actions.find(action=>action.resize)!.resize!, uri = `file://temporary/${mockProcessed}.png`;
  mockFiles.set(uri, mockPNG(target.width, target.height)); mockProcessing--;
  return { uri, ...target };
} }));
beforeEach(() => { mockFiles.clear(); mockProcessed = mockProcessing = mockMaximum = 0; mockGate = undefined; });

test('real PNG/JPEG/WebP headers determine dimensions; a tiny compressed bomb is blocked before decode', async () => {
  expect(imageDimensions(mockPNG(1200, 800))).toMatchObject({ width: 1200, height: 800, mime: 'image/png' });
  const jpeg = Uint8Array.from([255, 216, 255, 192, 0, 8, 8, 0x03, 0x20, 0x04, 0xb0, 1]);
  expect(imageDimensions(jpeg)).toMatchObject({ width: 1200, height: 800, mime: 'image/jpeg' });
  const webp = new Uint8Array(30); webp.set([...Buffer.from('RIFF')]); webp.set([...Buffer.from('WEBPVP8X')], 8); webp[16] = 10; webp[24] = 255; webp[25] = 1; webp[27] = 255;
  expect(imageDimensions(webp)).toMatchObject({ width: 512, height: 256, mime: 'image/webp' });
  expect(imageDimensions(new Uint8Array([1, 2, 3]))).toBeUndefined();
  mockFiles.set('file://huge.png', mockPNG(20000, 20000));
  await expect(managedImagePreview('file://huge.png', 'thumbnail')).rejects.toThrow('1600 万像素');
  expect(mockProcessed).toBe(0); expect(mockFiles.has('file://huge.png')).toBe(true);
  expect(() => requirePreviewDimensions(undefined)).toThrow();
});

test('JPEG orientation swaps the display bounds and animated WebP does not enter the decoder', async () => {
  const exif = new Uint8Array(36); exif.set([255, 225, 0, 34]); exif.set([...Buffer.from('Exif\0\0')], 4);
  const tiff = new DataView(exif.buffer, 10); exif.set([73, 73], 10); tiff.setUint16(2, 42, true); tiff.setUint32(4, 8, true);
  tiff.setUint16(8, 1, true); tiff.setUint16(10, 0x112, true); tiff.setUint16(12, 3, true); tiff.setUint32(14, 1, true); tiff.setUint16(18, 6, true);
  const jpeg = Uint8Array.from([255, 216, ...exif, 255, 192, 0, 8, 8, 0x03, 0x20, 0x04, 0xb0, 1]);
  expect(imageDimensions(jpeg)).toMatchObject({ width: 800, height: 1200 });
  const webp = new Uint8Array(30); webp.set([...Buffer.from('RIFF')]); webp.set([...Buffer.from('WEBPVP8X')], 8); webp[16] = 10; webp[20] = 2; webp[24] = 255; webp[27] = 255;
  mockFiles.set('file://animated.webp', webp);
  await expect(managedImagePreview('file://animated.webp', 'thumbnail')).rejects.toThrow('动态图片'); expect(mockProcessed).toBe(0);
});

test('PNG animation or a header without an image-data boundary is rejected before decode', async () => {
  const animated = mockPNG(1000, 1000); animated.set([...Buffer.from('acTL')], 37);
  const hiddenControl = mockPNG(1000, 1000); hiddenControl.set([...Buffer.from('iCCP')], 37);
  new DataView(hiddenControl.buffer).setUint32(33, 300 * 1024);
  mockFiles.set('file://animated.png', animated); mockFiles.set('file://long-header.png', hiddenControl);
  await expect(managedImagePreview('file://animated.png', 'thumbnail')).rejects.toThrow('动态图片');
  await expect(managedImagePreview('file://long-header.png', 'thumbnail')).rejects.toThrow('无法安全读取图片尺寸');
  expect(mockProcessed).toBe(0);
  expect(mockFiles.has('file://animated.png')).toBe(true); expect(mockFiles.has('file://long-header.png')).toBe(true);
});

test('thumbnail and preview outputs are bounded and processing never overlaps', async () => {
  mockFiles.set('file://one.png', mockPNG(4000, 3000)); mockFiles.set('file://two.png', mockPNG(1000, 4000));
  expect(previewDimensions({ width: 4000, height: 3000 }, 'thumbnail')).toEqual({ width: 512, height: 384 });
  const values = await Promise.all([managedImagePreview('file://one.png', 'thumbnail'), managedImagePreview('file://two.png', 'preview')]);
  expect(values[0]).toMatchObject({ width: 512, height: 384, originalWidth: 4000 });
  expect(values[1]).toMatchObject({ width: 400, height: 1600 });
  expect(mockMaximum).toBe(1);
  expect(values.every(value => value.width * value.height <= 4_000_000)).toBe(true);
  expect(inspectLocalImage(values[0].uri)).toMatchObject({ width: 512, height: 384 });
});

test('same-image consumers share work and one cancellation leaves the other intact', async () => {
  mockFiles.set('file://shared.png', mockPNG(1000, 1000));
  let release!: () => void; mockGate = () => new Promise(resolve => { release = resolve; });
  const a = new AbortController(), b = new AbortController();
  const first = managedImagePreview('file://shared.png', 'thumbnail', a.signal).catch(error => error);
  const second = managedImagePreview('file://shared.png', 'thumbnail', b.signal);
  await waitFor(() => expect(mockProcessed).toBe(1)); a.abort(); release();
  expect(await first).toBeInstanceOf(Error); await expect(second).resolves.toMatchObject({ width: 512 });
  expect(mockProcessed).toBe(1);
});

test('on-demand detail crops from source pixels before resize and keeps the low-memory budget', async () => {
  mockFiles.set('file://detail.png', mockPNG(4000, 3000));
  const region = { originX: 1200, originY: 800, width: 960, height: 640 };
  const detail = await managedImagePreview('file://detail.png', 'detail', undefined, region);
  expect(mockActions).toEqual([{ crop: region }, { resize: { width: 960, height: 640 } }]);
  expect(detail).toMatchObject({ width: 960, height: 640, originalWidth: 4000, originalHeight: 3000, region });
  // This tile has real source resolution, unlike magnifying the 1600px base.
  expect(detail.width / region.width).toBe(1);
  const bounded = previewDimensions({ width: 4000, height: 3000 }, 'detail');
  expect(bounded.width * bounded.height).toBeLessThanOrEqual(1_500_000);
  expect((1600 * 1600 + bounded.width * bounded.height) * 4).toBeLessThan(16 * 1024 * 1024);
});

test('detail cache identities include the crop and invalid crops never decode', async () => {
  mockFiles.set('file://regions.png', mockPNG(4000, 3000));
  const first = { originX: 0, originY: 0, width: 640, height: 640 }, second = { ...first, originX: 640 };
  const a = await managedImagePreview('file://regions.png', 'detail', undefined, first);
  const again = await managedImagePreview('file://regions.png', 'detail', undefined, first);
  expect(again.uri).toBe(a.uri); expect(mockProcessed).toBe(1);
  const b = await managedImagePreview('file://regions.png', 'detail', undefined, second);
  expect(b.uri).not.toBe(a.uri); expect(b.region).toEqual(second); expect(mockProcessed).toBe(2);
  for (const region of [undefined, { ...first, originX: -1 }, { ...first, width: Infinity }, { ...first, originX: 3900 }]) {
    await expect(managedImagePreview('file://regions.png', 'detail', undefined, region)).rejects.toThrow('区域无效');
  }
  expect(mockProcessed).toBe(2); expect(mockFiles.has('file://regions.png')).toBe(true);
});

test('cancelled queued preprocessing cannot decode or remove its original file', async () => {
  let release!: () => void;
  const blocker = serializeImageProcessing(() => new Promise<void>(resolve => { release = resolve; }));
  await waitFor(() => expect(release).toBeDefined());
  mockFiles.set('file://queued.png', mockPNG(1000, 1000));
  const controller = new AbortController(); const image = managedImagePreview('file://queued.png', 'preview', controller.signal).catch(error => error);
  controller.abort(); release(); await blocker; await image;
  expect(mockProcessed).toBe(0); expect(mockFiles.has('file://queued.png')).toBe(true);
});

function Display({ uri, visible = true }: { uri: string; visible?: boolean }) {
  const resource = useManagedImage(uri, 'preview', visible);
  return resource.uri ? <Image testID="managed" source={{ uri: resource.uri }} /> : null;
}
test('background and offscreen transitions unmount image sources and release the decoded working set', async () => {
  mockFiles.set('file://lifecycle.png', mockPNG(1200, 800));
  const view = await render(<Display uri="file://lifecycle.png" />);
  await waitFor(() => expect(view.getByTestId('managed')).toBeTruthy()); expect(managedImageWorkingSetBytes()).toBe(1200 * 800 * 4);
  await act(async () => { mockListeners.get('change')?.('background'); });
  expect(view.queryByTestId('managed')).toBeNull(); expect(managedImageWorkingSetBytes()).toBe(0);
  await act(async () => { mockListeners.get('change')?.('active'); });
  await waitFor(() => expect(view.getByTestId('managed')).toBeTruthy());
  await view.rerender(<Display uri="file://lifecycle.png" visible={false} />);
  expect(view.queryByTestId('managed')).toBeNull(); expect(managedImageWorkingSetBytes()).toBe(0); await view.unmount();
});

test('pixel admission shares a source and waits instead of exceeding 32 MiB', async () => {
  const controller = new AbortController();
  const first = await reserveDecodedImage('one', 4_000_000, controller.signal);
  const duplicate = await reserveDecodedImage('one', 4_000_000, controller.signal);
  const second = await reserveDecodedImage('two', 4_000_000, controller.signal);
  let admitted = false;
  const third = reserveDecodedImage('three', 4_000_000, controller.signal).then(release => { admitted = true; return release; });
  await Promise.resolve(); expect(admitted).toBe(false); expect(managedImageWorkingSetBytes()).toBe(32_000_000);
  first(); expect(managedImageWorkingSetBytes()).toBe(32_000_000); duplicate(); const releaseThird = await third;
  expect(managedImageWorkingSetBytes()).toBe(32_000_000); second(); releaseThird(); expect(managedImageWorkingSetBytes()).toBe(0);
});
