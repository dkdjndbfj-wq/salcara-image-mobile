import { clearRemoteCache, loadCachedSessions, loadCachedThread, resetRemoteCacheForTests, saveCachedSessions, saveCachedThread } from '../remote/cache';
import type { HubEvent, SessionInfo } from '../remote/client';
import { applyEvent, mergeHistory, type Timeline } from '../remote/store';

const mockSettings = new Map<string, string>();
const mockWrite = jest.fn(async (key: string, value: string | null) => { if (value == null) mockSettings.delete(key); else mockSettings.set(key, value); });
const mockClearQueuedScope = jest.fn(async (_scope: string) => undefined);
jest.mock('../remote/drafts', () => ({ clearRemoteQueuedScope: (scope: string) => mockClearQueuedScope(scope) }));
jest.mock('../storage/database', () => ({ getSetting: async (key: string) => mockSettings.get(key) ?? null,
  setSetting: (key: string, value: string | null) => mockWrite(key, value) }));
const session: SessionInfo = { sessionKey: 'codex:original', tool: 'codex', client: 'Codex CLI', title: 'Fixture', cwd: '/fixture', updatedAt: 1, status: 'idle', controllable: true, controlSurface: 'cli' };
const timeline = { session, items: [{ kind: 'message', role: 'assistant', id: 'm1', text: 'Fixture', ts: 1, final: true }] };
const key = 'pc|codex:original';
const scope = 'pair|credential:old';
beforeEach(async () => { await resetRemoteCacheForTests(); mockSettings.clear(); mockWrite.mockClear(); mockClearQueuedScope.mockReset().mockResolvedValue(undefined); jest.useFakeTimers(); });
afterEach(async () => { await resetRemoteCacheForTests(); jest.useRealTimers(); });
async function flush() { await jest.advanceTimersByTimeAsync(1600); }

test('cached revert tombstones retain newly discovered untagged output IDs and reject their next-page replay',async()=>{
  const base:Timeline={items:[],loading:false,session};
  const common={deviceId:'pc',sessionKey:session.sessionKey,tool:'codex',ts:1};
  const revoked:HubEvent={...common,type:'session.reverted',id:'old-user',turnId:'old-turn',operationId:'revert-op'};
  const output:HubEvent={...common,type:'message',id:'previously-unseen-output',role:'assistant',text:'old result',final:true};
  const next=mergeHistory(applyEvent(base,revoked),session,[{...common,type:'message',id:'old-user',turnId:'old-turn',role:'user',text:'old request',final:true},output,{...common,type:'turn',turnId:'old-turn',status:'completed'},revoked]);
  saveCachedThread(scope,key,next);await flush();
  const cached=await loadCachedThread(scope,key);expect(cached?.revertedItems).toContain(output.id);
  const restored={...cached,items:cached!.items as Timeline['items'],loading:false} as Timeline;
  expect(mergeHistory(restored,session,[output]).items).toEqual([]);
});

test('revoking before debounce prevents any late thread or directory write', async () => {
  saveCachedThread(scope, key, timeline); saveCachedSessions(scope, 'pc', [session]);
  await clearRemoteCache(scope, ['pc']); await flush();
  expect(await loadCachedThread(scope, key)).toBeNull(); expect(await loadCachedSessions(scope, 'pc')).toBeNull();
  saveCachedThread(scope, key, timeline); await flush(); expect(await loadCachedThread(scope, key)).toBeNull();
  expect(mockClearQueuedScope).toHaveBeenCalledWith(scope);
  expect(mockClearQueuedScope).toHaveBeenCalledTimes(1);
});

test('clear is ordered after an already-started write and cannot resurrect its index', async () => {
  let unblock!: () => void;
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  mockWrite.mockImplementationOnce(async (name, value) => { await gate; if (value != null) mockSettings.set(name, value); });
  saveCachedThread(scope, key, timeline);
  jest.advanceTimersByTime(1600); await Promise.resolve(); await Promise.resolve();
  const cleared = clearRemoteCache(scope, ['pc']); unblock(); await cleared;
  expect(await loadCachedThread(scope, key)).toBeNull(); expect([...mockSettings.keys()]).toEqual([]);
});

