import { setHubFetch, type FetchLike } from '../remote/client';
import { applyNativeSessionAction, bootRemote, connectStation, loadAgentProfiles, pairRemoteQr, parseRemoteQr, readNativeSessionActions, readArchivedSessions, resetRemoteForTests } from '../remote/store';

const mockSettings = new Map<string, string>(), mockSecrets = new Map<string, string>();
let mockUuid = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `0199bbb1-1234-4678-9abc-${String(++mockUuid).padStart(12, '0')}` }));
jest.mock('../storage/database', () => ({ getSetting: async (key: string) => mockSettings.get(key) ?? null,
  setSetting: async (key: string, value: string | null) => { if (value === null) mockSettings.delete(key); else mockSettings.set(key, value); } }));
jest.mock('../storage/secure-keys', () => ({ getProviderKey: async () => null }));
jest.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'this-device-only', getItemAsync: async (key: string) => mockSecrets.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { mockSecrets.set(key, value); }, deleteItemAsync: async (key: string) => { mockSecrets.delete(key); } }));
const origin = 'https://actions-fixture.example', hubUrl = `${origin}/salcara-hub/v1`, sessionKey = 'codex:s';
const device = { deviceId: 'pc', name: 'Fixture', os: 'windows', tools: [], projects: [], online: true, lastSeen: 1 };
const catalog = () => ({ sessionKey, revision: 'runtime-1', title: '原会话', archived: false, actions: ['rename', 'archive', 'fork'] });
const response = (value: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });
const nativeSession = { sessionKey: 'codex:new', tool: 'codex', client: 'Codex', title: '分支', cwd: 'C:/work', updatedAt: 1, status: 'idle', controllable: false };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
let commands: Record<string, unknown>[], account: string, support: boolean, actionCap: boolean;
let handle: (input: Record<string, unknown>) => unknown | Promise<unknown>;
async function pair() {
  await bootRemote([]); await connectStation(origin);
  await pairRemoteQr(parseRemoteQr(JSON.stringify({ type: 'salcara-remote-pair', version: 1, hubUrl, deviceId: 'pc', deviceName: 'Fixture', ticket: 'b'.repeat(64), expiresAt: Date.now() + 120000 })));
  await loadAgentProfiles('pc');
}
beforeEach(() => {
  resetRemoteForTests(); mockSettings.clear(); mockSecrets.clear(); mockUuid = 0; commands = []; account = 'api_aaaaaaaa'; support = true; actionCap = true;
  handle = input => ({ ok: true, result: input.type === 'sessions.archived' ? { sessions: [{ ...nativeSession, archived: true }], nextCursor: 'cursor-2' } : catalog() });
  setHubFetch((async (endpoint, init) => {
    if (endpoint.endsWith('/ping')) return response({ service: 'salcara-hub', protocol: 'salcara-remote', protocolVersion: 1, authModes: ['device-pairing'], capabilities: ['device.identity.v1', 'pair.qr.v1', 'pair.revoke.v1', 'session.remote.v1', 'commands.idempotency.v1', ...(support ? ['session.actions.v1'] : [])] });
    if (endpoint.endsWith('/app/pair/qr')) return response({ pair_token: 'a'.repeat(64), device });
    if (endpoint.endsWith('/app/devices')) return response({ devices: [device] });
    if (endpoint.endsWith('/app/commands')) {
      const input = JSON.parse(String(init.body)).command; commands.push(input);
      if (input.type === 'agents.status') return response({ ok: true, result: { agents: [{ id: 'codex', tool: 'codex', available: true,
        capabilities: { read: true, list: true, send: true, sessionActions: actionCap, archivedSessions: actionCap }, execution: { tool: 'codex', controlSurface: 'cli' }, api: { source: 'computer', configured: true, accountId: account } }] } });
      if (input.type === 'sessions.list') return response({ ok: true, result: { sessions: [] } });
      return response(await handle(input));
    }
    return response({ events: [], nextSeq: 0, lastSeq: 0, hasMore: false });
  }) as FetchLike);
});
afterEach(() => { resetRemoteForTests(); setHubFetch(null); });

