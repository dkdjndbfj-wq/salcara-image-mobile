import { setHubFetch, type AgentCapabilities, type FetchLike, type PermissionMode, type SessionInfo } from '../remote/client';
import { pendingDelivery, resetDeliveryForTests } from '../remote/delivery';
import { decodeNewTask, encodeNewTask } from '../remote/new-task';
import { parseAgentStatus } from '../remote/projection';
import { applyEvent, bootRemote, connectStation, getRemoteState, loadAgentProfiles, pairRemoteQr, parseRemoteQr, remoteDeliveryScope,
  resetRemoteForTests, retryNewSession, sendToSession, startSession } from '../remote/store';

const mockSettings = new Map<string, string>(), mockSecrets = new Map<string, string>();
jest.mock('../storage/database', () => ({ getSetting: async (key: string) => mockSettings.get(key) ?? null,
  setSetting: async (key: string, value: string) => { mockSettings.set(key, value); } }));
jest.mock('../storage/secure-keys', () => ({ getProviderKey: async () => null }));
jest.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'fixture', getItemAsync: async (key: string) => mockSecrets.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { mockSecrets.set(key, value); }, deleteItemAsync: async (key: string) => { mockSecrets.delete(key); } }));
jest.mock('expo-crypto', () => ({ randomUUID: () => require('node:crypto').randomUUID() }));

const modes: PermissionMode[] = ['ask', 'auto_review', 'full_access'];
const capabilities: AgentCapabilities = { list: true, read: true, send: true, interrupt: true, approval: true, questions: true,
  subagents: true, attachments: true, imageInput: true, imageOutput: true, modelOverride: true, continue: true, permissionModes: modes };
const key = 'codex:11111111-2222-4333-8444-555555555555';
const origin = 'https://permission-fixture.example';
const device = { deviceId: 'pc', name: 'Fixture', os: 'windows', tools: [], projects: [], online: true, lastSeen: 1 };
const reply = (value: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });
let rawCaps: unknown, policy: unknown, lose: string | undefined;
const writes: Array<{ requestId: string; command: Record<string, unknown> }> = [];
async function pair() {
  await bootRemote([]); await connectStation(origin);
  await pairRemoteQr(parseRemoteQr(JSON.stringify({ type: 'salcara-remote-pair', version: 1, hubUrl: `${origin}/salcara-hub/v1`,
    deviceId: 'pc', deviceName: 'Fixture', ticket: 'b'.repeat(64), expiresAt: Date.now() + 120000 })));
  await loadAgentProfiles('pc');
}
beforeEach(() => {
  resetRemoteForTests(); mockSettings.clear(); mockSecrets.clear(); writes.length = 0; rawCaps = capabilities; policy = { autoAll: true }; lose = undefined;
  const transport: FetchLike = async (endpoint, init) => {
    if (endpoint.endsWith('/ping')) return reply({ service: 'salcara-hub', protocol: 'salcara-remote', protocolVersion: 1,
      authModes: ['device-pairing'], capabilities: ['device.identity.v1', 'pair.qr.v1', 'session.remote.v1', 'pair.revoke.v1', 'commands.idempotency.v1'] });
    if (endpoint.endsWith('/app/pair/qr')) return reply({ pair_token: 'a'.repeat(64), device });
    if (endpoint.endsWith('/app/devices')) return reply({ devices: [device] });
    if (!endpoint.endsWith('/app/commands')) throw new Error('Unexpected fixture endpoint');
    const body = JSON.parse(String(init.body));
    if (body.command.type === 'agents.status') return reply({ ok: true, result: { policy, agents: [{ id: 'codex', available: true, remoteSendSupported: true,
      capabilities: rawCaps, api: { configured: true, source: 'computer', name: 'Fixture', model: 'gpt-fixture', accountId: 'api_aaaaaaaa' } },
      { id: 'claude', available: true, remoteSendSupported: true, capabilities, api: { configured: false, source: 'tool' } }] } });
    writes.push(body);
    if (lose === body.command.type) { lose = undefined; throw new Error('Synthetic lost acknowledgement'); }
    const result = body.command.type === 'session.start' ? { sessionKey: key } : body.command.type === 'session.continue'
      ? { accepted: true, sessionKey: key, previousTurnId: body.command.expectedTurnId, operationId: body.command.operationId } : {};
    return reply({ ok: true, result });
  };
  setHubFetch(transport);
});
afterEach(() => { resetRemoteForTests(); setHubFetch(null); });

