import { createHash } from 'node:crypto';
import { canonicalHubUrl, readPairQr } from '../remote/pairing';
import { command, confirmQrPair, discoverStation, devices, openStream, setHubFetch, type DeviceStatus, type FetchLike } from '../remote/client';
import { connectionId, connectionToken, deliveryCredentialId, forgetConnection, loadConnections, saveConnection, selectConnectionIf, selectedConnection } from '../remote/connections';
import { resetDeliveryForTests } from '../remote/delivery';
import { resetQuestionOutboxForTests } from '../remote/question-outbox';
import { bootRemote, connectStation, getPendingRemoteMessage, getRemoteState, loadAgentProfiles, loadSessions, openSession, pairRemoteQr, pairScannedRemoteQr, parseScannedRemoteQr, parseRemoteQr, refreshDevices, remoteDeliveryScope, revokeRemoteConnection, resetRemoteForTests, sendToSession, setAgentApi, setRemoteForeground, setRemoteScreenOpen, signOutRemote, syncSessionEvents, timelineKey, useSavedConnection } from '../remote/store';

const mockSettings = new Map<string, string>();
const mockSecrets = new Map<string, string>();
const mockSettingWrite = jest.fn();
const mockGetProviderKey = jest.fn(async (..._args: unknown[]) => 'never-needed');
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; }
jest.mock('expo-crypto', () => ({ ...jest.requireActual('expo-crypto'), randomUUID: () => jest.requireActual('node:crypto').randomUUID(), getRandomBytesAsync: async () => new Uint8Array(32).fill(23) }));
jest.mock('../storage/database', () => ({
  getSetting: async (key: string) => mockSettings.get(key) ?? null,
  setSetting: (...args: unknown[]) => mockSettingWrite(...args),
}));
jest.mock('../storage/secure-keys', () => ({ getProviderKey: (...args: unknown[]) => mockGetProviderKey(...args) }));
jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'this-device-only',
  getItemAsync: async (key: string) => mockSecrets.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { mockSecrets.set(key, value); },
  deleteItemAsync: async (key: string) => { mockSecrets.delete(key); },
}));

const origin = 'https://station.example';
const url = `${origin}/salcara-hub/v1`;
const token = 'a'.repeat(64);
const device: DeviceStatus = { deviceId: 'pc-1', name: 'My PC', os: 'windows', tools: [], projects: [], online: true, lastSeen: 1 };
const qr = () => ({ type: 'salcara-remote-pair', version: 1, hubUrl: url, deviceId: device.deviceId, deviceName: device.name, ticket: 'b'.repeat(64), expiresAt: Date.now() + 120_000 });
const capabilities = ['device.identity.v1', 'pair.qr.v1', 'session.remote.v1', 'pair.revoke.v1'];
const discovery = { service: 'salcara-hub', protocol: 'salcara-remote', protocolVersion: 1, authModes: ['device-pairing'], capabilities };
const response = (payload: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => { resetRemoteForTests(); mockSettings.clear(); mockSecrets.clear(); mockGetProviderKey.mockClear(); mockSettingWrite.mockReset(); mockSettingWrite.mockImplementation(async (key: string, value: string | null) => { if (value === null) mockSettings.delete(key); else mockSettings.set(key, value); }); });
afterEach(() => { resetRemoteForTests(); setHubFetch(null); });

test('station address is strict, canonical, credential-free and HTTPS', () => {
  expect(canonicalHubUrl(' HTTPS://Station.Example:443/v1/ ')).toBe(url);
  expect(canonicalHubUrl(url)).toBe(url);
  for (const input of ['http://station.example', 'http://10.0.0.1', 'https://localhost', 'https://192.168.1.1', 'https://127.0.0.1', 'https://[::1]', 'https://[fd00::1]', 'https://u:pass@station.example', `${origin}?`, `${origin}#`, `${origin}?key=secret`, `${origin}/other`, `${origin}/salcara-hub/v1/../other`, `${origin}\\evil`]) expect(() => canonicalHubUrl(input)).toThrow();
  expect(() => canonicalHubUrl('http://127.0.0.1:123')).toThrow();
  expect(canonicalHubUrl('http://127.0.0.1:123', true)).toBe('http://127.0.0.1:123/salcara-hub/v1');
});

test('direct QR obtains the station from QR, discovers before claiming and preserves existing pair on failure', async () => {
  const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
  setHubFetch(stationTransport(calls));
  await bootRemote([]);
  expect(getRemoteState().phase).toBe('setup');
  await pairScannedRemoteQr(parseScannedRemoteQr(JSON.stringify(qr())));
  expect(calls[0].url).toBe(`${url}/ping`); expect(calls[1].url).toBe(`${url}/app/pair/qr`);
  const before = getRemoteState().connectionId;
  setHubFetch((async () => response({ service: 'wrong' })) as FetchLike);
  await expect(pairScannedRemoteQr(parseScannedRemoteQr(JSON.stringify({ ...qr(), hubUrl: 'https://other.example/salcara-hub/v1' })))).rejects.toThrow('兼容');
  expect(getRemoteState().connectionId).toBe(before); expect(getRemoteState().connections).toHaveLength(1);
  expect(mockGetProviderKey).not.toHaveBeenCalled();
});

