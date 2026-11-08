import { setHubFetch, type FetchLike, type SessionInfo } from '../remote/client';
import { bootRemote, connectStation, getRemoteState, loadAgentProfiles, loadClaudeDesktopHistory, loadMoreSessions, loadNativeSessions,
  loadSessions, pairRemoteQr, parseRemoteQr, resetRemoteForTests } from '../remote/store';

const mockSettings = new Map<string, string>(), mockSecrets = new Map<string, string>();
jest.mock('../storage/database', () => ({ getSetting: async (key: string) => mockSettings.get(key) ?? null,
  setSetting: async (key: string, value: string | null) => { if (value === null) mockSettings.delete(key); else mockSettings.set(key, value); } }));
jest.mock('../storage/secure-keys', () => ({ getProviderKey: async () => null }));
jest.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'fixture', getItemAsync: async (key: string) => mockSecrets.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { mockSecrets.set(key, value); }, deleteItemAsync: async (key: string) => { mockSecrets.delete(key); } }));

type Surface = 'cli' | 'desktop' | 'read-only';
const surfaces: Surface[] = ['cli', 'desktop', 'read-only'];
const origin = 'https://sidebar-fixture.example', hubUrl = `${origin}/salcara-hub/v1`;
const key = 'codex:0199aaa1-1234-4678-9abc-000000000111';
const native: SessionInfo = { sessionKey: key, tool: 'codex', client: 'Codex App', title: 'Original', cwd: '/fixture', updatedAt: 1,
  status: 'idle', controllable: true, controlSurface: 'desktop', sidebarIndex: 1 };
const cli: SessionInfo = { ...native, client: 'Codex', controlSurface: 'cli' };
const readOnly: SessionInfo = { ...native, sessionKey: 'claude-desktop:local_0199aaa1-1234-4678-9abc-000000000001', tool: 'claude', client: 'Claude Desktop',
  sessionScope: 'desktop-chat', controllable: false, controlSurface: 'read-only' };
const device = { deviceId: 'pc', name: 'Fixture', os: 'windows', tools: [], projects: [], online: true, lastSeen: 1 };
const response = (value: unknown, status = 200) => ({ ok: status === 200, status, text: async () => JSON.stringify(value) });
const failure500 = Symbol('synthetic-http-500');
let identity: string, lease: number, canList: boolean, commands: Record<string, unknown>[];
let handler: (input: Record<string, unknown>) => unknown | Promise<unknown>;
const status = () => ({ ok: true, result: { agents: [
  { id: 'codex', available: true, api: { source: 'tool' }, capabilities: { list: canList, read: true },
    ...(lease > Date.now() ? { desktopLive: { active: true, expiresAt: lease, sessionKeys: [key], capabilities: { list: true, read: true, send: true } } } : {}) },
  { id: 'claude-desktop', available: true, remoteSendSupported: false, api: { source: 'tool' },
    desktopHistory: { available: true, readOnly: true, identity, scopes: ['desktop-chat'] } },
] } });
const result = (mode: Surface, rows: SessionInfo[], cursor?: string) => ({ ok: true, result: { sessions: rows,
  ...(cursor ? { nextCursor: cursor } : {}), ...(mode === 'read-only' ? { historyIdentity: identity } : {}) } });
const row = (mode: Surface) => mode === 'cli' ? cli : mode === 'desktop' ? native : readOnly;
const read = (mode: Surface, more = false, preserve = false) => mode === 'cli'
  ? more ? loadMoreSessions('pc', 'codex') : loadSessions('pc', 'codex', { preservePages: preserve })
  : mode === 'desktop' ? loadNativeSessions('pc', more, { preservePages: preserve }) : loadClaudeDesktopHistory('pc', 'desktop-chat', more, { preservePages: preserve });
const directory = (mode: Surface) => mode === 'desktop' ? getRemoteState().sessions.pc?.native : mode === 'read-only'
  ? getRemoteState().sessions.pc?.readOnly?.['desktop-chat'] : getRemoteState().sessions.pc?.pages?.codex;
const list = (mode: Surface) => mode === 'desktop' ? getRemoteState().sessions.pc?.native?.list : mode === 'read-only'
  ? getRemoteState().sessions.pc?.readOnly?.['desktop-chat']?.list : getRemoteState().sessions.pc?.list;
async function pair() {
  await bootRemote([]); await connectStation(origin);
  await pairRemoteQr(parseRemoteQr(JSON.stringify({ type: 'salcara-remote-pair', version: 1, hubUrl, deviceId: 'pc', deviceName: 'Fixture',
    ticket: 'b'.repeat(64), expiresAt: Date.now() + 120_000 })));
  await loadAgentProfiles('pc');
}
beforeEach(() => {
  resetRemoteForTests(); mockSettings.clear(); mockSecrets.clear(); identity = 'c'.repeat(64); lease = Date.now() + 120_000; canList = true; commands = [];
  handler = () => ({ ok: false, error: 'synthetic directory error' });
  setHubFetch((async (endpoint, init) => {
    if (endpoint.endsWith('/ping')) return response({ service: 'salcara-hub', protocol: 'salcara-remote', protocolVersion: 1, authModes: ['device-pairing'],
      capabilities: ['device.identity.v1', 'pair.qr.v1', 'session.remote.v1', 'pair.revoke.v1'] });
    if (endpoint.endsWith('/app/pair/qr')) return response({ pair_token: 'a'.repeat(64), device });
    if (endpoint.endsWith('/app/devices')) return response({ devices: [device] });
    if (!endpoint.endsWith('/app/commands')) return response({ events: [], lastSeq: 0, nextSeq: 0 });
    const input = JSON.parse(String(init.body)).command; commands.push(input);
    if (input.type === 'agents.status') return response(status());
    const value = await handler(input);
    return value === failure500 ? response({ error: 'synthetic unavailable' }, 500) : response(value);
  }) as FetchLike);
});
afterEach(() => { resetRemoteForTests(); setHubFetch(null); });

