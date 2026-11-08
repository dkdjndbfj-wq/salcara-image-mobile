import { setHubFetch, type AgentCapabilities, type AgentProfile, type SessionInfo } from '../remote/client';
import { bootRemote, connectStation, continueSession, getRemoteState, loadAgentProfiles, openSession, pairRemoteQr, parseRemoteQr,
  remoteDeliveryScope, resetRemoteForTests, retryNewSession, newSessionReceiptKey, sendToSession, startSession, timelineKey } from '../remote/store';
import { pendingDelivery } from '../remote/delivery';
import { claudeSessionAdmissionBlocked } from '../remote/turn-control';
import { claudeApiAdmissionReady } from '../remote/api-admission';

const mockSettings = new Map<string, string>();
const mockSecrets = new Map<string, string>();
let mockPersistHook: (() => void) | undefined;
jest.mock('../storage/database', () => ({ getSetting: async (key: string) => mockSettings.get(key) ?? null,
  setSetting: async (key: string, value: string) => {
    mockSettings.set(key, value);
    if (key === 'remote_pending_delivery_v1' && value !== '[]' && mockPersistHook) {
      const hook = mockPersistHook; mockPersistHook = undefined; hook();
    }
  } }));
jest.mock('../storage/secure-keys', () => ({ getProviderKey: async () => null }));
jest.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'fixture', getItemAsync: async (key: string) => mockSecrets.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { mockSecrets.set(key, value); }, deleteItemAsync: async (key: string) => { mockSecrets.delete(key); } }));
jest.mock('expo-crypto', () => ({ randomUUID: () => require('node:crypto').randomUUID() }));

const origin = 'https://claude-session-fixture.example';
const device = { deviceId: 'pc', name: 'Fixture', os: 'windows', tools: [], projects: [], online: true, lastSeen: 1 };
const caps: AgentCapabilities = { list: true, read: true, send: true, interrupt: true, approval: true, questions: true,
  subagents: true, attachments: true, imageInput: true, imageOutput: true, modelOverride: true, continue: true };
const base: SessionInfo = { sessionKey: 'claude:fixture', tool: 'claude', client: 'Claude Code', title: 'Fixture', cwd: 'C:\\Fixture',
  status: 'idle', controllable: true, updatedAt: 1, lastTerminalTurnId: 'finished-turn', controlSurface: 'cli' };
const validApi: AgentProfile['api'] = { name: 'Synthetic API', model: '', protocol: 'anthropic', configured: true,
  pending: false, source: 'computer', accountId: 'api_aaaaaaaa' };
const reply = (value: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });
let observed: SessionInfo, lose: boolean;
const writes: Array<{ requestId: string; command: Record<string, unknown> }> = [];
async function setup() {
  await bootRemote([]); await connectStation(origin);
  await pairRemoteQr(parseRemoteQr(JSON.stringify({ type: 'salcara-remote-pair', version: 1, hubUrl: `${origin}/salcara-hub/v1`,
    deviceId: 'pc', deviceName: 'Fixture', ticket: 'b'.repeat(64), expiresAt: Date.now() + 120000 })));
  await loadAgentProfiles('pc'); await openSession('pc', observed.sessionKey);
}
beforeEach(() => {
  resetRemoteForTests(); mockSettings.clear(); mockSecrets.clear(); writes.length = 0; mockPersistHook = undefined; lose = false; observed = { ...base };
  setHubFetch(async (endpoint, init) => {
    if (endpoint.endsWith('/ping')) return reply({ service: 'salcara-hub', protocol: 'salcara-remote', protocolVersion: 1,
      authModes: ['device-pairing'], capabilities: ['device.identity.v1', 'pair.qr.v1', 'session.remote.v1', 'pair.revoke.v1', 'commands.idempotency.v1'] });
    if (endpoint.endsWith('/app/pair/qr')) return reply({ pair_token: 'a'.repeat(64), device });
    if (endpoint.endsWith('/app/devices')) return reply({ devices: [device] });
    if (new URL(endpoint).pathname.endsWith('/events')) return reply({ events: [], nextSeq: 0, lastSeq: 0, hasMore: false });
    if (!endpoint.endsWith('/app/commands')) throw new Error('Unexpected fixture endpoint');
    const body = JSON.parse(String(init.body));
    if (body.command.type === 'agents.status') return reply({ ok: true, result: { agents: ['claude', 'codex', 'claude-desktop'].map(id => ({ id,
      available: true, remoteSendSupported: true, capabilities: caps, api: { ...validApi } })) } });
    if (body.command.type === 'session.open') return reply({ ok: true, result: { session: observed, events: [] } });
    writes.push(body);
    if (lose) { lose = false; throw new Error('Synthetic lost acknowledgement'); }
    return reply({ ok: true, result: body.command.type === 'session.start' ? { sessionKey: base.sessionKey } : body.command.type === 'session.continue'
      ? { accepted: true, sessionKey: body.command.sessionKey, previousTurnId: body.command.expectedTurnId, operationId: body.command.operationId } : {} });
  });
});
afterEach(() => { resetRemoteForTests(); setHubFetch(null); });

