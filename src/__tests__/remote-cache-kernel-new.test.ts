import { clearRemoteCache, loadCachedSessions, loadCachedThread, resetRemoteCacheForTests, saveCachedSessions, saveCachedThread } from '../remote/cache';
import type { SessionInfo } from '../remote/client';

const mockSettings = new Map<string, string>();
const mockWrite = jest.fn(async (key: string, value: string | null) => { if (value == null) mockSettings.delete(key); else mockSettings.set(key, value); });
jest.mock('../storage/database', () => ({ getSetting: async (key: string) => mockSettings.get(key) ?? null,
  setSetting: (key: string, value: string | null) => mockWrite(key, value) }));
const session: SessionInfo = { sessionKey: 'codex:original', tool: 'codex', client: 'Codex CLI', title: 'Fixture', cwd: '/fixture', updatedAt: 1, status: 'idle', controllable: true, controlSurface: 'cli' };
const timeline = { session, items: [{ kind: 'message', role: 'assistant', id: 'm1', text: 'Fixture', ts: 1, final: true }] };
const key = 'pc|codex:original';
const scope = 'pair|credential:old';
beforeEach(async () => { await resetRemoteCacheForTests(); mockSettings.clear(); mockWrite.mockClear(); jest.useFakeTimers(); });
afterEach(async () => { await resetRemoteCacheForTests(); jest.useRealTimers(); });
async function flush() { await jest.advanceTimersByTimeAsync(1600); }

test('revoking before debounce prevents any late thread or directory write', async () => {
  saveCachedThread(scope, key, timeline); saveCachedSessions(scope, 'pc', [session]);
  await clearRemoteCache(scope, ['pc']); await flush();
  expect(await loadCachedThread(scope, key)).toBeNull(); expect(await loadCachedSessions(scope, 'pc')).toBeNull();
  saveCachedThread(scope, key, timeline); await flush(); expect(await loadCachedThread(scope, key)).toBeNull();
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
