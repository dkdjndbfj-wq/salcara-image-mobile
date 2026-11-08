import { setHubFetch, type FetchLike } from '../remote/client';
import { applyEvent, bootRemote, compactSessionContext, connectStation, loadAgentProfiles, pairRemoteQr, parseRemoteQr, readSessionContext, resetRemoteForTests } from '../remote/store';

const mockSettings = new Map<string, string>(), mockSecrets = new Map<string, string>();
let mockUuid = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `0199aaa1-1234-4678-9abc-${String(++mockUuid).padStart(12, '0')}` }));
jest.mock('../storage/database', () => ({ getSetting: async (key: string) => mockSettings.get(key) ?? null,
  setSetting: async (key: string, value: string | null) => { if (value === null) mockSettings.delete(key); else mockSettings.set(key, value); } }));
jest.mock('../storage/secure-keys', () => ({ getProviderKey: async () => null }));
jest.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'this-device-only', getItemAsync: async (key: string) => mockSecrets.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { mockSecrets.set(key, value); }, deleteItemAsync: async (key: string) => { mockSecrets.delete(key); } }));
const origin = 'https://context-fixture.example', hubUrl = `${origin}/salcara-hub/v1`, sessionKey = 'codex:s';
const device = { deviceId: 'pc', name: 'Fixture', os: 'windows', tools: [], projects: [], online: true, lastSeen: 1 };
const context = () => ({ sessionKey, revision: 'runtime-1', canCompact: true });
const response = (value: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
let commands: Record<string, unknown>[], account: string, support: boolean, contextCap: boolean;
let handle: (input: Record<string, unknown>) => unknown | Promise<unknown>;
async function pair() {
  await bootRemote([]); await connectStation(origin);
  await pairRemoteQr(parseRemoteQr(JSON.stringify({ type: 'salcara-remote-pair', version: 1, hubUrl, deviceId: 'pc', deviceName: 'Fixture', ticket: 'b'.repeat(64), expiresAt: Date.now() + 120000 })));
  await loadAgentProfiles('pc');
}
beforeEach(() => {
  resetRemoteForTests(); mockSettings.clear(); mockSecrets.clear(); mockUuid = 0; commands = []; account = 'api_aaaaaaaa'; support = true; contextCap = true;
  handle = input => ({ ok: true, result: input.type === 'session.compact' ? { ...context(), canCompact: false,
    compaction: { operationId: input.operationId, state: 'requested', blocking: true, startedAt: 1, updatedAt: 1 } } : context() });
  setHubFetch((async (endpoint, init) => {
    if (endpoint.endsWith('/ping')) return response({ service: 'salcara-hub', protocol: 'salcara-remote', protocolVersion: 1, authModes: ['device-pairing'], capabilities: ['device.identity.v1', 'pair.qr.v1', 'pair.revoke.v1', 'session.remote.v1', ...(support ? ['session.context.v1'] : [])] });
    if (endpoint.endsWith('/app/pair/qr')) return response({ pair_token: 'a'.repeat(64), device });
    if (endpoint.endsWith('/app/devices')) return response({ devices: [device] });
    if (endpoint.endsWith('/app/commands')) {
      const input = JSON.parse(String(init.body)).command; commands.push(input);
      if (input.type === 'agents.status') return response({ ok: true, result: { agents: [{ id: 'codex', tool: 'codex', available: true,
        capabilities: { read: true, list: true, send: true, context: contextCap, compact: contextCap }, execution: { tool: 'codex', controlSurface: 'cli' }, api: { source: 'computer', configured: true, accountId: account } }] } });
      return response(await handle(input));
    }
    return response({ events: [], nextSeq: 0, lastSeq: 0, hasMore: false });
  }) as FetchLike);
});
afterEach(() => { resetRemoteForTests(); setHubFetch(null); });

test('context read stays source bound and compact uses its exact revision and one operation', async () => {
  await pair(); const reading = await readSessionContext('pc', sessionKey);
  const pending = deferred<unknown>(); const started = deferred<void>(); let compactCommand: Record<string, unknown> | undefined;
  handle = input => { compactCommand = input; started.resolve(); return pending.promise; };
  const first = compactSessionContext('pc', sessionKey, reading), second = compactSessionContext('pc', sessionKey, reading);
  expect(first).toBe(second); await started.promise;
  expect(compactCommand).toMatchObject({ type: 'session.compact', accountId: account, expectedRevision: reading.value.revision, controlSurface: 'cli' });
  pending.resolve({ ok: true, result: { ...context(), canCompact: false, compaction: { operationId: compactCommand!.operationId, state: 'requested', blocking: true, startedAt: 1, updatedAt: 1 } } });
  expect((await first).value.compaction?.state).toBe('requested');
  expect(commands.filter(item => item.type === 'session.compact')).toHaveLength(1);
});
test('late reads and old revision handles cannot cross an account switch', async () => {
  await pair(); const old = await readSessionContext('pc', sessionKey);
  const pending = deferred<unknown>(), started = deferred<void>();
  handle = () => { started.resolve(); return pending.promise; };
  const read = readSessionContext('pc', sessionKey); await started.promise;
  account = 'api_bbbbbbbb'; await loadAgentProfiles('pc');
  pending.resolve({ ok: true, result: context() });
  await expect(read).rejects.toThrow('来源已改变');
  expect(() => compactSessionContext('pc', sessionKey, old)).toThrow('不能压缩');
  expect(commands.filter(item => item.type === 'session.compact')).toHaveLength(0);
});
test.each(['hub', 'adapter'])('missing %s capability fails before a context command', async missing => {
  if (missing === 'hub') support = false; else contextCap = false;
  await pair(); await expect(readSessionContext('pc', sessionKey)).rejects.toThrow();
  expect(commands.filter(item => item.type === 'session.context')).toHaveLength(0);
});
test('returning to A after observed A-B-A does not revive an old compact handle', async () => {
  await pair(); const reading = await readSessionContext('pc', sessionKey);
  account = 'api_bbbbbbbb'; await loadAgentProfiles('pc');
  account = 'api_aaaaaaaa'; await loadAgentProfiles('pc');
  expect(() => compactSessionContext('pc', sessionKey, reading)).toThrow('不能压缩');
  expect(commands.filter(item => item.type === 'session.compact')).toHaveLength(0);
});
test('context notification is only an invalidation hint and never a history bubble', () => {
  const timeline = { items: [], loading: false };
  const event = { type: 'context.updated' as const, deviceId: 'pc', sessionKey, tool: 'codex', seq: 5, ts: 1, context: { ...context(), snapshot: { usedTokens: 999 } } };
  const next = applyEvent(timeline, event);
  expect(next).toEqual({ ...timeline, contextSignal: 5 });
  expect(applyEvent(next, { ...event, seq: 4 })).toBe(next);
});
