import type { ProviderProfile } from '../domain';
import { confirmPair, setHubFetch, type FetchLike } from '../remote/client';
import { connectionToken, loadConnections } from '../remote/connections';
import { bootRemote, diagnoseRemoteConnection, getRemoteState, onRemoteChange, pairScannedRemoteQr, parseScannedRemoteQr, resetRemoteForTests, signInRemote, watchCredentials } from '../remote/store';

const mockSettings = new Map<string, string>(), mockSecrets = new Map<string, string>();
const mockReadSetting = jest.fn(), mockReadSecret = jest.fn(), mockReadProvider = jest.fn(), mockWriteSetting = jest.fn();
jest.mock('../storage/database', () => ({
  getSetting: (key: string) => mockReadSetting(key),
  setSetting: (key: string, value: string | null) => mockWriteSetting(key, value),
}));
jest.mock('../storage/secure-keys', () => ({ getProviderKey: (id: string) => mockReadProvider(id) }));
jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'fixture', getItemAsync: (key: string) => mockReadSecret(key),
  setItemAsync: async (key: string, value: string) => { mockSecrets.set(key, value); },
  deleteItemAsync: async (key: string) => { mockSecrets.delete(key); },
}));
jest.mock('expo-crypto', () => ({ randomUUID: () => require('node:crypto').randomUUID() }));

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
const provider: ProviderProfile = { id: 'legacy-a', name: 'A', baseUrl: 'https://legacy-a.example/v1', model: null,
  quality: null, aspectRatio: null, resolutionTier: null, createdAt: 1, updatedAt: 1 };
const hubUrl = 'https://new-b.example/salcara-hub/v1';
const device = { deviceId: 'pc', name: 'Fixture', os: 'windows', tools: [], projects: [], online: true, lastSeen: 1 };
const qr = (ticket = 'b', deviceId = device.deviceId) => parseScannedRemoteQr(JSON.stringify({ type: 'salcara-remote-pair', version: 1, hubUrl,
  deviceId, deviceName: device.name, ticket: ticket.repeat(64), expiresAt: Date.now() + 60000 }));
const reply = (value: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });
const transport: FetchLike = async endpoint => endpoint.endsWith('/ping')
  ? reply({ service: 'salcara-hub', protocol: 'salcara-remote', protocolVersion: 1, authModes: ['device-pairing'],
    capabilities: ['device.identity.v1', 'pair.qr.v1', 'session.remote.v1', 'pair.revoke.v1'] })
  : endpoint.endsWith('/app/pair/qr') ? reply({ pair_token: 'c'.repeat(64), device }) : reply({ devices: [device] });

beforeEach(() => {
  resetRemoteForTests(); mockSettings.clear(); mockSecrets.clear();
  mockReadSetting.mockReset().mockImplementation(async (key: string) => mockSettings.get(key) ?? null);
  mockWriteSetting.mockReset().mockImplementation(async (key: string, value: string | null) => { if (value === null) mockSettings.delete(key); else mockSettings.set(key, value); });
  mockReadSecret.mockReset().mockImplementation(async (key: string) => mockSecrets.get(key) ?? null);
  mockReadProvider.mockReset().mockResolvedValue('synthetic-legacy-key'); setHubFetch(transport);
});
afterEach(() => { resetRemoteForTests(); setHubFetch(null); });

test('switching the paired computer cancels a pending Hub probe before a computer echo can be sent', async () => {
  await bootRemote([]); await pairScannedRemoteQr(qr());
  const late = deferred<Awaited<ReturnType<FetchLike>>>(); const targets: string[] = [];
  let probeBody: Record<string, unknown> = {};
  setHubFetch(async (endpoint, init) => {
    if (endpoint.endsWith('/app/diagnostics')) { probeBody = JSON.parse(String(init.body)); targets.push(String(probeBody.target)); return late.promise; }
    if (endpoint.endsWith('/app/pair/qr')) return reply({ pair_token: 'd'.repeat(64), device: { ...device, deviceId: 'new-pc' } });
    return transport(endpoint, init);
  });
  const pending = diagnoseRemoteConnection('pc'); const rejected = expect(pending).rejects.toMatchObject({ code: 'aborted' });
  await flush(); expect(targets).toEqual(['hub']);
  await pairScannedRemoteQr(qr('e', 'new-pc')); await rejected;
  late.resolve(reply({ version: 1, ...probeBody, status: 'ok', deviceOnline: true, lastSeen: 1 })); await flush();
  expect(targets).toEqual(['hub']); expect(getRemoteState().devices[0].deviceId).toBe('new-pc');
});

