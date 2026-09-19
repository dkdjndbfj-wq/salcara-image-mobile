import {
  imageEndpoint,
  normalizeBaseUrl,
  parseImageModels,
  qualitiesForModel,
  redactSensitiveText,
  RESOLUTION_MAP,
  sizeFor,
} from '../domain-utils';

describe('domain utilities', () => {
  test.each([
    ['https://salcara.top', 'https://salcara.top/v1'],
    ['https://salcara.top/', 'https://salcara.top/v1'],
    ['https://salcara.top/v1/', 'https://salcara.top/v1'],
    ['https://salcara.top/api', 'https://salcara.top/api/v1'],
    ['http://10.0.2.2:3000', 'http://10.0.2.2:3000/v1'],
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

  test('maps all nine size combinations', () => {
    expect(Object.keys(RESOLUTION_MAP)).toHaveLength(3);
    expect(Object.values(RESOLUTION_MAP).flatMap((tiers) => Object.values(tiers))).toEqual([
      '1024x1024', '2048x2048', '2880x2880',
      '1536x1024', '2048x1152', '3840x2160',
      '1024x1536', '1152x2048', '2160x3840',
    ]);
    expect(sizeFor('9:16', '4K')).toBe('2160x3840');
  });

  test('redacts bearer tokens and API keys', () => {
    const text = redactSensitiveText('Bearer abc.def-123 sk-abcdefghijklmnopqrstuvwxyz');
    expect(text).toBe('Bearer *** sk-***');
  });
});
