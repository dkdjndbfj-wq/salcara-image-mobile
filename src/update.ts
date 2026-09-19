const RELEASE_API_URL = 'https://api.github.com/repos/dkdjndbfj-wq/salcara-image-mobile/releases/latest';

type GitHubAsset = {
  name?: string;
  browser_download_url?: string;
  size?: number;
  digest?: string | null;
  content_type?: string;
};

type GitHubRelease = {
  tag_name?: string;
  name?: string;
  body?: string | null;
  html_url?: string;
  published_at?: string;
  prerelease?: boolean;
  draft?: boolean;
  assets?: GitHubAsset[];
};

export type AppRelease = {
  version: string;
  tagName: string;
  title: string;
  notes: string;
  pageUrl: string;
  publishedAt: string | null;
  apk: {
    name: string;
    url: string;
    size: number;
    digest: string | null;
  };
};

export function normalizeVersion(value: string): string {
  return value.trim().replace(/^v/i, '').split(/[+-]/, 1)[0];
}

export function compareVersions(left: string, right: string): number {
  const parse = (value: string) => normalizeVersion(value).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

export async function fetchLatestRelease(signal?: AbortSignal): Promise<AppRelease> {
  const response = await fetch(RELEASE_API_URL, {
    headers: { Accept: 'application/vnd.github+json' },
    signal,
  });
  if (!response.ok) throw new Error(`检查更新失败（HTTP ${response.status}）`);
  const release = (await response.json()) as GitHubRelease;
  if (release.draft || release.prerelease) throw new Error('最新发布版本不可用于正式更新');

  const asset = release.assets?.find((item) => item.name?.toLowerCase().endsWith('.apk'));
  const tagName = release.tag_name?.trim();
  if (!tagName || !asset?.name || !asset.browser_download_url) {
    throw new Error('最新版本没有可安装的 Android APK');
  }

  return {
    version: normalizeVersion(tagName),
    tagName,
    title: release.name?.trim() || `Salcara Image ${tagName}`,
    notes: release.body?.trim() || '本次版本包含体验优化与问题修复。',
    pageUrl: release.html_url ?? 'https://github.com/dkdjndbfj-wq/salcara-image-mobile/releases/latest',
    publishedAt: release.published_at ?? null,
    apk: {
      name: asset.name,
      url: asset.browser_download_url,
      size: asset.size ?? 0,
      digest: asset.digest ?? null,
    },
  };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '未知大小';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