test('parallel thread writes preserve the complete bounded LRU index', async () => {
  for (let i = 0; i < 45; i++) saveCachedThread(scope, `pc|codex:${i}`, { ...timeline, session: { ...session, sessionKey: `codex:${i}` } });
  await flush();
  const index = JSON.parse(mockSettings.get(`remote.cache.index.${scope}`) ?? '[]');
  expect(index).toHaveLength(40); expect(new Set(index).size).toBe(40);
  expect([...mockSettings.keys()].filter(key => key.startsWith('remote.cache.t.'))).toHaveLength(40);
  await clearRemoteCache(scope, ['pc']); expect([...mockSettings.keys()]).toEqual([]);
});

test('different pairing credentials never restore the previous cache', async () => {
  saveCachedThread(scope, key, timeline); saveCachedSessions(scope, 'pc', [session]); await flush();
  expect(await loadCachedThread(scope, key)).not.toBeNull();
  expect(await loadCachedThread('pair|credential:new', key)).toBeNull(); expect(await loadCachedSessions('pair|credential:new', 'pc')).toBeNull();
});

test('delegation display survives cache without carrying invented task links', async () => {
  saveCachedThread(scope, key, { session, items: [{ kind: 'message', role: 'user', id: 'delegated', text: 'fixture', ts: 1, final: true,
    messageOrigin: { kind: 'delegation', sourceTask: 'unverified', url: 'https://example.test' } }] });
  await flush();
  const cached = await loadCachedThread(scope, key);
  expect(cached?.items[0]).toMatchObject({ messageOrigin: { kind: 'delegation' } });
  expect((cached?.items[0] as { messageOrigin: unknown }).messageOrigin).toEqual({ kind: 'delegation' });
});

test('native desktop histories cannot enter or hydrate the disk cache, including malformed old records', async () => {
  const native = { ...session, sessionKey: 'claude-desktop:local_fixture', tool: 'claude' as const, controlSurface: 'read-only' as const };
  saveCachedThread(scope, key, { ...timeline, session: { ...session, controlSurface: 'desktop' } });
  saveCachedSessions(scope, 'pc', [native]); await flush();
  expect(await loadCachedThread(scope, key)).toBeNull(); expect(await loadCachedSessions(scope, 'pc')).toEqual([]);
  mockSettings.set(`remote.cache.t.${scope}.${key}`, JSON.stringify({ ...timeline, session: { ...session, controlSurface: 'desktop' }, savedAt: Date.now() }));
  expect(await loadCachedThread(scope, key)).toBeNull();
  mockSettings.set(`remote.cache.s.${scope}.pc`, JSON.stringify([native])); expect(await loadCachedSessions(scope, 'pc')).toBeNull();
});

test('reset cancels deferred work instead of writing after teardown', async () => {
  saveCachedThread(scope, key, timeline); await resetRemoteCacheForTests(); await flush(); expect(mockWrite).not.toHaveBeenCalled();
});

test('awaited reset drains active storage before the fixture is replaced', async () => {
  let unblock!: () => void;
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  mockWrite.mockImplementationOnce(async (name, value) => { await gate; if (value != null) mockSettings.set(name, value); });
  saveCachedThread(scope, key, timeline);
  jest.advanceTimersByTime(1600); await Promise.resolve(); await Promise.resolve();
  let drained = false;
  const reset = resetRemoteCacheForTests().then(() => { drained = true; });
  await Promise.resolve(); expect(drained).toBe(false);
  unblock(); await reset; expect(drained).toBe(true);
  mockSettings.clear(); const writesAfterDrain = mockWrite.mock.calls.length;
  await flush(); expect(mockSettings.size).toBe(0); expect(mockWrite).toHaveBeenCalledTimes(writesAfterDrain);
});

