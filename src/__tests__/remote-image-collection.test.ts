// Keep the actual SQLite query and draft/queue writers in the loop. Only the
// native filesystem is synthetic; no phone data or remote service is touched.
let mockDb: InstanceType<typeof import('node:sqlite').DatabaseSync>;
const mockFiles = new Map<string, string>();
const mockDirectories = new Set<string>();
const mockDelete = jest.fn(async (uri: string) => { mockFiles.delete(uri); });
const mockInfo = jest.fn(async (uri: string) => ({ exists: mockFiles.has(uri) || mockDirectories.has(uri), isDirectory: mockDirectories.has(uri) }));
let mockReferenceRead: (() => Promise<void>) | undefined;
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: async () => ({
  execAsync: async (sql: string) => mockDb.exec(sql),
  runAsync: async (sql: string, ...args: unknown[]) => mockDb.prepare(sql).run(...args as never[]),
  getAllAsync: async (sql: string, ...args: unknown[]) => {
    if (sql.startsWith('SELECT key, value FROM app_settings')) await mockReferenceRead?.();
    return mockDb.prepare(sql).all(...args as never[]);
  },
  getFirstAsync: async (sql: string, ...args: unknown[]) => mockDb.prepare(sql).get(...args as never[]) ?? null,
}) }));
jest.mock('expo-file-system/legacy', () => ({ documentDirectory: 'file://fixture/documents/', EncodingType: { Base64: 'base64' },
  getInfoAsync: (uri: string) => mockInfo(uri), makeDirectoryAsync: async () => undefined,
  readAsStringAsync: async (uri: string) => mockFiles.get(uri) ?? '',
  writeAsStringAsync: async (uri: string, content: string) => { mockFiles.set(uri, content); },
  deleteAsync: (uri: string) => mockDelete(uri),
}));
jest.mock('expo-crypto', () => ({ randomUUID: () => require('node:crypto').randomUUID(), CryptoDigestAlgorithm: { SHA256: 'SHA256' },
  digestStringAsync: async (_algorithm: string, value: string) => require('node:crypto').createHash('sha256').update(value).digest('hex'),
}));

let storage: typeof import('../storage/database');
let files: typeof import('../remote/queued-image-files');
let cache: typeof import('../remote/cache') | undefined;
const scope = 'station|credential:original';
const bytes = (value: string) => Buffer.from(value).toString('base64');
const image = (value: string) => ({ uri: 'file://picker/reused.jpg', mime: 'image/jpeg' as const, width: 40, height: 30, base64: bytes(value) });
const manifest = async () => JSON.parse((await storage.getSetting('remote_image_files_v2'))!);
const stage = (value: string, owner = scope) => files.withQueueImageTransaction(tx => tx.stage(owner, image(value)));
const cold = async () => { await files.resetQueuedImageLifecycleForTests(); return files.collectRemoteImagesAtStartup(); };
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

beforeEach(async () => {
  jest.resetModules(); mockDb = new (require('node:sqlite').DatabaseSync)(':memory:');
  storage = require('../storage/database'); files = require('../remote/queued-image-files'); cache = undefined;
  await storage.initializeDatabase();
  mockFiles.clear(); mockDirectories.clear(); mockReferenceRead = undefined;
  mockDelete.mockReset().mockImplementation(async uri => { mockFiles.delete(uri); });
  mockInfo.mockReset().mockImplementation(async uri => ({ exists: mockFiles.has(uri) || mockDirectories.has(uri), isDirectory: mockDirectories.has(uri) }));
});
afterEach(async () => { await cache?.resetRemoteCacheForTests(); jest.restoreAllMocks(); mockDb.close(); });