test('duplicate camera callbacks claim one one-time QR ticket only once', async () => {
  let claims = 0;
  let release: ((value: Awaited<ReturnType<FetchLike>>) => void) | undefined;
  setHubFetch((async (endpoint) => {
    if (endpoint.endsWith('/ping')) return response(discovery);
    if (endpoint.endsWith('/app/pair/qr')) {
      claims += 1;
      return new Promise((resolve) => { release = resolve; });
    }
    return response({ devices: [device] });
  }) as FetchLike);
  await bootRemote([]);
  const scanned = parseScannedRemoteQr(JSON.stringify(qr()));
  const first = pairScannedRemoteQr(scanned);
  const second = pairScannedRemoteQr(scanned);
  for (let i = 0; i < 20 && !release; i += 1) await flush();
  expect(claims).toBe(1);
  release!(response({ pair_token: token, device }));
  await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
  expect(getRemoteState().connectionId).toBe(connectionId(url, device.deviceId));
});

test('a stale guarded startup selection cannot survive a storage-write race', async () => {
  mockSettings.set('remote_device_connection_v1', 'old-connection');
  const release = deferred<void>();
  let entered = false;
  mockSettingWrite.mockImplementationOnce(async (key: string, value: string | null) => {
    entered = true;
    if (value === null) mockSettings.delete(key); else mockSettings.set(key, value);
    await release.promise;
  });
  let current = true;
  const write = selectConnectionIf('new-connection', () => current);
  for (let i = 0; i < 20 && !entered; i += 1) await flush();
  expect(entered).toBe(true);
  current = false;
  release.resolve();
  await expect(write).resolves.toBe(false);
  expect(await selectedConnection()).toBe('old-connection');
});

test('same physical computer uses one secure phone identity across stations, unbind revokes both but not other PCs', async () => {
  const claims: Record<string, unknown>[] = [], revokes: string[] = [];
  setHubFetch((async (endpoint, init) => {
    if (endpoint.endsWith('/ping')) return response({ ...discovery, capabilities: [...capabilities, 'pair.single-phone.v1'] });
    if (endpoint.endsWith('/app/pair/qr')) { const body = JSON.parse(String(init.body)); claims.push(body);
      return response({ pair_token: token, computerId: 'physical-pc', device: { ...device, deviceId: body.deviceId } }); }
    if (endpoint.endsWith('/app/pair/revoke')) { revokes.push(endpoint); return response({ ok: true }); }
    return response({ devices: [device] });
  }) as FetchLike);
  await bootRemote([]);
  await pairScannedRemoteQr(parseScannedRemoteQr(JSON.stringify({ ...qr(), computerId: 'physical-pc' })));
  const two = 'https://other.example/salcara-hub/v1';
  await pairScannedRemoteQr(parseScannedRemoteQr(JSON.stringify({ ...qr(), hubUrl: two, deviceId: 'pc-two', computerId: 'physical-pc' })));
  expect(claims).toHaveLength(2); expect(claims[0].phoneId).toMatch(/^[a-f0-9]{64}$/); expect(claims[0].phoneId).toBe(claims[1].phoneId);
  const other = { id: connectionId(url, 'unrelated'), hubUrl: url, deviceId: 'unrelated', deviceName: 'Other PC', pairedAt: 1, computerId: 'other-pc' };
  await saveConnection(other, 'e'.repeat(64));
  await revokeRemoteConnection();
  expect(revokes.sort()).toEqual([`${url}/app/pair/revoke`, `${two}/app/pair/revoke`].sort());
  expect(await loadConnections()).toEqual([other]);
  expect([...mockSettings.values()].join()).not.toContain(String(claims[0].phoneId));
});

test('station handover blocks durable message receipts before moving A to B', async () => {
  const other = 'https://other.example/salcara-hub/v1';
  const aToken = 'a'.repeat(64), bToken = 'c'.repeat(64);
  let stationSwitches = 0;
  setHubFetch((async (endpoint, init) => {
    if (endpoint.endsWith('/ping')) return response({ ...discovery, capabilities: [...capabilities, 'pair.single-phone.v1', 'commands.idempotency.v1'] });
    if (endpoint.endsWith('/app/pair/qr')) {
      const body = JSON.parse(String(init.body)) as { deviceId: string };
      const isB = endpoint.startsWith(other);
      return response({ pair_token: isB ? bToken : aToken, computerId: 'physical-pc', device: { ...device, deviceId: body.deviceId } });
    }
    if (endpoint.endsWith('/app/devices')) {
      const isB = endpoint.startsWith(other);
      return response({ devices: [{ ...device, deviceId: isB ? 'pc-b' : 'pc-1', online: true }] });
    }
    if (endpoint.endsWith('/app/commands')) {
      const body = JSON.parse(String(init.body)) as { command?: { type?: string } };
      if (body.command?.type === 'remote.station.switch') stationSwitches += 1;
      return response({ ok: true, result: {} });
    }
    if (endpoint.includes('/app/events')) return response({ events: [], nextSeq: 0, lastSeq: 0, hasMore: false });
    return response({ devices: [] });
  }) as FetchLike);
  await bootRemote([]);
  const pairQr = (hubUrl: string, deviceId: string) => ({ ...qr(), hubUrl, deviceId, computerId: 'physical-pc' });
  await pairScannedRemoteQr(parseScannedRemoteQr(JSON.stringify(pairQr(url, 'pc-1'))));
  const aId = getRemoteState().connectionId!;
  await pairScannedRemoteQr(parseScannedRemoteQr(JSON.stringify(pairQr(other, 'pc-b'))));
  const bId = getRemoteState().connectionId!;
  // Return to A before installing an A-scoped unconfirmed message receipt.
  await useSavedConnection(aId);
  const scope = remoteDeliveryScope();
  mockSettings.set('remote_pending_delivery_v1', JSON.stringify([{
    scope, deviceId: 'pc-1', sessionKey: 'codex:pending', surface: 'cli', text: '同一条任务',
    requestId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', createdAt: Date.now(), attempted: true, safeRetry: true,
  }]));
  resetDeliveryForTests();
  expect(await getPendingRemoteMessage('pc-1', 'codex:pending')).toBeDefined();
  const before = stationSwitches;
  await expect(useSavedConnection(bId)).rejects.toThrow('待确认消息');
  expect(stationSwitches).toBe(before);
  expect(getRemoteState().connectionId).toBe(aId);
  // A pending answer to an Agent question is a second durable outbox and must
  // receive the same protection even when no message receipt exists.
  mockSettings.set('remote_pending_delivery_v1', '[]'); resetDeliveryForTests();
  mockSettings.set('remote_question_outbox_v1', JSON.stringify([{
    scope, deviceId: 'pc-1', sessionKey: 'codex:question', approvalId: 'bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb',
    decision: 'allow', requestId: 'cccccccc-cccc-4ccc-accc-cccccccccccc', createdAt: Date.now(), lastObservedAt: Date.now(), attempted: true,
  }]));
  resetQuestionOutboxForTests();
  await expect(useSavedConnection(bId)).rejects.toThrow('待确认消息');
  expect(stationSwitches).toBe(before);

  // Different stations normally issue different device IDs. Once both durable
  // outboxes are settled, selecting B must still ask the computer to hand over
  // A → B; a phone-only profile switch would strand the computer on A.
  mockSettings.set('remote_question_outbox_v1', '[]'); resetQuestionOutboxForTests();
  await useSavedConnection(bId);
  expect(stationSwitches).toBe(before + 1);
  expect(getRemoteState().connectionId).toBe(bId);
});

