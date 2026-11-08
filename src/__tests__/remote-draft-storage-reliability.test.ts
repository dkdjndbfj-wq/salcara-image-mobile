import { loadRemoteDraft, loadRemoteQueuedDrafts, saveRemoteDraft, saveRemoteQueuedDrafts } from '../remote/drafts';

const mockSettings = new Map<string, string>();
let mockReadFailure = false;
let mockWriteFailure = false;
const mockGet = jest.fn(async (key: string): Promise<string | null> => { if (mockReadFailure) throw new Error('synthetic read failure'); return mockSettings.get(key) ?? null; });
jest.mock('../storage/database', () => ({ getSetting: (key: string) => mockGet(key),
  setSetting: async (key: string, value: string) => { if (mockWriteFailure) throw new Error('synthetic write failure'); mockSettings.set(key, value); } }));
jest.mock('../remote/queued-image-files', () => ({ markRemoteImagesInUse: () => undefined,
  withQueueImageTransaction: async (run: any) => run({ assertActive: async () => undefined, stage: async (_scope: string, image: any) => image }),
  retireQueuedImageScope: async () => undefined, verifyManagedQueuedImage: async () => undefined }));
jest.mock('expo-file-system/legacy', () => ({ getInfoAsync: async () => ({ exists: true, isDirectory: false }) }));
const scope = 'synthetic-pair|credential:fixture', key = `${scope}|pc|codex:original`;
const row = { id: 'row-1', text: 'Preserve queued task', images: [], scope, apiIdentity: 'computer:api_fixture', state: 'waiting' as const,
  sendOptions: { surface: 'cli' as const } };
beforeEach(() => { mockSettings.clear(); mockReadFailure = false; mockWriteFailure = false; mockGet.mockReset().mockImplementation(async name => {
  if (mockReadFailure) throw new Error('synthetic read failure'); return mockSettings.get(name) ?? null;
}); });

test.each(['text', 'queue'] as const)('%s read failure cannot be treated as an empty writable table', async kind => {
  const setting = kind === 'text' ? 'remote_drafts_v1' : 'remote_queued_v1';
  const original = JSON.stringify({ [key]: kind === 'text' ? 'Preserve unsent text' : [row] }); mockSettings.set(setting, original); mockReadFailure = true;
  await expect(kind === 'text' ? saveRemoteDraft(key, 'Replacement', scope) : saveRemoteQueuedDrafts(key, [{ ...row, text: 'Replacement' }])).rejects.toThrow();
  expect(mockSettings.get(setting)).toBe(original);
});

test.each(['text', 'queue'] as const)('%s write failure preserves committed data and permits a later bounded retry', async kind => {
  const setting = kind === 'text' ? 'remote_drafts_v1' : 'remote_queued_v1';
  const original = JSON.stringify({ [key]: kind === 'text' ? 'Preserve unsent text' : [row] }); mockSettings.set(setting, original); mockWriteFailure = true;
  await expect(kind === 'text' ? saveRemoteDraft(key, 'Replacement', scope) : saveRemoteQueuedDrafts(key, [{ ...row, text: 'Replacement' }])).rejects.toThrow();
  expect(mockSettings.get(setting)).toBe(original); mockWriteFailure = false;
  await (kind === 'text' ? saveRemoteDraft(key, 'Retry', scope) : saveRemoteQueuedDrafts(key, [{ ...row, text: 'Retry' }]));
  expect(JSON.parse(mockSettings.get(setting)!)[key]).toEqual(kind === 'text' ? 'Retry' : [{ ...row, text: 'Retry' }]);
});

test.each(['text', 'queue'] as const)('%s delayed read is serialized with later saves and cannot lose an unrelated row', async kind => {
  const setting = kind === 'text' ? 'remote_drafts_v1' : 'remote_queued_v1', other = `${scope}|pc|codex:other`;
  mockSettings.set(setting, JSON.stringify({ [key]: kind === 'text' ? 'Old' : [row] }));
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), start = new Promise<void>(resolve => { entered = resolve; });
  mockGet.mockImplementationOnce(async name => { const before = mockSettings.get(name) ?? null; entered(); await gate; return before; });
  const reading = kind === 'text' ? loadRemoteDraft(key) : loadRemoteQueuedDrafts(key); await start;
  const saving = kind === 'text' ? saveRemoteDraft(other, 'New', scope) : saveRemoteQueuedDrafts(other, [{ ...row, text: 'New' }]);
  release(); await reading; await saving;
  const saved = JSON.parse(mockSettings.get(setting)!);
  expect(saved[key]).toEqual(kind === 'text' ? 'Old' : [row]); expect(saved[other]).toEqual(kind === 'text' ? 'New' : [{ ...row, text: 'New' }]);
});

