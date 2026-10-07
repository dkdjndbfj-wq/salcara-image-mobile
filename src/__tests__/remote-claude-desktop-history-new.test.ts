import { setHubFetch, type FetchLike, type SessionInfo } from '../remote/client';
import { bootRemote, connectStation, getRemoteState, loadAgentProfiles, loadClaudeDesktopHistory, loadEarlierHistory, openSession, pairRemoteQr, parseRemoteQr, resetRemoteForTests, sendToSession, interruptSession, respondApproval, setAgentApi, syncSessionEvents, timelineKey } from '../remote/store';

const mockSettings = new Map<string, string>(), mockSecrets = new Map<string, string>();
jest.mock('expo-crypto', () => ({ randomUUID: () => '0199aaa1-1234-4678-9abc-000000000001' }));
jest.mock('../storage/database', () => ({ getSetting: async (key: string) => mockSettings.get(key) ?? null,
  setSetting: async (key: string, value: string | null) => { if (value === null) mockSettings.delete(key); else mockSettings.set(key, value); } }));
jest.mock('../storage/secure-keys', () => ({ getProviderKey: async () => null }));
jest.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'this-device-only', getItemAsync: async (key: string) => mockSecrets.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { mockSecrets.set(key, value); }, deleteItemAsync: async (key: string) => { mockSecrets.delete(key); } }));

const origin = 'https://claude-history-fixture.example', hubUrl = `${origin}/salcara-hub/v1`;
const key = 'claude-desktop:local_0199aaa1-1234-4678-9abc-000000000001';
const device = { deviceId: 'pc', name: 'Fixture', os: 'windows', tools: [], projects: [], online: true, lastSeen: 1 };
const row: SessionInfo = { sessionKey: key, tool: 'claude', client: 'Claude Desktop', sessionScope: 'desktop-chat', title: 'Original Chat', cwd: 'C:\\fixture', updatedAt: 1, status: 'idle', controllable: false, controlSurface: 'read-only' };
const response = (value: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });
let identity: string, commands: Record<string, unknown>[], eventReads: number, handler: (command: Record<string, unknown>) => unknown | Promise<unknown>;
const defaultHandler = (command: Record<string, unknown>): unknown => {
  if (command.type === 'agents.status' || command.type === 'agents.api.set') return { ok: true, result: { agents: [{ id: 'claude-desktop', available: true, remoteSendSupported: false, api: { source: 'tool' },
    desktopHistory: { available: true, readOnly: true, identity, scopes: ['desktop-chat', 'desktop-cowork'] } }] } };
  if (command.type === 'sessions.list') return { ok: true, result: { sessions: command.client === 'desktop-chat' ? [row] : [], nextCursor: '', historyIdentity: identity } };
  if (command.type === 'session.describe') return { ok: true, result: { session: row, historyIdentity: identity } };
  if (command.type === 'session.open') return { ok: true, result: { session: row, historyIdentity: identity, nextCursor: command.cursor ? '' : 'older', events: [
    { type: 'message', deviceId: 'pc', sessionKey: key, tool: 'claude', ts: command.cursor ? 1 : 10, id: command.cursor ? 'past' : 'latest', role: 'assistant', text: 'Original answer', final: true },
    { type: 'approval.request', deviceId: 'pc', sessionKey: key, tool: 'claude', ts: 2, approvalId: 'historical', kind: 'permission', title: 'Old prompt' },
  ] } };
  throw new Error(`unexpected command ${command.type}`);
};
async function pair() {
  await bootRemote([]); await connectStation(origin);
  await pairRemoteQr(parseRemoteQr(JSON.stringify({ type: 'salcara-remote-pair', version: 1, hubUrl, deviceId: 'pc', deviceName: 'Fixture', ticket: 'b'.repeat(64), expiresAt: Date.now() + 120000 })));
  await loadAgentProfiles('pc');
}
beforeEach(() => {
  resetRemoteForTests(); mockSettings.clear(); mockSecrets.clear(); identity = 'c'.repeat(64); commands = []; eventReads = 0; handler = defaultHandler;
  setHubFetch((async (endpoint, init) => {
    if (endpoint.endsWith('/ping')) return response({ service: 'salcara-hub', protocol: 'salcara-remote', protocolVersion: 1, authModes: ['device-pairing'], capabilities: ['device.identity.v1', 'pair.qr.v1', 'session.remote.v1', 'pair.revoke.v1'] });
    if (endpoint.endsWith('/app/pair/qr')) return response({ pair_token: 'a'.repeat(64), device });
    if (endpoint.endsWith('/app/devices')) return response({ devices: [device] });
    if (!endpoint.endsWith('/app/commands')) { eventReads += 1; return response({ events: [], nextSeq: 0, lastSeq: 0 }); }
    const command = JSON.parse(String(init.body)).command; commands.push(command); return response(await handler(command));
  }) as FetchLike);
});
afterEach(() => { resetRemoteForTests(); setHubFetch(null); });