test.each(['selection', 'pair-token'] as const)('late legacy startup cannot overwrite a newly paired station after its %s read', async pauseAt => {
  mockSettings.set('remote_service', provider.id); mockSecrets.set('remote-pair-legacy-a', 'a'.repeat(64));
  const read = deferred<string | null>(); let entered = false;
  if (pauseAt === 'selection') mockReadSetting.mockImplementation(async (key: string) => {
    if (key === 'remote_service') { entered = true; return read.promise; } return mockSettings.get(key) ?? null;
  });
  else mockReadSecret.mockImplementation(async (key: string) => {
    if (key === 'remote-pair-legacy-a') { entered = true; return read.promise; } return mockSecrets.get(key) ?? null;
  });
  const starting = bootRemote([provider]); await flush(); expect(entered).toBe(true);
  await pairScannedRemoteQr(qr());
  const current = getRemoteState().connectionId;
  read.resolve(pauseAt === 'selection' ? provider.id : 'a'.repeat(64));
  await starting;
  expect(getRemoteState()).toMatchObject({ phase: 'ready', serviceId: null, connectionId: current, selectedHubUrl: hubUrl });
  expect(watchCredentials()).toEqual({ url: hubUrl, pairToken: 'c'.repeat(64) });
});

test.each([false, true])('a delayed QR acknowledgement keeps the current credential while retaining an unrelated computer: different=%s', async different => {
  const oldReply = deferred<Awaited<ReturnType<FetchLike>>>(); let oldClaimed = false;
  setHubFetch(async (endpoint, init) => {
    if (endpoint.endsWith('/app/pair/qr') && JSON.parse(String(init.body)).ticket === 'b'.repeat(64)) {
      oldClaimed = true; return oldReply.promise;
    }
    if (endpoint.endsWith('/app/pair/qr')) return reply({ pair_token: 'c'.repeat(64), device: { ...device, deviceId: different ? 'new-pc' : 'pc' } });
    return transport(endpoint, init);
  });
  await bootRemote([]);
  const old = pairScannedRemoteQr(qr()); await flush(); expect(oldClaimed).toBe(true);
  await pairScannedRemoteQr(qr('d', different ? 'new-pc' : 'pc'));
  oldReply.resolve(reply({ pair_token: 'a'.repeat(64), device })); await old;
  const saved = await loadConnections(); expect(saved).toHaveLength(different ? 2 : 1);
  expect(await connectionToken(saved.find(item => item.deviceId === (different ? 'new-pc' : 'pc'))!)).toBe('c'.repeat(64));
  if (different) expect(await connectionToken(saved.find(item => item.deviceId === 'pc')!)).toBe('a'.repeat(64));
  expect(watchCredentials()).toEqual({ url: hubUrl, pairToken: 'c'.repeat(64) });
  resetRemoteForTests(); await bootRemote([]);
  expect(watchCredentials()).toEqual({ url: hubUrl, pairToken: 'c'.repeat(64) });
});

test('normal legacy startup still restores its own unchanged credentials', async () => {
  mockSettings.set('remote_service', provider.id); mockSecrets.set('remote-pair-legacy-a', 'a'.repeat(64));
  await bootRemote([provider]);
  expect(getRemoteState()).toMatchObject({ phase: 'ready', serviceId: provider.id, connectionId: null });
  expect(watchCredentials()).toEqual({ url: 'https://legacy-a.example/salcara-hub/v1', pairToken: 'a'.repeat(64) });
  expect(mockReadProvider).not.toHaveBeenCalled();
});

test('legacy API selection discovers anonymously without model key storage or /me login', async () => {
  const calls: Array<{ endpoint: string; headers: unknown }> = [];
  mockReadProvider.mockRejectedValue(new Error('model key store must not be read'));
  setHubFetch(async (endpoint, init) => { calls.push({ endpoint, headers: init.headers }); return transport(endpoint, init); });
  await bootRemote([]); await signInRemote(provider);
  expect(getRemoteState()).toMatchObject({ phase: 'pairing', serviceId: provider.id });
  expect(calls).toHaveLength(1); expect(calls[0].endpoint).toBe('https://legacy-a.example/salcara-hub/v1/ping');
  expect(calls[0].headers).toEqual({ Accept: 'application/json' });
  expect(mockReadProvider).not.toHaveBeenCalled();
});

test('late legacy discovery cannot replace a newer QR pairing or read its old pairing token', async () => {
  const read = deferred<Awaited<ReturnType<FetchLike>>>(); let entered = false;
  setHubFetch(async (endpoint, init) => {
    if (endpoint.startsWith('https://legacy-a.example')) { entered = true; return read.promise; }
    return transport(endpoint, init);
  });
  await bootRemote([]); const pending = signInRemote(provider); const rejected = expect(pending).rejects.toThrow('连接选择已改变');
  await flush(); expect(entered).toBe(true); await pairScannedRemoteQr(qr());
  read.resolve(await transport('https://legacy-a.example/salcara-hub/v1/ping', {})); await rejected;
  expect(watchCredentials()).toEqual({ url: hubUrl, pairToken: 'c'.repeat(64) });
  expect(mockReadSecret.mock.calls.some(([key]) => key === 'remote-pair-legacy-a')).toBe(false);
});

