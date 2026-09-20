import { compareVersions, fetchLatestRelease, formatBytes, normalizeVersion } from '../update';

describe('app updates', () => {
  test('normalizes release tags', () => {
    expect(normalizeVersion('v1.2.3')).toBe('1.2.3');
    expect(normalizeVersion('1.2.3+12')).toBe('1.2.3');
  });

  test('compares numeric versions without lexical mistakes', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('v1.1', '1.1.0')).toBe(0);
    expect(compareVersions('1.0.9', '1.1.0')).toBe(-1);
  });

  test('formats update package sizes', () => {
    expect(formatBytes(10 * 1024 * 1024)).toBe('10.0 MB');
    expect(formatBytes(0)).toBe('未知大小');
  });

  test('falls back to the CDN version file when GitHub API is unavailable', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('api.github.com')) throw new Error('network blocked');
      if (url.includes('cdn.jsdelivr.net')) {
        return {
          ok: true,
          json: async () => ({ expo: { version: '1.2.3' } }),
        } as Response;
      }
      throw new Error('network blocked');
    });

    await expect(fetchLatestRelease()).resolves.toMatchObject({
      version: '1.2.3',
      tagName: 'v1.2.3',
      apk: { name: 'salcara-image-android-v1.2.3.apk' },
    });
    fetchMock.mockRestore();
  });
});
