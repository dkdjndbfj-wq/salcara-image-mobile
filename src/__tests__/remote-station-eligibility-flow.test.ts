import { createHash } from 'node:crypto';
import { setHubFetch, type FetchLike, type RemoteApiOption } from '../remote/client';
import { connectionId, saveConnection } from '../remote/connections';
import { apiStationChoices, bootRemote, getRemoteState, loadAgentProfiles, pairScannedRemoteQr, parseScannedRemoteQr, resetRemoteForTests, setAgentApi, useSavedConnection } from '../remote/store';

const mockSettings = new Map<string, string>();
const mockSecrets = new Map<string, string>();
const mockSettingWrite = jest.fn();
jest.mock('expo-crypto', () => ({ ...jest.requireActual('expo-crypto'), randomUUID: () => jest.requireActual('node:crypto').randomUUID(), getRandomBytesAsync: async () => new Uint8Array(32).fill(23) }));
jest.mock('../storage/database', () => ({ getSetting: async (key: string) => mockSettings.get(key) ?? null, setSetting: (...args: unknown[]) => mockSettingWrite(...args) }));
jest.mock('../storage/secure-keys', () => ({ getProviderKey: async () => null }));
jest.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'this-device-only',
  getItemAsync: async (key: string) => mockSecrets.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { mockSecrets.set(key, value); },
  deleteItemAsync: async (key: string) => { mockSecrets.delete(key); },
}));

const aHub = 'https://station-a.example/salcara-hub/v1', bHub = 'https://station-b.example/salcara-hub/v1';
const bId = connectionId(bHub, 'pc-b');
const capabilities = ['device.identity.v1', 'pair.qr.v1', 'session.remote.v1', 'pair.revoke.v1', 'pair.single-phone.v1',
  'commands.idempotency.v1', 'station.guard.v1', 'station.handover.v2', 'station.standby.v1'];
const response = (body: unknown, status = 200) => ({ ok: status === 200, status, text: async () => JSON.stringify(body) });
const device = (id: string) => ({ deviceId: id, name: 'Synthetic PC', os: 'windows', tools: [], projects: [], online: true, lastSeen: 1, capabilities: ['station.source-only.v1'] });
const writes: Array<{ endpoint: string; body: Record<string, any> }> = [];
const calls: string[] = [];
let option: RemoteApiOption;
let currentApi = 'api_aaaaaaaa';
let rejectSwitch = false;
let denialCode = '';

function resetOption(sourceType: RemoteApiOption['sourceType'] = 'official_account') {
  option = { id: 'api_bbbbbbbb', name: 'Synthetic source', models: [], sourceType,
    remoteEligibility: { supported: false, reason: sourceType === 'api_key' ? 'station_mismatch' : 'unsupported', apiRemote: true, accountRemote: false },
    station: { hubUrl: bHub, deviceId: 'pc-b' },
    stations: [{ hubUrl: bHub, deviceId: 'pc-b', apiRemote: true, accountRemote: true, checkedAt: Date.now() }],
  };
}

const transport: FetchLike = async (endpoint, init) => {
  calls.push(endpoint);
  const atB = endpoint.startsWith(bHub), id = atB ? 'pc-b' : 'pc-a';
  if (endpoint.endsWith('/ping')) return response({ service: 'salcara-hub', protocol: 'salcara-remote', protocolVersion: 1, authModes: ['device-pairing'], capabilities });
  if (endpoint.endsWith('/app/pair/qr')) return response({ pair_token: 'a'.repeat(64), computerId: 'physical-pc', device: device(id) });
  if (endpoint.endsWith('/app/devices')) return response({ devices: [device(id)] });
  if (endpoint.includes('/app/events')) return response({ events: [], nextSeq: 0, lastSeq: 0, hasMore: false });
  if (endpoint.endsWith('/app/commands')) {
    const body = JSON.parse(String(init.body)), cmd = body.command;
    if (cmd.type === 'agents.status') return response({ ok: true, result: { agents: [{ id: 'codex', available: true,
      api: { name: 'Fixture API', model: '', configured: true, source: 'computer', accountId: currentApi } }], apis: [option] } });
    if (cmd.type === 'remote.station.switch') {
      writes.push({ endpoint, body });
      if (rejectSwitch) return response({ code: 'source_grant_required' }, 403);
      currentApi = cmd.accountId ?? currentApi;
      const payloadHash = createHash('sha256').update([cmd.targetHubUrl, cmd.targetDeviceId, cmd.targetComputerId,
        cmd.agent ?? '', cmd.accountId ?? '', cmd.model ?? '', cmd.sessionKey ?? ''].join('\u0000') + (cmd.sourceOnly ? '\u0000source-only-v1' : '')).digest('hex');
      return response({ ok: true, result: { switched: true, operationId: cmd.operationId, payloadHash } });
    }
    if (cmd.type === 'agents.api.set') { writes.push({ endpoint, body }); return denialCode ? response({ code: denialCode }, 403) : response({ ok: true, result: {} }); }
    return response({ ok: true, result: {} });
  }
  throw new Error('Unexpected synthetic endpoint');
};

async function pair() {
  await saveConnection({ id: bId, hubUrl: bHub, deviceId: 'pc-b', deviceName: 'Synthetic PC', computerId: 'physical-pc', pairedAt: 1 }, 'b'.repeat(64));
  await bootRemote([]);
  await pairScannedRemoteQr(parseScannedRemoteQr(JSON.stringify({ type: 'salcara-remote-pair', version: 1, hubUrl: aHub,
    deviceId: 'pc-a', deviceName: 'Synthetic PC', computerId: 'physical-pc', ticket: 'c'.repeat(64), expiresAt: Date.now() + 120_000 })));
  await loadAgentProfiles('pc-a');
}

