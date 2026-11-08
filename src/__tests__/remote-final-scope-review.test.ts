import { setHubFetch, type FetchLike } from '../remote/client';
import { connectionId, saveConnection } from '../remote/connections';
import { bootRemote, getRemoteState, pairScannedRemoteQr, parseScannedRemoteQr, resetRemoteForTests, useSavedConnection } from '../remote/store';

const mockSettings = new Map<string, string>();
const mockSecrets = new Map<string, string>();
jest.mock('expo-crypto', () => ({ ...jest.requireActual('expo-crypto'), randomUUID: () => jest.requireActual('node:crypto').randomUUID(), getRandomBytesAsync: async () => new Uint8Array(32).fill(25) }));
jest.mock('../storage/database', () => ({ getSetting: async (key: string) => mockSettings.get(key) ?? null,
  setSetting: async (key: string, value: string | null) => { if (value === null) mockSettings.delete(key); else mockSettings.set(key, value); } }));
jest.mock('../storage/secure-keys', () => ({ getProviderKey: async () => null }));
jest.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'this-device-only',
  getItemAsync: async (key: string) => mockSecrets.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { mockSecrets.set(key, value); },
  deleteItemAsync: async (key: string) => { mockSecrets.delete(key); },
}));

const aHub = 'https://scope-a.example/salcara-hub/v1', bHub = 'https://scope-b.example/salcara-hub/v1', cHub = 'https://scope-c.example/salcara-hub/v1';
const aId = connectionId(aHub, 'pc-a'), bId = connectionId(bHub, 'pc-b'), cId = connectionId(cHub, 'pc-c');
const journalKey = 'remote_station_handover_v1';
const capabilities = ['device.identity.v1', 'pair.qr.v1', 'session.remote.v1', 'pair.revoke.v1', 'pair.single-phone.v1',
  'commands.idempotency.v1', 'station.guard.v1', 'station.handover.v2', 'station.standby.v1'];
const response = (body: unknown, status = 200) => ({ ok: status === 200, status, text: async () => JSON.stringify(body) });
const device = (id: string) => ({ deviceId: id, name: 'Synthetic scope review', os: 'windows', tools: [], projects: [], online: true, lastSeen: 1, capabilities: [] });
const attempts: Array<{ station: string; operationId: string }> = [];
let primary: 'offline' | 'uncertain' | 'forbidden' = 'offline';
let standby: 'forbidden' | 'rejected' | 'unsupported' | 'uncertain' = 'forbidden';

const transport: FetchLike = async (endpoint, init) => {
  const atB = endpoint.startsWith(bHub), atC = endpoint.startsWith(cHub), id = atB ? 'pc-b' : atC ? 'pc-c' : 'pc-a';
  if (endpoint.endsWith('/ping')) return response({ service: 'salcara-hub', protocol: 'salcara-remote', protocolVersion: 1, authModes: ['device-pairing'],
    capabilities: atB && standby === 'unsupported' ? capabilities.filter(value => value !== 'station.standby.v1') : capabilities });
  if (endpoint.endsWith('/app/pair/qr')) return response({ pair_token: 'a'.repeat(64), computerId: 'physical-scope-review', device: device(id) });
  if (endpoint.endsWith('/app/devices')) return response({ devices: [device(id)] });
  if (endpoint.includes('/app/events')) return response({ events: [], nextSeq: 0, lastSeq: 0, hasMore: false });
  if (endpoint.endsWith('/app/commands')) {
    const cmd = JSON.parse(String(init.body)).command;
    if (cmd.type === 'agents.status') return response({ ok: true, result: { agents: [], apis: [] } });
    if (cmd.type === 'remote.station.receipt') return response({ ok: true, result: { committed: false } });
    if (cmd.type === 'remote.station.switch') {
      attempts.push({ station: atB ? 'B' : atC ? 'C' : 'A', operationId: cmd.operationId });
      if (!atB && primary === 'uncertain') throw new Error('Synthetic lost acknowledgement');
      if (!atB && primary === 'forbidden') return response({ code: 'source_station_denied' }, 403);
      if (!atB) return response({ code: 'computer_offline' }, 409);
      if (standby === 'uncertain') return response({ ok: false, error: 'Synthetic dispatch unconfirmed', code: 'command_delivery_uncertain' });
      return standby === 'forbidden' ? response({ code: 'source_station_denied' }, 403)
        : response({ ok: false, error: 'Synthetic explicit refusal', code: 'source_station_denied' });
    }
  }
  throw new Error('Unexpected synthetic endpoint');
};

