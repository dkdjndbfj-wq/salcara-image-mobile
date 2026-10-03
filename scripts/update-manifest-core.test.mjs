import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUpdateManifest, assertManifestAdvance, OFFICIAL_REPOSITORY as repo } from './update-manifest-core.mjs';

const tag = 'v1.8.0';
const checksum = 'a'.repeat(64);
const release = { tag_name: tag, published_at: '2026-10-04T00:00:00Z', assets: [{
  name: `salcara-image-android-${tag}.apk`, size: 100,
  browser_download_url: `https://github.com/${repo}/releases/download/${tag}/salcara-image-android-${tag}.apk`,
  url: `https://api.github.com/repos/${repo}/releases/assets/123`, digest: `sha256:${checksum}`,
}] };
test('stable exact production package creates an update manifest', () => {
  assert.equal(createUpdateManifest(repo, tag, release, checksum).version, '1.8.0');
});
test('asset bytes must agree with the downloaded checksum', () => {
  assert.throws(() => createUpdateManifest(repo, tag, release, 'b'.repeat(64)), /digest/);
});
test('unpublished, draft, prerelease, wrong repository, and wrong asset are rejected', () => {
  for (const extra of [{ published_at: null }, { draft: true }, { prerelease: true }, { tag_name: 'v9.0.0' }, { assets: [] }]) {
    assert.throws(() => createUpdateManifest(repo, tag, { ...release, ...extra }, checksum));
  }
  assert.throws(() => createUpdateManifest('attacker/repo', tag, release, checksum));
});
test('mirrors cannot contain credentials, queries or foreign origins', () => {
  for (const base of ['https://user@salcara.top/app', 'https://salcara.top/app?x=1', 'https://salcara.top.attacker.test/app', 'http://salcara.top/app']) {
    assert.throws(() => createUpdateManifest(repo, tag, release, checksum, base));
  }
});
test('only monotonic and immutable release feeds are allowed', () => {
  const next = createUpdateManifest(repo, tag, release, checksum);
  assert.doesNotThrow(() => assertManifestAdvance({ ...next, version: '1.7.0' }, next));
  assert.doesNotThrow(() => assertManifestAdvance(next, next));
  assert.throws(() => assertManifestAdvance({ ...next, version: '1.9.0' }, next), /older/);
  assert.throws(() => assertManifestAdvance({ ...next, apk: { ...next.apk, digest: 'sha256:' + 'b'.repeat(64) } }, next), /mutate/);
});