test.each(['unknown', 'idle', 'running', 'failed'] as const)('an uncontrollable Claude %s history cannot admit send or direct continue', async status => {
  observed = { ...base, status, controllable: false }; await setup();
  await expect(sendToSession('pc', base.sessionKey, 'new task')).rejects.toMatchObject({ code: 'external_session_state_unknown' });
  await expect(sendToSession('pc', base.sessionKey, 'continue', { control: 'continue', expectedTurnId: 'finished-turn' })).rejects.toMatchObject({ code: 'external_session_state_unknown' });
  await expect(continueSession('pc', base.sessionKey)).rejects.toThrow();
  expect(writes).toEqual([]);
  expect(await pendingDelivery(remoteDeliveryScope(), 'pc', base.sessionKey)).toBeUndefined();
  expect(getRemoteState().timelines[timelineKey('pc', base.sessionKey)].items).toEqual([]);
});

test('an unknown Claude state cannot acquire admission from an inconsistent true flag', async () => {
  observed = { ...base, status: 'unknown', controllable: true }; await setup();
  await expect(sendToSession('pc', base.sessionKey, 'new task')).rejects.toMatchObject({ code: 'external_session_state_unknown' });
  expect(writes).toEqual([]);
});

test.each(['Claude Code', 'Claude Desktop'])('confirmed idle %s completion remains resumable and continuable', async client => {
  observed = { ...base, client }; await setup();
  await continueSession('pc', base.sessionKey);
  await sendToSession('pc', base.sessionKey, 'next');
  expect(writes.map(row => row.command.type)).toEqual(['session.continue', 'session.send']);
});

test('loss of Claude control while persisting the new receipt is fenced before dispatch', async () => {
  await setup();
  mockPersistHook = () => { getRemoteState().timelines[timelineKey('pc', base.sessionKey)].session = { ...base, updatedAt: 2, status: 'unknown', controllable: false }; };
  await expect(sendToSession('pc', base.sessionKey, 'new task')).rejects.toMatchObject({ code: 'external_session_state_unknown' });
  expect(writes).toEqual([]);
  expect(await pendingDelivery(remoteDeliveryScope(), 'pc', base.sessionKey)).toBeUndefined();
  expect(getRemoteState().timelines[timelineKey('pc', base.sessionKey)].session).toMatchObject({ status: 'unknown', controllable: false });
});

test('an attempted exact UUID may recover its receipt without inventing a fresh Claude command', async () => {
  await setup(); lose = true;
  await expect(sendToSession('pc', base.sessionKey, 'original')).rejects.toMatchObject({ retryable: true });
  const pending = await pendingDelivery(remoteDeliveryScope(), 'pc', base.sessionKey);
  getRemoteState().timelines[timelineKey('pc', base.sessionKey)].session = { ...base, status: 'unknown', controllable: false };
  await sendToSession('pc', base.sessionKey, 'original', { retryRequestId: pending!.requestId });
  expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
  expect(await pendingDelivery(remoteDeliveryScope(), 'pc', base.sessionKey)).toBeUndefined();
});

test('the Claude-only admission rule leaves the Codex native control contract unchanged', () => {
  expect(claudeSessionAdmissionBlocked({ ...base, sessionKey: 'codex:fixture', tool: 'codex', status: 'unknown', controllable: false, controlSurface: 'desktop' })).toBe(false);
  expect(claudeSessionAdmissionBlocked(undefined)).toBe(false);
});