test('old stored approval/local echoes and malformed items cannot become actionable history', async () => {
  const items = [...timeline.items, { kind: 'approval', id: 'approve', ts: 1, state: 'pending' },
    { ...timeline.items[0], local: true, id: 'unsent' }, { kind: 'message', id: 'broken', ts: 1, text: {} }];
  mockSettings.set(`remote.cache.t.${scope}.${key}`, JSON.stringify({ items, session, savedAt: Date.now() }));
  expect((await loadCachedThread(scope, key))?.items).toEqual(timeline.items);
  mockSettings.set(`remote.cache.t.${scope}.${key}`, JSON.stringify({ items, session: { ...session, sessionKey: 'claude:other' }, savedAt: Date.now() }));
  expect(await loadCachedThread(scope, key)).toBeNull();
});

test('cached assistant and tool attachments keep only bounded local references', async () => {
  const image = { id: 'att_0123456789abcdef0123456789abcdef', mime: 'image/png', size: 8, uri: 'file:///cache/result.png' };
  const tool = { kind: 'tool', id: 'read-1', ts: 2, tool: 'read', title: '查看图片', status: 'done', attachments: [image] };
  saveCachedThread(scope, key, { ...timeline, items: [{ ...timeline.items[0], attachments: [image] }, tool] });
  await flush();
  expect((await loadCachedThread(scope, key))?.items).toHaveLength(2);
  mockSettings.set(`remote.cache.t.${scope}.${key}`, JSON.stringify({ ...timeline, items: [{ ...tool, attachments: [{ ...image, uri: 'https://evil.example/x' }] }], savedAt: Date.now() }));
  expect((await loadCachedThread(scope, key))?.items).toEqual([]);
});

test('extension adapter sessions use the same bounded cache namespace', async () => {
  const extension: SessionInfo = { ...session, tool: 'hermes', sessionKey: 'hermes:thread-1', client: 'Hermes' };
  saveCachedSessions(scope, 'pc', [extension]);
  await flush();
  expect(await loadCachedSessions(scope, 'pc')).toEqual([extension]);
  mockSettings.set(`remote.cache.s.${scope}.pc`, JSON.stringify([{ ...extension, sessionKey: 'codex:foreign' }]));
  // A foreign namespace invalidates this cached directory; it is not an
  // authoritative empty list and must be fetched from the computer again.
  expect(await loadCachedSessions(scope, 'pc')).toBeNull();
});

test('message skills survive cache only as bounded user references within the original pairing and session', async () => {
  const skills = [{ name: 'review', path: 'C:/codex/review/SKILL.md', displayName: '代码检查', brandColor: '#8A42EF', iconSmall: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1kAAAAASUVORK5CYII=' }];
  const user = { kind: 'message', role: 'user', id: 'skill-message', text: 'literal $other', ts: 1, final: true, skills };
  saveCachedThread(scope, key, { session, items: [user, { ...user, id: 'assistant', role: 'assistant' },
    { ...user, id: 'malformed', skills: [{ ...skills[0], secret: 'do not retain' }] }] });
  await flush();
  const stored = mockSettings.get(`remote.cache.t.${scope}.${key}`)!;
  expect(stored).not.toContain('do not retain');
  const cached = (await loadCachedThread(scope, key))!.items as Array<typeof user>;
  expect(cached[0]).toMatchObject({ text: 'literal $other', skills });
  expect(cached[1].skills).toBeUndefined(); expect(cached[2].skills).toBeUndefined();
  expect(await loadCachedThread('pair|credential:new', key)).toBeNull();
  expect(await loadCachedThread(scope, 'pc|claude:original')).toBeNull();
  mockSettings.set(`remote.cache.t.${scope}.${key}`, JSON.stringify({ session, savedAt: Date.now(), items: [
    { ...user, skills: [{ name: 'bad\nname' }] }, { ...user, id: 'duplicate', skills: [...skills, ...skills] }, { ...user, id: 'assistant', role: 'assistant' },
  ] }));
  for (const item of (await loadCachedThread(scope, key))!.items as Array<typeof user>) expect(item.skills).toBeUndefined();
});
