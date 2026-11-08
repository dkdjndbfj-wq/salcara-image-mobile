import { setHubFetch, type FetchLike, type HubEvent, type SessionInfo } from '../remote/client';
import {
  bootRemote, connectStation, getRemoteState, hydrateCachedThread, loadAgentProfiles, loadNativeSessions,
  onRemoteEvent, openSession, pairRemoteQr, parseRemoteQr, resetRemoteForTests, respondApproval,
  syncSessionEvents, timelineKey, approvalStateKey,
} from '../remote/store';
import { saveCachedThread } from '../remote/cache';

const mockSettings = new Map<string, string>(), mockSecrets = new Map<string, string>();
let mockUuid = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `0199aaa1-1234-4678-9abc-${String(++mockUuid).padStart(12, '0')}` }));
jest.mock('../storage/database', () => ({ getSetting: async (key: string) => mockSettings.get(key) ?? null,
  setSetting: async (key: string, value: string | null) => { if (value === null) mockSettings.delete(key); else mockSettings.set(key, value); } }));
jest.mock('../storage/secure-keys', () => ({ getProviderKey: async () => null }));
jest.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'this-device-only', getItemAsync: async (key: string) => mockSecrets.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { mockSecrets.set(key, value); }, deleteItemAsync: async (key: string) => { mockSecrets.delete(key); } }));
jest.mock('../remote/cache', () => ({ clearRemoteCache: async () => undefined, loadCachedSessions: async () => null,
  loadCachedThread: async () => ({ items: [{ kind: 'message', id: 'disk-cli', role: 'assistant', text: 'old synthetic CLI cache', ts: 1, final: true }], savedAt: 1 }),
  resetRemoteCacheForTests: async () => undefined, saveCachedSessions: jest.fn(), saveCachedThread: jest.fn() }));

const origin = 'https://isolation-fixture.example', hubUrl = `${origin}/salcara-hub/v1`;
const key = 'codex:0199aaa1-1234-4678-9abc-000000000111';
const device = { deviceId: 'pc', name: 'Fixture', os: 'windows', tools: [], projects: [], online: true, lastSeen: 1 };
const cli: SessionInfo = { sessionKey: key, tool: 'codex', client: 'Codex', title: 'CLI original', cwd: 'C:/fixture/cli', updatedAt: 1,
  status: 'idle', controllable: true, controlSurface: 'cli' };
const native: SessionInfo = { ...cli, client: 'Codex App', title: 'Native original', cwd: 'C:/fixture/native', controlSurface: 'desktop', sidebarIndex: 1, pinnedIndex: 2 };
const message = (id: string, text: string): HubEvent => ({ type: 'message', deviceId: 'pc', sessionKey: key, tool: 'codex', ts: 1, seq: 2, id, role: 'assistant', text, final: true });
const response = (value: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });
let lease: number, nativeApproval: boolean, eventReads: number, commands: Record<string, unknown>[];
let commandHandler: (input: Record<string, unknown>) => unknown | Promise<unknown>;
let eventHandler: () => unknown | Promise<unknown>;
const defaultCommand = (input: Record<string, unknown>): unknown => {
  if (input.type === 'agents.status') return { ok: true, result: { agents: [{ id: 'codex', available: true, api: { source: 'tool' },
    ...(lease > Date.now() ? { desktopLive: { active: true, expiresAt: lease, sessionKeys: [key], capabilities: { list: true, read: true, send: true, approval: nativeApproval },
      ...(nativeApproval ? { approvalTransport: 'codex-hook-v1' } : {}) } } : {}) }] } };
  if (input.type === 'session.open') return { ok: true, result: { session: cli, events: [] } };
  if (input.type === 'desktop.sessions.list') return { ok: true, result: { sessions: [native] } };
  if (input.type === 'desktop.session.open') return { ok: true, result: { session: native, events: [message('native-answer', 'native synthetic content')] } };
  if (input.type === 'approval.respond' || input.type === 'desktop.approval.respond') return { ok: true, result: {} };
  throw new Error(`unexpected synthetic command ${input.type}`);
};
async function pair() {
  await bootRemote([]); await connectStation(origin);
  await pairRemoteQr(parseRemoteQr(JSON.stringify({ type: 'salcara-remote-pair', version: 1, hubUrl, deviceId: 'pc', deviceName: 'Fixture', ticket: 'b'.repeat(64), expiresAt: Date.now() + 120000 })));
  await loadAgentProfiles('pc');
}
beforeEach(() => {
  resetRemoteForTests(); mockSettings.clear(); mockSecrets.clear(); jest.clearAllMocks(); mockUuid = 0;
  lease = 0; nativeApproval = false; eventReads = 0; commands = []; commandHandler = defaultCommand;
  eventHandler = () => ({ events: [], nextSeq: 0, lastSeq: 0, hasMore: false });
  setHubFetch((async (endpoint, init) => {
    if (endpoint.endsWith('/ping')) return response({ service: 'salcara-hub', protocol: 'salcara-remote', protocolVersion: 1, authModes: ['device-pairing'], capabilities: ['device.identity.v1', 'pair.qr.v1', 'session.remote.v1', 'pair.revoke.v1', 'commands.idempotency.v1'] });
    if (endpoint.endsWith('/app/pair/qr')) return response({ pair_token: 'a'.repeat(64), device });
    if (endpoint.endsWith('/app/devices')) return response({ devices: [device] });
    if (endpoint.endsWith('/app/commands')) {
      const input = JSON.parse(String(init.body)).command; commands.push(input); return response(await commandHandler(input));
    }
    eventReads += 1;
    if (new URL(endpoint).searchParams.get('limit') === '1') return response({ events: [], nextSeq: 0, lastSeq: 0, hasMore: false });
    return response(await eventHandler());
  }) as FetchLike);
});
afterEach(() => { resetRemoteForTests(); setHubFetch(null); });