beforeEach(() => {
  resetRemoteForTests(); mockSettings.clear(); mockSecrets.clear(); writes.length = 0; calls.length = 0; currentApi = 'api_aaaaaaaa'; rejectSwitch = false; denialCode = '';
  mockSettingWrite.mockReset().mockImplementation(async (key: string, value: string | null) => { if (value === null) mockSettings.delete(key); else mockSettings.set(key, value); });
  resetOption(); setHubFetch(transport);
});
afterEach(() => { resetRemoteForTests(); setHubFetch(null); });

test('station guard blocks unsupported official accounts and legacy API-origin hints without writes', async () => {
  await pair();
  await expect(setAgentApi('pc-a', 'codex', option.id)).rejects.toThrow('不支持账号');
  resetOption('api_key'); delete option.remoteEligibility; delete option.stations;
  await loadAgentProfiles('pc-a');
  await expect(setAgentApi('pc-a', 'codex', option.id)).rejects.toThrow('尚未确认');
  expect(writes).toHaveLength(0);
  expect(getRemoteState().selectedHubUrl).toBe(aHub);
});

test('explicit eligible destination changes the source and transport atomically and reloads B identity', async () => {
  await pair();
  expect(apiStationChoices('pc-a', option.id).map(item => item.id)).toEqual([bId]);
  await setAgentApi('pc-a', 'codex', option.id, '', undefined, bId);
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ endpoint: aHub + '/app/commands', body: { deviceId: 'pc-a', command: {
    type: 'remote.station.switch', accountId: option.id, agent: 'codex', targetDeviceId: 'pc-b', targetComputerId: 'physical-pc', targetHubUrl: bHub,
  } } });
  expect(writes[0].body.requestId).toBe(writes[0].body.command.operationId);
  expect(getRemoteState().connectionId).toBe(bId);
  expect(getRemoteState().agents['pc-b']?.list[0].api.accountId).toBe(option.id);
  expect(mockSettings.has('remote_station_handover_v1')).toBe(false);
  expect(calls.some(call => call.includes('/app/source/'))).toBe(false);
});

test('leaving the target during its API verification cannot report a successful selection in the new connection', async () => {
  await pair();
  const sourceId = getRemoteState().connectionId!;
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  setHubFetch(async (endpoint, init) => {
    const reply = await transport(endpoint, init);
    if (endpoint === bHub + '/app/commands' && JSON.parse(String(init.body)).command.type === 'agents.status') {
      entered(); await new Promise<void>(resolve => { release = resolve; });
    }
    return reply;
  });
  const selection = setAgentApi('pc-a', 'codex', option.id, '', undefined, bId);
  const outcome = expect(selection).rejects.toThrow('API 或连接已切换');
  await started;
  // The local connection choice changes while the previous computer read is
  // in flight; its eventual reply must not confirm the new screen's API.
  await useSavedConnection(sourceId, true);
  release(); await outcome;
  expect(getRemoteState().connectionId).toBe(sourceId);
  expect(getRemoteState().agents['pc-b']).toBeUndefined();
  expect(writes).toHaveLength(1);
});

test('v2 store handover never requests a grant after an incompatible policy reply', async () => {
  await pair(); rejectSwitch = true;
  await expect(setAgentApi('pc-a', 'codex', option.id, '', undefined, bId)).rejects.toMatchObject({ code: 'source_grant_required' });
  expect(writes).toHaveLength(1);
  expect(calls.some(call => call.includes('/app/source/'))).toBe(false);
  expect(getRemoteState().selectedHubUrl).toBe(aHub);
});

test('capability withdrawal during journal persistence cancels before dispatch and does not strand the journal', async () => {
  await pair();
  mockSettingWrite.mockImplementation(async (key: string, value: string | null) => {
    if (value === null) mockSettings.delete(key); else mockSettings.set(key, value);
    if (key === 'remote_station_handover_v1' && value !== null) {
      option.stations = [];
      await loadAgentProfiles('pc-a');
    }
  });
  await expect(setAgentApi('pc-a', 'codex', option.id, '', undefined, bId)).rejects.toThrow('能力已变化');
  expect(writes).toHaveLength(0);
  expect(mockSettings.has('remote_station_handover_v1')).toBe(false);
  expect(getRemoteState().selectedHubUrl).toBe(aHub);
});

test('transport-only switch preserves a source without granting permission to run it at the destination', async () => {
  await pair(); currentApi = option.id;
  await loadAgentProfiles('pc-a');
  await useSavedConnection(bId);
  expect(writes).toHaveLength(1);
  expect(writes[0].body.command).toMatchObject({ sourceOnly: true, accountId: option.id });
  expect(getRemoteState().connectionId).toBe(bId);
  await loadAgentProfiles('pc-b');
  await expect(setAgentApi('pc-b', 'codex', option.id)).rejects.toThrow('不支持账号');
  expect(writes).toHaveLength(1);
});

test.each(['source_station_denied', 'station_guard_unsupported', 'remote_execution_disabled'])('policy denial %s does not turn a healthy connection into an offline computer', async code => {
  resetOption('api_key');
  option.remoteEligibility = { supported: true, reason: 'supported', apiRemote: true, accountRemote: true };
  await pair(); const before = getRemoteState().connection;
  denialCode = code;
  await expect(setAgentApi('pc-a', 'codex', option.id)).rejects.toMatchObject({ code });
  expect(getRemoteState().connection).toBe(before);
  expect(getRemoteState().connectionError).toBeUndefined();
  expect(getRemoteState().devices.find(item => item.deviceId === 'pc-a')?.online).toBe(true);
});
