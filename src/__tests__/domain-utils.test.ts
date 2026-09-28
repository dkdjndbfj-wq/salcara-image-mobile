import {
  imageEndpoint,
  latestCompletedImage,
  normalizeBaseUrl,
  parseImageModels,
  qualitiesForModel,
  redactSensitiveText,
  sizeFor,
} from '../domain-utils';
import type { ChatMessage } from '../domain';

describe('domain utilities', () => {
  test.each([
    ['https://salcara.top', 'https://salcara.top/v1'],
    ['https://salcara.top/', 'https://salcara.top/v1'],
    ['https://salcara.top/v1/', 'https://salcara.top/v1'],
    ['https://salcara.top/api', 'https://salcara.top/api/v1'],
    ['http://10.0.2.2:3000', 'http://10.0.2.2:3000/v1'],
    ['https://ark.cn-beijing.volces.com/api/v3', 'https://ark.cn-beijing.volces.com/api/v3'],
    ['https://open.bigmodel.cn/api/paas/v4/', 'https://open.bigmodel.cn/api/paas/v4'],
    ['https://generativelanguage.googleapis.com/v1beta/openai', 'https://generativelanguage.googleapis.com/v1beta/openai'],
    ['https://qianfan.baidubce.com/v2', 'https://qianfan.baidubce.com/v2'],
    ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'https://dashscope.aliyuncs.com/compatible-mode/v1'],
    // Repairs addresses saved by older versions.
    ['https://ark.cn-beijing.volces.com/api/v3/v1', 'https://ark.cn-beijing.volces.com/api/v3'],
    ['https://generativelanguage.googleapis.com/v1beta/openai/v1', 'https://generativelanguage.googleapis.com/v1beta/openai'],
  ])('normalizes %s', (input, expected) => expect(normalizeBaseUrl(input)).toBe(expected));

  test('rejects insecure remote endpoints', () => {
    expect(() => normalizeBaseUrl('http://example.com')).toThrow('HTTPS');
  });

  test('builds compatible endpoints', () => {
    expect(imageEndpoint('https://salcara.top', 'images/generations')).toBe('https://salcara.top/v1/images/generations');
  });

  test('filters and sorts gpt-image models', () => {
    expect(parseImageModels({ data: [{ id: 'text-model' }, { id: 'gpt-image-2.5' }, { id: 'gpt-image-2' }, { id: 'gpt-image-2' }] })).toEqual([
      'gpt-image-2',
      'gpt-image-2.5',
    ]);
  });

  test('gpt-image-2 hides xhigh and max only for the exact model', () => {
    expect(qualitiesForModel('gpt-image-2')).toEqual(['auto', 'low', 'medium', 'high']);
    expect(qualitiesForModel('gpt-image-2.5-sunburst')).toContain('max');
  });

  test('GPT Image 2 sizes follow the ratio and clarity', () => {
    expect(['1:1', '16:9', '9:16'].flatMap((ratio) => (['1K', '2K', '4K'] as const).map((tier) => sizeFor(ratio as never, tier, 'gpt-image-2')))).toEqual([
      '1024x1024', '2048x2048', '2880x2880',
      '1360x768', '2736x1536', '3840x2160',
      '768x1360', '1536x2736', '2160x3840',
    ]);
  });

  test('redacts bearer tokens and API keys', () => {
    const text = redactSensitiveText('Bearer abc.def-123 sk-abcdefghijklmnopqrstuvwxyz');
    expect(text).toBe('Bearer *** sk-***');
  });

  test('continues from the latest completed assistant image only', () => {
    const base: ChatMessage = {
      id: 'one', conversationId: 'conversation', role: 'assistant', prompt: 'first', mode: 'generate',
      status: 'complete', providerId: 'provider', model: 'gpt-image', quality: 'high', size: '1024x1024',
      transparent: false, imageUri: 'file://first.png', remoteImageUrl: null, references: [], maskUri: null,
      error: null, elapsedMs: 1000, createdAt: 1,
    };
    const latest = latestCompletedImage([
      base,
      { ...base, id: 'failed', status: 'error', imageUri: null, createdAt: 2 },
      { ...base, id: 'two', imageUri: 'file://second.png', createdAt: 3 },
      { ...base, id: 'user', role: 'user', imageUri: null, createdAt: 4 },
    ]);
    expect(latest?.imageUri).toBe('file://second.png');
  });
});