test('API plus station handover reloads Agent status with B\'s device id', async () => {
  const other = 'https://other.example/salcara-hub/v1';
  const aDevice = 'pc-a', bDevice = 'pc-b';
  const aToken = 'a'.repeat(64), bToken = 'c'.repeat(64), apiB = 'api_' + 'b'.repeat(16);
  const calls: Array<{ endpoint: string; deviceId?: string; type?: string }> = [];
  setHubFetch((async (endpoint, init) => {
    const isB = endpoint.startsWith(other);
    if (endpoint.endsWith('/ping')) return response({ ...discovery, capabilities: [...capabilities, 'pair.single-phone.v1', 'commands.idempotency.v1'] });
    if (endpoint.endsWith('/app/pair/qr')) {
      const body = JSON.parse(String(init.body)) as { deviceId: string };
      return response({ pair_token: isB ? bToken : aToken, computerId: 'physical-pc', device: { ...device, deviceId: body.deviceId } });
    }
    if (endpoint.endsWith('/app/devices')) return response({ devices: [{ ...device, deviceId: isB ? bDevice : aDevice, online: true }] });
    if (endpoint.endsWith('/app/commands')) {
      const body = JSON.parse(String(init.body)) as { deviceId?: string; command?: { type?: string } };
      const type = body.command?.type;
      calls.push({ endpoint, deviceId: body.deviceId, type });
      if (type === 'agents.status') return response({ ok: true, result: { agents: [
        { id: 'codex', available: true, api: { name: isB ? 'B API' : 'A API', model: '', configured: true, source: 'computer', accountId: apiB } },
      ], apis: [{ id: apiB, name: 'B API', models: [], ...(isB ? {} : { station: { hubUrl: other, deviceId: bDevice } }) }] } });
      return response({ ok: true, result: {} });
    }
    if (endpoint.includes('/app/events')) return response({ events: [], nextSeq: 0, lastSeq: 0, hasMore: false });
    throw new Error(`Unexpected synthetic endpoint: ${endpoint}`);
  }) as FetchLike);

  await bootRemote([]);
  const pair = async (hubUrl: string, deviceId: string) => pairScannedRemoteQr(parseScannedRemoteQr(JSON.stringify({
    ...qr(), hubUrl, deviceId, computerId: 'physical-pc', ticket: deviceId === aDevice ? 'b'.repeat(64) : 'd'.repeat(64),
  })));
  await pair(url, aDevice); const aId = getRemoteState().connectionId!;
  await pair(other, bDevice); const bId = getRemoteState().connectionId!;
  await useSavedConnection(aId);
  await loadAgentProfiles(aDevice);
  await setAgentApi(aDevice, 'codex', apiB);

  expect(getRemoteState().connectionId).toBe(bId);
  expect(getRemoteState().agents[bDevice]?.list.find((item) => item.id === 'codex')?.api.name).toBe('B API');
  const bReads = calls.filter((call) => call.endpoint.startsWith(other) && call.type === 'agents.status');
  expect(bReads.length).toBeGreaterThan(0);
  expect(bReads.every((call) => call.deviceId === bDevice)).toBe(true);
  expect(calls.some((call) => call.endpoint.startsWith(other) && call.deviceId === aDevice && call.type === 'agents.status')).toBe(false);
});

test('read-only history recovers when online stream is briefly replaced, writes are never blindly retried', async () => {
  let count = 0;
  setHubFetch((async () => { count += 1; return count === 1 ? response({ error: 'offline' }, 409) : response({ ok: true, result: { sessions: [] } }); }) as FetchLike);
  await expect(command({ url, pairToken: token, deviceId: 'pc-1' }, 'pc-1', { type: 'sessions.list' })).resolves.toEqual({ sessions: [] });
  expect(count).toBe(2); count = 0;
  await expect(command({ url, pairToken: token, deviceId: 'pc-1' }, 'pc-1', { type: 'session.send', sessionKey: 'codex:one', text: 'fixture', controlSurface: 'cli' })).rejects.toThrow();
  expect(count).toBe(1);
});

