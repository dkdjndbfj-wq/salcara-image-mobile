jest.mock('expo/fetch', () => ({ fetch: (...args: Parameters<typeof fetch>) => global.fetch(...args) }));

import { compareVersions, fetchLatestRelease, formatBytes, normalizeVersion, parseReleaseManifest } from '../update';

const released = {
  version: '1.2.3', tagName: 'v1.2.3', title: 'Salcara Image v1.2.3', notes: 'Published',
  publishedAt: '2026-09-21T00:00:00Z',
  apk: {
    name: 'salcara-image-android-v1.2.3.apk', size: 123456,
    url: 'https://github.com/dkdjndbfj-wq/salcara-image-mobile/releases/download/v1.2.3/salcara-image-android-v1.2.3.apk',
    digest: `sha256:${'a'.repeat(64)}`,
  },
};

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

  test('falls back to a published release manifest when GitHub API is unavailable', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('api.github.com')) throw new Error('network blocked');
      if (url.includes('cdn.jsdelivr.net')) {
        return {
          ok: true,
          json: async () => released,
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

  test('does not advertise unreleased main/app.json or a release missing its APK', () => {
    expect(() => parseReleaseManifest({ expo: { version: '9.9.9' } })).toThrow('更新清单');
    expect(() => parseReleaseManifest({ ...released, publishedAt: null })).toThrow('更新清单');
    expect(() => parseReleaseManifest({ ...released, apk: { ...released.apk, size: 0 } })).toThrow('更新清单');
  });

  test.each([
    'https://github.com/attacker/project/releases/download/v1.2.3/app.apk',
    `${released.apk.url}?redirect=elsewhere`,
    `${released.apk.url}/../../../../attacker.apk`,
    released.apk.url.replace('https:', 'http:'),
    released.apk.url.replace('github.com/', 'github.com.attacker.example/'),
  ])('rejects update download URLs outside the exact official release asset: %s', (url) => {
    expect(() => parseReleaseManifest({ ...released, apk: { ...released.apk, url } })).toThrow('更新清单');
  });
});