test.each(surfaces)('%s first-page failure records head and a successful explicit retry clears it', async (mode) => {
  await pair(); await expect(read(mode)).rejects.toThrow('synthetic directory error');
  expect(directory(mode)).toMatchObject({ loading: false, errorPage: 'head', error: 'synthetic directory error' });
  handler = () => result(mode, []); await read(mode, false, true);
  expect(directory(mode)?.error).toBeUndefined(); expect(directory(mode)?.errorPage).toBeUndefined(); expect(list(mode)).toEqual([]);
});

test.each(surfaces)('%s retained cursor does not turn a failed head refresh into a next-page retry', async (mode) => {
  await pair(); handler = () => result(mode, [row(mode)], 'older'); await read(mode);
  handler = () => ({ ok: false, error: 'synthetic refresh failure' }); await expect(read(mode, false, true)).rejects.toThrow();
  expect(directory(mode)).toMatchObject({ errorPage: 'head', nextCursor: 'older', loading: false }); expect(list(mode)).toEqual([row(mode)]);
  handler = () => result(mode, [{ ...row(mode), title: 'Updated' }], 'new-head-cursor'); await read(mode, false, true);
  expect(commands.at(-1)).not.toHaveProperty('cursor'); expect(directory(mode)?.nextCursor).toBe('older');
  expect(directory(mode)?.errorPage).toBeUndefined(); expect(list(mode)?.[0].title).toBe('Updated');
});

test.each(surfaces)('%s more-page errors preserve the continuation and clear after the same page succeeds', async (mode) => {
  await pair(); handler = () => result(mode, [row(mode)], 'older'); await read(mode);
  handler = () => ({ ok: false, error: 'synthetic page failure' }); await expect(read(mode, true)).rejects.toThrow();
  expect(directory(mode)).toMatchObject({ errorPage: 'more', nextCursor: 'older', loading: false }); expect(list(mode)).toEqual([row(mode)]);
  handler = () => result(mode, []); await read(mode, true); expect(commands.at(-1)?.cursor).toBe('older');
  expect(directory(mode)?.errorPage).toBeUndefined(); expect(directory(mode)?.nextCursor).toBeUndefined(); expect(list(mode)).toEqual([row(mode)]);
});

test('a temporary HTTP 500 marks transport error but an explicit paired read recovers without sending a task', async () => {
  await pair(); handler = () => failure500; await expect(read('cli')).rejects.toThrow();
  expect(getRemoteState()).toMatchObject({ connection: 'error' }); expect(directory('cli')).toMatchObject({ errorPage: 'head', loading: false });
  expect(getRemoteState().devices[0].online).toBe(true);
  handler = () => result('cli', []); await read('cli', false, true);
  expect(getRemoteState()).toMatchObject({ connection: 'open', connectionError: undefined }); expect(directory('cli')?.error).toBeUndefined();
  expect(commands.every(input => input.type === 'agents.status' || input.type === 'sessions.list')).toBe(true);
});

test.each(surfaces)('%s stale directory return after pairing reset cannot publish rows or errors', async (mode) => {
  await pair(); let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  handler = () => (entered(), new Promise(resolve => { release = () => resolve(result(mode, [{ ...row(mode), title: 'Stale private result' }])); }));
  const pending = read(mode); await ready; resetRemoteForTests(); release(); await pending;
  expect(getRemoteState().sessions.pc).toBeUndefined(); expect(getRemoteState().connection).toBe('idle');
});

test.each(surfaces)('%s directory return cannot install rows after its capability or identity is revoked', async (mode) => {
  await pair(); let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }), oldIdentity = identity;
  handler = () => (entered(), new Promise(resolve => { release = () => resolve({ ...result(mode, [row(mode)]), result: {
    ...(result(mode, [row(mode)]).result), ...(mode === 'read-only' ? { historyIdentity: oldIdentity } : {}) } }); }));
  const pending = read(mode); await ready;
  if (mode === 'cli') canList = false; else if (mode === 'desktop') lease = 0; else identity = 'd'.repeat(64);
  await loadAgentProfiles('pc'); release(); await expect(pending).rejects.toThrow();
  expect(list(mode) ?? []).toEqual([]);
  expect(commands.filter(input => input.type === 'sessions.list' || input.type === 'desktop.sessions.list')).toHaveLength(1);
});
