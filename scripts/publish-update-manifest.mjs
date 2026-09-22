import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Run only after gh release create succeeds. Never derive availability from app.json.
const repository = process.env.GITHUB_REPOSITORY;
const tag = process.env.GITHUB_REF_NAME;
const commit = process.env.GITHUB_SHA;
if (!repository || !/^v\d+\.\d+\.\d+$/.test(tag ?? '') || !commit) {
  throw new Error('A published release tag, repository and commit are required');
}
function api(path, method = 'GET', body) {
  const args = ['api', `repos/${repository}/${path}`, '--method', method];
  if (body) args.push('--input', '-');
  return JSON.parse(execFileSync('gh', args, {
    encoding: 'utf8', input: body ? JSON.stringify(body) : undefined,
    stdio: ['pipe', 'pipe', 'pipe'],
  }));
}
const release = api(`releases/tags/${tag}`);
const apk = release.assets.find((asset) => asset.name === `salcara-image-android-${tag}.apk`);
if (release.draft || release.prerelease || !release.published_at || !apk?.size || !apk.browser_download_url || !apk.url) {
  throw new Error('The stable release and its APK must be published before announcing an update');
}
const checksum = readFileSync(`${apk.name}.sha256`, 'utf8').trim().split(/\s+/)[0];
if (!/^[a-f0-9]{64}$/i.test(checksum)) throw new Error('Invalid SHA-256 sidecar');
const mirrorBase = (process.env.SALCARA_APK_MIRROR_BASE_URL ?? '').trim().replace(/\/+$/, '');
if (mirrorBase && !/^https:\/\/(?:[a-z0-9-]+\.)*salcara\.top(?::\d+)?(?:\/[^\s]*)?$/i.test(mirrorBase)) {
  throw new Error('SALCARA_APK_MIRROR_BASE_URL must be an HTTPS Salcara host');
}
const manifest = {
  version: tag.slice(1), tagName: tag, title: release.name,
  notes: release.body ?? '', pageUrl: release.html_url, publishedAt: release.published_at,
  apk: {
    name: apk.name,
    url: apk.browser_download_url,
    apiUrl: apk.url,
    ...(mirrorBase ? { mirrorUrl: `${mirrorBase}/${encodeURIComponent(apk.name)}` } : {}),
    size: apk.size,
    digest: `sha256:${checksum}`,
  },
};
let existing;
try { existing = api('contents/latest.json?ref=updates'); } catch {
  // Create a dedicated branch once. If it already exists, the following read
  // and write will surface a real permissions/connection failure instead.
  try { api('git/refs', 'POST', { ref: 'refs/heads/updates', sha: commit }); } catch {}
  try { existing = api('contents/latest.json?ref=updates'); } catch {}
}
if (existing?.content) {
  const previous = JSON.parse(Buffer.from(existing.content, 'base64').toString('utf8'));
  const parts = (value) => value.split('.').map(Number);
  const [a, b] = [parts(previous.version), parts(manifest.version)];
  const firstDifference = a.map((value, index) => value - b[index]).find((value) => value !== 0);
  if (firstDifference > 0) throw new Error('Refusing to replace the update manifest with an older release');
}
api('contents/latest.json', 'PUT', {
  message: `Publish update manifest for ${tag}`, branch: 'updates',
  content: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`).toString('base64'),
  ...(existing?.sha ? { sha: existing.sha } : {}),
});
console.log(`Published released-only update manifest for ${tag}`);