test.each(['Claude Code', 'Claude Desktop'])('%s sends an explicitly negotiated native approval mode on send and continue', async client => {
  observed = { ...base, client }; await setup();
  const status = getRemoteState().agents.pc;
  status.autoAll = true;
  const profile = status.list.find(item => item.id === (client === 'Claude Desktop' ? 'claude-desktop' : 'claude'))!;
  profile.capabilities!.approvalModes = ['ask', 'auto_edits', 'auto_all'];
  await continueSession('pc', base.sessionKey, { approval: 'auto_all' });
  await sendToSession('pc', base.sessionKey, 'next', { approval: 'ask' });
  expect(writes.map(row => row.command.approval)).toEqual(['auto_all', 'ask']);
  expect(writes.every(row => row.command.permissionMode === undefined)).toBe(true);
});

test('old Bridge cannot pretend to apply a Claude next-turn mode or start native bypass', async () => {
  await setup(); getRemoteState().agents.pc.autoAll = true;
  await expect(sendToSession('pc', base.sessionKey, 'draft', { approval: 'ask' })).rejects.toMatchObject({ code: 'permission_mode_unavailable' });
  await expect(startSession('pc', { tool: 'claude', cwd: base.cwd, prompt: 'draft', approval: 'auto_all' })).rejects.toMatchObject({ code: 'permission_mode_unavailable' });
  expect(writes).toEqual([]);
  expect(await pendingDelivery(remoteDeliveryScope(), 'pc', base.sessionKey)).toBeUndefined();
});

test('desktop consent is required and rechecked after receipt storage without clearing the draft', async () => {
  await setup(); const status = getRemoteState().agents.pc;
  status.list.find(item => item.id === 'claude')!.capabilities!.approvalModes = ['ask', 'auto_edits', 'auto_all'];
  await expect(sendToSession('pc', base.sessionKey, 'draft', { approval: 'auto_all' })).rejects.toMatchObject({ code: 'permission_mode_forbidden' });
  status.autoAll = true;
  mockPersistHook = () => { status.autoAll = false; };
  await expect(sendToSession('pc', base.sessionKey, 'draft', { approval: 'auto_all' })).rejects.toMatchObject({ code: 'permission_mode_forbidden' });
  expect(writes).toEqual([]);
  expect(await pendingDelivery(remoteDeliveryScope(), 'pc', base.sessionKey)).toBeUndefined();
  expect(getRemoteState().timelines[timelineKey('pc', base.sessionKey)].items).toEqual([]);
});

test('attempted permission-change receipt retries the exact original UUID and mode after revocation', async () => {
  await setup(); const status = getRemoteState().agents.pc; status.autoAll = true;
  status.list.find(item => item.id === 'claude')!.capabilities!.approvalModes = ['ask', 'auto_edits', 'auto_all'];
  lose = true;
  await expect(sendToSession('pc', base.sessionKey, 'original', { approval: 'auto_all' })).rejects.toMatchObject({ retryable: true });
  const pending = await pendingDelivery(remoteDeliveryScope(), 'pc', base.sessionKey);
  expect(pending!.sendOptions!.approval).toBe('auto_all');
  status.autoAll = false;
  status.list.find(item => item.id === 'claude')!.capabilities!.approvalModes = [];
  await sendToSession('pc', base.sessionKey, 'original', { retryRequestId: pending!.requestId, approval: 'ask' });
  expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
  expect(writes[1].command.approval).toBe('auto_all');
});

test('a malformed or cross-agent approval never creates a fresh receipt', async () => {
  await setup();
  getRemoteState().agents.pc.list.find(item => item.id === 'claude')!.capabilities!.approvalModes = ['ask', 'auto_edits', 'auto_all'];
  await expect(sendToSession('pc', base.sessionKey, 'draft', { approval: 'full_access' as never })).rejects.toMatchObject({ code: 'permission_mode_unavailable' });
  observed = { ...base, sessionKey: 'codex:fixture', tool: 'codex' }; await openSession('pc', observed.sessionKey);
  await expect(sendToSession('pc', observed.sessionKey, 'draft', { approval: 'ask' })).rejects.toMatchObject({ code: 'permission_mode_unavailable' });
  expect(writes).toEqual([]);
});

