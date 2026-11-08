import { setHubFetch, type DeviceStatus, type FetchLike, type SessionInfo } from '../remote/client';
import { bootRemote, connectStation, getRemoteState, pairRemoteQr, parseRemoteQr, recoverRemoteContent, resetRemoteForTests, timelineKey } from '../remote/store';

const mockSettings = new Map<string, string>();
const mockSecrets = new Map<string, string>();
jest.mock('../storage/database', () => ({ getSetting: async (key: string) => mockSettings.get(key) ?? null,
  setSetting: async (key: string, value: string | null) => { if (value === null) mockSettings.delete(key); else mockSettings.set(key, value); } }));
jest.mock('../storage/secure-keys', () => ({ getProviderKey: async () => null }));
jest.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'this-device-only',
  getItemAsync: async (key: string) => mockSecrets.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { mockSecrets.set(key, value); },
  deleteItemAsync: async (key: string) => { mockSecrets.delete(key); } }));

const origin = 'https://recovery.fixture.example', hubUrl = `${origin}/salcara-hub/v1`, deviceId = 'pc';
const device: DeviceStatus = { deviceId, name: 'Fixture PC', os: 'windows', tools: [{ id: 'codex', name: 'Codex', available: true }], projects: [], online: true, lastSeen: 1 };
const session: SessionInfo = { sessionKey: 'codex:recovery', tool: 'codex', client: 'Codex App', title: 'Recovery fixture', cwd: 'C:/fixture', updatedAt: 10, status: 'idle', controllable: true };
const caps = { list: true, read: true, send: true, interrupt: true, approval: true, questions: true, subagents: true,
  attachments: true, imageInput: true, imageOutput: true, modelOverride: true };
const response = (value: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });
const discovery = { service: 'salcara-hub', protocol: 'salcara-remote', protocolVersion: 1, authModes: ['device-pairing'],
  capabilities: ['device.identity.v1', 'pair.qr.v1', 'session.remote.v1', 'pair.revoke.v1'] };
const qr = () => JSON.stringify({ type: 'salcara-remote-pair', version: 1, hubUrl, deviceId, deviceName: device.name, ticket: 'b'.repeat(64), expiresAt: Date.now() + 120_000 });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function agentStatus() { return { agents: [{ id: 'codex', tool: 'codex', controlSurface: 'cli', available: true, remoteSendSupported: true, capabilities: caps,
  api: { name: 'Fixture API', model: 'fixture-model', configured: true, source: 'computer' } }] }; }
function transport(commandHandler: (command: Record<string, unknown>) => unknown | Promise<unknown>, options?: { devices?: () => Promise<void> }) {
  const requests: string[] = [], commands: Record<string, unknown>[] = [];
  const fetch = (async (endpoint: string, init: Record<string, unknown>) => {
    requests.push(endpoint);
    if (endpoint.endsWith('/ping')) return response(discovery);
    if (endpoint.endsWith('/app/pair/qr')) return response({ pair_token: 'a'.repeat(64), device });
    if (endpoint.endsWith('/app/devices')) { await options?.devices?.(); return response({ devices: [device] }); }
    if (endpoint.endsWith('/app/commands')) {
      const command = JSON.parse(String(init.body)).command as Record<string, unknown>;
      commands.push(command);
      return response({ ok: true, result: await commandHandler(command) });
    }
    if (endpoint.includes('/app/events')) return response({ events: [], nextSeq: 0, lastSeq: 0, hasMore: false });
    throw new Error(`unexpected request ${endpoint}`);
  }) as FetchLike;
  return { fetch, requests, commands };
}
async function pair() {
  await bootRemote([]); await connectStation(origin); await pairRemoteQr(parseRemoteQr(qr()));
}

beforeEach(() => { resetRemoteForTests(); mockSettings.clear(); mockSecrets.clear(); });
afterEach(() => { resetRemoteForTests(); setHubFetch(null); });

test('settings recovery refreshes directories and merges recent remote snapshots without touching local chat storage', async () => {
  const calls = transport(command => command.type === 'agents.status' ? agentStatus()
    : command.type === 'sessions.list' ? { sessions: [session] }
      : command.type === 'session.open' ? { session, events: [{ type: 'message', deviceId, sessionKey: session.sessionKey, tool: 'codex', id: 'remote-recovered', role: 'assistant', text: 'recovered from computer', final: true, ts: 20 }] }
        : {});
  setHubFetch(calls.fetch); await pair();
  const progress: string[] = [];
  const result = await recoverRemoteContent(stage => progress.push(stage));
  expect(result).toEqual({ deviceId, deviceName: device.name, total: 1, synced: 1, failed: 0, directoryFailed: 0 });
  expect(calls.requests.some(url => url.endsWith('/app/devices'))).toBe(true);
  expect(calls.commands.map(command => command.type)).toEqual(expect.arrayContaining(['agents.status', 'sessions.list', 'session.open']));
  expect(getRemoteState().timelines[timelineKey(deviceId, session.sessionKey)].items).toEqual(expect.arrayContaining([expect.objectContaining({ text: 'recovered from computer' })]));
  expect(progress).toEqual(expect.arrayContaining(['checking', 'directory', 'content']));
  expect([...mockSettings.keys()].some(key => /^(?:conversations|messages|memories)\b/.test(key))).toBe(false);
});

test('recovery is single-flight for repeated settings taps', async () => {
  const gate = deferred<void>(); let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  const calls = transport(command => command.type === 'agents.status' ? agentStatus()
    : command.type === 'sessions.list' ? { sessions: [session] }
      : command.type === 'session.open' ? { session, events: [] } : {}, { devices: async () => { entered(); await gate.promise; } });
  setHubFetch(calls.fetch); await pair();
  const first = recoverRemoteContent(), second = recoverRemoteContent();
  await started;
  expect(calls.requests.filter(url => url.endsWith('/app/devices'))).toHaveLength(1);
  gate.resolve();
  await Promise.all([first, second]);
  expect(calls.commands.filter(command => command.type === 'agents.status')).toHaveLength(1);
  expect(calls.commands.filter(command => command.type === 'session.open')).toHaveLength(1);
});

test('late recovery from an old connection stops before reading or publishing its directory', async () => {
  const gate = deferred<void>(); let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  const calls = transport(command => command.type === 'agents.status' ? agentStatus() : command.type === 'sessions.list' ? { sessions: [session] } : {},
    { devices: async () => { entered(); await gate.promise; } });
  setHubFetch(calls.fetch); await pair();
  const recovery = recoverRemoteContent(); await started;
  await connectStation('https://other.fixture.example');
  gate.resolve();
  await expect(recovery).rejects.toThrow('连接已切换');
  expect(calls.commands).toEqual([]);
  expect(getRemoteState().sessions[deviceId]).toBeUndefined();
});
