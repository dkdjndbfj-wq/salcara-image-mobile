import { clearRemoteQueuedScope, loadRemoteDraft, loadRemoteQueuedDrafts, saveRemoteDraft, saveRemoteQueuedDrafts } from '../remote/drafts';

const mockStorage = new Map<string, string>();
const mockSet = jest.fn(async (key: string, value: string) => { mockStorage.set(key, value); });
jest.mock('../storage/database', () => ({ getSetting: async (key: string) => mockStorage.get(key) ?? null,
  setSetting: (key: string, value: string) => mockSet(key, value) }));
jest.mock('expo-file-system/legacy', () => ({ documentDirectory: 'file://synthetic-documents/', EncodingType: { Base64: 'base64' } }));
jest.mock('expo-crypto', () => ({ CryptoDigestAlgorithm: { SHA256: 'SHA256' }, digestStringAsync: async (_algorithm: string, value: string) =>
  require('node:crypto').createHash('sha256').update(value).digest('hex') }));

const a = 'station|credential-generation-a';
const b = 'station|credential-generation-ab';
const key = (scope: string) => `${scope}|pc|codex:task`;
beforeEach(() => { mockStorage.clear(); mockSet.mockReset().mockImplementation(async (name, value) => { mockStorage.set(name, value); }); });

test('private text is not migrated from the public station key or another credential generation', async () => {
  await saveRemoteDraft('station|pc|codex:task', 'legacy text');
  await saveRemoteDraft(key(a), 'private text', a);
  expect(await loadRemoteDraft(key(b))).toBe('');
  expect(await loadRemoteDraft(key(a))).toBe('private text');
});

test('unpair clears only the exact credential-scoped text and queue; late writes are fenced', async () => {
  await saveRemoteDraft(key(a), 'private A', a); await saveRemoteDraft(key(b), 'private B', b);
  await saveRemoteDraft('station|pc|codex:task', 'legacy text');
  await saveRemoteQueuedDrafts(key(a), [{ text: 'queued A', images: [], scope: a }]);
  await saveRemoteQueuedDrafts(key(b), [{ text: 'queued B', images: [], scope: b }]);
  await clearRemoteQueuedScope(a);
  expect(await loadRemoteDraft(key(a))).toBe(''); expect(await loadRemoteQueuedDrafts(key(a))).toEqual([]);
  expect(await loadRemoteDraft(key(b))).toBe('private B'); expect(await loadRemoteQueuedDrafts(key(b))).toMatchObject([{ text: 'queued B' }]);
  expect(await loadRemoteDraft('station|pc|codex:task')).toBe('legacy text');
  await expect(saveRemoteDraft(key(a), 'late text', a)).rejects.toThrow('原配对已解除');
  await expect(saveRemoteQueuedDrafts(key(a), [{ text: 'late queue', images: [], scope: a }])).rejects.toThrow('原配对已解除');
  expect(await loadRemoteDraft(key(a))).toBe('');
});

test('mismatched explicit text scope is rejected instead of writing into another private key', async () => {
  await expect(saveRemoteDraft(key(b), 'misrouted', a)).rejects.toThrow('身份不匹配');
  expect(await loadRemoteDraft(key(b))).toBe('');
});

test('unpair drains an already-started text write then removes it before accepting new work', async () => {
  let release!: () => void; let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  mockSet.mockImplementationOnce(async (name, value) => { started(); await gate; mockStorage.set(name, value); });
  const writing = saveRemoteDraft(key(a), 'pending text', a); await entered;
  const retiring = clearRemoteQueuedScope(a); release(); await writing; await retiring;
  expect(await loadRemoteDraft(key(a))).toBe('');
});

test('legacy bare connection cleanup cannot clear a newly paired credential namespace', async () => {
  const oldScope = 'station|credential:old-digest'; const newScope = 'station|credential:new-digest';
  await saveRemoteDraft(key(oldScope), 'old', oldScope); await saveRemoteDraft(key(newScope), 'new', newScope);
  await saveRemoteQueuedDrafts(key(newScope), [{ text: 'new queued task', images: [], scope: newScope }]);
  await clearRemoteQueuedScope('station');
  expect(await loadRemoteDraft(key(newScope))).toBe('new');
  expect(await loadRemoteQueuedDrafts(key(newScope))).toMatchObject([{ text: 'new queued task' }]);
  await clearRemoteQueuedScope(oldScope);
  expect(await loadRemoteDraft(key(oldScope))).toBe(''); expect(await loadRemoteDraft(key(newScope))).toBe('new');
  expect(await loadRemoteQueuedDrafts(key(newScope))).toMatchObject([{ text: 'new queued task' }]);
  await expect(saveRemoteDraft(key(oldScope), 'late old', oldScope)).rejects.toThrow('原配对已解除');
  await saveRemoteDraft(key(newScope), 'still new', newScope); expect(await loadRemoteDraft(key(newScope))).toBe('still new');
});