test.each(modes)('%s is frozen in start/send/continue payloads without changing the previous session', async permissionMode => {
  await pair();
  await startSession('pc', { tool: 'codex', cwd: 'C:\\Fixture', prompt: 'new', approval: 'ask', permissionMode });
  await sendToSession('pc', key, 'send', { permissionMode });
  await sendToSession('pc', key, 'continue', { permissionMode, control: 'continue', expectedTurnId: 'turn-1', surface: 'cli' });
  expect(writes.map(row => row.command.type)).toEqual(['session.start', 'session.send', 'session.continue']);
  expect(writes.map(row => row.command.permissionMode)).toEqual([permissionMode, permissionMode, permissionMode]);
  expect(getRemoteState().timelines[`pc|${key}`].session?.permissionMode).toBeUndefined();
});

test.each([undefined, {}, { autoAll: false }])('unknown or denied full access does not emit a command: %j', async value => {
  policy = value; await pair();
  await expect(sendToSession('pc', key, 'no', { permissionMode: 'full_access' })).rejects.toMatchObject({ code: 'permission_mode_forbidden' });
  expect(writes).toEqual([]);
});

test('old/unsupported hosts and native desktop cannot silently ignore a selected permission mode', async () => {
  rawCaps = { ...capabilities, permissionModes: undefined }; await pair();
  await expect(sendToSession('pc', key, 'no', { permissionMode: 'ask' })).rejects.toMatchObject({ code: 'permission_mode_unavailable' });
  rawCaps = capabilities; await loadAgentProfiles('pc');
  await expect(sendToSession('pc', key, 'no', { permissionMode: 'ask', surface: 'desktop' })).rejects.toMatchObject({ code: 'permission_mode_unavailable' });
  await expect(sendToSession('pc', 'claude:fixture', 'no', { permissionMode: 'auto_review' })).rejects.toMatchObject({ code: 'permission_mode_unavailable' });
  expect(writes).toEqual([]);
});

test('an untouched old conversation omits permissionMode and a cleared host confirmation removes the label', async () => {
  await pair(); await sendToSession('pc', key, 'legacy'); expect(writes[0].command).not.toHaveProperty('permissionMode');
  const old: SessionInfo = { sessionKey: key, tool: 'codex', client: 'Codex', title: 'Fixture', cwd: 'C:\\Fixture', updatedAt: 1,
    status: 'idle', controllable: true, permissionMode: 'full_access' };
  const { permissionMode: _mode, ...cleared } = old;
  expect(applyEvent({ items: [], loading: false, session: old }, { type: 'session.updated', deviceId: 'pc', sessionKey: key, tool: 'codex', ts: 2,
    session: { ...cleared, updatedAt: 2 } }).session?.permissionMode).toBeUndefined();
});

test('a receipt survives restart and retries the exact original permission, not the new picker value', async () => {
  await pair(); lose = 'session.send';
  await expect(sendToSession('pc', key, 'frozen', { permissionMode: 'auto_review' })).rejects.toMatchObject({ retryable: true });
  const pending = await pendingDelivery(remoteDeliveryScope(), 'pc', key); resetDeliveryForTests();
  expect((await pendingDelivery(remoteDeliveryScope(), 'pc', key))?.sendOptions?.permissionMode).toBe('auto_review');
  await sendToSession('pc', key, 'frozen', { retryRequestId: pending!.requestId, permissionMode: 'full_access' });
  expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
});

test('a lost new-task receipt keeps its original permission through restart and retry', async () => {
  await pair(); lose = 'session.start';
  await expect(startSession('pc', { tool: 'codex', cwd: 'C:\\Fixture', prompt: 'new', approval: 'ask', permissionMode: 'auto_review' })).rejects.toMatchObject({ retryable: true });
  const original = writes[0]; resetDeliveryForTests();
  await retryNewSession('pc', 'codex', false, original.requestId);
  expect(writes).toHaveLength(2); expect(writes[1]).toEqual(original);
});

test('caller mutation after dispatch starts cannot change the frozen permission', async () => {
  await pair(); const options = { permissionMode: 'ask' as PermissionMode };
  const sent = sendToSession('pc', key, 'frozen', options); options.permissionMode = 'full_access'; await sent;
  expect(writes[0].command.permissionMode).toBe('ask');
});

test('capability parsing drops unrecognized modes and unknown policy never grants full access', () => {
  const status = parseAgentStatus({ agents: [{ id: 'codex', available: true, capabilities: { ...capabilities, permissionModes: ['ask', 'auto_review', 'invented', 'ask'] } }] });
  expect(status.agents[0].capabilities?.permissionModes).toEqual(['ask', 'auto_review']); expect(status.autoAll).toBe(false);
  expect(() => encodeNewTask({ version: 1, tool: 'claude', cwd: 'C:\\Fixture', prompt: 'no', approval: 'ask', permissionMode: 'auto_review', images: [] })).toThrow();
  const encoded = encodeNewTask({ version: 1, tool: 'codex', cwd: 'C:\\Fixture', prompt: 'yes', approval: 'ask', permissionMode: 'ask', images: [] });
  expect(decodeNewTask(encoded).permissionMode).toBe('ask');
});
