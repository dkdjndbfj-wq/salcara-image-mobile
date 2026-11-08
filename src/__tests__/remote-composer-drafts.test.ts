import { createComposerDraftSession, hydrateComposerImages } from '../remote/composer-drafts';
import { clearRemoteQueuedScope, saveRemoteQueuedDrafts } from '../remote/drafts';
import { decodeNewTask, encodeNewTask, type NewTaskSnapshot } from '../remote/new-task';

const mockSettings = new Map<string, string>();
const mockFiles = new Map<string, string>();
const mockDirectories = new Set<string>();
const mockGet = jest.fn(async (key: string): Promise<string | null> => mockSettings.get(key) ?? null);
const mockSet = jest.fn(async (key: string, value: string) => { mockSettings.set(key, value); });
const mockRead = jest.fn(async (uri: string) => mockFiles.get(uri) ?? '');
const mockWrite = jest.fn(async (uri: string, value: string) => { mockFiles.set(uri, value); });
const mockDelete = jest.fn(async (uri: string) => { mockFiles.delete(uri); });
jest.mock('../storage/database', () => ({ getSetting: (key: string) => mockGet(key), setSetting: (key: string, value: string) => mockSet(key, value) }));
jest.mock('expo-crypto', () => ({ randomUUID: () => require('node:crypto').randomUUID(), CryptoDigestAlgorithm: { SHA256: 'SHA256' }, digestStringAsync: async (_algorithm: string, value: string) =>
  require('node:crypto').createHash('sha256').update(value).digest('hex') }));
jest.mock('expo-file-system/legacy', () => ({ documentDirectory: 'file://synthetic-documents/', EncodingType: { Base64: 'base64' },
  getInfoAsync: async (uri: string) => ({ exists: mockFiles.has(uri) || mockDirectories.has(uri), isDirectory: mockDirectories.has(uri) }),
  readAsStringAsync: (uri: string) => mockRead(uri), writeAsStringAsync: (uri: string, value: string) => mockWrite(uri, value),
  makeDirectoryAsync: async () => undefined, deleteAsync: (uri: string) => mockDelete(uri) }));
const scope = 'paired-fixture|credential:one', otherScope = 'paired-fixture|credential:two';
const key = `${scope}|pc|codex:thread`, setting = 'remote_composer_drafts_v1';
const bytes = (text: string) => Buffer.from(text).toString('base64');
const image = (text = 'original') => ({ uri: 'file://picker/reused.jpg', mime: 'image/jpeg' as const, width: 40, height: 50, base64: bytes(text) });
const opened = async (draftKey = key, draftScope = scope) => { const writer = createComposerDraftSession(draftKey, draftScope); await writer.restore(); return writer; };

test.each(['"', '\\', '\u0001', '字'])('latest-message edit backup round-trips 100k %p characters without changing ordinary draft limits', async character => {
  const backupKey = `${scope}|pc|sent-edit:${'a'.repeat(64)}`;
  const body = {version:1,text:character.repeat(100_000),features:{},phase:'prepared',messageId:'user',turnId:'turn',operationId:'operation'};
  const writer = await opened(backupKey);
  const saved = await writer.save({text:JSON.stringify(body),images:[]});writer.dispose();
  const restored = await createComposerDraftSession(backupKey,scope).restore();
  expect(JSON.parse(restored!.text)).toEqual(body);
  expect(restored!.revision).toBe(saved.revision);
  const main = await opened();
  await expect(main.save({text:'x'.repeat(100_001),images:[]})).rejects.toThrow('超出限制');
  expect(await main.restore()).toBeUndefined();
});

