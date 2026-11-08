import { setHubFetch, type AgentCapabilities, type SessionInfo } from '../remote/client';
import { pendingDelivery, resetDeliveryForTests } from '../remote/delivery';
import { bootRemote, connectStation, getRemoteState, loadAgentProfiles, openSession, pairRemoteQr, parseRemoteQr, remoteDeliveryScope,
  resetRemoteForTests, sendToSession, steerSession, timelineKey } from '../remote/store';

const mockSettings = new Map<string, string>(), mockSecrets = new Map<string, string>();
let mockPersistHook: (() => void) | undefined;
jest.mock('../storage/database', () => ({ getSetting: async (key: string) => mockSettings.get(key) ?? null,
  setSetting: async (key: string, value: string) => { mockSettings.set(key, value);
    if (key === 'remote_pending_delivery_v1' && value !== '[]' && mockPersistHook) { const hook = mockPersistHook; mockPersistHook = undefined; hook(); }
  } }));
jest.mock('../storage/secure-keys', () => ({ getProviderKey: async () => null }));
jest.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'fixture', getItemAsync: async (key: string) => mockSecrets.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { mockSecrets.set(key, value); }, deleteItemAsync: async (key: string) => { mockSecrets.delete(key); } }));
jest.mock('expo-crypto', () => ({ randomUUID: () => require('node:crypto').randomUUID() }));

const origin = 'https://steer-fixture.example';
const device = { deviceId: 'pc', name: 'Fixture', os: 'windows', tools: [], projects: [], online: true, lastSeen: 1 };
const caps: AgentCapabilities = { list: true, read: true, send: true, interrupt: true, approval: true, questions: true,
  subagents: true, attachments: true, imageInput: true, imageOutput: true, modelOverride: true, continue: true, steer: true };
const base: SessionInfo = { sessionKey: 'codex:fixture', tool: 'codex', client: 'Codex', title: 'Fixture', cwd: 'C:\\Fixture',
  status: 'running', controllable: true, updatedAt: 1, activeTurnId: 'turn-1', controlSurface: 'cli' };
const reply = (value: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });
let observed: SessionInfo, lose: boolean, supported: boolean, hostSteer: boolean, badAck: boolean;
const writes: Array<{ requestId: string; command: Record<string, unknown> }> = [];
async function setup() {
  await bootRemote([]); await connectStation(origin);
  await pairRemoteQr(parseRemoteQr(JSON.stringify({ type: 'salcara-remote-pair', version: 1, hubUrl: `${origin}/salcara-hub/v1`,
    deviceId: 'pc', deviceName: 'Fixture', ticket: 'b'.repeat(64), expiresAt: Date.now() + 120000 })));
  await loadAgentProfiles('pc'); await openSession('pc', observed.sessionKey);
}
beforeEach(() => {
  resetRemoteForTests(); mockSettings.clear(); mockSecrets.clear(); writes.length = 0; mockPersistHook = undefined;
  lose = badAck = false; supported = hostSteer = true; observed = { ...base };
  setHubFetch(async (endpoint, init) => {
    if (endpoint.endsWith('/ping')) return reply({ service: 'salcara-hub', protocol: 'salcara-remote', protocolVersion: 1, authModes: ['device-pairing'],
      capabilities: ['device.identity.v1', 'pair.qr.v1', 'session.remote.v1', 'pair.revoke.v1', 'commands.idempotency.v1', ...(supported ? ['session.steer.v1'] : [])] });
    if (endpoint.endsWith('/app/pair/qr')) return reply({ pair_token: 'a'.repeat(64), device });
    if (endpoint.endsWith('/app/devices')) return reply({ devices: [device] });
    if (new URL(endpoint).pathname.endsWith('/events')) return reply({ events: [], nextSeq: 0, lastSeq: 0, hasMore: false });
    if (!endpoint.endsWith('/app/commands')) throw new Error('Unexpected fixture endpoint');
    const body = JSON.parse(String(init.body));
    if (body.command.type === 'agents.status') return reply({ ok: true, result: { agents: [{ id: 'codex', available: true, remoteSendSupported: true,
      capabilities: { ...caps, steer: hostSteer }, api: { name: 'Fixture API', model: 'gpt-fixture', protocol: 'openai', configured: true, pending: false, source: 'computer', accountId: 'api_aaaaaaaa' } }] } });
    if (body.command.type === 'session.open') return reply({ ok: true, result: { session: observed, events: [] } });
    writes.push(body);
    if (lose) { lose = false; throw new Error('Synthetic lost acknowledgement'); }
    return reply({ ok: true, result: { accepted: true, sessionKey: body.command.sessionKey, turnId: badAck ? 'wrong-turn' : body.command.expectedTurnId, operationId: body.command.operationId } });
  });
});
afterEach(() => { resetRemoteForTests(); setHubFetch(null); });

