import { setHubFetch, type FetchLike } from '../remote/client';
import { selectedConnection } from '../remote/connections';
import { bootRemote, connectStation, getRemoteState, loadAgentProfiles, loadSessions, openSession, pairRemoteQr, parseRemoteQr, resetRemoteForTests, timelineKey, useSavedConnection } from '../remote/store';

const mockSettings = new Map<string, string>();
const mockSecrets = new Map<string, string>();
const mockSettingWrite = jest.fn();
jest.mock('../storage/database', () => ({
  getSetting: async (key: string) => mockSettings.get(key) ?? null,
  setSetting: (...args: unknown[]) => mockSettingWrite(...args),
}));
jest.mock('../storage/secure-keys', () => ({ getProviderKey: async () => null }));
jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'this-device-only',
  getItemAsync: async (key: string) => mockSecrets.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { mockSecrets.set(key, value); },
  deleteItemAsync: async (key: string) => { mockSecrets.delete(key); },
}));
const first = 'https://station-a.example';
const next = 'https://station-b.example';
const hubUrl = `${first}/salcara-hub/v1`;
const device = { deviceId: 'pc-a', name: '电脑 A', os: 'windows', tools: [], projects: [], online: true, lastSeen: 1 };
const session = { sessionKey: 'codex:original', tool: 'codex', client: 'Codex App', title: '原任务', cwd: '/fixture', updatedAt: 1, status: 'idle', controllable: true };
const discovery = { service: 'salcara-hub', protocol: 'salcara-remote', protocolVersion: 1, authModes: ['device-pairing'],
  capabilities: ['device.identity.v1', 'pair.qr.v1', 'session.remote.v1', 'pair.revoke.v1'] };
const response = (value: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; }
const transport: FetchLike = async (url, init) => {
  if (url.endsWith('/ping')) return response(discovery);
  if (url.endsWith('/app/pair/qr')) return response({ pair_token: 'a'.repeat(64), device });
  if (url.endsWith('/app/devices')) return response({ devices: [device] });
  if (url.includes('/app/events?')) return response({ events: [], nextSeq: 0, lastSeq: 0, hasMore: false });
  if (url.endsWith('/app/commands')) {
    const command = JSON.parse(String(init.body)).command;
    return response({ ok: true, result: command.type === 'agents.status'
      ? { agents: [{ id: 'codex', available: true, api: { name: '原 API', model: 'gpt-fixture', configured: true, source: 'computer' } }], apis: [{ id: 'opaque-a', name: '原 API' }] }
      : command.type === 'session.open' ? { session, events: [{ type: 'message', deviceId: device.deviceId, sessionKey: session.sessionKey, tool: 'codex', ts: 1, id: 'reply', role: 'assistant', text: '保留的回复', final: true }] }
        : { sessions: [session] } });
  }
  throw new Error(`Unexpected synthetic endpoint: ${url}`);
};
async function pairedA() {
  await bootRemote([]); await connectStation(first);
  await pairRemoteQr(parseRemoteQr(JSON.stringify({ type: 'salcara-remote-pair', version: 1, hubUrl, deviceId: device.deviceId,
    deviceName: device.name, ticket: 'b'.repeat(64), expiresAt: Date.now() + 120_000 })));
  await loadAgentProfiles(device.deviceId); await loadSessions(device.deviceId); await openSession(device.deviceId, session.sessionKey);
}
beforeEach(() => {
  resetRemoteForTests(); mockSettings.clear(); mockSecrets.clear(); mockSettingWrite.mockReset();
  mockSettingWrite.mockImplementation(async (key: string, value: string | null) => { if (value === null) mockSettings.delete(key); else mockSettings.set(key, value); });
  setHubFetch(transport);
});
afterEach(() => { resetRemoteForTests(); setHubFetch(null); });