test('a newly discovered prefixed Hub never receives a legacy token issued for the default root Hub', async () => {
  mockSecrets.set('remote-pair-legacy-a', 'a'.repeat(64));
  const headers: unknown[] = [];
  setHubFetch(async (endpoint, init) => { headers.push(init.headers); return transport(endpoint, init); });
  await bootRemote([]); await signInRemote({ ...provider, baseUrl: 'https://legacy-a.example/tenant/v1' });
  expect(getRemoteState()).toMatchObject({ phase: 'pairing' });
  expect(watchCredentials()).toBeNull(); expect(headers).toEqual([{ Accept: 'application/json' }]);
  expect(mockSecrets.get('remote-pair-legacy-a')).toBe('a'.repeat(64));
  expect(mockReadProvider).not.toHaveBeenCalled();
});

test('a successful direct QR publishes ready state together with its credentials for notification subscribers', async () => {
  await bootRemote([]);
  const snapshots: ReturnType<typeof watchCredentials>[] = [];
  const unsubscribe = onRemoteChange(() => { if (getRemoteState().phase === 'ready') snapshots.push(watchCredentials()); });
  try { await pairScannedRemoteQr(qr()); } finally { unsubscribe(); }
  expect(snapshots.length).toBeGreaterThan(0);
  expect(snapshots.every(snapshot => snapshot?.url === hubUrl && snapshot?.pairToken === 'c'.repeat(64))).toBe(true);
});

test('closing the scanner during its startup selection write keeps the old connection while saving the new computer', async () => {
  await bootRemote([]); await pairScannedRemoteQr(qr());
  const current = getRemoteState().connectionId;
  const write = deferred<void>(); let entered = false, visible = true;
  mockWriteSetting.mockImplementation(async (key: string, value: string | null) => {
    if (value === null) mockSettings.delete(key); else mockSettings.set(key, value);
    if (key === 'remote_device_connection_v1' && value !== current) { entered = true; await write.promise; }
  });
  setHubFetch(async (endpoint, init) => endpoint.endsWith('/app/pair/qr')
    ? reply({ pair_token: 'd'.repeat(64), device: { ...device, deviceId: 'new-pc' } }) : transport(endpoint, init));
  const pairing = pairScannedRemoteQr(qr('e', 'new-pc'), () => visible); await flush(); expect(entered).toBe(true);
  visible = false; write.resolve(); await pairing;
  expect(getRemoteState().connectionId).toBe(current);
  expect(mockSettings.get('remote_device_connection_v1')).toBe(current);
  expect(watchCredentials()).toEqual({ url: hubUrl, pairToken: 'c'.repeat(64) });
  expect(await loadConnections()).toHaveLength(2);
});

test.each([
  { status: 503, code: 'pair_persistence_failed', error: '无法保存配对状态' },
  { status: 409, code: 'pair_state_changed', error: '配对状态已改变' },
])('Hub $code preserves the concrete error and never replays a consumed QR or legacy code', async failure => {
  await bootRemote([]); await pairScannedRemoteQr(qr());
  const current = getRemoteState().connectionId;
  const claims: string[] = [];
  setHubFetch(async (endpoint, init) => {
    if (endpoint.endsWith('/app/pair/qr') || endpoint.endsWith('/app/pair/confirm')) {
      claims.push(endpoint); return { ok: false, status: failure.status, text: async () => JSON.stringify({ code: failure.code, error: failure.error, retryable: false }) };
    }
    return transport(endpoint, init);
  });
  const first = pairScannedRemoteQr(qr('d')), duplicate = pairScannedRemoteQr(qr('d'));
  await expect(Promise.all([first, duplicate])).rejects.toMatchObject({ status: failure.status, code: failure.code, message: failure.error });
  await flush(); expect(claims).toHaveLength(1);
  expect(getRemoteState()).toMatchObject({ phase: 'ready', connectionId: current });
  expect(watchCredentials()).toEqual({ url: hubUrl, pairToken: 'c'.repeat(64) });
  expect(await connectionToken((await loadConnections())[0])).toBe('c'.repeat(64));
  await expect(confirmPair({ url: hubUrl, key: 'synthetic-key' }, 'ABC12345')).rejects.toMatchObject({ status: failure.status, code: failure.code, message: failure.error });
  await flush(); expect(claims).toEqual([`${hubUrl}/app/pair/qr`, `${hubUrl}/app/pair/confirm`]);
});