test('Chat/Cowork directory and paginated history use native readonly identity without a CLI or Hub events fallback', async () => {
  await pair(); const profile = getRemoteState().agents.pc.list.find(item => item.id === 'claude-desktop');
  expect(profile).toMatchObject({ available: true, remoteSendSupported: false, desktopHistory: { readOnly: true, identity } });
  await loadClaudeDesktopHistory('pc', 'desktop-chat'); await loadClaudeDesktopHistory('pc', 'desktop-cowork');
  await openSession('pc', key); await loadEarlierHistory('pc', key); await syncSessionEvents('pc', key);
  expect(commands.find(item => item.type === 'session.open')).toMatchObject({ client: 'desktop-chat', controlSurface: 'read-only', historyIdentity: identity, sessionKey: key });
  expect(getRemoteState().sessions.pc.readOnly?.['desktop-chat']?.list).toEqual([row]);
  expect(getRemoteState().sessions.pc.readOnly?.['desktop-cowork']?.list).toEqual([]);
  const timeline = getRemoteState().timelines[timelineKey('pc', key)];
  expect(timeline.items.map(item => item.id)).toEqual(['past', 'latest']); expect(timeline.nextCursor).toBeUndefined(); expect(eventReads).toBe(0);
  expect(Object.keys(getRemoteState().approvals)).toEqual([]);
});

test('readonly head refresh retains older loaded pages and its cursor while remaining silent', async () => {
  await pair(); const older = { ...row, sessionKey: 'claude-desktop:local_0199aaa1-1234-4678-9abc-000000000002', updatedAt: 0 };
  let head = 0, release!: (value: unknown) => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  handler = command => command.type === 'sessions.list' ? command.cursor
    ? { ok: true, result: { sessions: [older], nextCursor: 'third-page', historyIdentity: identity } }
    : ++head === 1 ? { ok: true, result: { sessions: [row], nextCursor: 'second-page', historyIdentity: identity } }
      : (entered(), new Promise(resolve => { release = resolve; })) : defaultHandler(command);
  await loadClaudeDesktopHistory('pc', 'desktop-chat'); await loadClaudeDesktopHistory('pc', 'desktop-chat', true);
  const refresh = loadClaudeDesktopHistory('pc', 'desktop-chat', false, { preservePages: true }); await started;
  expect(getRemoteState().sessions.pc.readOnly?.['desktop-chat']).toMatchObject({ loading: false, nextCursor: 'third-page' });
  release({ ok: true, result: { sessions: [{ ...row, status: 'running' }], nextCursor: 'second-page', historyIdentity: identity } }); await refresh;
  const entry = getRemoteState().sessions.pc.readOnly?.['desktop-chat'];
  expect(entry?.list.map(item => item.sessionKey)).toEqual([key, older.sessionKey]);
  expect(entry?.list[0].status).toBe('running'); expect(entry?.nextCursor).toBe('third-page');
});

