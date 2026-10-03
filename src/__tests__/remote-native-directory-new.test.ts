import { setHubFetch, type FetchLike, type SessionInfo } from '../remote/client';
import { bootRemote, connectStation, getRemoteState, hydrateCachedThread, loadAgentProfiles, loadNativeSessions, loadSessions, loadEarlierHistory, openSession, pairRemoteQr, parseRemoteQr, resetRemoteForTests, syncSessionEvents, timelineKey } from '../remote/store';
import { deliveryCredentialId } from '../remote/connections';

const mockSettings = new Map<string, string>(), mockSecrets = new Map<string, string>();
let mockUuid = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `0199aaa1-1234-4678-9abc-${String(++mockUuid).padStart(12, '0')}` }));
jest.mock('../storage/database', () => ({ getSetting: async (key: string) => mockSettings.get(key) ?? null,
  setSetting: async (key: string, value: string | null) => { if (value === null) mockSettings.delete(key); else mockSettings.set(key, value); } }));
jest.mock('../storage/secure-keys', () => ({ getProviderKey: async () => null }));
jest.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'this-device-only', getItemAsync: async (key: string) => mockSecrets.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { mockSecrets.set(key, value); }, deleteItemAsync: async (key: string) => { mockSecrets.delete(key); } }));

const origin = 'https://native-fixture.example', hubUrl = `${origin}/salcara-hub/v1`;
const keys = ['codex:0199aaa1-1234-4678-9abc-000000000001', 'codex:0199aaa1-1234-4678-9abc-000000000002'];
const device = { deviceId: 'pc', name: 'Fixture', os: 'windows', tools: [], projects: [], online: true, lastSeen: 1 };
const row = (index: number): SessionInfo => ({ sessionKey: keys[index], tool: 'codex', client: 'Codex App', title: `native-${index}`, cwd: 'C:\\fixture', updatedAt: index + 1,
  status: 'idle', controllable: true, controlSurface: 'desktop', sidebarIndex: index + 1, ...(index === 0 ? { pinnedIndex: 3 } : {}) });
const response = (value: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });
let lease: number, reads: number, commands: Record<string, unknown>[], eventReads: number, handler: (command: Record<string, unknown>) => unknown | Promise<unknown>;
const status = () => ({ agents: [{ id: 'codex', available: true, api: { source: 'tool' }, desktopLive: { active: true, expiresAt: lease, sessionKeys: keys,
  capabilities: { list: true, read: true, send: true } } }] });
const defaultHandler = (command: Record<string, unknown>): unknown => {
  if (command.type === 'agents.status') return { ok: true, result: status() };
  if (command.type === 'desktop.sessions.list') return { ok: true, result: { sessions: [row(1), row(0)] } };
  if (command.type === 'sessions.list') return { ok: true, result: { sessions: [{ ...row(1), sessionKey: 'codex:history-only', controlSurface: 'cli' }] } };
  if (command.type === 'desktop.session.open') { reads += 1; return { ok: true, result: { session: row(0), events: [
    { type: 'message', deviceId: 'pc', sessionKey: keys[0], tool: 'codex', ts: 1, id: 'answer', role: 'assistant', text: reads === 1 ? 'partial' : 'finished', final: reads > 1 },
  ] } }; }
  throw new Error(`unexpected command ${command.type}`);
};
async function pair() {
  await bootRemote([]); await connectStation(origin);
  await pairRemoteQr(parseRemoteQr(JSON.stringify({ type: 'salcara-remote-pair', version: 1, hubUrl, deviceId: 'pc', deviceName: 'Fixture', ticket: 'b'.repeat(64), expiresAt: Date.now() + 120000 })));
  await loadAgentProfiles('pc');
}
beforeEach(() => {
  resetRemoteForTests(); mockSettings.clear(); mockSecrets.clear(); mockUuid = 0; lease = Date.now() + 60000; reads = 0; commands = []; eventReads = 0; handler = defaultHandler;
  setHubFetch((async (endpoint, init) => {
    if (endpoint.endsWith('/ping')) return response({ service: 'salcara-hub', protocol: 'salcara-remote', protocolVersion: 1, authModes: ['device-pairing'], capabilities: ['device.identity.v1', 'pair.qr.v1', 'session.remote.v1', 'pair.revoke.v1'] });
    if (endpoint.endsWith('/app/pair/qr')) return response({ pair_token: 'a'.repeat(64), device });
    if (endpoint.endsWith('/app/devices')) return response({ devices: [device] });
    if (!endpoint.endsWith('/app/commands')) { eventReads += 1; return response({ events: [], nextSeq: 0, lastSeq: 0 }); }
    const command = JSON.parse(String(init.body)).command; commands.push(command); return response(await handler(command));
  }) as FetchLike);
});
afterEach(() => { resetRemoteForTests(); setHubFetch(null); });

