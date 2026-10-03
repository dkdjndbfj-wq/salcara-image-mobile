jest.mock('expo/fetch', () => ({ fetch: (...args: Parameters<typeof fetch>) => global.fetch(...args) }));

import {
  apkDownloadCandidates, autoUpdateCheckEnabled, compareVersions, fetchLatestRelease, formatBytes, IOS_UPDATE_URL, normalizeVersion, parseReleaseManifest, productionUpdateCheckEnabled, REMOTE_TEST_APPLICATION_ID, updateInstallMode,
} from '../update';

const released = {
  version: '1.2.3', tagName: 'v1.2.3', title: 'Salcara Image v1.2.3', notes: 'Published',
  publishedAt: '2026-09-21T00:00:00Z',
  apk: {
    name: 'salcara-image-android-v1.2.3.apk', size: 123456,
    url: 'https://github.com/dkdjndbfj-wq/salcara-image-mobile/releases/download/v1.2.3/salcara-image-android-v1.2.3.apk',
    apiUrl: 'https://api.github.com/repos/dkdjndbfj-wq/salcara-image-mobile/releases/assets/123456789',
    digest: `sha256:${'a'.repeat(64)}`,
  },
};

describe('app updates', () => {
  test('isolates the remote test APK from every production update entry point', () => {
    expect(productionUpdateCheckEnabled(REMOTE_TEST_APPLICATION_ID)).toBe(false);
    expect(productionUpdateCheckEnabled('top.salcara.image')).toBe(true);
    expect(productionUpdateCheckEnabled(null)).toBe(true);
    expect(productionUpdateCheckEnabled(undefined)).toBe(true);
  });

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

  test('ignores other APKs and selects the exact production asset', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      if (!String(input).includes('api.github.com')) throw new Error('offline mirror');
      return { ok: true, json: async () => ({
        tag_name: released.tagName, published_at: released.publishedAt,
        assets: [
          { name: 'debug-test.apk', browser_download_url: 'https://example.com/test.apk' },
          { name: released.apk.name, browser_download_url: released.apk.url, size: released.apk.size, digest: released.apk.digest },
        ],
      }) } as Response;
    });
    try { await expect(fetchLatestRelease()).resolves.toMatchObject({ apk: { name: released.apk.name } }); }
    finally { fetchMock.mockRestore(); }
  });

  test('a cancelled check cannot return a late valid manifest', async () => {
    const controller = new AbortController();
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async () => {
      controller.abort();
      return { ok: true, json: async () => released } as Response;
    });
    try { await expect(fetchLatestRelease(controller.signal)).rejects.toMatchObject({ name: 'AbortError' }); }
    finally { fetchMock.mockRestore(); }
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

  test('accepts only an official API asset or first-party mirror as alternate download fronts', () => {
    expect(parseReleaseManifest(released).apk.apiUrl).toContain('/releases/assets/');
    expect(() => parseReleaseManifest({
      ...released,
      apk: { ...released.apk, apiUrl: 'https://api.github.com/repos/attacker/repo/releases/assets/1' },
    })).toThrow('更新清单');
    expect(() => parseReleaseManifest({
      ...released,
      apk: { ...released.apk, mirrorUrl: 'https://example.com/app.apk' },
    })).toThrow('更新清单');
    const withMirror = parseReleaseManifest({
      ...released,
      apk: { ...released.apk, mirrorUrl: 'https://salcara.top/downloads/salcara-image-android-v1.2.3.apk' },
    });
    expect(apkDownloadCandidates(withMirror).map((item) => item.label)).toEqual([
      'Salcara 更新镜像', 'GitHub API 资源', 'GitHub 发布资源',
    ]);
  });

  test('installs the APK only on Android; iOS goes to the App Store / TestFlight or just shows notes', () => {
    expect(updateInstallMode('android')).toBe('apk');
    expect(updateInstallMode('android', 'https://apps.apple.com/app/id1')).toBe('apk');
    expect(updateInstallMode('ios', '')).toBe('notes');
    expect(updateInstallMode('ios', '   ')).toBe('notes');
    expect(updateInstallMode('ios', 'itms-apps://apps.apple.com/app/id1')).toBe('notes');
    expect(updateInstallMode('ios', 'https://testflight.apple.com/join/AbCdEf')).toBe('store');
    expect(updateInstallMode('ios', 'https://apps.apple.com/cn/app/id1234567890')).toBe('store');
    // The shipped constant drives the default: no link → notes only and no silent checks.
    expect(updateInstallMode('ios')).toBe(IOS_UPDATE_URL ? 'store' : 'notes');
    expect(autoUpdateCheckEnabled('ios', '')).toBe(false);
    expect(autoUpdateCheckEnabled('ios', 'https://apps.apple.com/app/id1')).toBe(true);
    expect(autoUpdateCheckEnabled('android')).toBe(true);
  });
});