test('new-task receipt identity survives encoding and cannot consume a reused draft revision', async () => {
  const writer = await opened(); const original = await writer.save({ text: 'same task', images: [] });
  const snapshot: NewTaskSnapshot = { version: 1, tool: 'codex', cwd: 'C:/fixture', prompt: 'same task', approval: 'ask', images: [],
    composerDraft: { key, revision: original.revision, identity: original.identity } };
  const owner = decodeNewTask(encodeNewTask(snapshot)).composerDraft!;
  expect(owner.identity).toBe(original.identity);
  expect(await writer.consume(owner.revision, owner.identity)).toBe(true); await writer.pruneEmpty();
  const newer = await writer.save({ text: 'same task', images: [] });
  expect(newer.revision).toBe(owner.revision); expect(newer.identity).not.toBe(owner.identity);
  expect(await writer.consume(owner.revision, owner.identity)).toBe(false);
  expect(await writer.restore()).toMatchObject({ identity: newer.identity, text: 'same task' });
  expect(() => encodeNewTask({ ...snapshot, composerDraft: { ...owner, identity: '' } })).toThrow();
  expect(decodeNewTask(encodeNewTask({ ...snapshot, composerDraft: { key, revision: original.revision } })).composerDraft).not.toHaveProperty('identity');
});
beforeEach(() => {
  mockSettings.clear(); mockFiles.clear(); mockDirectories.clear();
  mockGet.mockReset().mockImplementation(async name => mockSettings.get(name) ?? null);
  mockSet.mockReset().mockImplementation(async (name, value) => { mockSettings.set(name, value); });
  mockRead.mockReset().mockImplementation(async uri => mockFiles.get(uri) ?? '');
  mockWrite.mockReset().mockImplementation(async (uri, value) => { mockFiles.set(uri, value); });
  mockDelete.mockReset().mockImplementation(async uri => { mockFiles.delete(uri); });
});

test('unsent text and images recover together as metadata, without storing base64 or reading payloads', async () => {
  const writer = await opened(); const stored = await writer.save({ text: 'My unsent task', images: [image()] }); writer.dispose();
  expect(stored.images[0].base64).toBe(''); expect(stored.images[0].uri).not.toBe(image().uri);
  expect(mockSettings.get(setting)).not.toContain(bytes('original'));
  mockRead.mockClear(); const restored = await createComposerDraftSession(key, scope).restore();
  expect(restored).toMatchObject({ text: 'My unsent task', imageCount: 1, images: [{ base64: '' }] });
  expect(mockRead).not.toHaveBeenCalled();
  expect(await hydrateComposerImages(scope, restored!)).toEqual([{ ...stored.images[0], base64: bytes('original') }]);
});

test('picker URI reuse cannot replace a persisted draft and exact credential generations remain isolated', async () => {
  const writer = await opened(); const old = await writer.save({ text: 'Old', images: [image('old')] });
  const next = await writer.save({ text: 'Next', images: [image('next')] });
  const other = await opened(`${otherScope}|pc|codex:thread`, otherScope); const their = await other.save({ text: 'Other', images: [image('next')] });
  expect(old.images[0].uri).not.toBe(next.images[0].uri); expect(next.images[0].uri).not.toBe(their.images[0].uri);
  expect(mockFiles.get(old.images[0].uri)).toBe(bytes('old'));
  await expect(hydrateComposerImages(otherScope, next)).rejects.toThrow('内容已改变');
});

test('missing and directory-replaced images remain explicitly blocked and may not become pure text', async () => {
  const writer = await opened(); const saved = await writer.save({ text: 'Requires image', images: [image()] }); writer.dispose();
  mockFiles.delete(saved.images[0].uri);
  const reopened = createComposerDraftSession(key, scope); const restored = await reopened.restore();
  expect(restored).toMatchObject({ imageCount: 1, missingImages: true, images: [{ uri: saved.images[0].uri }] });
  const edited = await reopened.save({ ...restored!, text: 'Edited text' });
  await expect(hydrateComposerImages(scope, edited)).rejects.toThrow('不会只发送文字');
  mockDirectories.add(saved.images[0].uri);
  await expect(hydrateComposerImages(scope, { ...edited, missingImages: false })).rejects.toThrow('不存在');
});

test('managed bytes modified outside the app fail verification without an upload', async () => {
  const writer = await opened(); const saved = await writer.save({ text: 'Original', images: [image()] });
  mockFiles.set(saved.images[0].uri, bytes('changed'));
  await expect(hydrateComposerImages(scope, saved)).rejects.toThrow('内容已改变');
});