test('failed forced native selection stays sticky, cannot hydrate CLI cache, sync CLI or receive a CLI acknowledgement', async () => {
  await pair(); const heard = jest.fn(), unsubscribe = onRemoteEvent(heard);
  try {
    await expect(openSession('pc', key, { controlSurface: 'desktop' })).rejects.toThrow('桌面连接已断开');
    expect(getRemoteState().timelines[timelineKey('pc', key)]).toMatchObject({ readSurface: 'desktop', items: [] });
    await hydrateCachedThread('pc', key);
    const before = eventReads;
    await expect(syncSessionEvents('pc', key)).rejects.toThrow('桌面连接已断开');
    expect(eventReads).toBe(before);
    // An older CLI approval may finish after the native selection. Its local
    // CLI ack uses the same handleEvent boundary as CLI Hub records.
    await respondApproval({ approvalId: 'old-cli-approval', deviceId: 'pc', sessionKey: key }, 'allow');
    expect(heard).not.toHaveBeenCalled();
    expect(getRemoteState().timelines[timelineKey('pc', key)].items).toEqual([]);
    expect(saveCachedThread).not.toHaveBeenCalled();
  } finally { unsubscribe(); }
});

test('return boundary drops a foreign CLI buffer injected while native metadata is pending', async () => {
  lease = Date.now() + 60_000; await pair();
  let finish!: (value: unknown) => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  commandHandler = input => input.type === 'desktop.session.open' ? (entered(), new Promise(resolve => { finish = resolve; })) : defaultCommand(input);
  const reading = openSession('pc', key, { controlSurface: 'desktop' }); await started;
  const state = getRemoteState(), id = timelineKey('pc', key);
  expect(state.timelines[id].readSurface).toBe('desktop');
  // Simulate a competing legacy writer; the snapshot must independently
  // validate the surface of the buffer it joins at its final await boundary.
  state.timelines[id] = { ...state.timelines[id], session: cli, items: [{ kind: 'message', id: 'foreign-cli', role: 'assistant', text: 'wrong synthetic buffer', ts: 1, final: true }] };
  finish(defaultCommand({ type: 'desktop.session.open' })); await reading;
  expect(getRemoteState().timelines[id].items.map(item => item.id)).toEqual(['native-answer']);
  expect(getRemoteState().timelines[id]).toMatchObject({ readSurface: 'desktop', session: { controlSurface: 'desktop', cwd: native.cwd } });
  expect(saveCachedThread).not.toHaveBeenCalled();
});

test('renewed native lease replaces old-lease history instead of joining stale content', async () => {
  lease = Date.now() + 60_000; await pair(); await openSession('pc', key, { controlSurface: 'desktop' });
  lease += 1000; await loadAgentProfiles('pc');
  commandHandler = input => input.type === 'desktop.session.open' ? { ok: true, result: { session: native, events: [message('renewed-answer', 'renewed synthetic content')] } } : defaultCommand(input);
  await openSession('pc', key, { background: true, controlSurface: 'desktop' });
  expect(getRemoteState().timelines[timelineKey('pc', key)].items.map(item => item.id)).toEqual(['renewed-answer']);
});