test('leaving binding while discovery waits preserves paired A and every cached resource', async () => {
  await pairedA();
  const before = getRemoteState(); const selected = await selectedConnection(); const saved = new Map(mockSettings);
  const late = deferred<Awaited<ReturnType<FetchLike>>>(); let wanted = true;
  setHubFetch((url, init) => url.startsWith(next) ? late.promise : transport(url, init));
  const connecting = connectStation(next, () => wanted);
  expect(getRemoteState().signingIn).toBe('station'); wanted = false;
  late.resolve(response(discovery)); await connecting;
  expect(getRemoteState()).toEqual({ ...before, signingIn: null });
  expect(getRemoteState().sessions[device.deviceId]).toBe(before.sessions[device.deviceId]);
  expect(getRemoteState().agents[device.deviceId]).toBe(before.agents[device.deviceId]);
  expect(getRemoteState().timelines[timelineKey(device.deviceId, session.sessionKey)]).toBe(before.timelines[timelineKey(device.deviceId, session.sessionKey)]);
  expect(await selectedConnection()).toBe(selected); expect(mockSettings).toEqual(saved);
});
test('first-time canceled discovery leaves setup empty and does not persist a station', async () => {
  await bootRemote([]); const before = getRemoteState(); const writes = mockSettingWrite.mock.calls.length;
  const late = deferred<Awaited<ReturnType<FetchLike>>>(); let wanted = true;
  setHubFetch(async () => late.promise); const connecting = connectStation(next, () => wanted);
  wanted = false; late.resolve(response(discovery)); await connecting;
  expect(getRemoteState()).toEqual({ ...before, signingIn: null }); expect(mockSettingWrite.mock.calls.length).toBe(writes);
});
test('cancellation during the saved-selection write restores A startup selection before returning', async () => {
  await pairedA(); const before = getRemoteState(); const selected = await selectedConnection();
  const write = deferred<void>(); const entered = deferred<void>(); let wanted = true;
  mockSettingWrite.mockImplementationOnce(async (key: string, value: string | null) => {
    if (value === null) mockSettings.delete(key); else mockSettings.set(key, value);
    entered.resolve();
    await write.promise;
  });
  const connecting = connectStation(next, () => wanted);
  // Wait for discovery and the synthetic SQLite write, never a real network.
  await entered.promise;
  wanted = false; write.resolve(); await connecting;
  expect(getRemoteState()).toEqual({ ...before, signingIn: null }); expect(await selectedConnection()).toBe(selected);
});
test('without a cancellation callback the existing station-selection behavior remains compatible', async () => {
  await pairedA(); await connectStation(next);
  expect(getRemoteState()).toMatchObject({ phase: 'pairing', selectedHubUrl: `${next}/salcara-hub/v1`, connectionId: null, signingIn: null });
  expect(getRemoteState().sessions).toEqual({}); expect(getRemoteState().agents).toEqual({}); expect(getRemoteState().timelines).toEqual({});
  expect(await selectedConnection()).toBeNull();
});
test('cancellation during the legacy preference await restores selection without clearing cached A', async () => {
  await pairedA(); const before = getRemoteState(); const selected = await selectedConnection();
  const write = deferred<void>(); const entered = deferred<void>(); let wanted = true;
  mockSettingWrite.mockImplementation(async (key: string, value: string | null) => {
    if (value === null) mockSettings.delete(key); else mockSettings.set(key, value);
    if (key === 'remote_service' && value === null && wanted) { entered.resolve(); await write.promise; }
  });
  const connecting = connectStation(next, () => wanted); await entered.promise;
  wanted = false; write.resolve(); await connecting;
  expect(getRemoteState()).toEqual({ ...before, signingIn: null }); expect(await selectedConnection()).toBe(selected);
});
test('a newer chosen connection cannot be overwritten or cleared by late canceled discovery', async () => {
  await pairedA(); const id = getRemoteState().connectionId!; const late = deferred<Awaited<ReturnType<FetchLike>>>();
  setHubFetch((url, init) => url.startsWith(next) ? late.promise : transport(url, init));
  const connecting = connectStation(next, () => false).catch((problem: Error) => problem);
  await useSavedConnection(id, true); const current = getRemoteState();
  late.resolve(response(discovery)); expect(await connecting).toBeInstanceOf(Error);
  expect(getRemoteState()).toBe(current); expect(await selectedConnection()).toBe(id);
});