test('Desktop Code starts with its declared CLI executor and entrypoint rather than its display card surface', async () => {
  await setup();
  const desktop = getRemoteState().agents.pc.list.find(profile => profile.id === 'claude-desktop')!;
  desktop.execution = { tool: 'claude', controlSurface: 'cli', entrypoint: 'claude-desktop' };
  await startSession('pc', { tool: 'claude', desktop: true, cwd: base.cwd, prompt: 'code task', approval: 'ask' });
  expect(writes).toHaveLength(1);
  expect(writes[0].command).toMatchObject({ type: 'session.start', tool: 'claude', entrypoint: 'claude-desktop' });
});

test.each(['claude', 'claude-desktop'])('a revoked %s executor blocks start/send/continue even if capabilities still claim send', async id => {
  observed = { ...base, client: id === 'claude-desktop' ? 'Claude Desktop' : 'Claude Code' }; await setup();
  getRemoteState().agents.pc.list.find(profile => profile.id === id)!.execution = null;
  await expect(startSession('pc', { tool: 'claude', desktop: id === 'claude-desktop', cwd: base.cwd, prompt: 'no', approval: 'ask' })).rejects.toMatchObject({ code: 'agent_capability_unavailable' });
  await expect(sendToSession('pc', base.sessionKey, 'no')).rejects.toMatchObject({ code: 'agent_capability_unavailable' });
  await expect(continueSession('pc', base.sessionKey)).rejects.toMatchObject({ code: 'agent_capability_unavailable' });
  expect(writes).toEqual([]);
});

test('a changed Desktop Code executor cannot switch the pending new-task command to another tool', async () => {
  await setup();
  const desktop = getRemoteState().agents.pc.list.find(profile => profile.id === 'claude-desktop')!;
  mockPersistHook = () => { desktop.execution = { tool: 'codex', controlSurface: 'cli' }; };
  await expect(startSession('pc', { tool: 'claude', desktop: true, cwd: base.cwd, prompt: 'code task', approval: 'ask' })).rejects.toMatchObject({ code: 'agent_capability_unavailable' });
  expect(writes).toEqual([]);
});

const unavailableApis: Array<[string, Partial<AgentProfile['api']>]> = [
  ['native login', { source: 'tool' }], ['unconfigured computer', { configured: false }],
  ['pending application', { pending: true }], ['missing handle', { accountId: undefined }],
  ['invalid handle', { accountId: 'not-an-api-handle' }],
];
test.each(['claude', 'claude-desktop'])('%s requires a confirmed API for all new admissions but keeps history readable', async id => {
  observed = { ...base, client: id === 'claude-desktop' ? 'Claude Desktop' : 'Claude Code' }; await setup();
  const profile = getRemoteState().agents.pc.list.find(item => item.id === id)!;
  for (const [, unavailable] of unavailableApis) {
    profile.api = { ...validApi, ...unavailable };
    expect(claudeApiAdmissionReady(profile)).toBe(false);
    await expect(startSession('pc', { tool: 'claude', desktop: id === 'claude-desktop', cwd: base.cwd, prompt: 'draft', approval: 'ask' }))
      .rejects.toMatchObject({ code: 'claude_api_required' });
    await expect(sendToSession('pc', base.sessionKey, 'draft')).rejects.toMatchObject({ code: 'claude_api_required' });
    await expect(continueSession('pc', base.sessionKey)).rejects.toMatchObject({ code: 'claude_api_required' });
    await openSession('pc', base.sessionKey);
    expect(getRemoteState().timelines[timelineKey('pc', base.sessionKey)].session).toMatchObject(observed);
    expect(await pendingDelivery(remoteDeliveryScope(), 'pc', base.sessionKey)).toBeUndefined();
  }
  expect(writes).toEqual([]);
});

test.each(['computer', 'phone'] as const)('a confirmed %s API runs Desktop Code using its actual card, not the Code card', async source => {
  observed = { ...base, client: 'Claude Desktop' }; await setup();
  const status = getRemoteState().agents.pc;
  status.list.find(item => item.id === 'claude')!.api = { ...validApi, source: 'tool', configured: false, accountId: undefined };
  status.list.find(item => item.id === 'claude-desktop')!.api = { ...validApi, source, accountId: 'api_bbbbbbbb' };
  await continueSession('pc', base.sessionKey);
  await sendToSession('pc', base.sessionKey, 'new message');
  await startSession('pc', { tool: 'claude', desktop: true, cwd: base.cwd, prompt: 'new task', approval: 'ask' });
  expect(writes.map(row => row.command.type)).toEqual(['session.continue', 'session.send', 'session.start']);
  expect(writes.every(row => row.command.accountId === 'api_bbbbbbbb')).toBe(true);
});

