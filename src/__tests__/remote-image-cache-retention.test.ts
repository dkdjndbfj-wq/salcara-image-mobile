const mockFiles = new Map<string, { bytes: number; modified: number }>();
const mockSettings = new Map<string, string>();
const mockRoot = 'file://cache/salcara-remote-attachments';
jest.mock('../storage/database', () => ({ getSetting: async (key: string) => mockSettings.get(key) ?? null }));
jest.mock('expo-file-system', () => {
  class File {
    uri: string;
    constructor(...parts: Array<string | { uri: string }>) { this.uri = parts.map(item => typeof item === 'string' ? item.replace(/\/$/, '') : item.uri).join('/'); }
    get name() { return this.uri.split('/').at(-1)!; }
    get size() { return mockFiles.get(this.uri)?.bytes ?? 0; }
    get modificationTime() { return mockFiles.get(this.uri)?.modified; }
    get exists() { return mockFiles.has(this.uri); }
    delete() { mockFiles.delete(this.uri); }
  }
  class Directory extends File {
    get exists() { return [...mockFiles.keys()].some(uri => uri.startsWith(`${this.uri}/`)); }
    list() { return [...new Set([...mockFiles.keys()].filter(uri => uri.startsWith(`${this.uri}/`)).map(uri => uri.slice(this.uri.length + 1).split('/')[0]))]
      .map(name => mockFiles.has(`${this.uri}/${name}`) ? new File(this, name) : new Directory(this, name)); }
  }
  return { File, Directory, Paths: { cache: 'file://cache' } };
});

import { ATTACHMENT_CACHE_TTL, collectAttachmentCache, reserveAttachmentCache, retainCachedAttachment } from '../remote/attachment-cache-policy';
const MiB = 1024 * 1024;
let sequence = 0;
function add(bytes: number, age: number, partial = false) {
  const id = `att_${(++sequence).toString(16).padStart(32, '0')}`;
  const uri = `${mockRoot}/${'a'.repeat(32)}/${id}.${partial ? 'part' : 'jpg'}`;
  mockFiles.set(uri, { bytes, modified: Date.now() - age }); return { uri, id };
}
beforeEach(() => { mockFiles.clear(); mockSettings.clear(); });

test('expired file collection preserves visible editors and exact pending/canvas references', async () => {
  const expired = add(MiB, ATTACHMENT_CACHE_TTL + 1), visible = add(MiB, ATTACHMENT_CACHE_TTL + 1);
  const pending = add(MiB, ATTACHMENT_CACHE_TTL + 1), canvas = add(MiB, ATTACHMENT_CACHE_TTL + 1);
  mockSettings.set('remote_pending_delivery_v1', JSON.stringify([{ attachmentSources: [{ uri: pending.uri }] }]));
  mockSettings.set('remote_image_canvas_sessions_v2', JSON.stringify([{ imageId: canvas.id }]));
  const release = retainCachedAttachment(visible.uri);
  expect((await collectAttachmentCache()).removed).toBe(1);
  expect(mockFiles.has(expired.uri)).toBe(false);
  expect([visible, pending, canvas].every(item => mockFiles.has(item.uri))).toBe(true); release();
});

test('LRU admission reclaims old recoverable cache, never pending images', async () => {
  const oldest = add(8 * MiB, 4 * 86400_000);
  for (let i = 0; i < 7; i++) add(8 * MiB, 2 * 86400_000);
  const release = await reserveAttachmentCache(8 * MiB);
  expect(mockFiles.has(oldest.uri)).toBe(false); expect(mockFiles.size).toBe(7); release();
  mockSettings.set('remote_pending_delivery_v1', JSON.stringify([...mockFiles.keys()]));
  const release2 = await reserveAttachmentCache(8 * MiB);
  await expect(reserveAttachmentCache(8 * MiB)).rejects.toThrow('空间不足'); release2();
});

test('partial uploads use the one-hour deadline and collector ignores files outside managed directory', async () => {
  const stale = add(MiB, 3600_001, true), recent = add(MiB, 1800_000, true);
  mockFiles.set('file://documents/user-saved.png', { bytes: MiB, modified: 0 });
  await collectAttachmentCache();
  expect(mockFiles.has(stale.uri)).toBe(false); expect(mockFiles.has(recent.uri)).toBe(true);
  expect(mockFiles.has('file://documents/user-saved.png')).toBe(true);
});

test('corrupt ownership prevents deletion and each cleanup round is bounded by bytes', async () => {
  for (let i = 0; i < 8; i++) add(8 * MiB, ATTACHMENT_CACHE_TTL + 100);
  mockSettings.set('remote_composer_drafts_v1', '{');
  await expect(collectAttachmentCache()).rejects.toThrow(); expect(mockFiles.size).toBe(8);
  mockSettings.clear(); expect((await collectAttachmentCache()).removed).toBe(6); expect(mockFiles.size).toBe(2);
});

test('canvas identity preserves originals while expired derived images remain rebuildable', async () => {
  const original = add(MiB, ATTACHMENT_CACHE_TTL + 100);
  const thumbnail = original.uri.replace('.jpg', '-thumbnail-v1-deadbeef.jpg');
  const preview = original.uri.replace('.jpg', '-preview-v1-deadbeef.jpg');
  const detail = original.uri.replace('.jpg', '-detail-v1-deadbeef.jpg');
  mockFiles.set(thumbnail, { bytes: MiB, modified: Date.now() - ATTACHMENT_CACHE_TTL - 100 });
  mockFiles.set(preview, { bytes: MiB, modified: Date.now() - ATTACHMENT_CACHE_TTL - 100 });
  mockFiles.set(detail, { bytes: MiB, modified: Date.now() - ATTACHMENT_CACHE_TTL - 100 });
  mockSettings.set('remote_image_canvas_sessions_v2', JSON.stringify([{ imageId: original.id }]));
  mockSettings.set('remote_pending_delivery_v1', JSON.stringify([{ uri: preview }]));
  expect((await collectAttachmentCache()).removed).toBe(2);
  expect(mockFiles.has(thumbnail)).toBe(false);
  expect(mockFiles.has(detail)).toBe(false);
  expect(mockFiles.has(original.uri)).toBe(true);
  expect(mockFiles.has(preview)).toBe(true);
});

test('quota reclaims derived images before older originals and keeps visible derived files', async () => {
  const original = add(8 * MiB, 4 * 86400_000);
  for (let i = 0; i < 5; i++) add(8 * MiB, 2 * 86400_000);
  const thumbnail = original.uri.replace('.jpg', '-thumbnail-v1-deadbeef.jpg');
  const preview = original.uri.replace('.jpg', '-preview-v1-deadbeef.jpg');
  mockFiles.set(thumbnail, { bytes: 8 * MiB, modified: Date.now() - 86400_000 });
  mockFiles.set(preview, { bytes: 8 * MiB, modified: Date.now() - 86400_000 });
  const releaseVisible = retainCachedAttachment(preview);
  const releaseSpace = await reserveAttachmentCache(8 * MiB);
  expect(mockFiles.has(thumbnail)).toBe(false);
  expect(mockFiles.has(original.uri)).toBe(true);
  expect(mockFiles.has(preview)).toBe(true);
  releaseSpace(); releaseVisible();
});