test('cold startup reclaims superseded snapshots while drafts, queues, receipts and unindexed history across pairings survive', async () => {
  const { createComposerDraftSession } = require('../remote/composer-drafts') as typeof import('../remote/composer-drafts');
  const { saveRemoteQueuedDrafts } = require('../remote/drafts') as typeof import('../remote/drafts');
  const composer = createComposerDraftSession(`${scope}|pc|codex:thread`, scope); await composer.restore();
  const old = await composer.save({ text: 'old', images: [image('old')] });
  const current = await composer.save({ text: 'current', images: [image('current')] }); composer.dispose();
  const queued = await saveRemoteQueuedDrafts(`${scope}|pc|codex:queue`, [{ text: 'queued', images: [image('queued')], scope }]);
  const receiptSource = await stage('awaiting receipt');
  const [submitted] = await files.handoffQueuedImages(scope, [{ ...image('awaiting receipt'), uri: receiptSource.uri }]);
  await storage.setSetting('remote_pending_delivery_v1', JSON.stringify([{ scope, attachmentSources: [{ uri: submitted.uri }] }]));
  const historical = await stage('other pairing history', 'station|credential:another');
  await storage.setSetting('remote.cache.t.other-pair.pc|codex:thread', JSON.stringify({ items: [{ images: [historical.uri] }] }));
  const lostCommit = await stage('failed draft commit');
  const result = await cold();
  expect(result).toMatchObject({ removedFiles: 3, deferred: false });
  expect(result.freedBytes).toBeGreaterThan(0);
  expect(new Set(mockDelete.mock.calls.map(([uri]) => uri))).toEqual(new Set([old.images[0].uri, receiptSource.uri, lostCommit.uri]));
  for (const uri of [current.images[0].uri, queued[0].images[0].uri, submitted.uri, historical.uri]) expect(mockFiles.has(uri)).toBe(true);
  expect((await manifest()).retired).toEqual([]);
  await expect(stage('next send on the same pairing')).resolves.toHaveProperty('uri');
});

test('reference enumeration ignores the LRU index and uses only exact owner tables and cache key prefix', async () => {
  await storage.setSetting('remote_composer_drafts_v1', '{}');
  await storage.setSetting('remote_queued_v1', '{}');
  await storage.setSetting('remote_pending_delivery_v1', '[]');
  await storage.setSetting('remote.cache.t.scope.thread', '{"items":[]}');
  await storage.setSetting('remote.cache.index.scope', '[]');
  await storage.setSetting('remoteXcacheXtXfalse-prefix', '{"private":"not an owner"}');
  await storage.setSetting('provider_secret', 'fixture-secret');
  const rows = await storage.remoteImageReferenceRecords();
  expect(rows.map(row => row.key).sort()).toEqual(['remote_composer_drafts_v1', 'remote_queued_v1', 'remote_pending_delivery_v1', 'remote.cache.t.scope.thread'].sort());
  expect(JSON.stringify(rows)).not.toContain('fixture-secret');
});

test.each([
  ['remote_composer_drafts_v1', '{broken'], ['remote_queued_v1', 'null'],
  ['remote_pending_delivery_v1', '{}'], ['remote.cache.t.scope.thread', '{"items":null}'],
])('uncertain persisted owners abort the entire collection: %s', async (key, value) => {
  const orphan = await stage('unused'); await storage.setSetting(key, value);
  expect(await cold()).toEqual({ removedFiles: 0, freedBytes: 0, deferred: true });
  expect(mockDelete).not.toHaveBeenCalled(); expect(mockFiles.has(orphan.uri)).toBe(true);
});

test('a failed reference read never becomes an empty owner set', async () => {
  const orphan = await stage('unused'); mockReferenceRead = async () => { throw new Error('fixture database unavailable'); };
  expect(await cold()).toMatchObject({ deferred: true, removedFiles: 0 });
  expect(mockDelete).not.toHaveBeenCalled(); expect(mockFiles.has(orphan.uri)).toBe(true);
});

test('an unproven manifest path prevents deletion and directories are never removed', async () => {
  const orphan = await stage('unused'); const original = await manifest();
  await storage.setSetting('remote_image_files_v2', JSON.stringify({ ...original, files: [{ ...original.files[0], uri: 'file://fixture/documents/important.jpg' }] }));
  expect(await cold()).toMatchObject({ deferred: true }); expect(mockDelete).not.toHaveBeenCalled();
  await storage.setSetting('remote_image_files_v2', JSON.stringify(original)); mockDirectories.add(orphan.uri);
  expect(await cold()).toMatchObject({ removedFiles: 0 }); expect(mockDelete).not.toHaveBeenCalled();
  expect((await manifest()).files).toHaveLength(1);
});