test('steer targets the active turn, carries the selected source, and never sends model overrides', async () => {
  await setup(); await steerSession('pc', base.sessionKey, 'focus tests');
  expect(writes).toHaveLength(1);
  expect(writes[0].command).toEqual({ type: 'session.steer', sessionKey: base.sessionKey, text: 'focus tests',
    expectedTurnId: 'turn-1', controlSurface: 'cli', operationId: writes[0].requestId, accountId: 'api_aaaaaaaa' });
  expect(getRemoteState().timelines[timelineKey('pc', base.sessionKey)].items).toEqual([]);
  expect(await pendingDelivery(remoteDeliveryScope(), 'pc', base.sessionKey)).toBeUndefined();
});

test.each(['old-hub', 'unsupported-host', 'idle', 'waiting', 'unowned', 'native'])("%s cannot masquerade as active-turn control", async condition => {
  if (condition === 'old-hub') supported = false;
  if (condition === 'unsupported-host') hostSteer = false;
  if (condition === 'idle') observed = { ...base, status: 'idle', activeTurnId: undefined };
  if (condition === 'waiting') observed = { ...base, status: 'waiting_approval' };
  if (condition === 'unowned') observed = { ...base, controllable: false };
  if (condition === 'native') observed = { ...base, controlSurface: 'desktop' };
  await setup(); await expect(steerSession('pc', base.sessionKey, 'no')).rejects.toThrow();
  expect(writes).toEqual([]);
});

test.each([{ model: 'different' }, { effort: 'high' as const }, { permissionMode: 'ask' as const }, { approval: 'ask' as const }])('steer rejects turn-level options %j', async options => {
  await setup(); await expect(sendToSession('pc', base.sessionKey, 'no', { control: 'steer', expectedTurnId: 'turn-1', ...options })).rejects.toThrow();
  expect(writes).toEqual([]);
});

test('completion during receipt persistence cannot send input to a successor turn', async () => {
  await setup();
  mockPersistHook = () => { getRemoteState().timelines[timelineKey('pc', base.sessionKey)].session = { ...base, activeTurnId: 'turn-2' }; };
  await expect(steerSession('pc', base.sessionKey, 'old target')).rejects.toMatchObject({ code: 'turn_control_stale' });
  expect(writes).toEqual([]);
  expect(await pendingDelivery(remoteDeliveryScope(), 'pc', base.sessionKey)).toBeUndefined();
});

test('lost receipt survives restart and retries exact original target after the turn has finished', async () => {
  await setup(); lose = true;
  await expect(steerSession('pc', base.sessionKey, 'original')).rejects.toMatchObject({ retryable: true });
  const pending = await pendingDelivery(remoteDeliveryScope(), 'pc', base.sessionKey);
  resetDeliveryForTests();
  expect((await pendingDelivery(remoteDeliveryScope(), 'pc', base.sessionKey))?.sendOptions).toMatchObject({ control: 'steer', expectedTurnId: 'turn-1' });
  getRemoteState().timelines[timelineKey('pc', base.sessionKey)].session = { ...base, status: 'idle', activeTurnId: undefined };
  await sendToSession('pc', base.sessionKey, 'original', { retryRequestId: pending!.requestId, model: 'must-not-replace-original', expectedTurnId: 'turn-2' });
  expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
});

test('wrong-turn acknowledgement is uncertain and cannot become a fresh send', async () => {
  await setup(); badAck = true;
  await expect(steerSession('pc', base.sessionKey, 'original')).rejects.toMatchObject({ retryable: false });
  expect((await pendingDelivery(remoteDeliveryScope(), 'pc', base.sessionKey))?.uncertain).toBe(true);
  await expect(sendToSession('pc', base.sessionKey, 'original')).rejects.toThrow(); expect(writes).toHaveLength(1);
});
