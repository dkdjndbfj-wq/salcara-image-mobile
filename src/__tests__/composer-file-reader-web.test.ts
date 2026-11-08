import { readComposerFiles } from '../remote/composer-file-reader.web';

const mockPrepareImage = jest.fn();
jest.mock('../remote/attachments', () => ({ prepareRemoteImage: (...args: unknown[]) => mockPrepareImage(...args) }));
const mockDataUrls = new Map<string, string>();
const originalReader = global.FileReader;
const originalDecoder = global.TextDecoder;
class TestFileReader {
  result = '';onload?: () => void;onerror?: () => void;
  readAsDataURL(file: File) { const data = mockDataUrls.get(file.name); if (!data) { this.onerror?.();return; }this.result = data;this.onload?.(); }
}
const bytes = (text: string) => { const buffer = Buffer.from(text, 'utf8');return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength); };
const file = (name: string, body: string, type = '') => ({ name, type, size: Buffer.byteLength(body, 'utf8'), arrayBuffer: jest.fn(async () => bytes(body)) } as unknown as File);
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]).toString('base64');
beforeAll(() => { global.FileReader = TestFileReader as unknown as typeof FileReader;global.TextDecoder = require('node:util').TextDecoder; });
afterAll(() => { global.FileReader = originalReader;global.TextDecoder = originalDecoder; });
beforeEach(() => {
  jest.clearAllMocks();mockDataUrls.clear();
  mockPrepareImage.mockResolvedValue({ uri: 'file://prepared.png', base64: png, mime: 'image/png', width: 1, height: 1 });
});

test('text files decode complete UTF-8 including whitespace, emoji and line endings', async () => {
  const body = '  中文🙂\r\nconst value = "exact";\n  ', result = await readComposerFiles([file('source.ts', body)], () => true);
  expect(result).toEqual({ texts: [{ name: 'source.ts', text: body }], images: [] });expect(mockPrepareImage).not.toHaveBeenCalled();
});

test('unsupported type and size/count limits fail before starting any file reads', async () => {
  const source = file('source.ts', 'const a = 1');
  await expect(readComposerFiles([source, file('archive.zip', 'binary')], () => true)).rejects.toThrow('暂不支持');
  expect(source.arrayBuffer).not.toHaveBeenCalled();
  await expect(readComposerFiles([{ ...source, size: 1024 * 1024 + 1 } as File], () => true)).rejects.toThrow('过大');
  await expect(readComposerFiles([{ ...source, size: 0 } as File], () => true)).rejects.toThrow('为空');
  await expect(readComposerFiles([], () => true)).rejects.toThrow('1 至 8');
  await expect(readComposerFiles(Array.from({ length: 9 }, () => source), () => true)).rejects.toThrow('1 至 8');
  await expect(readComposerFiles(Array.from({ length: 5 }, (_, index) => file(`${index}.png`, 'x')), () => true)).rejects.toThrow('最多添加 4');
  await expect(readComposerFiles([{ ...file('huge.png', 'x'), size: 8 * 1024 * 1024 + 1 } as File], () => true)).rejects.toThrow('过大');
  expect(source.arrayBuffer).not.toHaveBeenCalled();
});

test('invalid UTF-8, binary text and long content reject the batch without yielding partial results', async () => {
  const invalid = { ...file('invalid.txt', 'x'), arrayBuffer: jest.fn(async () => Uint8Array.from([0xc3, 0x28]).buffer) } as File;
  await expect(readComposerFiles([file('good.ts', 'keep'), invalid], () => true)).rejects.toThrow('不是有效的 UTF-8');
  await expect(readComposerFiles([file('binary.txt', 'a\0b')], () => true)).rejects.toThrow('含二进制');
  await expect(readComposerFiles([file('long.md', 'x'.repeat(40001))], () => true)).rejects.toThrow('40,000');
});

test('images use their actual magic bytes and reject disguised or unreadable images', async () => {
  mockDataUrls.set('renamed.jpg', `data:image/jpeg;base64,${png}`);
  const result = await readComposerFiles([file('renamed.jpg', 'x')], () => true);
  expect(mockPrepareImage).toHaveBeenCalledWith({ uri: `data:image/png;base64,${png}` });expect(result.images[0].mime).toBe('image/png');
  mockDataUrls.set('fake.png', `data:image/png;base64,${Buffer.from('not an image').toString('base64')}`);
  await expect(readComposerFiles([file('fake.png', 'x')], () => true)).rejects.toThrow('图片内容无效');
  await expect(readComposerFiles([file('read-failure.png', 'x')], () => true)).rejects.toThrow('无法读取');
});

test('a scope or draft change during text read cancels the complete addition', async () => {
  let current = true, finish!: (value: ArrayBuffer) => void;
  const pending = { ...file('slow.ts', 'x'), arrayBuffer: jest.fn(() => new Promise<ArrayBuffer>(resolve => { finish = resolve; })) } as File;
  const promise = readComposerFiles([pending], () => current);
  current = false;finish(bytes('original file') as ArrayBuffer);
  await expect(promise).rejects.toThrow('电脑、对话或输入已变化');
});

test('a scope change during image preparation cancels the complete addition', async () => {
  let current = true;
  mockDataUrls.set('image.png', `data:image/png;base64,${png}`);
  mockPrepareImage.mockImplementation(async () => { current = false;return { uri: 'file://old-scope.png', base64: png, mime: 'image/png', width: 1, height: 1 }; });
  await expect(readComposerFiles([file('image.png', 'x')], () => current)).rejects.toThrow('电脑、对话或输入已变化');
});