test('a foreground readonly page wins over an unfinished background head refresh', async () => {
  await pair(); const older = { ...row, sessionKey: 'claude-desktop:local_0199aaa1-1234-4678-9abc-000000000002' };
  handler = command => command.type === 'sessions.list' ? { ok: true, result: { sessions: [row], nextCursor: 'second-page', historyIdentity: identity } } : defaultHandler(command);
  await loadClaudeDesktopHistory('pc', 'desktop-chat');
  let release!: (value: unknown) => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  handler = command => command.type === 'sessions.list' ? command.cursor
    ? { ok: true, result: { sessions: [older], nextCursor: 'third-page', historyIdentity: identity } }
    : (entered(), new Promise(resolve => { release = resolve; })) : defaultHandler(command);
  const refresh = loadClaudeDesktopHistory('pc', 'desktop-chat', false, { preservePages: true }); await started;
  await loadClaudeDesktopHistory('pc', 'desktop-chat', true);
  release({ ok: true, result: { sessions: [{ ...row, title: 'stale background' }], nextCursor: 'second-page', historyIdentity: identity } }); await refresh;
  expect(getRemoteState().sessions.pc.readOnly?.['desktop-chat']).toMatchObject({ loading: false, nextCursor: 'third-page' });
  expect(getRemoteState().sessions.pc.readOnly?.['desktop-chat']?.list).toEqual([row, older]);
});

test('readonly native IDs cannot send, stop or approve even before any history loads', async () => {
  await pair(); const before = commands.length;
  await expect(sendToSession('pc', key, 'no')).rejects.toThrow('只支持查看');
  await expect(interruptSession('pc', key)).rejects.toThrow('只支持查看');
  await expect(respondApproval({ approvalId: 'old', deviceId: 'pc', sessionKey: key }, 'allow')).rejects.toThrow('只支持查看');
  expect(commands).toHaveLength(before);
});

test('cold native history resolves its current category with metadata only, without any CLI directory scan', async () => {
  await pair(); await openSession('pc', key);
  expect(commands.find(item => item.type === 'session.describe')).toMatchObject({ sessionKey: key, controlSurface: 'read-only', historyIdentity: identity });
  expect(commands.some(item => item.type === 'sessions.list')).toBe(false);
  expect(commands.find(item => item.type === 'session.open')).toMatchObject({ sessionKey: key, client: 'desktop-chat', historyIdentity: identity });
  expect(getRemoteState().timelines[timelineKey('pc', key)].items.map(item => item.id)).toEqual(['latest']); expect(eventReads).toBe(0);
});

test.each(['foreign-identity', 'wrong-tool', 'wrong-client', 'controllable', 'wrong-scope'])('cold native metadata fails closed (%s)', async fault => {
  await pair(); handler = command => command.type === 'session.describe' ? { ok: true, result: { session: { ...row,
    ...(fault === 'wrong-tool' ? { tool: 'codex' } : fault === 'wrong-client' ? { client: 'Claude Code' } : fault === 'controllable' ? { controllable: true } : fault === 'wrong-scope' ? { sessionScope: 'desktop-code' } : {}) },
    historyIdentity: fault === 'foreign-identity' ? 'd'.repeat(64) : identity } } : defaultHandler(command);
  await expect(openSession('pc', key)).rejects.toThrow();
  expect(commands.some(item => item.type === 'session.open')).toBe(false); expect(eventReads).toBe(0);
});

test('a changed desktop namespace clears old history and rejects late directory data', async () => {
  await pair(); await loadClaudeDesktopHistory('pc', 'desktop-chat'); await openSession('pc', key);
  let release!: (value: unknown) => void, entered!: () => void;
  const pending = new Promise<void>(resolve => { entered = resolve; });
  handler = command => command.type === 'sessions.list' ? (entered(), new Promise(resolve => { release = resolve; })) : defaultHandler(command);
  const loading = loadClaudeDesktopHistory('pc', 'desktop-chat'); await pending; identity = 'd'.repeat(64); await loadAgentProfiles('pc');
  expect(getRemoteState().timelines[timelineKey('pc', key)]).toBeUndefined();
  expect(getRemoteState().sessions.pc.readOnly?.['desktop-chat']).toBeUndefined();
  release({ ok: true, result: { sessions: [row], historyIdentity: 'c'.repeat(64) } }); await expect(loading).rejects.toThrow('账号已变更');
  expect(getRemoteState().sessions.pc.readOnly?.['desktop-chat']?.list ?? []).toEqual([]);
});