async function pair() {
  await saveConnection({ id: bId, hubUrl: bHub, deviceId: 'pc-b', deviceName: 'Synthetic scope review', computerId: 'physical-scope-review', pairedAt: 1 }, 'b'.repeat(64));
  await saveConnection({ id: cId, hubUrl: cHub, deviceId: 'pc-c', deviceName: 'Synthetic scope review', computerId: 'physical-scope-review', pairedAt: 1 }, 'd'.repeat(64));
  await bootRemote([]);
  await pairScannedRemoteQr(parseScannedRemoteQr(JSON.stringify({ type: 'salcara-remote-pair', version: 1, hubUrl: aHub,
    deviceId: 'pc-a', deviceName: 'Synthetic scope review', computerId: 'physical-scope-review', ticket: 'c'.repeat(64), expiresAt: Date.now() + 120_000 })));
}

beforeEach(() => { resetRemoteForTests(); mockSettings.clear(); mockSecrets.clear(); attempts.length = 0; primary = 'offline'; standby = 'forbidden'; setHubFetch(transport); });
afterEach(() => { resetRemoteForTests(); setHubFetch(null); });

test.each(['forbidden', 'rejected'] as const)('new handover rejected before execution on both stations releases its journal: %s', async kind => {
  await pair(); standby = kind;
  await expect(useSavedConnection(bId)).rejects.toMatchObject({ code: 'source_station_denied' });
  expect(attempts.map(item => item.station)).toEqual(['A', 'B']);
  expect(attempts[1].operationId).toBe(attempts[0].operationId);
  expect(getRemoteState().connectionId).toBe(aId);
  expect(mockSettings.has(journalKey)).toBe(false);
});

test('a lost primary acknowledgement retains the original journal despite standby policy refusal', async () => {
  await pair(); primary = 'uncertain';
  await expect(useSavedConnection(bId)).rejects.toMatchObject({ code: 'source_station_denied' });
  expect(attempts.map(item => item.station)).toEqual(['A', 'B']);
  expect(JSON.parse(mockSettings.get(journalKey)!)).toMatchObject({ operationId: attempts[0].operationId,
    fromConnectionId: aId, targetConnectionId: bId, deviceId: 'pc-a' });
  expect(getRemoteState().connectionId).toBe(aId);
});

test('retrying an older journal cannot erase its ambiguous original dispatch on two later refusals', async () => {
  await pair(); primary = 'uncertain';
  await expect(useSavedConnection(bId)).rejects.toMatchObject({ code: 'source_station_denied' });
  const original = mockSettings.get(journalKey)!;
  primary = 'offline';
  await expect(useSavedConnection(bId)).rejects.toMatchObject({ code: 'source_station_denied' });
  expect(mockSettings.get(journalKey)).toBe(original);
  expect(new Set(attempts.map(item => item.operationId)).size).toBe(1);
  expect(getRemoteState().connectionId).toBe(aId);
});

test('an unsupported standby that never dispatched cannot strand a new offline-primary operation', async () => {
  await pair(); standby = 'unsupported';
  await expect(useSavedConnection(bId)).rejects.toThrow('备用切换');
  expect(attempts.map(item => item.station)).toEqual(['A']);
  expect(mockSettings.has(journalKey)).toBe(false);
  expect(getRemoteState().connectionId).toBe(aId);
});

test('an uncertain standby business receipt keeps the original operation despite known-offline primary', async () => {
  await pair(); standby = 'uncertain';
  await expect(useSavedConnection(bId)).rejects.toMatchObject({ code: 'command_delivery_uncertain' });
  expect(JSON.parse(mockSettings.get(journalKey)!)).toMatchObject({ operationId: attempts[0].operationId });
  expect(getRemoteState().connectionId).toBe(aId);
});

test('a later primary policy refusal cannot erase an older uncertain dispatch or mint another UUID', async () => {
  await pair(); primary = 'uncertain';
  await expect(useSavedConnection(bId)).rejects.toMatchObject({ code: 'source_station_denied' });
  const original = mockSettings.get(journalKey)!;
  primary = 'forbidden';
  await expect(useSavedConnection(bId)).rejects.toMatchObject({ code: 'source_station_denied' });
  await expect(useSavedConnection(cId)).rejects.toThrow('上一次中转站切换仍在确认');
  expect(mockSettings.get(journalKey)).toBe(original);
  expect(attempts.map(item => item.station)).toEqual(['A', 'B', 'A']);
  expect(new Set(attempts.map(item => item.operationId)).size).toBe(1);
  expect(getRemoteState().connectionId).toBe(aId);
});