test('a filesystem deletion failure retains exact ownership for the next cold-start retry', async () => {
  const orphan = await stage('unused'); mockDelete.mockRejectedValueOnce(new Error('fixture denied'));
  expect(await cold()).toMatchObject({ removedFiles: 0 });
  expect((await manifest()).files).toHaveLength(1); expect(mockFiles.has(orphan.uri)).toBe(true);
  expect(await cold()).toMatchObject({ removedFiles: 1 }); expect((await manifest()).files).toHaveLength(0);
});

test('a failed manifest commit cannot be forgotten by a later successful deletion', async () => {
  const first = await stage('first'), second = await stage('second');
  const originalSet = storage.setSetting;
  jest.spyOn(storage, 'setSetting').mockImplementationOnce(async () => { throw new Error('fixture failed commit'); }).mockImplementation(originalSet);
  expect(await cold()).toMatchObject({ removedFiles: 1 });
  expect((await manifest()).files.map((file: { uri: string }) => file.uri)).toEqual([first.uri]);
  expect(mockFiles.has(first.uri)).toBe(false); expect(mockFiles.has(second.uri)).toBe(false);
  expect(await cold()).toMatchObject({ removedFiles: 1 }); expect((await manifest()).files).toHaveLength(0);
});

test('a debounced history writer fences collection before its references reach SQLite', async () => {
  const orphan = await stage('pending history'); await files.resetQueuedImageLifecycleForTests();
  cache = require('../remote/cache');
  cache!.saveCachedThread(scope, 'pc|codex:thread', { items: [{ kind: 'message', images: [orphan.uri] }] });
  expect(await files.collectRemoteImagesAtStartup()).toMatchObject({ deferred: true, removedFiles: 0 });
  expect(mockFiles.has(orphan.uri)).toBe(true); expect(mockDelete).not.toHaveBeenCalled();
});

test('a queued publisher arriving during the owner scan stops collection and drains without a lock cycle', async () => {
  const orphan = await stage('reused'); await files.resetQueuedImageLifecycleForTests();
  const entered = deferred(), release = deferred();
  mockReferenceRead = async () => { entered.resolve(); await release.promise; };
  const collecting = files.collectRemoteImagesAtStartup(); await entered.promise;
  const writing = stage('reused'); release.resolve();
  expect(await collecting).toMatchObject({ deferred: true, removedFiles: 0 });
  expect((await writing).uri).toBe(orphan.uri); expect(mockDelete).not.toHaveBeenCalled();
});

test('a consumer arriving during filesystem stat cancels deletion before its native dispatch', async () => {
  const orphan = await stage('reused'); await files.resetQueuedImageLifecycleForTests();
  const entered = deferred(), release = deferred();
  mockInfo.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return { exists: true, isDirectory: false }; });
  const collecting = files.collectRemoteImagesAtStartup(); await entered.promise;
  const writing = stage('reused'); release.resolve();
  expect(await collecting).toMatchObject({ deferred: true, removedFiles: 0 }); await writing;
  expect(mockFiles.has(orphan.uri)).toBe(true); expect(mockDelete).not.toHaveBeenCalled();
});

test('maintenance is shared and never sweeps again after remote consumers have started', async () => {
  const orphan = await stage('before boot'); await files.resetQueuedImageLifecycleForTests();
  const first = files.collectRemoteImagesAtStartup(); expect(files.collectRemoteImagesAtStartup()).toBe(first);
  await first; expect(mockFiles.has(orphan.uri)).toBe(false);
  const live = await stage('active preview'); await files.collectRemoteImagesAtStartup();
  expect(mockFiles.has(live.uri)).toBe(true);
  expect(await cold()).toMatchObject({ removedFiles: 1 });
});
