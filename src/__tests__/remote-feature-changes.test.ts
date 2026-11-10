import { openStream, parseFeatureChange, sessionEventsPage, setHubFetch, type FetchLike } from '../remote/client';
import { AgentFeatureCache } from '../remote/agent-feature-cache';
import { agentFeaturesGeneration, bootRemote, cachedAgentFeatures, connectStation, getRemoteState, listAgentFeatures,
  loadAgentProfiles, onRemoteEvent, openSession, pairRemoteQr, parseRemoteQr, refreshDevices, resetRemoteForTests, sessionCursor, syncSessionEvents, timelineKey } from '../remote/store';

const mockSettings = new Map<string, string>(), mockSecrets = new Map<string, string>();
let mockUuid = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `0199aaa1-1234-4678-9abc-${String(++mockUuid).padStart(12, '0')}` }));
jest.mock('../storage/database', () => ({ getSetting: async (key: string) => mockSettings.get(key) ?? null,
  setSetting: async (key: string, value: string | null) => { if (value === null) mockSettings.delete(key); else mockSettings.set(key, value); } }));
jest.mock('../storage/secure-keys', () => ({ getProviderKey: async () => null }));
jest.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'this-device-only', getItemAsync: async (key: string) => mockSecrets.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { mockSecrets.set(key, value); }, deleteItemAsync: async (key: string) => { mockSecrets.delete(key); } }));