test('an unselected CLI event cannot overwrite a newly loaded native directory or claim native authority', async () => {
  await pair(); await openSession('pc', key);
  let finish!: (value: unknown) => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  eventHandler = () => (entered(), new Promise(resolve => { finish = resolve; }));
  const sync = syncSessionEvents('pc', key); await started;
  lease = Date.now() + 60_000; await loadAgentProfiles('pc'); await loadNativeSessions('pc');
  finish({ events: [
    { type: 'session.updated', deviceId: 'pc', sessionKey: key, tool: 'codex', ts: 1, seq: 1, session: { ...cli, title: 'CLI changed', cwd: 'C:/fixture/other-cli' } },
    { type: 'session.updated', deviceId: 'pc', sessionKey: key, tool: 'codex', ts: 2, seq: 2, session: { ...native, title: 'untrusted desktop claim', cwd: 'C:/fixture/untrusted' } },
    { ...message('cli-answer', 'CLI real content'), seq: 3 },
  ], nextSeq: 3, lastSeq: 3, hasMore: false }); await sync;
  expect(getRemoteState().sessions.pc.native?.list).toEqual([native]);
  expect(getRemoteState().timelines[timelineKey('pc', key)].session).toMatchObject({ controlSurface: 'cli', title: 'CLI changed', cwd: 'C:/fixture/other-cli' });
  expect(getRemoteState().timelines[timelineKey('pc', key)].items.map(item => item.id)).toEqual(['cli-answer']);
});

test('native snapshot does not promote the saved CLI directory row to desktop', async () => {
  await pair(); await openSession('pc', key);
  // Populate the old CLI directory, then obtain an independent native lease.
  getRemoteState().sessions.pc = { loaded: true, loading: false, list: [cli] };
  lease = Date.now() + 60_000; await loadAgentProfiles('pc'); await loadNativeSessions('pc');
  await openSession('pc', key, { controlSurface: 'desktop' });
  expect(getRemoteState().sessions.pc.list).toEqual([cli]);
  expect(getRemoteState().sessions.pc.native?.list[0]).toMatchObject({ controlSurface: 'desktop', cwd: native.cwd, sidebarIndex: 1, pinnedIndex: 2 });
});

test('trusted local native approval receipt still updates its card without opening Hub CLI event access', async () => {
  lease = Date.now() + 60_000; nativeApproval = true; await pair();
  const approvalId = '0199aaa1-1234-4678-9abc-000000000222';
  commandHandler = input => input.type === 'desktop.session.open' ? { ok: true, result: { session: native, events: [
    { type: 'approval.request', deviceId: 'pc', sessionKey: key, tool: 'codex', ts: Date.now(), approvalId, kind: 'permission', title: 'Synthetic permission', expiresAt: Date.now() + 60_000, approvalTransport: 'codex-hook-v1' },
  ] } } : defaultCommand(input);
  await openSession('pc', key, { controlSurface: 'desktop' });
  await respondApproval({ approvalId, deviceId: 'pc', sessionKey: key, controlSurface: 'desktop' }, 'allow');
  expect(commands.some(input => input.type === 'desktop.approval.respond')).toBe(true);
  expect(getRemoteState().timelines[timelineKey('pc', key)].items.find(item => item.id === approvalId)).toMatchObject({ kind: 'approval', state: 'allow', by: 'phone' });
  expect(getRemoteState().approvals[approvalStateKey('pc', key, approvalId)]).toBeUndefined();
});

test('a native approval event cannot grant a capability missing from the live host', async () => {
  lease = Date.now() + 60_000; await pair();
  const approvalId = '0199aaa1-1234-4678-9abc-000000000333';
  commandHandler = input => input.type === 'desktop.session.open' ? { ok: true, result: { session: native, events: [
    { type: 'approval.request', deviceId: 'pc', sessionKey: key, tool: 'codex', ts: Date.now(), approvalId, kind: 'permission', title: 'Synthetic permission', expiresAt: Date.now() + 60_000, approvalTransport: 'codex-hook-v1' },
  ] } } : defaultCommand(input);
  await openSession('pc', key, { controlSurface: 'desktop' });
  await expect(respondApproval({ approvalId, deviceId: 'pc', sessionKey: key, controlSurface: 'desktop' }, 'allow'))
    .rejects.toMatchObject({ code: 'desktop_capability_unavailable' });
  expect(commands.some(input => input.type === 'desktop.approval.respond')).toBe(false);
  expect(getRemoteState().timelines[timelineKey('pc', key)].items.find(item => item.id === approvalId)).toMatchObject({ kind: 'approval', state: 'pending' });
});