test.each(['damaged', 'unknown', 'oversized'])('%s composer data is not restored as empty or overwritten', async kind => {
  const raw = kind === 'damaged' ? '{broken' : kind === 'unknown' ? '["future"]' : JSON.stringify(Object.fromEntries(Array.from({ length: 51 }, (_, index) => [String(index), {}])));
  mockSettings.set(setting, raw); const writer = createComposerDraftSession(key, scope);
  await expect(writer.restore()).rejects.toThrow('记录无效');
  await expect(writer.save({ text: 'Replacement', images: [] })).rejects.toThrow();
  expect(mockSettings.get(setting)).toBe(raw);
});

test('temporary read failure prevents saves until a genuine successful restore, without truncating original data', async () => {
  const old = await opened(); await old.save({ text: 'Preserve', images: [] }); old.dispose(); const raw = mockSettings.get(setting);
  const writer = createComposerDraftSession(key, scope); mockGet.mockRejectedValueOnce(new Error('synthetic read failure'));
  await expect(writer.restore()).rejects.toThrow(); await expect(writer.save({ text: 'Replacement', images: [] })).rejects.toThrow('尚未读取');
  expect(mockSettings.get(setting)).toBe(raw); expect(await writer.restore()).toMatchObject({ text: 'Preserve' });
});

test('failed storage commit rolls back the writer revision; the same input is retryable and previous metadata remains', async () => {
  const writer = await opened(); await writer.save({ text: 'Old', images: [] }); const original = mockSettings.get(setting);
  mockSet.mockRejectedValueOnce(new Error('synthetic commit failure'));
  await expect(writer.save({ text: 'New', images: [] })).rejects.toThrow('commit failure'); expect(mockSettings.get(setting)).toBe(original);
  expect(await writer.save({ text: 'Retry', images: [] })).toMatchObject({ text: 'Retry' });
});

test('a delayed old restore cannot revive its writer or overwrite a newer mounted composer', async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), start = new Promise<void>(resolve => { entered = resolve; });
  mockGet.mockImplementationOnce(async name => { entered(); await gate; return mockSettings.get(name) ?? null; });
  const old = createComposerDraftSession(key, scope); const reading = old.restore(); await start;
  const next = createComposerDraftSession(key, scope); const newest = next.restore(); release();
  await expect(reading).rejects.toThrow('会话已改变'); await newest;
  await expect(old.save({ text: 'Late', images: [] })).rejects.toThrow('会话已改变');
  await next.save({ text: 'Newest', images: [] }); expect(JSON.parse(mockSettings.get(setting)!)[key].text).toBe('Newest');
});

test('concurrent saves serialize frozen snapshots and a late clear cannot erase a newer external revision', async () => {
  const writer = await opened(); const supplied = image('first'); const saving = writer.save({ text: 'First', images: [supplied] });
  supplied.base64 = bytes('mutated caller');
  const next = writer.save({ text: 'Second', images: [image('second')] });
  const first = await saving; const second = await next; expect(mockFiles.get(first.images[0].uri)).toBe(bytes('first'));
  const rows = JSON.parse(mockSettings.get(setting)!); rows[key].revision = second.revision + 1; rows[key].text = 'External newer'; mockSettings.set(setting, JSON.stringify(rows));
  await expect(writer.save({ text: '', images: [] })).rejects.toThrow('其他窗口改变');
  expect(JSON.parse(mockSettings.get(setting)!)[key].text).toBe('External newer');
});

