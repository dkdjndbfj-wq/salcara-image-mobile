import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createUpdateManifest, assertManifestAdvance } from './update-manifest-core.mjs';

// Run only after gh release create succeeds. Never derive availability from app.json.
const repository = process.env.GITHUB_REPOSITORY;
const tag = process.env.GITHUB_REF_NAME;
const commit = process.env.GITHUB_SHA;
// Contents API defaults can expose the human publisher's configured email.
// Use the project's public GitHub noreply identity for automation and local runs.
const publisherIdentity = { name: 'Salcara', email: '284591649+dkdjndbfj-wq@users.noreply.github.com' };
if (!repository || !/^v\d+\.\d+\.\d+$/.test(tag ?? '') || !commit) {
  throw new Error('A published release tag, repository and commit are required');
}
function api(path, method = 'GET', body) {
  const args = ['api', `repos/${repository}/${path}`, '--method', method];
  const requestDir = body ? mkdtempSync(join(tmpdir(), 'salcara-update-publish-')) : null;
  const requestFile = requestDir ? join(requestDir, 'request.json') : null;
  try {
    if (body) {
      writeFileSync(requestFile, JSON.stringify(body), { flag: 'wx' });
      args.push('--input', requestFile);
    }
    return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000 }));
  } finally {
    if (requestFile) unlinkSync(requestFile);
    if (requestDir) rmdirSync(requestDir);
  }
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
const manifest = createUpdateManifest(repository, tag, release, checksum, mirrorBase);
function optional(path) {
  try { return api(path); }
  catch (error) {
    if (/\(HTTP 404\)/.test(String(error.stderr ?? ''))) return undefined;
    throw error; // Never turn auth/rate-limit/network failures into first-time publication.
  }
}
if (!optional('git/ref/heads/updates')) api('git/refs', 'POST', { ref: 'refs/heads/updates', sha: commit });
const existing = optional('contents/latest.json?ref=updates');
if (existing?.content) {
  const previous = JSON.parse(Buffer.from(existing.content, 'base64').toString('utf8'));
  assertManifestAdvance(previous, manifest);
}
api('contents/latest.json', 'PUT', {
  message: `Publish update manifest for ${tag}`, branch: 'updates',
  author: publisherIdentity, committer: publisherIdentity,
  content: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`).toString('base64'),
  ...(existing?.sha ? { sha: existing.sha } : {}),
});
console.log(`Published released-only update manifest for ${tag}`);
