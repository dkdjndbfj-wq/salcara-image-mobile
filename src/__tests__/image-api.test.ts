jest.mock('../storage/files', () => ({
  saveBase64Png: jest.fn((value: string) => `file://base64-${value.slice(0, 4)}.png`),
  downloadPng: jest.fn(async (url: string) => `file://download-${url.split('/').pop()}`),
}));

import { buildEditFields, buildGenerationBody, persistApiResult } from '../api/image-api';

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

  test('persists base64 responses', async () => {
    await expect(persistApiResult({ data: [{ b64_json: 'YWJjZA==' }] })).resolves.toBe('file://base64-YWJj.png');
  });

  test('downloads URL responses', async () => {
    await expect(persistApiResult({ data: [{ url: 'https://cdn.example/result.png' }] })).resolves.toBe('file://download-result.png');
  });

  test('rejects successful responses with no image', async () => {
    await expect(persistApiResult({ data: [] })).rejects.toThrow('没有找到图片数据');
  });
});