test('retirement removes only this exact private composer and fences delayed saves, retaining queued/history references until then', async () => {
  const writer = await opened(); const draft = await writer.save({ text: 'Task', images: [image()] });
  await saveRemoteQueuedDrafts(`${scope}|pc|codex:queue`, [{ id: 'row', text: 'Queue', images: draft.images, scope, apiIdentity: 'computer:api_fixture', sendOptions: { surface: 'cli' }, state: 'waiting' }]);
  await writer.save({ text: '', images: [] }); expect(mockFiles.has(draft.images[0].uri)).toBe(true);
  const other = await opened(`${otherScope}|pc|codex:thread`, otherScope); const theirs = await other.save({ text: 'Other', images: [image()] });
  await clearRemoteQueuedScope(scope);
  expect(mockFiles.has(draft.images[0].uri)).toBe(false); expect(mockFiles.has(theirs.images[0].uri)).toBe(true);
  await expect(writer.save({ text: 'Late', images: [image()] })).rejects.toThrow(/原配对已解除|会话已改变/);
  expect(await createComposerDraftSession(`${otherScope}|pc|codex:thread`, otherScope).restore()).toMatchObject({ text: 'Other' });
});

test('new Codex, Claude Code and Claude Desktop composers use independent exact Agent namespaces', async () => {
  for (const id of ['codex', 'claude', 'claude-desktop']) { const writer = await opened(`${scope}|pc|new:${id}`); await writer.save({ text: id, images: [] }); writer.dispose(); }
  for (const id of ['codex', 'claude', 'claude-desktop']) expect(await createComposerDraftSession(`${scope}|pc|new:${id}`, scope).restore()).toMatchObject({ text: id });
});

test('a confirmed submission can consume its original draft after close, but cannot clear a newer edit', async () => {
  const writer = await opened(); const original = await writer.save({ text: 'Submitted', images: [image()] }); writer.dispose();
  expect(await writer.consume(original.revision)).toBe(true);
  const next = createComposerDraftSession(key, scope); expect(await next.restore()).toMatchObject({ text: '', images: [], imageCount: 0 });
  await next.save({ text: 'New unsent edit', images: [] });
  expect(await writer.consume(original.revision)).toBe(false); await writer.pruneEmpty();
  expect(JSON.parse(mockSettings.get(setting)!)[key].text).toBe('New unsent edit');
});

test('empty accepted tombstones block legacy fallback until its exact successful cleanup; failed consume is retryable', async () => {
  const writer = await opened(); const original = await writer.save({ text: 'Submitted', images: [] });
  mockSet.mockRejectedValueOnce(new Error('synthetic consume commit failure'));
  await expect(writer.consume(original.revision)).rejects.toThrow('commit failure'); expect(JSON.parse(mockSettings.get(setting)!)[key].text).toBe('Submitted');
  expect(await writer.consume(original.revision)).toBe(true);
  expect(JSON.parse(mockSettings.get(setting)!)[key]).toMatchObject({ text: '', images: [], imageCount: 0 });
  await writer.pruneEmpty(); expect(mockSettings.get(setting)).toBe('{}');
  expect(await writer.save({ text: 'Next', images: [] })).toMatchObject({ text: 'Next' });
});

test('an already started image writer is fenced before publishing into a newly mounted composer', async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), start = new Promise<void>(resolve => { entered = resolve; });
  mockWrite.mockImplementationOnce(async (uri, content) => { entered(); await gate; mockFiles.set(uri, content); });
  const old = await opened(); const saving = old.save({ text: 'Old in-flight draft', images: [image()] }); await start;
  const next = createComposerDraftSession(key, scope); const restoring = next.restore(); release();
  await expect(saving).rejects.toThrow('会话已改变'); expect(await restoring).toBeUndefined();
  await next.save({ text: 'New owner', images: [] }); expect(JSON.parse(mockSettings.get(setting)!)[key].text).toBe('New owner');
});

test('encoded-size limits reject a candidate before committing an unreadable composer table', async () => {
  const original = await opened(); await original.save({ text: 'Keep this', images: [] });
  // Each row is individually valid, but accepting another large escaped
  // string would exceed the same encoded limit used by future readers.
  const rows = JSON.parse(mockSettings.get(setting)!); const base = rows[key];
  for (let index = 0; index < 19; index += 1) rows[`${scope}|pc|codex:fill-${index}`] = { ...base, text: 'x'.repeat(100_000) };
  mockSettings.set(setting, JSON.stringify(rows));
  const writer = await opened(`${scope}|pc|codex:final`); const before = mockSettings.get(setting);
  await expect(writer.save({ text: 'x'.repeat(100_000), images: [] })).rejects.toThrow('超出限制'); expect(mockSettings.get(setting)).toBe(before);
});