test('QR is scoped to a preselected exact endpoint and expires', () => {
  const raw = qr();
  expect(readPairQr(JSON.stringify(raw), url)).toMatchObject(raw);
  expect(() => readPairQr(JSON.stringify(raw), 'https://other.example/salcara-hub/v1')).toThrow('不一致');
  expect(() => readPairQr(JSON.stringify({ ...raw, hubUrl: `${url}/` }), url)).toThrow('不一致');
  expect(() => readPairQr(JSON.stringify({ ...raw, hubUrl: `${url}?secret=x` }), url)).toThrow();
  expect(() => readPairQr(JSON.stringify({ ...raw, expiresAt: Date.now() - 1 }), url)).toThrow('过期');
  expect(() => readPairQr(JSON.stringify({ ...raw, expiresAt: Date.now() + 3600_000 }), url)).toThrow('有效期');
  expect(() => readPairQr(JSON.stringify({ ...raw, ticket: 'abc' }), url)).toThrow('凭证');
});

test('discovery rejects the old API-account plugin and requires supported protocol capabilities', async () => {
  let payload: unknown = { service: 'salcara-hub' };
  setHubFetch((async () => response(payload)) as FetchLike);
  await expect(discoverStation(origin)).rejects.toThrow('兼容');
  payload = { ...discovery, capabilities: capabilities.slice(1) };
  await expect(discoverStation(origin)).rejects.toThrow('兼容');
  payload = discovery;
  await expect(discoverStation(origin)).resolves.toMatchObject({ url });
});

test('device QR exchange is anonymous; every later request carries only its device credential', async () => {
  const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
  setHubFetch((async (endpoint, init) => { calls.push({ url: endpoint, init }); return response(endpoint.endsWith('/app/pair/qr') ? { pair_token: token, device } : { devices: [device, { ...device, deviceId: 'other' }] }); }) as FetchLike);
  const paired = await confirmQrPair(readPairQr(JSON.stringify(qr()), url));
  expect(paired.token).toBe(token);
  expect(calls[0].init.headers).not.toHaveProperty('Authorization');
  expect(calls[0].init.headers).not.toHaveProperty('X-Salcara-Pair-Token');
  expect(JSON.parse(String(calls[0].init.body))).toEqual({ deviceId: 'pc-1', ticket: 'b'.repeat(64) });
  expect(await devices({ url, pairToken: token, deviceId: 'pc-1' })).toEqual([device]);
  expect(calls[1].init.headers).toMatchObject({ 'X-Salcara-Pair-Token': token });
  expect(calls[1].init.headers).not.toHaveProperty('Authorization');
  expect(calls[1].init).toMatchObject({ redirect: 'error', credentials: 'omit' });
  await expect(command({ url, pairToken: token, deviceId: 'pc-1' }, 'other', { type: 'sessions.list' })).rejects.toThrow('不属于');
  expect(calls).toHaveLength(2);
});

test('rejects redirected discovery and mismatched pair response device before persisting', async () => {
  setHubFetch((async () => ({ ...response(discovery), redirected: true, url: 'https://other.example/ping' })) as FetchLike);
  await expect(discoverStation(origin)).rejects.toThrow('重定向');
  setHubFetch((async () => response({ pair_token: token, device: { ...device, deviceId: 'other' } })) as FetchLike);
  await expect(confirmQrPair(readPairQr(JSON.stringify(qr()), url))).rejects.toThrow('无效');
  expect(mockSecrets.size).toBe(0);
});

test('aborting a read-only command cancels the transport without a retry', async () => {
  let aborted = false;
  let calls = 0;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  setHubFetch((async (_endpoint, init) => new Promise<Awaited<ReturnType<FetchLike>>>((_resolve, reject) => {
    calls += 1;
    const signal = init.signal as AbortSignal;
    if (signal.aborted) { aborted = true; reject(new Error('aborted')); return; }
    signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
    entered();
  })) as FetchLike);
  const controller = new AbortController();
  const pending = command({ url, pairToken: token, deviceId: 'pc-1' }, 'pc-1', { type: 'desktop.session.open', sessionKey: 'codex:one', controlSurface: 'desktop' }, undefined, controller.signal);
  await started;
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: 'aborted', status: 499 });
  expect(aborted).toBe(true);
  expect(calls).toBe(1);
});

test('keychain token binds both exact station endpoint and device, without leaking to settings', async () => {
  expect(deliveryCredentialId(token)).not.toBe(deliveryCredentialId('c'.repeat(64)));
  expect(deliveryCredentialId(token)).not.toContain(token);
  const profile = { id: connectionId(url, device.deviceId), hubUrl: url, deviceId: device.deviceId, deviceName: device.name, pairedAt: 1 };
  await saveConnection(profile, token);
  expect(await loadConnections()).toEqual([profile]);
  expect(await connectionToken(profile)).toBe(token);
  expect([...mockSettings.values()].join()).not.toContain(token);
  const otherUrl = 'https://other.example/salcara-hub/v1';
  expect(connectionId(otherUrl, device.deviceId)).not.toBe(profile.id);
  expect(await connectionToken({ ...profile, hubUrl: otherUrl })).toBeNull();
  const secretKey = [...mockSecrets.keys()][0];
  mockSecrets.set(secretKey, JSON.stringify({ hubUrl: otherUrl, deviceId: device.deviceId, token }));
  expect(await connectionToken(profile)).toBeNull();
});

