import { fetch } from 'expo/fetch';
import { MAX_APK_BYTES } from './apk-download';

const REPOSITORY = 'dkdjndbfj-wq/salcara-image-mobile';
const RELEASE_API_URL = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
const RELEASE_PAGE_URL = `https://github.com/${REPOSITORY}/releases/latest`;
const RELEASE_MANIFEST_URLS = [
  `https://cdn.jsdelivr.net/gh/${REPOSITORY}@updates/latest.json`,
  `https://raw.githubusercontent.com/${REPOSITORY}/updates/latest.json`,
] as const;

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

async function fetchGitHubRelease(signal?: AbortSignal): Promise<AppRelease> {
  const response = await fetch(RELEASE_API_URL, {
    credentials: 'omit',
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Salcara-Image-Android',
    },
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

  return parseReleaseManifest({
    version: normalizeVersion(tagName),
    tagName,
    title: release.name?.trim() || `Salcara Image ${tagName}`,
    notes: release.body?.trim() || '本次版本包含体验优化与问题修复。',
    pageUrl: release.html_url ?? RELEASE_PAGE_URL,
    publishedAt: release.published_at ?? null,
    apk: {
      name: asset.name,
      url: asset.browser_download_url,
      size: asset.size ?? 0,
      digest: asset.digest ?? null,
    },
  });
}

async function fetchReleaseManifest(url: string, signal?: AbortSignal): Promise<AppRelease> {
  const response = await fetch(url, {
    credentials: 'omit',
    headers: { Accept: 'application/json', 'User-Agent': 'Salcara-Image-Android', 'Cache-Control': 'no-cache' },
    signal,
  });
  if (!response.ok) throw new Error(`备用更新入口失败（HTTP ${response.status}）`);
  return parseReleaseManifest(await response.json());
}

/** Only a manifest written after successful release publication is installable. */
export function parseReleaseManifest(payload: unknown): AppRelease {
  const release = payload as Partial<AppRelease> | null;
  if (!release || typeof release.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(release.version)
    || release.tagName !== `v${release.version}` || !release.publishedAt
    || !Number.isFinite(Date.parse(release.publishedAt))
    || release.apk?.name !== `salcara-image-android-${release.tagName}.apk`
    || typeof release.apk.url !== 'string'
    || release.apk.url !== `https://github.com/${REPOSITORY}/releases/download/${release.tagName}/${release.apk.name}`
    || !Number.isSafeInteger(release.apk.size) || release.apk.size <= 0 || release.apk.size > MAX_APK_BYTES
    || !/^sha256:[a-f0-9]{64}$/i.test(release.apk.digest ?? '')) {
    throw new Error('更新清单不完整，无法确认已发布的安装包');
  }
  return {
    ...release,
    title: typeof release.title === 'string' ? release.title : `Salcara Image ${release.tagName}`,
    notes: typeof release.notes === 'string' ? release.notes : '体验优化与问题修复。',
    pageUrl: `https://github.com/${REPOSITORY}/releases/tag/${release.tagName}`,
  } as AppRelease;
}

/**
 * Check multiple independent front doors concurrently. GitHub API, GitHub raw
 * files and jsDelivr have different reachability across mobile networks, so a
 * single blocked host no longer makes automatic update detection silently fail.
 */
export async function fetchLatestRelease(signal?: AbortSignal): Promise<AppRelease> {
  const results = await Promise.allSettled([
    withEndpointTimeout((endpointSignal) => fetchGitHubRelease(endpointSignal), signal),
    ...RELEASE_MANIFEST_URLS.map((url) =>
      withEndpointTimeout((endpointSignal) => fetchReleaseManifest(url, endpointSignal), signal)),
  ]);
  const releases = results
    .filter((result): result is PromiseFulfilledResult<AppRelease> => result.status === 'fulfilled')
    .map((result) => result.value);
  if (releases.length > 0) {
    // CDN copies may be briefly stale. Compare every reachable source instead
    // of trusting whichever network happens to answer first.
    return releases.reduce((latest, candidate) =>
      compareVersions(candidate.version, latest.version) > 0 ? candidate : latest);
  }
  if (signal?.aborted) {
    const aborted = new Error('连接更新服务器超时，请切换网络后重试。');
    aborted.name = 'AbortError';
    throw aborted;
  }
  throw new Error('GitHub 与备用更新入口均无法连接，请检查网络或稍后重试。');
}

async function withEndpointTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  if (parentSignal?.aborted) controller.abort();
  else parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', onParentAbort);
  }
}

export function latestReleasePageUrl(): string {
  return RELEASE_PAGE_URL;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '未知大小';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