test('current native lease cannot hydrate an older CLI disk snapshot for the same UUID', async () => {
  await pair(); const state = getRemoteState();
  const key = keys[0];
  const scope = `${state.connectionId}|credential:${deliveryCredentialId('a'.repeat(64))}`;
  const session = { ...row(0), controlSurface: 'cli', controllable: true };
  mockSettings.set(`remote.cache.t.${scope}.${timelineKey('pc', key)}`, JSON.stringify({ items: [
    { kind: 'message', role: 'assistant', id: 'old-cli', text: 'Wrong surface', final: true, ts: 1 },
  ], session, savedAt: Date.now() }));
  await hydrateCachedThread('pc', key);
  expect(getRemoteState().timelines[timelineKey('pc', key)]).toBeUndefined();
});

test('native directory uses only the authorized native transport and retains real pins/order independently of all history', async () => {
  await pair(); await loadNativeSessions('pc'); await loadSessions('pc', 'codex');
  expect(commands.filter(item => item.type !== 'agents.status')).toEqual([
    { type: 'desktop.sessions.list', tool: 'codex', controlSurface: 'desktop' }, { type: 'sessions.list', tool: 'codex', limit: 100 },
  ]);
  expect(getRemoteState().sessions.pc.native?.list.map(item => [item.sessionKey, item.pinnedIndex, item.sidebarIndex])).toEqual([[keys[0], 3, 1], [keys[1], undefined, 2]]);
  expect(getRemoteState().sessions.pc.list.map(item => item.sessionKey)).toEqual(['codex:history-only']);
});

test('native open and demand sync read real desktop snapshots instead of CLI events and replace partial replies by ID', async () => {
  await pair(); await loadNativeSessions('pc'); await openSession('pc', keys[0]); await syncSessionEvents('pc', keys[0], 20); await syncSessionEvents('pc', keys[0], 20);
  expect(commands.filter(item => item.type === 'desktop.session.open')).toHaveLength(3);
  expect(commands.some(item => item.type === 'session.open')).toBe(false); expect(eventReads).toBe(0);
  const timeline = getRemoteState().timelines[timelineKey('pc', keys[0])];
  expect(timeline.items).toHaveLength(1); expect(timeline.items[0]).toMatchObject({ kind: 'message', text: 'finished', final: true });
  expect(getRemoteState().sessions.pc.native?.list[0]).toMatchObject({ pinnedIndex: 3, sidebarIndex: 1 });
});

test('expired lease rejects native list and sync before dispatch and does not use history fallback', async () => {
  await pair(); await loadNativeSessions('pc'); await openSession('pc', keys[0]);
  lease = Date.now() - 1; await loadAgentProfiles('pc'); const before = commands.length;
  await expect(loadNativeSessions('pc')).rejects.toThrow('桌面连接已断开');
  await expect(syncSessionEvents('pc', keys[0])).rejects.toThrow('桌面连接已断开');
  expect(commands).toHaveLength(before); expect(getRemoteState().sessions.pc.native?.list).toHaveLength(2);
  expect(getRemoteState().timelines[timelineKey('pc', keys[0])].session?.controlSurface).toBe('desktop');
});