test('late auth cleanup cannot delete a replacement token for the same station and computer', async () => {
  const profile = { id: connectionId(url, device.deviceId), hubUrl: url, deviceId: device.deviceId, deviceName: device.name, pairedAt: 1 };
  const oldToken = 'a'.repeat(64);
  const replacement = 'c'.repeat(64);
  await saveConnection(profile, oldToken);
  // A QR claim can replace the credential while an earlier devices request is
  // still unwinding. Cleanup must be conditional on the credential that failed.
  await saveConnection(profile, replacement);
  const connections = await forgetConnection(profile, oldToken);
  expect(connections).toEqual([profile]);
  expect(await connectionToken(profile)).toBe(replacement);
  expect(await loadConnections()).toEqual([profile]);
});

function stationTransport(calls: Array<{ url: string; init: Record<string, unknown> }>) {
  return (async (endpoint: string, init: Record<string, unknown>) => {
    calls.push({ url: endpoint, init });
    if (endpoint.endsWith('/ping')) return response(discovery);
    if (endpoint.endsWith('/app/pair/qr')) return response({ pair_token: token, device });
    if (endpoint.endsWith('/app/devices')) return response({ devices: [device] });
    if (endpoint.includes('/app/events')) return response({ events: [], nextSeq: 0, lastSeq: 0, hasMore: false });
    if (endpoint.endsWith('/app/commands')) {
      const session = { sessionKey: 'codex:one', tool: 'codex', client: 'Codex', title: 'Original', cwd: '/fixture', updatedAt: 1, status: 'idle', controllable: true };
      const command = JSON.parse(String(init.body)).command;
      return response({ ok: true, result: command.type === 'session.open' ? { session, events: [] } : { sessions: [session] } });
    }
    // Hold SSE open until the fixture aborts it; no test timer/retry loops.
    const signal = init.signal as AbortSignal;
    return new Promise<Awaited<ReturnType<FetchLike>>>((_resolve, reject) => { if (signal.aborted) reject(new Error('aborted')); else signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
  }) as FetchLike;
}

test('new pairing works with an empty API manager, survives boot and station switches clear cached sessions', async () => {
  const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
  setHubFetch(stationTransport(calls));
  await bootRemote([]);
  expect(getRemoteState().phase).toBe('setup');
  expect(() => parseRemoteQr(JSON.stringify(qr()))).toThrow('先输入');
  await connectStation(origin);
  expect(getRemoteState()).toMatchObject({ phase: 'pairing', selectedHubUrl: url });
  expect(calls.every((item) => !Object.prototype.hasOwnProperty.call(item.init.headers, 'Authorization'))).toBe(true);
  await pairRemoteQr(parseRemoteQr(JSON.stringify(qr())));
  const id = getRemoteState().connectionId;
  await loadSessions('pc-1');
  expect(getRemoteState().sessions['pc-1'].list).toHaveLength(1);
  await connectStation('https://other.example');
  expect(getRemoteState()).toMatchObject({ phase: 'pairing', sessions: {}, timelines: {}, approvals: {}, devices: [], connectionId: null });
  expect(getRemoteState().connections).toHaveLength(1);
  await useSavedConnection(id!);
  expect(getRemoteState().connectionId).toBe(id);
  mockSettings.set('remote_station_handover_v1', JSON.stringify({ operationId: '10000000-0000-4000-8000-000000000001', fromConnectionId: id, targetConnectionId: id, deviceId: device.deviceId, createdAt: Date.now() }));
  await signOutRemote();
  expect(mockSettings.has('remote_station_handover_v1')).toBe(false);
  expect(getRemoteState().connections).toHaveLength(1);
  await useSavedConnection(id!);
  resetRemoteForTests();
  await bootRemote([]);
  expect(getRemoteState()).toMatchObject({ phase: 'ready', connectionId: id, selectedHubUrl: url });
  expect(mockGetProviderKey).not.toHaveBeenCalled();
  expect(calls.filter((item) => !item.url.endsWith('/ping') && !item.url.endsWith('/app/pair/qr')).every((item) => !Object.prototype.hasOwnProperty.call(item.init.headers, 'Authorization'))).toBe(true);
});

test('stream sends only pair token, filters other devices and does not retry revoked credentials', async () => {
  const calls: Array<Record<string, unknown>> = [];
  setHubFetch((async (_url, init) => { calls.push(init); return response({ error: 'invalid_pair' }, 403); }) as FetchLike);
  const states: string[] = [];
  const handle = openStream({ hub: { url, pairToken: token, deviceId: 'pc-1' }, onEvent: () => undefined, onDevice: () => undefined, onState: (state) => states.push(state) });
  for (let index = 0; index < 20 && !states.includes('closed'); index += 1) await flush();
  expect(states).toContain('closed');
  expect(calls).toHaveLength(1);
  expect(calls[0].headers).toEqual({ Accept: 'text/event-stream', 'X-Salcara-Pair-Token': token });
  handle.close();
});

test('revoked multi-station credentials are removed from the saved connection index', async () => {
  const other = 'https://other.example/salcara-hub/v1';
  const aToken = 'a'.repeat(64), bToken = 'c'.repeat(64);
  setHubFetch((async (endpoint, init) => {
    if (endpoint.endsWith('/ping')) return response({ ...discovery, capabilities: [...capabilities, 'pair.single-phone.v1'] });
    if (endpoint.endsWith('/app/pair/qr')) {
      const body = JSON.parse(String(init.body)) as { deviceId: string };
      const isB = endpoint.startsWith(other);
      return response({ pair_token: isB ? bToken : aToken, computerId: 'physical-pc', device: { ...device, deviceId: body.deviceId } });
    }
    if (endpoint.endsWith('/app/devices')) {
      if (endpoint.startsWith(origin)) return response({ error: 'revoked' }, 403);
      return response({ devices: [{ ...device, deviceId: 'pc-b', online: true }] });
    }
    return response({ devices: [] });
  }) as FetchLike);
  await bootRemote([]);
  await pairScannedRemoteQr(parseScannedRemoteQr(JSON.stringify({ ...qr(), computerId: 'physical-pc', deviceId: 'pc-a', ticket: 'b'.repeat(64) })));
  const aId = getRemoteState().connectionId!;
  await pairScannedRemoteQr(parseScannedRemoteQr(JSON.stringify({ ...qr(), hubUrl: other, computerId: 'physical-pc', deviceId: 'pc-b', ticket: 'd'.repeat(64) })));
  const bId = getRemoteState().connectionId!;
  await useSavedConnection(aId, true);
  await expect(refreshDevices()).rejects.toThrow('配对凭证');
  expect(getRemoteState().connectionId).toBeNull();
  expect(getRemoteState().connections.map((item) => item.id)).toEqual([bId]);
  expect(mockSecrets.has(`remote-device-${aId}`)).toBe(false);
  expect(mockSecrets.has(`remote-device-${bId}`)).toBe(true);
  resetRemoteForTests();
  await bootRemote([]);
  expect(getRemoteState().connections.map((item) => item.id)).toEqual([bId]);
});

test('restoring pairing in the main app is local-only; opening remote workspace uses short requests, never SSE', async () => {
  const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
  setHubFetch(stationTransport(calls));
  await bootRemote([]); await connectStation(origin); await pairRemoteQr(parseRemoteQr(JSON.stringify(qr())));
  resetRemoteForTests(); calls.length = 0;
  await bootRemote([]); setRemoteForeground(true);
  expect(getRemoteState()).toMatchObject({ phase: 'ready', connection: 'idle' });
  expect(calls).toHaveLength(0);
  setRemoteScreenOpen(true);
  await flush(); await flush();
  expect(calls.some((call) => call.url.endsWith('/app/devices'))).toBe(true);
  expect(calls.some((call) => call.url.includes('/app/stream'))).toBe(false);
  setRemoteScreenOpen(false);
  const count = calls.length;
  setRemoteForeground(true); await flush();
  expect(calls).toHaveLength(count);
});

test('switching stations discards a late sessions reply from the previous computer connection', async () => {
  const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
  const base = stationTransport(calls);
  let finish: ((value: Awaited<ReturnType<FetchLike>>) => void) | undefined;
  setHubFetch((async (endpoint, init) => endpoint.endsWith('/app/commands') ? new Promise((resolve) => { finish = resolve; }) : base(endpoint, init)) as FetchLike);
  await bootRemote([]); await connectStation(origin); await pairRemoteQr(parseRemoteQr(JSON.stringify(qr())));
  const oldRequest = loadSessions('pc-1');
  await connectStation('https://next.example');
  finish!(response({ ok: true, result: { sessions: [{ sessionKey: 'old-secret' }] } }));
  await oldRequest;
  expect(getRemoteState()).toMatchObject({ selectedHubUrl: 'https://next.example/salcara-hub/v1', sessions: {}, timelines: {}, approvals: {}, devices: [] });
});

test('a discovery/network failure stays visibly disconnected while preserving saved pairing', async () => {
  const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
  setHubFetch(stationTransport(calls));
  await bootRemote([]); await connectStation(origin); await pairRemoteQr(parseRemoteQr(JSON.stringify(qr())));
  const id = getRemoteState().connectionId!;
  setHubFetch((async () => { throw new Error('offline'); }) as FetchLike);
  await expect(useSavedConnection(id)).rejects.toThrow('连不上');
  expect(getRemoteState()).toMatchObject({ connection: 'error', devicesLoaded: true, devices: [], sessions: {} });
  expect(getRemoteState().connectionError).toContain('连不上');
  expect(getRemoteState().connections).toHaveLength(1);
  expect(mockSecrets.size).toBe(1);
});

test('continuing a thread sends one CLI turn with phone-chosen model/effort and shows the message right away', async () => {
  const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
  const base = stationTransport(calls);
  const commands: Array<Record<string, unknown>> = [];
  setHubFetch((async (endpoint, init) => {
    if (endpoint.endsWith('/app/commands')) {
      const body = JSON.parse(String(init.body));
      commands.push(body);
      if (body.command.type === 'session.send') return response({ ok: true, result: {} });
    }
    return base(endpoint, init);
  }) as FetchLike);
  await bootRemote([]); await connectStation(origin); await pairRemoteQr(parseRemoteQr(JSON.stringify(qr())));
  await loadSessions('pc-1');
  await sendToSession('pc-1', 'codex:one', 'fix the tests', { model: 'gpt-5-codex', effort: 'high' });
  const sent = commands.find((item) => (item.command as { type: string }).type === 'session.send')!;
  expect(sent.command).toEqual({ type: 'session.send', sessionKey: 'codex:one', text: 'fix the tests', controlSurface: 'cli', model: 'gpt-5-codex', effort: 'high', operationId: expect.stringMatching(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/) });
  expect(getRemoteState().timelines[timelineKey('pc-1', 'codex:one')].items).toEqual([expect.objectContaining({ kind: 'message', role: 'user', text: 'fix the tests', local: true })]);
});

test('a rejected send removes the optimistic message', async () => {
  const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
  const base = stationTransport(calls);
  setHubFetch((async (endpoint, init) => {
    if (endpoint.endsWith('/app/commands') && JSON.parse(String(init.body)).command.type === 'session.send') return response({ ok: false, error: '这个会话正在电脑上运行，结束后才能继续' });
    return base(endpoint, init);
  }) as FetchLike);
  await bootRemote([]); await connectStation(origin); await pairRemoteQr(parseRemoteQr(JSON.stringify(qr())));
  await expect(sendToSession('pc-1', 'codex:one', 'too early')).rejects.toThrow('正在电脑上运行');
  expect(getRemoteState().timelines[timelineKey('pc-1', 'codex:one')].items).toEqual([]);
});

test('agent status keeps only labels and opaque API handles; choosing an API sends the handle only', async () => {
  const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
  const base = stationTransport(calls);
  const commands: Array<Record<string, unknown>> = [];
  const status = (source: string) => ({ agents: [
    { id: 'codex', available: true, api: { name: 'Main', model: 'gpt-5', protocol: 'responses', configured: true, pending: false, source, accountId: 'api_0123456789abcdef', key: 'sk-secret', baseUrl: 'https://private.example' } },
    { id: 'claude', available: false, api: { source: 'tool' } },
  ], apis: [{ id: 'api_0123456789abcdef', name: 'Main', models: ['gpt-5', 'https://leak.example'], key: 'sk-secret' }, { id: 'raw-vault-id', name: 'bad' }] });
  setHubFetch((async (endpoint, init) => {
    if (endpoint.endsWith('/app/commands')) {
      const body = JSON.parse(String(init.body)); commands.push(body);
      return response({ ok: true, result: status(body.command.type === 'agents.api.set' ? 'phone' : 'computer') });
    }
    return base(endpoint, init);
  }) as FetchLike);
  await bootRemote([]); await connectStation(origin); await pairRemoteQr(parseRemoteQr(JSON.stringify(qr())));
  await loadAgentProfiles('pc-1');
  const entry = getRemoteState().agents['pc-1'];
  expect(entry.list.map((item) => item.id)).toEqual(['codex', 'claude-desktop', 'claude']);
  expect(entry.list[0].api).toEqual({ name: 'Main', model: 'gpt-5', protocol: 'responses', configured: true, pending: false, source: 'computer', accountId: 'api_0123456789abcdef' });
  expect(entry.apis).toEqual([{ id: 'api_0123456789abcdef', name: 'Main', models: ['gpt-5'] }]);
  expect(JSON.stringify(getRemoteState())).not.toContain('sk-secret');
  await setAgentApi('pc-1', 'codex', 'api_0123456789abcdef', 'gpt-5');
  expect(commands[commands.length - 1].command).toEqual({ type: 'agents.api.set', agent: 'codex', accountId: 'api_0123456789abcdef', model: 'gpt-5' });
  expect(getRemoteState().agents['pc-1'].list[0].api.source).toBe('phone');
});

test('live sync starts at the newest event and long-polls only when the station supports it', async () => {
  const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
  const base = stationTransport(calls);
  let waitSupported = false;
  setHubFetch((async (endpoint, init) => {
    if (endpoint.endsWith('/ping')) { calls.push({ url: endpoint, init }); return response({ ...discovery, capabilities: [...capabilities, ...(waitSupported ? ['events.wait.v1'] : [])] }); }
    if (endpoint.includes('/app/events')) {
      calls.push({ url: endpoint, init });
      if (endpoint.endsWith('limit=1')) return response({ events: [], nextSeq: 0, lastSeq: 41 });
      return response({ events: [{ seq: 42, type: 'message', deviceId: 'pc-1', sessionKey: 'codex:one', tool: 'codex', ts: 1, id: 'm', role: 'assistant', text: 'hi', final: false }], nextSeq: 42, lastSeq: 42 });
    }
    return base(endpoint, init);
  }) as FetchLike);
  await bootRemote([]); await connectStation(origin); await pairRemoteQr(parseRemoteQr(JSON.stringify(qr())));
  await syncSessionEvents('pc-1', 'codex:one', 20);
  const reads = calls.filter((item) => item.url.includes('/app/events'));
  expect(reads[0].url).toContain('after=0&limit=1');
  expect(reads[1].url).toContain('after=41');
  expect(reads[1].url).not.toContain('wait=');
  expect(getRemoteState().timelines[timelineKey('pc-1', 'codex:one')].items[0]).toMatchObject({ text: 'hi', final: false });
  waitSupported = true;
  resetRemoteForTests(); calls.length = 0;
  await bootRemote([]); await connectStation(origin); await pairRemoteQr(parseRemoteQr(JSON.stringify(qr())));
  await syncSessionEvents('pc-1', 'codex:one', 20);
  expect(calls.filter((item) => item.url.includes('/app/events'))[1].url).toContain('wait=20');
});

test('opening checks session identity and excludes other device/session history', async () => {
  const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
  const base = stationTransport(calls);
  let mismatch = false;
  const session = { sessionKey: 'codex:one', tool: 'codex', client: 'Codex App', title: 'Original', cwd: '/fixture', updatedAt: 1, status: 'idle', controllable: true, controlSurface: 'cli' };
  const event = (deviceId: string, sessionKey: string, text: string) => ({ type: 'message', deviceId, sessionKey, tool: 'codex', ts: 1, id: text, role: 'assistant', text, final: true });
  setHubFetch((async (endpoint, init) => {
    if (endpoint.endsWith('/app/commands')) {
      calls.push({ url: endpoint, init });
      const type = JSON.parse(String(init.body)).command.type;
      return response({ ok: true, result: type === 'sessions.list' ? { sessions: [session] } : { session: { ...session, sessionKey: mismatch ? 'codex:other' : session.sessionKey }, events: [
        event('pc-1', 'codex:one', 'own'), event('pc-2', 'codex:one', 'other device'), event('pc-1', 'codex:other', 'other session'),
        { type: 'session.updated', deviceId: 'pc-1', sessionKey: 'codex:one', session: { ...session, sessionKey: 'codex:other' } },
      ] } });
    }
    return base(endpoint, init);
  }) as FetchLike);
  await bootRemote([]); await connectStation(origin); await pairRemoteQr(parseRemoteQr(JSON.stringify(qr())));
  await loadSessions('pc-1'); await openSession('pc-1', 'codex:one');
  const key = timelineKey('pc-1', 'codex:one');
  expect(getRemoteState().timelines[key].items).toHaveLength(1);
  expect(getRemoteState().timelines[key].items[0]).toMatchObject({ text: 'own' });
  mismatch = true;
  await expect(openSession('pc-1', 'codex:one')).rejects.toThrow('身份不一致');
  expect(getRemoteState().timelines[key].items).toHaveLength(1);
});

test.each(['success', 'no-capability', 'bad-receipt', 'busy'] as const)('offline A uses the same UUID through paired B standby: %s', async (scenario) => {
  const other = 'https://backup.example/salcara-hub/v1';
  let broken = false, activeB = false;
  const attempts: Array<{ station: string; operationId?: string; requestId?: string; type?: string }> = [];
  setHubFetch((async (endpoint, init) => {
    const isB = endpoint.startsWith(other);
    if (endpoint.endsWith('/ping')) return response({ ...discovery, capabilities: [...capabilities, 'pair.single-phone.v1', 'commands.idempotency.v1', ...(scenario === 'no-capability' ? [] : ['station.standby.v1'])] });
    if (endpoint.endsWith('/app/pair/qr')) {
      const body = JSON.parse(String(init.body));
      return response({ pair_token: isB ? 'c'.repeat(64) : token, computerId: 'physical-pc', device: { ...device, deviceId: body.deviceId } });
    }
    if (endpoint.endsWith('/app/devices')) return response({ devices: [{ ...device, deviceId: isB ? 'pc-b' : 'pc-1', online: isB ? activeB : !broken }] });
    if (endpoint.endsWith('/app/commands')) {
      const body = JSON.parse(String(init.body));
      const cmd = body.command;
      attempts.push({ station: isB ? 'B' : 'A', operationId: cmd.operationId, requestId: body.requestId, type: cmd.type });
      if (cmd.type === 'remote.station.switch' && broken && !isB) {
        if (scenario === 'busy') return response({ ok: false, error: 'Agent 正在处理任务' });
        throw new Error('synthetic source offline');
      }
      if (cmd.type === 'remote.station.switch' && broken && isB) {
        const payloadHash = createHash('sha256').update([cmd.targetHubUrl, cmd.targetDeviceId, cmd.targetComputerId, cmd.agent ?? '', cmd.accountId ?? '', cmd.model ?? '', cmd.sessionKey ?? ''].join('\u0000')).digest('hex');
        activeB = scenario === 'success';
        return response({ ok: true, result: { switched: true, operationId: cmd.operationId, payloadHash: scenario === 'bad-receipt' ? 'f'.repeat(64) : payloadHash } });
      }
      return response({ ok: true, result: {} });
    }
    if (endpoint.includes('/app/events')) return response({ events: [], nextSeq: 0, lastSeq: 0, hasMore: false });
    throw new Error('unexpected synthetic endpoint');
  }) as FetchLike);
  await bootRemote([]);
  await pairScannedRemoteQr(parseScannedRemoteQr(JSON.stringify({ ...qr(), computerId: 'physical-pc' })));
  const aId = getRemoteState().connectionId!;
  await pairScannedRemoteQr(parseScannedRemoteQr(JSON.stringify({ ...qr(), hubUrl: other, deviceId: 'pc-b', computerId: 'physical-pc' })));
  const bId = getRemoteState().connectionId!;
  await useSavedConnection(aId);
  attempts.length = 0; broken = true;
  if (scenario === 'success') {
    await useSavedConnection(bId);
    expect(getRemoteState().connectionId).toBe(bId);
    const writes = attempts.filter(item => item.type === 'remote.station.switch');
    expect(writes.map(item => item.station)).toEqual(['A', 'B']);
    expect(writes[1].operationId).toBe(writes[0].operationId);
    expect(writes[1].requestId).toBe(writes[0].requestId);
    expect(mockSettings.get('remote_station_handover_v1')).toBeUndefined();
  } else {
    await expect(useSavedConnection(bId)).rejects.toThrow(scenario === 'no-capability' ? '备用切换' : scenario === 'busy' ? '正在处理任务' : '回执不匹配');
    expect(getRemoteState().connectionId).toBe(aId);
    if (scenario !== 'bad-receipt') expect(attempts.some(item => item.station === 'B' && item.type === 'remote.station.switch')).toBe(false);
  }
});