test.each(['send', 'continue', 'start'] as const)('API removal during %s receipt persistence cannot admit a new command', async action => {
  await setup();
  mockPersistHook = () => { getRemoteState().agents.pc.list.find(item => item.id === 'claude')!.api = { ...validApi, source: 'tool', configured: false, accountId: undefined }; };
  const perform = () => action === 'start' ? startSession('pc', { tool: 'claude', cwd: base.cwd, prompt: 'draft', approval: 'ask' })
    : action === 'continue' ? continueSession('pc', base.sessionKey) : sendToSession('pc', base.sessionKey, 'draft');
  await expect(perform()).rejects.toMatchObject({ code: 'claude_api_required' });
  expect(writes).toEqual([]);
  expect(await pendingDelivery(remoteDeliveryScope(), 'pc', action === 'start' ? newSessionReceiptKey('claude', false) : base.sessionKey)).toBeUndefined();
});

test('changing the applied API while persisting a new send cannot silently substitute it', async () => {
  await setup();
  mockPersistHook = () => { getRemoteState().agents.pc.list.find(item => item.id === 'claude')!.api = { ...validApi, accountId: 'api_bbbbbbbb' }; };
  await expect(sendToSession('pc', base.sessionKey, 'draft')).rejects.toMatchObject({ code: 'request_scope_changed' });
  expect(writes).toEqual([]);
});

test.each(['send', 'continue', 'start'] as const)('attempted %s recovers only the original UUID after its API disappears', async action => {
  await setup(); lose = true;
  const start = { tool: 'claude', cwd: base.cwd, prompt: 'original', approval: 'ask' } as const;
  await expect(action === 'start' ? startSession('pc', start) : action === 'continue' ? continueSession('pc', base.sessionKey) : sendToSession('pc', base.sessionKey, 'original'))
    .rejects.toMatchObject({ retryable: true });
  const key = action === 'start' ? newSessionReceiptKey('claude', false) : base.sessionKey;
  const receipt = (await pendingDelivery(remoteDeliveryScope(), 'pc', key))!;
  getRemoteState().agents.pc.list.find(item => item.id === 'claude')!.api = { ...validApi, source: 'tool', configured: false, accountId: undefined };
  await expect(sendToSession('pc', base.sessionKey, 'different')).rejects.toThrow();
  if (action === 'start') await retryNewSession('pc', 'claude', false, receipt.requestId);
  else await sendToSession('pc', base.sessionKey, receipt.text, { retryRequestId: receipt.requestId });
  expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
  expect(await pendingDelivery(remoteDeliveryScope(), 'pc', key)).toBeUndefined();
});

test.each(['send', 'start'] as const)('attempted %s retains its original wire account after a different API is applied', async action => {
  await setup(); lose = true;
  await expect(action === 'start' ? startSession('pc', { tool: 'claude', cwd: base.cwd, prompt: 'original', approval: 'ask' }) : sendToSession('pc', base.sessionKey, 'original'))
    .rejects.toMatchObject({ retryable: true });
  const key = action === 'start' ? newSessionReceiptKey('claude', false) : base.sessionKey;
  const receipt = (await pendingDelivery(remoteDeliveryScope(), 'pc', key))!;
  getRemoteState().agents.pc.list.find(item => item.id === 'claude')!.api = { ...validApi, accountId: 'api_bbbbbbbb' };
  if (action === 'start') await retryNewSession('pc', 'claude', false, receipt.requestId);
  else await sendToSession('pc', base.sessionKey, receipt.text, { retryRequestId: receipt.requestId });
  expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
  expect(writes[1].command.accountId).toBe('api_aaaaaaaa');
});

test('unconfigured Claude cannot acquire API readiness from the legacy executor fallback', () => {
  expect(claudeApiAdmissionReady(undefined, 'claude')).toBe(false);
  expect(claudeApiAdmissionReady(undefined, 'claude-desktop')).toBe(false);
  expect(claudeApiAdmissionReady(undefined, 'codex')).toBe(true);
});