test('double fork uses a single exact operation and cannot turn into rename', async () => {
  await pair(); const reading = await readNativeSessionActions('pc', sessionKey), pending = deferred<unknown>(), started = deferred<void>();
  let sent: Record<string, unknown> | undefined;
  handle = input => { sent = input; started.resolve(); return pending.promise; };
  const first = applyNativeSessionAction('pc', sessionKey, reading, 'fork'), second = applyNativeSessionAction('pc', sessionKey, reading, 'fork');
  expect(first).toBe(second); expect(() => applyNativeSessionAction('pc', sessionKey, reading, 'rename', '新名称')).toThrow('仍在进行');
  await started.promise;
  expect(sent).toMatchObject({ type: 'session.action', action: 'fork', accountId: account, expectedRevision: reading.value.revision, controlSurface: 'cli' });
  pending.resolve({ ok: true, result: { sessionKey, action: 'fork', state: 'completed', operationId: sent!.operationId, session: nativeSession } });
  expect((await first).session?.sessionKey).toBe('codex:new');
  expect(commands.filter(item => item.type === 'session.action')).toHaveLength(1);
});
test('a completed response from the former API cannot update or open another source', async () => {
  await pair(); const reading = await readNativeSessionActions('pc', sessionKey), pending = deferred<unknown>(), started = deferred<void>();
  let sent: Record<string, unknown> | undefined;
  handle = input => { sent = input; started.resolve(); return pending.promise; };
  const result = applyNativeSessionAction('pc', sessionKey, reading, 'fork'); await started.promise;
  account = 'api_bbbbbbbb'; await loadAgentProfiles('pc');
  pending.resolve({ ok: true, result: { sessionKey, action: 'fork', state: 'completed', operationId: sent!.operationId, session: nativeSession } });
  await expect(result).rejects.toThrow('来源已改变');
});
test('an unconfirmed fork is never automatically retried by a fresh button click', async () => {
  await pair(); const reading = await readNativeSessionActions('pc', sessionKey);
  handle = input => ({ ok: true, result: input.type === 'session.action' ? { sessionKey, action: 'fork', operationId: input.operationId, state: 'unconfirmed' } : catalog() });
  expect((await applyNativeSessionAction('pc', sessionKey, reading, 'fork')).state).toBe('unconfirmed');
  expect(() => applyNativeSessionAction('pc', sessionKey, reading, 'fork')).toThrow('不能执行');
  expect((await readNativeSessionActions('pc', sessionKey)).value.actions).toEqual([]);
  expect(commands.filter(item => item.type === 'session.action')).toHaveLength(1);
});
test('A-B-A invalidates both action readings and archive cursors', async () => {
  await pair(); const reading = await readNativeSessionActions('pc', sessionKey), archived = await readArchivedSessions('pc', 'codex');
  account = 'api_bbbbbbbb'; await loadAgentProfiles('pc'); account = 'api_aaaaaaaa'; await loadAgentProfiles('pc');
  expect(() => applyNativeSessionAction('pc', sessionKey, reading, 'fork')).toThrow('不能执行');
  await expect(readArchivedSessions('pc', 'codex', archived)).rejects.toThrow('读取位置已改变');
});
test.each(['hub', 'adapter'])('missing %s support prevents native commands', async missing => {
  if (missing === 'hub') support = false; else actionCap = false;
  await pair(); await expect(readNativeSessionActions('pc', sessionKey)).rejects.toThrow(); await expect(readArchivedSessions('pc', 'codex')).rejects.toThrow();
  expect(commands.some(item => item.type === 'session.actions' || item.type === 'sessions.archived')).toBe(false);
});
test('archive pages cannot include active, duplicate, or foreign conversations', async () => {
  await pair();
  for (const sessions of [[nativeSession], [{ ...nativeSession, archived: true, tool: 'claude' }], [{ ...nativeSession, archived: true }, { ...nativeSession, archived: true }]]) {
    handle = () => ({ ok: true, result: { sessions, nextCursor: '' } });
    await expect(readArchivedSessions('pc', 'codex')).rejects.toThrow('归档会话身份不一致');
  }
});
