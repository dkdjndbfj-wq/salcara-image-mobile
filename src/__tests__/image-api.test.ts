jest.mock('expo/fetch', () => ({ fetch: (...args: Parameters<typeof fetch>) => global.fetch(...args) }));

jest.mock('../storage/files', () => ({
  saveBase64Png: jest.fn((value: string) => `file://base64-${value.slice(0, 4)}.png`),
  downloadPng: jest.fn(async (url: string) => `file://download-${url.split('/').pop()}`),
}));

import { buildEditFields, buildGenerationBody, editImage, findImagePayload, generateImage, persistApiResult } from '../api/image-api';

const common = {
  model: 'gpt-image-2.5-sunburst',
  prompt: '奥特曼打怪兽',
  quality: 'max' as const,
  size: '2048x2048',
};

describe('OpenAI-compatible image payloads', () => {
  test('generation body fixes PNG and n=1 without background by default', () => {
    expect(buildGenerationBody({ ...common, transparent: false })).toEqual({ ...common, n: 1, output_format: 'png' });
  });

  test('transparent generation sends only the supported background field', () => {
    expect(buildGenerationBody({ ...common, transparent: true })).toEqual({ ...common, n: 1, output_format: 'png', background: 'transparent' });
  });

  test('edit fields use multipart string values and fixed output', () => {
    expect(buildEditFields({ ...common, transparent: true })).toEqual({ ...common, n: '1', output_format: 'png', background: 'transparent' });
  });

  test('uploads reference images as Expo File parts supported by Android fetch', async () => {
    const OriginalFormData = global.FormData;
    class NativeFormDataStub {
      _parts: Array<[string, unknown]> = [];
      append(name: string, value: unknown) {
        this._parts.push([name, value]);
      }
    }
    Object.defineProperty(global, 'FormData', { configurable: true, value: NativeFormDataStub });
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ b64_json: 'YWJjZA==' }] }),
    } as Response);

    try {
      await editImage({
        baseUrl: 'https://salcara.top/v1',
        apiKey: 'test-key',
        ...common,
        transparent: false,
        references: [{
          id: 'reference-1',
          uri: 'file:///reference.png',
          name: 'reference.png',
          mimeType: 'image/png',
          size: 4,
        }],
      });

      const request = fetchMock.mock.calls[0]?.[1];
      expect(request).toMatchObject({ redirect: 'error', credentials: 'omit' });
      const parts = (request?.body as unknown as NativeFormDataStub)._parts;
      const imagePart = parts.find(([name]) => name === 'image[]')?.[1] as { bytes?: unknown; uri?: string } | undefined;
      expect(imagePart?.uri).toBe('file:///reference.png');
      expect(typeof imagePart?.bytes).toBe('function');
    } finally {
      fetchMock.mockRestore();
      Object.defineProperty(global, 'FormData', { configurable: true, value: OriginalFormData });
    }
  });

  test('persists base64 responses', async () => {
    await expect(persistApiResult({ data: [{ b64_json: 'YWJjZA==' }] })).resolves.toBe('file://base64-YWJj.png');
  });

  test('downloads URL responses', async () => {
    await expect(persistApiResult({ data: [{ url: 'https://cdn.example/result.png' }] })).resolves.toBe('file://download-result.png');
  });

  test('uses one alternate Android fetch transport after a pre-response failure', async () => {
    const fetchMock = jest.spyOn(global, 'fetch')
      .mockRejectedValueOnce(new Error('Network request failed'))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ b64_json: 'YWJjZA==' }] }) } as Response);
    await expect(generateImage({
      ...common, baseUrl: 'https://salcara.top/v1', apiKey: 'test-key', transparent: false,
    })).resolves.toBe('file://base64-YWJj.png');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockRestore();
  });

  test('uses inline data URLs without another network dependency', async () => {
    await expect(persistApiResult({ data: [{ url: 'data:image/png;base64,YWJjZA==' }] })).resolves.toBe('file://base64-YWJj.png');
  });

  test('accepts common gateway wrappers and image aliases', async () => {
    expect(findImagePayload({ result: { images: [{ base64: 'YWJjZA==' }] } })).toEqual({ base64: 'YWJjZA==' });
    expect(findImagePayload({ output: [{ image_url: { url: 'https://cdn.example/result' } }] })).toEqual({ url: 'https://cdn.example/result' });
    expect(findImagePayload({ data: [{ url: 'https://cdn.example/expiring' }, { partial_image_b64: 'YWJjZA==' }] })).toEqual({ base64: 'YWJjZA==' });
    expect(findImagePayload({ data: [{ revised_prompt: '普通文本，不是图片' }] })).toBeNull();
  });

  test('accepts a chat-style content image URL returned by a proxy', async () => {
    await expect(persistApiResult({ choices: [{ message: { content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,YWJjZA==' } }] } }] })).resolves.toBe('file://base64-YWJj.png');
  });

  test('rejects successful responses with no image', async () => {
    await expect(persistApiResult({ data: [] })).rejects.toThrow('没有找到图片数据');
    await expect(persistApiResult({ data: [] })).rejects.toThrow('URL 转 base64');
  });
});
