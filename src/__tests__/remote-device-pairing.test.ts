import { canonicalHubUrl, readPairQr } from '../remote/pairing';
import { command, confirmQrPair, discoverStation, devices, openStream, setHubFetch, type DeviceStatus, type FetchLike } from '../remote/client';
import { connectionId, connectionToken, deliveryCredentialId, loadConnections, saveConnection } from '../remote/connections';
import { bootRemote, connectStation, getRemoteState, loadAgentProfiles, loadSessions, openSession, pairRemoteQr, parseRemoteQr, resetRemoteForTests, sendToSession, setAgentApi, setRemoteForeground, setRemoteScreenOpen, signOutRemote, syncSessionEvents, timelineKey, useSavedConnection } from '../remote/store';

const mockSettings = new Map<string, string>();
const mockSecrets = new Map<string, string>();
const mockGetProviderKey = jest.fn(async (..._args: unknown[]) => 'never-needed');
jest.mock('../storage/database', () => ({
  getSetting: async (key: string) => mockSettings.get(key) ?? null,
  setSetting: async (key: string, value: string | null) => { if (value === null) mockSettings.delete(key); else mockSettings.set(key, value); },
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

beforeEach(() => { resetRemoteForTests(); mockSettings.clear(); mockSecrets.clear(); mockGetProviderKey.mockClear(); });
afterEach(() => { resetRemoteForTests(); setHubFetch(null); });

test('station address is strict, canonical, credential-free and HTTPS', () => {
  expect(canonicalHubUrl(' HTTPS://Station.Example:443/v1/ ')).toBe(url);
  expect(canonicalHubUrl(url)).toBe(url);
  for (const input of ['http://station.example', 'http://10.0.0.1', 'https://localhost', 'https://192.168.1.1', 'https://127.0.0.1', 'https://[::1]', 'https://[fd00::1]', 'https://u:pass@station.example', `${origin}?`, `${origin}#`, `${origin}?key=secret`, `${origin}/other`, `${origin}/salcara-hub/v1/../other`, `${origin}\\evil`]) expect(() => canonicalHubUrl(input)).toThrow();
  expect(() => canonicalHubUrl('http://127.0.0.1:123')).toThrow();
  expect(canonicalHubUrl('http://127.0.0.1:123', true)).toBe('http://127.0.0.1:123/salcara-hub/v1');
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
  await signOutRemote();
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
  expect(sent.command).toEqual({ type: 'session.send', sessionKey: 'codex:one', text: 'fix the tests', controlSurface: 'cli', model: 'gpt-5-codex', effort: 'high' });
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