test('native older pages preserve original transport and pagination frontier across foreground demand refresh', async () => {
  await pair(); await loadNativeSessions('pc');
  handler = command => command.type === 'desktop.session.open' ? { ok: true, result: { session: row(0),
    events: [{ type: 'message', deviceId: 'pc', sessionKey: keys[0], tool: 'codex', ts: command.cursor ? 1 : 10,
      id: command.cursor ? 'older' : 'latest', role: 'assistant', text: command.cursor ? 'past' : 'new', final: true }],
    nextCursor: command.cursor ? '' : 'lease-signed-fixture' } } : defaultHandler(command);
  await openSession('pc', keys[0]); await loadEarlierHistory('pc', keys[0]); await syncSessionEvents('pc', keys[0]);
  const timeline = getRemoteState().timelines[timelineKey('pc', keys[0])];
  expect(timeline.items.map(item => item.id)).toEqual(['older', 'latest']); expect(timeline.nextCursor).toBeUndefined();
  expect(commands.find(item => item.cursor)).toEqual({ type: 'desktop.session.open', sessionKey: keys[0], controlSurface: 'desktop', cursor: 'lease-signed-fixture' });
  expect(commands.some(item => item.type === 'session.open')).toBe(false);
});

test('native paging that overlaps a demand snapshot is retained, but cannot escape a changed lease', async () => {
  await pair(); await loadNativeSessions('pc'); let release!: (value: unknown) => void, entered!: () => void;
  const pending = new Promise<void>(resolve => { entered = resolve; });
  handler = command => command.type === 'desktop.session.open' ? command.cursor ? (entered(), new Promise(resolve => { release = resolve; }))
    : { ok: true, result: { session: row(0), events: [], nextCursor: 'fixture-cursor' } } : defaultHandler(command);
  await openSession('pc', keys[0]); const loading = loadEarlierHistory('pc', keys[0]); await pending;
  await syncSessionEvents('pc', keys[0]);
  release({ ok: true, result: { session: row(0), events: [], nextCursor: '' } }); await loading;
  expect(getRemoteState().timelines[timelineKey('pc', keys[0])]).toMatchObject({ historyExpanded: true, loadingEarlier: false });
  await openSession('pc', keys[0]); const stale = loadEarlierHistory('pc', keys[0]); await Promise.resolve(); await Promise.resolve();
  lease += 1000; await loadAgentProfiles('pc');
  release({ ok: true, result: { session: row(0), events: [], nextCursor: '' } }); await expect(stale).rejects.toThrow('桌面授权已更新');
});

test('a response finishing after native authorization changed cannot publish a stale directory', async () => {
  await pair(); let release!: (value: unknown) => void; let entered!: () => void;
  const pending = new Promise<void>(resolve => { entered = resolve; });
  handler = command => command.type === 'desktop.sessions.list' ? (entered(), new Promise(resolve => { release = resolve; })) : defaultHandler(command);
  const loading = loadNativeSessions('pc'); await pending; lease += 1000; await loadAgentProfiles('pc');
  release({ ok: true, result: { sessions: [row(0)] } }); await expect(loading).rejects.toThrow('桌面授权已更新');
  expect(getRemoteState().sessions.pc.native?.list).toEqual([]);
});

test.each(['unauthorized', 'wrong-surface', 'duplicate', 'missing-order'] as const)('malformed native directory is rejected, not converted into a history request (%s)', async fault => {
  await pair(); const entries = [row(0)];
  if (fault === 'unauthorized') entries[0] = { ...entries[0], sessionKey: 'codex:0199aaa1-1234-4678-9abc-000000000003' };
  if (fault === 'wrong-surface') entries[0].controlSurface = 'cli';
  if (fault === 'duplicate') entries.push(row(0));
  if (fault === 'missing-order') delete entries[0].sidebarIndex;
  handler = command => command.type === 'desktop.sessions.list' ? { ok: true, result: { sessions: entries } } : defaultHandler(command);
  await expect(loadNativeSessions('pc')).rejects.toThrow('桌面目录无效');
  expect(commands.some(item => item.type === 'sessions.list')).toBe(false);
});