test('editing one queue preserves recognizable legacy and blocked malformed-image records verbatim', async () => {
  const legacyKey = `${scope}|pc|new:claude`, brokenKey = `${scope}|pc|codex:broken`;
  const legacy = { text: 'Legacy task', images: [], retainedFutureMetadata: { notMigrated: true } };
  const broken = { ...row, text: 'Needs original image', images: [{ uri: 'https://not-fetched.test/image', mime: 'image/jpeg', width: 40, height: 40 }] };
  mockSettings.set('remote_queued_v1', JSON.stringify({ [legacyKey]: legacy, [brokenKey]: [broken], [key]: [row] }));
  expect(await loadRemoteQueuedDrafts(legacyKey)).toMatchObject([{ state: 'blocked', text: 'Legacy task' }]);
  expect(await loadRemoteQueuedDrafts(brokenKey)).toMatchObject([{ state: 'blocked', missingImages: true, imageCount: 1 }]);
  await saveRemoteQueuedDrafts(key, [{ ...row, text: 'Changed only this row' }]);
  const saved = JSON.parse(mockSettings.get('remote_queued_v1')!); expect(saved[legacyKey]).toEqual(legacy); expect(saved[brokenKey]).toEqual([broken]);
});

test('appending a new submission keeps an unchanged blocked legacy record in the same queue without active migration', async () => {
  const legacy = { text: 'Legacy task', images: [], retainedFutureMetadata: { notMigrated: true } };
  mockSettings.set('remote_queued_v1', JSON.stringify({ [key]: [legacy, row] }));
  const loaded = await loadRemoteQueuedDrafts(key);
  await saveRemoteQueuedDrafts(key, [...loaded, { ...row, id: 'new-row', text: 'New appended task' }]);
  const saved = JSON.parse(mockSettings.get('remote_queued_v1')!)[key];
  expect(saved[0]).toEqual(legacy); expect(saved[1]).toMatchObject(row); expect(saved[2]).toMatchObject({ text: 'New appended task' });
});

test.each([{ futureVersion: 2 }, { imageCount: 'unknown' }, { missingImages: 'unknown' }, { sendOptions: { ...row.sendOptions, futureMode: 'steer' } }])(
  'unknown frozen queue semantics stay blocked and preserved rather than being replayed as current FIFO', async extra => {
    const stored = { ...row, ...extra }; mockSettings.set('remote_queued_v1', JSON.stringify({ [key]: [stored] }));
    const loaded = await loadRemoteQueuedDrafts(key); expect(loaded[0].state).toBe('blocked');
    await saveRemoteQueuedDrafts(key, [...loaded, { ...row, id: 'new-row', text: 'New appended task' }]);
    expect(JSON.parse(mockSettings.get('remote_queued_v1')!)[key][0]).toEqual(stored);
  });

test.each(['text', 'queue'] as const)('%s oversized existing tables are retained instead of silently dropping old rows', async kind => {
  const setting = kind === 'text' ? 'remote_drafts_v1' : 'remote_queued_v1';
  const original = JSON.stringify(Object.fromEntries(Array.from({ length: kind === 'text' ? 51 : 21 }, (_, index) => [`row-${index}`, kind === 'text' ? 'Old' : [row]])));
  mockSettings.set(setting, original);
  await expect(kind === 'text' ? saveRemoteDraft(key, 'New', scope) : saveRemoteQueuedDrafts(key, [row])).rejects.toThrow();
  expect(mockSettings.get(setting)).toBe(original);
});

test.each(['text', 'queue'] as const)('%s corrupt JSON is not a successful empty restore or overwritten by a new save', async kind => {
  const setting = kind === 'text' ? 'remote_drafts_v1' : 'remote_queued_v1', original = '{synthetic damaged data'; mockSettings.set(setting, original);
  await expect(kind === 'text' ? loadRemoteDraft(key) : loadRemoteQueuedDrafts(key)).rejects.toThrow();
  await expect(kind === 'text' ? saveRemoteDraft(key, 'Replacement', scope) : saveRemoteQueuedDrafts(key, [row])).rejects.toThrow();
  expect(mockSettings.get(setting)).toBe(original);
});

test.each(['text', 'queue'] as const)('%s unknown top-level storage shape is preserved rather than discarded', async kind => {
  const setting = kind === 'text' ? 'remote_drafts_v1' : 'remote_queued_v1', original = JSON.stringify(['future-shape']); mockSettings.set(setting, original);
  await expect(kind === 'text' ? saveRemoteDraft(key, 'Replacement', scope) : saveRemoteQueuedDrafts(key, [row])).rejects.toThrow();
  expect(mockSettings.get(setting)).toBe(original);
});