test('a remounted controller already saved a new revision before late old consume; its new edits survive', async () => {
  const old = await opened(); const submitted = await old.save({ text: 'Submitted', images: [] }); old.dispose();
  const next = createComposerDraftSession(key, scope); await next.restore();
  await next.save({ text: 'New deliberate edit', images: [image('new')] });
  expect(await old.consume(submitted.revision)).toBe(false); await old.pruneEmpty();
  expect(JSON.parse(mockSettings.get(setting)!)[key].text).toBe('New deliberate edit');
});

test('late old consume ahead of a remounted save reconciles only new edits, not the original accepted snapshot', async () => {
  const old = await opened(); const submitted = await old.save({ text: 'Submitted', images: [] }); old.dispose();
  const next = createComposerDraftSession(key, scope); await next.restore();
  expect(await old.consume(submitted.revision)).toBe(true); await old.pruneEmpty();
  expect(JSON.parse(mockSettings.get(setting)!)[key]).toMatchObject({ text: '', consumedFrom: submitted.revision });
  await expect(next.save({ text: ' Submitted ', images: [] })).rejects.toThrow('其他窗口改变');
  expect(await next.save({ text: 'New deliberate edit', images: [image('new')] })).toMatchObject({ text: 'New deliberate edit' });
});

test('new remounted edits queued behind an old consume commit are still durable and recoverable', async () => {
  const old = await opened(); const submitted = await old.save({ text: 'Submitted', images: [] }); old.dispose();
  const next = createComposerDraftSession(key, scope); await next.restore();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), start = new Promise<void>(resolve => { entered = resolve; });
  mockSet.mockImplementationOnce(async (name, value) => { entered(); await gate; mockSettings.set(name, value); });
  const consuming = old.consume(submitted.revision); await start;
  const saving = next.save({ text: 'New in-flight edit', images: [image('new')] }); release();
  expect(await consuming).toBe(true); expect(await saving).toMatchObject({ text: 'New in-flight edit' }); await old.pruneEmpty();
  next.dispose(); expect(await createComposerDraftSession(key, scope).restore()).toMatchObject({ text: 'New in-flight edit', imageCount: 1 });
});

test('an in-flight new image stage ahead of late old consume wins its revision before the old CAS runs', async () => {
  const old = await opened(); const submitted = await old.save({ text: 'Submitted', images: [] }); old.dispose();
  const next = createComposerDraftSession(key, scope); await next.restore();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), start = new Promise<void>(resolve => { entered = resolve; });
  mockWrite.mockImplementationOnce(async (uri, value) => { entered(); await gate; mockFiles.set(uri, value); });
  const saving = next.save({ text: 'New image stage', images: [image('new')] }); await start;
  const consuming = old.consume(submitted.revision); release();
  expect(await saving).toMatchObject({ text: 'New image stage' }); expect(await consuming).toBe(false);
  expect(JSON.parse(mockSettings.get(setting)!)[key].text).toBe('New image stage');
});

test('failed revision reconciliation does not let the accepted old prompt return; genuinely new edits can retry', async () => {
  const old = await opened(); const submitted = await old.save({ text: 'Submitted', images: [] }); old.dispose();
  const next = createComposerDraftSession(key, scope); await next.restore(); await old.consume(submitted.revision);
  mockSet.mockRejectedValueOnce(new Error('synthetic reconciled commit failure'));
  await expect(next.save({ text: 'New edit', images: [] })).rejects.toThrow('commit failure');
  await expect(next.save({ text: 'Submitted', images: [] })).rejects.toThrow('其他窗口改变');
  expect(await next.save({ text: 'Retried new edit', images: [] })).toMatchObject({ text: 'Retried new edit' });
});