const origin = 'https://feature-fixture.example', hubUrl = `${origin}/salcara-hub/v1`, sessionKey = 'codex:feature-fixture';
const device = { deviceId: 'pc', name: 'Fixture', os: 'windows', tools: [], projects: [], online: true, lastSeen: 1 };
const session = { sessionKey, tool: 'codex', client: 'Codex', title: 'Fixture', cwd: '/project', updatedAt: 1, status: 'idle', controlSurface: 'cli', controllable: true };
const target = { cwd: '/project' }, revision = 'a'.repeat(64);
const catalog = (path = '/old/SKILL.md') => ({ revision, collaborationModes: ['default', 'plan'], skillsSupported: true, skills: [{ name: 'review', path, description: 'Review' }] });
const change = (seq = 10, extra: Record<string, unknown> = {}) => ({ type: 'features.changed', deviceId: 'pc', tool: 'codex', sessionKey: '', seq, ...extra });
// Exact Hub HTTP whitelist: unlike the native SSE record, no sessionKey or ts.
const snapshotChange = (seq = 10, extra: Record<string, unknown> = {}) => ({ type: 'features.changed', deviceId: 'pc', tool: 'codex', seq, ...extra });
const page = (extra: Record<string, unknown> = {}) => ({ events: [], nextSeq: 0, lastSeq: 0, hasMore: false, ...extra });
const response = (value: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
let eventHandler: (url: URL) => unknown | Promise<unknown>;
let commandHandler: (input: Record<string, unknown>) => unknown | Promise<unknown>;
let commands: Record<string, unknown>[];
const defaultCommand = (input: Record<string, unknown>): unknown => {
  if (input.type === 'agents.status') return { ok: true, result: { agents: ['codex', 'claude'].map(id => ({ id, tool: id, available: true,
    capabilities: { features: true, read: true, list: true, send: true }, execution: { tool: id, controlSurface: 'cli' }, api: { source: 'tool' } })) } };
  if (input.type === 'features.list') return { ok: true, result: catalog() };
  if (input.type === 'session.open') return { ok: true, result: { session, events: [] } };
  throw new Error(`unexpected fixture command: ${input.type}`);
};
async function pair() {
  await bootRemote([]); await connectStation(origin);
  await pairRemoteQr(parseRemoteQr(JSON.stringify({ type: 'salcara-remote-pair', version: 1, hubUrl, deviceId: 'pc', deviceName: 'Fixture', ticket: 'b'.repeat(64), expiresAt: Date.now() + 120000 })));
  await loadAgentProfiles('pc');
}
beforeEach(() => {
  resetRemoteForTests(); mockSettings.clear(); mockSecrets.clear(); mockUuid = 0; commands = [];
  eventHandler = () => page(); commandHandler = defaultCommand;
  setHubFetch((async (endpoint, init) => {
    if (endpoint.endsWith('/ping')) return response({ service: 'salcara-hub', protocol: 'salcara-remote', protocolVersion: 1, authModes: ['device-pairing'], capabilities: ['device.identity.v1', 'pair.qr.v1', 'pair.revoke.v1', 'session.remote.v1', 'events.wait.v1'] });
    if (endpoint.endsWith('/app/pair/qr')) return response({ pair_token: 'a'.repeat(64), device });
    if (endpoint.endsWith('/app/devices')) return response({ devices: [device] });
    if (endpoint.endsWith('/app/commands')) { const input = JSON.parse(String(init.body)).command; commands.push(input); return response(await commandHandler(input)); }
    return response(await eventHandler(new URL(endpoint)));
  }) as FetchLike);
});
afterEach(() => { resetRemoteForTests(); setHubFetch(null); });

test.each([
  { seq: 0 }, { seq: -1 }, { seq: 1.2 }, { seq: Number.MAX_SAFE_INTEGER + 1 }, { seq: '10' }, { seq: null },
  { sessionKey: 'codex:other' }, { sessionKey: undefined }, { deviceId: 'other' }, { tool: 'bad:tool' },
  { type: 'message' }, { text: 'payload' }, { role: 'user' }, { skills: [] }, { ts: -1 }, { ts: 'today' },
])('feature control rejects malformed or non-pure data: %j', extra => {
  expect(parseFeatureChange(change(10, extra), 'pc')).toBeUndefined();
});
test('feature control accepts only a detached minimal record', () => {
  const raw = change(10, { ts: 100 }); const value = parseFeatureChange(raw, 'pc');
  expect(value).toEqual(raw); expect(value).not.toBe(raw);
});
test('the four-field Hub snapshot is normalized but missing session is not accepted on SSE', () => {
  expect(parseFeatureChange(snapshotChange(), 'pc', 'snapshot')).toEqual(change());
  expect(parseFeatureChange(snapshotChange(), 'pc')).toBeUndefined();
  for (const sessionKey of [null, undefined, 'codex:other', ' ']) {
    expect(parseFeatureChange(snapshotChange(10, { sessionKey }), 'pc', 'snapshot')).toBeUndefined();
  }
});

test('feature snapshots never contribute to conversation cursors, including misplaced control rows', async () => {
  eventHandler = () => page({ events: [change(999)], featureChanges: [change(999), change(1000, { text: 'mixed' })] });
  const result = await sessionEventsPage({ url: hubUrl, pairToken: 'a'.repeat(64), deviceId: 'pc' }, 'pc', sessionKey, 4);
  expect(result).toMatchObject({ events: [], nextSeq: 4, lastSeq: 0, featureChanges: [change(999)] });
});
test.each([null, {}, 'invalid', Array.from({ length: 257 }, () => change())])('invalid optional control snapshots do not break legacy event pages', async featureChanges => {
  eventHandler = () => page({ featureChanges });
  expect(await sessionEventsPage({ url: hubUrl, pairToken: 'a'.repeat(64), deviceId: 'pc' }, 'pc', sessionKey)).toMatchObject({ events: [], featureChanges: [] });
});

test('open head invalidates immediately even if the subsequent session snapshot fails', async () => {
  await pair(); await listAgentFeatures('pc', 'codex', target);
  const before = agentFeaturesGeneration('pc', 'codex'), heard = jest.fn(), unsubscribe = onRemoteEvent(heard);
  try {
    eventHandler = () => page({ featureChanges: [snapshotChange()] });
    commandHandler = input => input.type === 'session.open' ? { ok: false, error: 'fixture unavailable' } : defaultCommand(input);
    await expect(openSession('pc', sessionKey)).rejects.toThrow();
    expect(agentFeaturesGeneration('pc', 'codex')).not.toBe(before);
    expect(cachedAgentFeatures('pc', 'codex', target)?.skills[0].path).toBe('/old/SKILL.md');
    expect(heard).not.toHaveBeenCalled(); expect(sessionCursor('pc', sessionKey)).toBe(0);
    expect(Object.keys(getRemoteState().timelines)).toEqual([timelineKey('pc', sessionKey)]);
    expect(getRemoteState().timelines[timelineKey('pc', sessionKey)].items).toEqual([]);
  } finally { unsubscribe(); }
});

test.each(['empty', 'reset', 'gap'] as const)('sync consumes feature snapshots before the %s page branch', async kind => {
  await pair(); await openSession('pc', sessionKey); await listAgentFeatures('pc', 'codex', target);
  const before = agentFeaturesGeneration('pc', 'codex'), claude = agentFeaturesGeneration('pc', 'claude');
  eventHandler = url => url.searchParams.get('limit') === '1' ? page() : page({ featureChanges: [snapshotChange()],
    ...(kind === 'reset' ? { resetRequired: true } : kind === 'gap' ? { events: [{ type: 'notice', deviceId: 'pc', tool: 'codex', sessionKey, ts: 1, seq: 2, level: 'info', text: '[salcara:history-gap:v1]' }], nextSeq: 2, lastSeq: 2 } : {}) });
  await syncSessionEvents('pc', sessionKey);
  expect(agentFeaturesGeneration('pc', 'codex')).not.toBe(before);
  expect(agentFeaturesGeneration('pc', 'claude')).toBe(claude);
  expect(cachedAgentFeatures('pc', 'codex', target)?.skills[0].path).toBe('/old/SKILL.md');
  expect(sessionCursor('pc', sessionKey)).toBe(kind === 'gap' ? 2 : 0);
  await listAgentFeatures('pc', 'codex', target); const refreshed = agentFeaturesGeneration('pc', 'codex');
  await syncSessionEvents('pc', sessionKey);
  expect(agentFeaturesGeneration('pc', 'codex')).toBe(refreshed);
  expect(cachedAgentFeatures('pc', 'codex', target)?.skills).toHaveLength(1);
  expect(commands.filter(input => input.type === 'features.list')).toHaveLength(2);
});

test('unknown agents and malformed controls do not consume watermarks or produce notifications', async () => {
  await pair(); await openSession('pc', sessionKey); await listAgentFeatures('pc', 'codex', target);
  const before = agentFeaturesGeneration('pc', 'codex'), heard = jest.fn(), unsubscribe = onRemoteEvent(heard);
  try {
    eventHandler = () => page({ featureChanges: [change(100, { text: 'mixed' }), change(100, { deviceId: 'other' }), change(100, { tool: 'unknown' }), change(100, { tool: 'codex-desktop' })] });
    await syncSessionEvents('pc', sessionKey);
    expect(agentFeaturesGeneration('pc', 'codex')).toBe(before); expect(cachedAgentFeatures('pc', 'codex', target)).toBeDefined();
    eventHandler = () => page({ featureChanges: [change(1)] }); await syncSessionEvents('pc', sessionKey);
    expect(agentFeaturesGeneration('pc', 'codex')).not.toBe(before); expect(heard).not.toHaveBeenCalled();
  } finally { unsubscribe(); }
});

test('same-device changes for another registered tool leave Codex cache intact', async () => {
  await pair(); await openSession('pc', sessionKey); await listAgentFeatures('pc', 'codex', target);
  const before = agentFeaturesGeneration('pc', 'codex'), claude = agentFeaturesGeneration('pc', 'claude');
  eventHandler = () => page({ featureChanges: [change(10, { tool: 'claude' })] }); await syncSessionEvents('pc', sessionKey);
  expect(agentFeaturesGeneration('pc', 'codex')).toBe(before); expect(agentFeaturesGeneration('pc', 'claude')).not.toBe(claude);
  expect(cachedAgentFeatures('pc', 'codex', target)).toBeDefined();
});

test('a changed signal rejects the old in-flight catalog without overwriting the replacement', async () => {
  await pair(); await openSession('pc', sessionKey);
  const old = deferred<unknown>(), started = deferred<void>();
  commandHandler = input => input.type === 'features.list' ? (started.resolve(), old.promise) : defaultCommand(input);
  const reading = listAgentFeatures('pc', 'codex', target); const rejected = expect(reading).rejects.toThrow('已切换'); await started.promise;
  eventHandler = () => page({ featureChanges: [change()] }); await syncSessionEvents('pc', sessionKey);
  commandHandler = input => input.type === 'features.list' ? { ok: true, result: catalog('/new/SKILL.md') } : defaultCommand(input);
  await listAgentFeatures('pc', 'codex', target);
  old.resolve({ ok: true, result: catalog() }); await rejected;
  expect(cachedAgentFeatures('pc', 'codex', target)?.skills[0].path).toBe('/new/SKILL.md');
});

test('an invalidated cache-hit continuation rejects without discarding a newer same-scope catalog', async () => {
  await pair(); await openSession('pc', sessionKey); await listAgentFeatures('pc', 'codex', target);
  const originalRead = AgentFeatureCache.prototype.read, reached = deferred<void>(), release = deferred<void>();
  const held = jest.spyOn(AgentFeatureCache.prototype, 'read').mockImplementationOnce(async function (this: AgentFeatureCache, ...args) {
    const cached = await originalRead.apply(this, args); reached.resolve(); await release.promise; return cached;
  });
  const old = listAgentFeatures('pc', 'codex', target), rejected = expect(old).rejects.toThrow('已切换');
  try {
    await reached.promise; held.mockRestore();
    eventHandler = () => page({ featureChanges: [change()] }); await syncSessionEvents('pc', sessionKey);
    commandHandler = input => input.type === 'features.list' ? { ok: true, result: catalog('/new/SKILL.md') } : defaultCommand(input);
    await listAgentFeatures('pc', 'codex', target);
  } finally { held.mockRestore(); release.resolve(); }
  await rejected;
  expect(cachedAgentFeatures('pc', 'codex', target)?.skills[0].path).toBe('/new/SKILL.md');
});

test('one tool notification invalidates all its project and session catalogs', async () => {
  await pair(); await openSession('pc', sessionKey);
  const targets = [target, { cwd: '/another-project' }, { sessionKey }];
  for (const scope of targets) await listAgentFeatures('pc', 'codex', scope);
  eventHandler = () => page({ featureChanges: [change()] }); await syncSessionEvents('pc', sessionKey);
  for (const scope of targets) {
    expect(cachedAgentFeatures('pc', 'codex', scope)?.skills[0].path).toBe('/old/SKILL.md');
    await listAgentFeatures('pc', 'codex', scope);
  }
  expect(commands.filter(input => input.type === 'features.list')).toHaveLength(6);
});

test('connection changes fence late snapshots and allow lower seq in a new connection lifetime', async () => {
  await pair(); await openSession('pc', sessionKey);
  eventHandler = () => page({ featureChanges: [change(100)] }); await syncSessionEvents('pc', sessionKey);
  const pending = deferred<unknown>(), started = deferred<void>(); eventHandler = () => (started.resolve(), pending.promise);
  const old = syncSessionEvents('pc', sessionKey); await started.promise;
  const connectionId = getRemoteState().connectionId;
  await connectStation(origin);
  expect(getRemoteState()).toMatchObject({ phase: 'ready', connectionId });
  await refreshDevices();
  await loadAgentProfiles('pc'); const current = agentFeaturesGeneration('pc', 'codex');
  pending.resolve(page({ featureChanges: [change(1000)] })); await old;
  expect(agentFeaturesGeneration('pc', 'codex')).toBe(current);
  eventHandler = () => page({ featureChanges: [change(1)] }); await openSession('pc', sessionKey);
  expect(agentFeaturesGeneration('pc', 'codex')).not.toBe(current);
});

test('legacy event pages retain the cached directory and do not force repeat reads', async () => {
  await pair(); await openSession('pc', sessionKey); await listAgentFeatures('pc', 'codex', target);
  const before = agentFeaturesGeneration('pc', 'codex'); await syncSessionEvents('pc', sessionKey); await listAgentFeatures('pc', 'codex', target);
  expect(agentFeaturesGeneration('pc', 'codex')).toBe(before);
  expect(commands.filter(input => input.type === 'features.list')).toHaveLength(1);
});

test('SSE control callback is isolated, deduplicated and does not skip lower-seq ordinary events', async () => {
  const encoder = new TextEncoder(), changed = jest.fn(), messages = jest.fn(); let closed = false, calls = 0;
  const frames = [change(20), change(20), change(19), change(21, { text: 'mixed' }),
    { type: 'notice', deviceId: 'pc', sessionKey, tool: 'codex', seq: 2, ts: 2, text: 'normal', level: 'info' }];
  setHubFetch((async () => {
    if (++calls > 1) return { ok: false, status: 401, text: async () => '{}' };
    let sent = false;
    return { ok: true, status: 200, headers: { get: () => 'text/event-stream' }, text: async () => '', body: { getReader: () => ({ read: async () => {
      if (sent) return { done: true }; sent = true;
      return { done: false, value: encoder.encode(frames.map(frame => `event: event\ndata: ${JSON.stringify(frame)}\n\n`).join('')) };
    } }) } };
  }) as FetchLike);
  const stream = openStream({ hub: { url: hubUrl, pairToken: 'a'.repeat(64), deviceId: 'pc' }, onEvent: messages, onFeatureChange: changed,
    onDevice: () => undefined, onState: state => { if (state === 'closed') closed = true; }, wait: async () => undefined });
  try {
    for (let i = 0; i < 100 && !closed; i++) await new Promise(resolve => setTimeout(resolve, 0));
    expect(closed).toBe(true); expect(changed).toHaveBeenCalledTimes(1); expect(changed).toHaveBeenCalledWith(change(20));
    expect(messages).toHaveBeenCalledTimes(1); expect(messages.mock.calls[0][0].text).toBe('normal'); expect(stream.lastSeq()).toBe(2);
  } finally { stream.close(); }
});
