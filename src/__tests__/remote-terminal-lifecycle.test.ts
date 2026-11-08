import { AppState } from 'react-native';
import { setHubFetch, type DeviceStatus, type FetchLike, type HubEvent, type SessionInfo } from '../remote/client';
import { bootRemote, connectStation, getRemoteState, openSession, pairRemoteQr, parseRemoteQr, resetRemoteForTests,
  resetIncompleteTurnRecovery, syncSessionEvents, timelineKey } from '../remote/store';

const mockSettings = new Map<string, string>(), mockSecrets = new Map<string, string>();
jest.mock('../storage/database', () => ({ getSetting: async (key: string) => mockSettings.get(key) ?? null,
  setSetting: async (key: string, value: string | null) => { if (value === null) mockSettings.delete(key); else mockSettings.set(key, value); } }));
jest.mock('../storage/secure-keys', () => ({ getProviderKey: async () => null }));
jest.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'this-device-only',
  getItemAsync: async (key: string) => mockSecrets.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { mockSecrets.set(key, value); }, deleteItemAsync: async (key: string) => { mockSecrets.delete(key); } }));
const origin = 'https://station.example', sessionKey = 'codex:grace';
const device: DeviceStatus = { deviceId: 'pc', name: 'Fixture', os: 'windows', tools: [], projects: [], online: true, lastSeen: 1 };
const session: SessionInfo = { sessionKey, tool: 'codex', client: 'Codex App', title: 'Grace', cwd: '/fixture', updatedAt: 1, status: 'idle', controllable: true };
let now = 1_000, opens = 0, fail = false, complete = false, text = 'prefix';
let clock: jest.SpyInstance;
const state = () => getRemoteState().timelines[timelineKey('pc', sessionKey)];
const assistant = () => state().items.find(item => item.id === 'reply');
const sync = () => syncSessionEvents('pc', sessionKey);
beforeEach(() => {
  resetRemoteForTests(); mockSettings.clear(); mockSecrets.clear(); AppState.currentState = 'active';
  now = 1_000; opens = 0; fail = false; complete = false; text = 'prefix';
  clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
  setHubFetch((async (endpoint, init) => {
    let value: unknown;
    if (endpoint.endsWith('/ping')) value = { service: 'salcara-hub', protocol: 'salcara-remote', protocolVersion: 1,
      authModes: ['device-pairing'], capabilities: ['device.identity.v1', 'pair.qr.v1', 'session.remote.v1', 'pair.revoke.v1', 'events.cursor.v1', 'commands.idempotency.v1'] };
    else if (endpoint.endsWith('/app/pair/qr')) value = { pair_token: 'a'.repeat(64), device };
    else if (endpoint.endsWith('/app/devices')) value = { devices: [device] };
    else if (endpoint.endsWith('/app/commands')) {
      const command = JSON.parse(String(init.body)).command;
      if (command.type === 'session.open') {
        opens += 1;
        value = fail ? { ok: false, error: 'network snapshot unavailable' } : { ok: true, result: { session, events: [
          { type: 'message', id: 'reply', role: 'assistant', deviceId: 'pc', sessionKey, tool: 'codex', text, final: complete, turnId: 'turn-1', ts: 10 } satisfies HubEvent,
        ] } };
      } else value = { ok: true, result: {} };
    } else {
      const baseline = new URL(endpoint).searchParams.get('limit') === '1';
      value = baseline ? { events: [], nextSeq: 0, lastSeq: 10 } : { events: [
        { type: 'turn', deviceId: 'pc', sessionKey, tool: 'codex', status: 'completed', turnId: 'turn-1', ts: 11, seq: 11 },
      ], nextSeq: 11, lastSeq: 11 };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(value) };
  }) as FetchLike);
});
afterEach(() => { resetRemoteForTests(); setHubFetch(null); clock.mockRestore(); AppState.currentState = 'active'; });
async function open() {
  await bootRemote([]); await connectStation(origin);
  await pairRemoteQr(parseRemoteQr(JSON.stringify({ type: 'salcara-remote-pair', version: 1, hubUrl: `${origin}/salcara-hub/v1`,
    deviceId: 'pc', deviceName: device.name, ticket: 'b'.repeat(64), expiresAt: now + 120_000 })));
  await openSession('pc', sessionKey);
}

test('three fast terminal snapshots stay quiet for a full minute and a fresh successful read decides incompleteness', async () => {
  await open();
  for (const time of [1_000, 2_000, 7_000, 22_000, 60_999]) { now = time; await sync(); expect(assistant()).toMatchObject({ final: false, streamState: 'terminal-unconfirmed' }); }
  const before = opens; now = 76_000; await sync();
  expect(opens).toBeGreaterThan(before);
  expect(assistant()).toMatchObject({ final: false, streamState: 'incomplete' });
});

test('unavailable snapshots never exhaust the successful confirmation budget or replace retained text with an error', async () => {
  await open(); fail = true;
  for (const time of [1_000, 16_000, 46_000, 106_000, 166_000]) { now = time; await sync(); }
  expect(assistant()).toMatchObject({ text: 'prefix', final: false, streamState: 'terminal-unconfirmed' });
  expect(state().error).toBeUndefined();
  fail = false; complete = true; text = 'prefix completed'; now += 60_000; await sync();
  expect(assistant()).toMatchObject({ text, final: true });
});

test('background reset gives the returning thread a new grace window instead of spending the interval while suspended', async () => {
  await open(); for (const time of [1_000, 2_000, 7_000]) { now = time; await sync(); }
  resetIncompleteTurnRecovery('pc', sessionKey); AppState.currentState = 'background';
  const before = opens; now += 600_000; await sync(); expect(opens).toBe(before);
  AppState.currentState = 'active'; await sync();
  expect(assistant()).toMatchObject({ streamState: 'terminal-unconfirmed' });
  complete = true; text = 'complete after foreground'; now += 15_000; await sync();
  expect(assistant()).toMatchObject({ text, final: true });
});

test('late progress resets the stable-content window and failed reads after grace do not manufacture incompleteness', async () => {
  await open(); for (const time of [1_000, 16_000, 31_000]) { now = time; await sync(); }
  now = 61_000; text = 'prefix with late progress'; await sync();
  expect(assistant()).toMatchObject({ text, final: false, streamState: 'terminal-unconfirmed' });
  fail = true; now += 60_000; await sync();
  expect(assistant()).toMatchObject({ text, streamState: 'terminal-unconfirmed' });
  fail = false; complete = true; now += 60_000; await sync();
  expect(assistant()).toMatchObject({ text, final: true });
});