test('API-set status revokes old namespace before the same local UUID opens in the new identity', async () => {
  await pair(); await loadClaudeDesktopHistory('pc', 'desktop-chat'); await openSession('pc', key);
  const oldIdentity = identity;
  identity = 'd'.repeat(64); await setAgentApi('pc', 'claude-desktop', 'another-api');
  expect(getRemoteState().timelines[timelineKey('pc', key)]).toBeUndefined();
  expect(getRemoteState().sessions.pc.readOnly?.['desktop-chat']).toBeUndefined();
  await loadClaudeDesktopHistory('pc', 'desktop-chat');
  handler = command => command.type === 'session.open' ? { ok: true, result: { session: row, historyIdentity: identity, events: [
    { type: 'message', deviceId: 'pc', sessionKey: key, tool: 'claude', ts: 20, id: 'new-identity', role: 'assistant', text: 'New account', final: true },
  ] } } : defaultHandler(command);
  await openSession('pc', key);
  const timeline = getRemoteState().timelines[timelineKey('pc', key)];
  expect(timeline.historyLease).not.toBe(oldIdentity); expect(timeline.historyLease).toBe(identity);
  expect(timeline.items.map(item => item.id)).toEqual(['new-identity']);
});

test.each(['open', 'earlier'])('a late %s response cannot restore an account cleared by API-set status', async operation => {
  await pair(); await loadClaudeDesktopHistory('pc', 'desktop-chat'); await openSession('pc', key);
  let release!: (value: unknown) => void, entered!: () => void;
  const pending = new Promise<void>(resolve => { entered = resolve; });
  const oldIdentity = identity;
  handler = command => command.type === 'session.open' ? (entered(), new Promise(resolve => { release = resolve; })) : defaultHandler(command);
  const loading = operation === 'open' ? openSession('pc', key, { background: true }) : loadEarlierHistory('pc', key);
  const rejected = expect(loading).rejects.toThrow('账号已变更');
  await pending; identity = 'd'.repeat(64); await setAgentApi('pc', 'claude-desktop', 'another-api');
  release({ ok: true, result: { session: row, historyIdentity: oldIdentity, events: [
    { type: 'message', deviceId: 'pc', sessionKey: key, tool: 'claude', ts: 1, id: 'old-account', role: 'assistant', text: 'Old account', final: true },
  ] } }); await rejected;
  expect(getRemoteState().timelines[timelineKey('pc', key)]).toBeUndefined();
});

test.each(['open', 'earlier'])('readonly %s validates tool, client and scope before merging', async operation => {
  for (const invalid of [{ tool: 'codex' }, { client: 'Claude Code' }, { sessionScope: 'desktop-cowork' }]) {
    await pair(); handler = defaultHandler; await loadClaudeDesktopHistory('pc', 'desktop-chat'); await openSession('pc', key);
    handler = command => command.type === 'session.open' ? { ok: true, result: { session: { ...row, ...invalid }, historyIdentity: identity, events: [
      { type: 'message', deviceId: 'pc', sessionKey: key, tool: 'claude', ts: 1, id: 'foreign', role: 'assistant', text: 'Wrong client', final: true },
    ] } } : defaultHandler(command);
    await expect(operation === 'open' ? openSession('pc', key) : loadEarlierHistory('pc', key)).rejects.toThrow('身份不一致');
    expect(getRemoteState().timelines[timelineKey('pc', key)].items.some(item => item.id === 'foreign')).toBe(false);
  }
});

test.each(['cli', 'wrong-scope', 'controllable', 'foreign-identity'])('malformed native history is rejected (%s)', async fault => {
  await pair(); handler = command => command.type === 'sessions.list' ? { ok: true, result: { sessions: [{ ...row,
    ...(fault === 'cli' ? { controlSurface: 'cli' } : fault === 'wrong-scope' ? { sessionScope: 'desktop-cowork' } : fault === 'controllable' ? { controllable: true } : {}) }], historyIdentity: fault === 'foreign-identity' ? 'd'.repeat(64) : identity } } : defaultHandler(command);
  await expect(loadClaudeDesktopHistory('pc', 'desktop-chat')).rejects.toThrow();
  expect(getRemoteState().sessions.pc.readOnly?.['desktop-chat']?.list).toEqual([]);
});
