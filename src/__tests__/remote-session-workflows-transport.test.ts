import { setHubFetch, type FetchLike } from '../remote/client';
import { applySessionWorkflow, bootRemote, connectStation, loadAgentProfiles, pairRemoteQr, parseRemoteQr, readSessionWorkflows, resetRemoteForTests } from '../remote/store';
const mockSettings = new Map<string, string>(), mockSecrets = new Map<string, string>();
let mockUuid = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `0199bbb1-1234-4678-9abc-${String(++mockUuid).padStart(12, '0')}` }));
jest.mock('../storage/database', () => ({ getSetting: async (key: string) => mockSettings.get(key) ?? null,
  setSetting: async (key: string, value: string | null) => { if (value === null) mockSettings.delete(key); else mockSettings.set(key, value); } }));
jest.mock('../storage/secure-keys', () => ({ getProviderKey: async () => null }));
jest.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'this-device-only', getItemAsync: async (key: string) => mockSecrets.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { mockSecrets.set(key, value); }, deleteItemAsync: async (key: string) => { mockSecrets.delete(key); } }));
const origin = 'https://workflows-fixture.example', hubUrl = `${origin}/salcara-hub/v1`, sessionKey = 'codex:s';
const device = { deviceId: 'pc', name: 'Fixture', os: 'windows', tools: [], projects: [], online: true, lastSeen: 1 };
const catalog = () => ({ sessionKey, revision: 'runtime-1', canReview: true, goalSupported: true, goalActions: ['set'] });
const response = (value: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
let commands: Record<string, unknown>[], account: string, support: boolean, workflowCap: boolean;
let handle: (input: Record<string, unknown>) => unknown | Promise<unknown>;
async function pair() {
  await bootRemote([]); await connectStation(origin);
  await pairRemoteQr(parseRemoteQr(JSON.stringify({ type: 'salcara-remote-pair', version: 1, hubUrl, deviceId: 'pc', deviceName: 'Fixture', ticket: 'b'.repeat(64), expiresAt: Date.now() + 120000 })));
  await loadAgentProfiles('pc');
}
beforeEach(() => {
  resetRemoteForTests(); mockSettings.clear(); mockSecrets.clear(); mockUuid = 0; commands = []; account = 'api_aaaaaaaa'; support = true; workflowCap = true;
  handle = () => ({ ok: true, result: catalog() });
  setHubFetch((async (endpoint, init) => {
    if (endpoint.endsWith('/ping')) return response({ service: 'salcara-hub', protocol: 'salcara-remote', protocolVersion: 1, authModes: ['device-pairing'], capabilities: ['device.identity.v1', 'pair.qr.v1', 'pair.revoke.v1', 'session.remote.v1', 'commands.idempotency.v1', ...(support ? ['session.workflows.v1'] : [])] });
    if (endpoint.endsWith('/app/pair/qr')) return response({ pair_token: 'a'.repeat(64), device });
    if (endpoint.endsWith('/app/devices')) return response({ devices: [device] });
    if (endpoint.endsWith('/app/commands')) {
      const input = JSON.parse(String(init.body)).command; commands.push(input);
      if (input.type === 'agents.status') return response({ ok: true, result: { agents: [{ id: 'codex', tool: 'codex', available: true,
        capabilities: { read: true, list: true, send: true, sessionWorkflows: workflowCap }, execution: { tool: 'codex', controlSurface: 'cli' }, api: { source: 'computer', configured: true, accountId: account } }] } });
      return response(await handle(input));
    }
    return response({ events: [], nextSeq: 0, lastSeq: 0, hasMore: false });
  }) as FetchLike);
});
afterEach(() => { resetRemoteForTests(); setHubFetch(null); });
test('repeated review submits one immutable native operation', async () => {
  await pair(); const reading = await readSessionWorkflows('pc', sessionKey), pending = deferred<unknown>(), started = deferred<void>();
  let sent: Record<string, unknown> | undefined;
  handle = input => { sent = input; started.resolve(); return pending.promise; };
  const input = { kind: 'review' as const, target: { type: 'uncommittedChanges' as const } };
  const first = applySessionWorkflow('pc', sessionKey, reading, input), second = applySessionWorkflow('pc', sessionKey, reading, input);
  expect(first).toBe(second); expect(() => applySessionWorkflow('pc', sessionKey, reading, { kind: 'goal.set', objective: 'Finish' })).toThrow('仍在进行');
  await started.promise;
  expect(sent).toMatchObject({ type: 'session.workflow', kind: 'review', accountId: account, expectedRevision: 'runtime-1', controlSurface: 'cli' });
  pending.resolve({ ok: true, result: { sessionKey, operationId: sent!.operationId, kind: 'review', state: 'requested', turnId: 'native-turn' } });
  expect((await first).state).toBe('requested'); expect(commands.filter(item => item.type === 'session.workflow')).toHaveLength(1);
});
test('goal budgets are omitted unless explicitly requested', async () => {
  await pair(); const reading = await readSessionWorkflows('pc', sessionKey); let sent: Record<string, unknown> | undefined;
  handle = input => { sent = input; return { ok: true, result: { sessionKey, operationId: input.operationId, kind: 'goal.set', state: 'completed',
    goal: { threadId: 's', objective: 'Finish', status: 'active', tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 } } }; };
  await applySessionWorkflow('pc', sessionKey, reading, { kind: 'goal.set', objective: 'Finish' });
  expect(sent).not.toHaveProperty('tokenBudget'); expect(commands.some(item => item.type === 'session.send')).toBe(false);
});
test('A-B-A and late API responses cannot act on a former workflow catalog', async () => {
  await pair(); const reading = await readSessionWorkflows('pc', sessionKey), pending = deferred<unknown>(), started = deferred<void>(); let sent: Record<string, unknown> | undefined;
  handle = input => { sent = input; started.resolve(); return pending.promise; };
  const input = { kind: 'review' as const, target: { type: 'uncommittedChanges' as const } }, flight = applySessionWorkflow('pc', sessionKey, reading, input); await started.promise;
  account = 'api_bbbbbbbb'; await loadAgentProfiles('pc'); account = 'api_aaaaaaaa'; await loadAgentProfiles('pc');
  pending.resolve({ ok: true, result: { sessionKey, operationId: sent!.operationId, kind: 'review', state: 'requested', turnId: 'native-turn' } });
  await expect(flight).rejects.toThrow('来源已改变'); expect(() => applySessionWorkflow('pc', sessionKey, reading, input)).toThrow('不能执行');
});
test('unknown acknowledgments cannot be resubmitted with a fresh operation ID', async () => {
  await pair(); const reading = await readSessionWorkflows('pc', sessionKey);
  handle = input => ({ ok: true, result: input.type === 'session.workflow' ? { sessionKey, operationId: input.operationId, kind: 'review', state: 'unconfirmed' } : catalog() });
  const input = { kind: 'review' as const, target: { type: 'uncommittedChanges' as const } };
  expect((await applySessionWorkflow('pc', sessionKey, reading, input)).state).toBe('unconfirmed');
  expect(() => applySessionWorkflow('pc', sessionKey, reading, input)).toThrow('不能执行');
  expect((await readSessionWorkflows('pc', sessionKey)).value).toMatchObject({ canReview: false, goalActions: [] });
  expect(commands.filter(item => item.type === 'session.workflow')).toHaveLength(1);
});
test.each(['hub', 'adapter'])('absent %s capability sends no native commands', async missing => {
  if (missing === 'hub') support = false; else workflowCap = false;
  await pair(); await expect(readSessionWorkflows('pc', sessionKey)).rejects.toThrow(); expect(commands.some(item => item.type === 'session.workflows')).toBe(false);
});
