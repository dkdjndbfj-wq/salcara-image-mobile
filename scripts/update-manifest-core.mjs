export const OFFICIAL_REPOSITORY = 'dkdjndbfj-wq/salcara-image-mobile';

export function createUpdateManifest(repository, tag, release, checksum, mirrorBase = '') {
  if (repository !== OFFICIAL_REPOSITORY || !/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error('Unexpected release identity');
  const name = `salcara-image-android-${tag}.apk`;
  const apk = release.assets?.find((asset) => asset.name === name);
  const url = `https://github.com/${repository}/releases/download/${tag}/${name}`;
  if (release.tag_name !== tag || release.draft || release.prerelease || !Number.isFinite(Date.parse(release.published_at ?? ''))
      || !Number.isSafeInteger(apk?.size) || apk.size <= 0 || apk.size > 512 * 1024 * 1024
      || apk.browser_download_url !== url
      || !new RegExp(`^https://api\\.github\\.com/repos/${repository}/releases/assets/\\d+$`).test(apk.url ?? '')) {
    throw new Error('A published stable release and exact production APK are required');
  }
  if (!/^[a-f0-9]{64}$/i.test(checksum)) throw new Error('Invalid SHA-256 sidecar');
  const digest = `sha256:${checksum.toLowerCase()}`;
  if (apk.digest && apk.digest.toLowerCase() !== digest) throw new Error('Release asset digest differs from sidecar');
  if (mirrorBase) {
    const parsed = new URL(mirrorBase);
    if (parsed.protocol !== 'https:' || !(parsed.hostname === 'salcara.top' || parsed.hostname.endsWith('.salcara.top'))
        || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Invalid Salcara mirror base');
  }
  return {
    version: tag.slice(1), tagName: tag, title: release.name,
    notes: release.body ?? '', pageUrl: release.html_url, publishedAt: release.published_at,
    apk: { name, url, apiUrl: apk.url, size: apk.size, digest,
      ...(mirrorBase ? { mirrorUrl: `${mirrorBase.replace(/\/+$/, '')}/${encodeURIComponent(name)}` } : {}) },
  };
}

export function assertManifestAdvance(previous, next) {
  if (!/^\d+\.\d+\.\d+$/.test(previous?.version ?? '')) throw new Error('Existing manifest version is invalid');
  const a = previous.version.split('.').map(Number);
  const b = next.version.split('.').map(Number);
  const delta = a.map((value, index) => value - b[index]).find((value) => value !== 0) ?? 0;
  if (delta > 0) throw new Error('Refusing an older update manifest');
  if (delta === 0 && (previous.apk?.digest !== next.apk.digest || previous.apk?.size !== next.apk.size)) {
    throw new Error('Refusing to mutate an already announced version');
  }
}
