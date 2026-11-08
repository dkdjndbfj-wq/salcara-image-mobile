import { generatedImageSlotMapping, MAX_GENERATED_IMAGES, messageGeneratedImages, normalizeGeneratedImages, validateImageCount } from '../generated-images';
import type { GeneratedImage } from '../domain';

test('validates the billed count without silently clamping or coercing it', () => {
  expect(MAX_GENERATED_IMAGES).toBe(10);
  expect(validateImageCount()).toBe(1);
  expect(validateImageCount(1)).toBe(1);
  expect(validateImageCount(10)).toBe(10);
  for (const invalid of [0, -1, 11, 1.5, Infinity, NaN, '2', null, true, {}, []]) {
    expect(() => validateImageCount(invalid)).toThrow('1 到 10');
  }
});

test('bounds saved batches and strips invalid fields and duplicate identities', () => {
  const raw = [
    null,
    { id: 'one', uri: 'file:///first.png', remoteUrl: 'https://cdn.example/first.png', status: 'complete', error: 'old error', secret: 'discard' },
    { id: 'one', uri: 'file:///duplicate.png', status: 'complete' },
    { id: 'two', uri: 'javascript:alert(1)', remoteUrl: 'javascript:alert(2)', status: 'complete' },
    { id: 'three', uri: 'content://pictures/third', status: 'complete' },
    { id: 'bad-status', uri: null, status: 'done' },
    { id: 'untrusted-status', uri: null, status: { toString: null } },
  ];
  expect(normalizeGeneratedImages(raw)).toEqual([
    { id: 'one', uri: 'file:///first.png', remoteUrl: 'https://cdn.example/first.png', status: 'complete', error: null },
    { id: 'two', uri: null, remoteUrl: null, status: 'error', error: null },
    { id: 'three', uri: 'content://pictures/third', remoteUrl: null, status: 'complete', error: null },
  ]);
  expect(normalizeGeneratedImages(Array.from({ length: 30 }, (_, index) => ({ id: String(index), uri: null, status: 'pending' })))).toHaveLength(10);
  expect(normalizeGeneratedImages({ images: raw })).toEqual([]);
});

test('remote-only results remain recoverable and never count as delivered local files', () => {
  expect(normalizeGeneratedImages([{ id: 'one', uri: 'https://cdn.example/first.png', status: 'complete' }])).toEqual([
    { id: 'one', uri: null, remoteUrl: 'https://cdn.example/first.png', status: 'error', error: null },
  ]);
  expect(normalizeGeneratedImages([
    { id: 'unix', uri: '/data/user/0/app/first.png', status: 'complete' },
    { id: 'windows', uri: 'C:\\Images\\first.png', status: 'complete' },
  ]).every((image) => image.status === 'complete')).toBe(true);
});

test('old single-image and remote-download messages use the same stable gallery contract', () => {
  const message = { id: 'old-message', imageUri: 'file:///old.png', remoteImageUrl: null, status: 'complete' as const };
  expect(messageGeneratedImages(message)).toEqual([
    { id: 'old-message-image-1', uri: 'file:///old.png', remoteUrl: null, status: 'complete', error: null },
  ]);
  expect(messageGeneratedImages({ ...message, generatedImages: [{ id: 'new-image', uri: 'file:///new.png', status: 'complete' }] })[0].id).toBe('new-image');
  expect(messageGeneratedImages({ ...message, imageUri: null, remoteImageUrl: 'https://cdn.example/old.png', status: 'error', error: 'download failed' })[0]).toMatchObject({
    id: 'old-message-image-1', uri: null, remoteUrl: 'https://cdn.example/old.png', status: 'error', error: 'download failed',
  });
  expect(messageGeneratedImages({ ...message, imageUri: null })).toEqual([]);
  expect(messageGeneratedImages({ ...message, imageUri: 'generated-images/poster.png' })[0]).toMatchObject({ uri: 'generated-images/poster.png', status: 'complete' });
  expect(messageGeneratedImages({ ...message, imageUri: '../private.png' })).toEqual([]);
});

test('gallery slot mappings retain unavailable positions without exposing URLs or assigning them another image', () => {
  const labelFor = jest.fn((uri: string) => uri === 'file:///second.png' ? '图7' : undefined);
  const mapping = generatedImageSlotMapping([
    { id: 'one', uri: null, remoteUrl: 'https://cdn.example/private?token=hidden', status: 'error', error: 'secret backend message' },
    { id: 'two', uri: 'file:///second.png', status: 'complete' },
    { id: 'three', uri: null, status: 'pending' },
    { id: 'four', uri: 'file:///unavailable.png', status: 'complete' },
  ], labelFor);
  expect(mapping).toContain('共4张');
  expect(mapping).toContain('第1张：未下载，不可引用');
  expect(mapping).toContain('第2张：图7');
  expect(mapping).toContain('第3张：尚未完成，不可引用');
  expect(mapping).toContain('第4张：文件不可用，不可引用');
  expect(mapping).not.toMatch(/https?:|file:|secret|token/);
  expect(labelFor.mock.calls.map(([uri]) => uri)).toEqual(['file:///second.png', 'file:///unavailable.png']);
});

test('slot mapping follows the same ten-image bound as the gallery and supports legacy local references', () => {
  const images: GeneratedImage[] = Array.from({ length: 11 }, (_, index) => ({ id: `image-${index + 1}`, uri: `file:///image-${index + 1}.png`, status: 'complete' }));
  const labels = jest.fn(() => '图3');
  expect(generatedImageSlotMapping(images, labels)).toContain('共10张');
  expect(labels).toHaveBeenCalledTimes(10);
  expect(generatedImageSlotMapping([], labels)).toBe('');
  expect(generatedImageSlotMapping([{ id: 'legacy', uri: 'images/old.png', status: 'complete' }], () => '图12')).toContain('第1张：图12');
});
