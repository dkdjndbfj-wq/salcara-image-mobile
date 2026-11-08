import { setHubFetch, type FetchLike, type SessionInfo } from '../remote/client';
import { bootRemote, connectStation, loadAgentProfiles, pairRemoteQr, parseRemoteQr, prepareCooperation, cooperationReceiptOwner, resetRemoteForTests, sendCooperation } from '../remote/store';
import { cooperationCandidate, parseCooperationReading, readCooperationReceipts, saveCooperationReceipt } from '../remote/cooperation';
import { messageOrigin } from '../remote/conversation-metadata';
const mockSettings = new Map<string, string>(), mockSecrets = new Map<string, string>();
let mockUuid = 0;
let mockBeforeWrite: (() => Promise<void>) | undefined;
jest.mock('expo-crypto', () => ({ randomUUID: () => `0199bbb1-1234-4678-9abc-${String(++mockUuid).padStart(12, '0')}` }));
jest.mock('../storage/database', () => ({ getSetting: async (key: string) => mockSettings.get(key) ?? null, setSetting: async (key: string, value: string) => { if (mockBeforeWrite && value.includes("cancel before dispatch")) { const run = mockBeforeWrite; mockBeforeWrite = undefined; await run(); } mockSettings.set(key, value); } }));
jest.mock('../storage/secure-keys', () => ({ getProviderKey: async () => null }));
jest.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'this-device-only', getItemAsync: async (key: string) => mockSecrets.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { mockSecrets.set(key, value); }, deleteItemAsync: async (key: string) => { mockSecrets.delete(key); } }));
const origin = 'https://cooperation-fixture.example', hubUrl = `${origin}/salcara-hub/v1`, source = 'codex:source', target = 'codex:target';
const device = { deviceId: 'pc', name: 'Fixture', os: 'windows', tools: [], projects: [], online: true, lastSeen: 1 };
const session = (key: string): SessionInfo => ({ sessionKey: key, tool: 'codex', client: 'Codex', title: key, cwd: '/fixture', status: 'idle', controllable: true, controlSurface: 'cli', updatedAt: 1 });
const preparation = () => ({ ticket: 'd'.repeat(64), expiresAt: Date.now() + 300000, source: session(source), target: session(target) });
const response = (value: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });
let commands: Record<string, unknown>[], account: string, support: boolean, handle: (input: Record<string, unknown>) => unknown | Promise<unknown>;
async function pair() {
  await bootRemote([]); await connectStation(origin);
  await pairRemoteQr(parseRemoteQr(JSON.stringify({ type: 'salcara-remote-pair', version: 1, hubUrl, deviceId: 'pc', deviceName: 'Fixture', ticket: 'b'.repeat(64), expiresAt: Date.now() + 120000 })));
  await loadAgentProfiles('pc');
}
beforeEach(() => {
  resetRemoteForTests(); mockSettings.clear(); mockSecrets.clear(); mockUuid = 0; mockBeforeWrite = undefined; commands = []; account = 'api_aaaaaaaa'; support = true;
  handle = input => input.type === 'session.cooperation.prepare' ? { ok: true, result: preparation() }
    : input.type === 'session.send' ? { ok: true, result: { via: 'background', receiptId: input.operationId } }
    : { ok: true, result: { session: session(String(input.sessionKey)), events: [] } };
  setHubFetch((async (endpoint, init) => {
    if (endpoint.endsWith('/ping')) return response({ service: 'salcara-hub', protocol: 'salcara-remote', protocolVersion: 1, authModes: ['device-pairing'], capabilities: ['device.identity.v1', 'pair.qr.v1', 'pair.revoke.v1', 'session.remote.v1', 'commands.idempotency.v1', ...(support ? ['session.cooperation.v1'] : [])] });
    if (endpoint.endsWith('/app/pair/qr')) return response({ pair_token: 'a'.repeat(64), device });
    if (endpoint.endsWith('/app/devices')) return response({ devices: [device] });
    if (endpoint.endsWith('/app/commands')) {
      const input = JSON.parse(String(init.body)).command; commands.push(input);
      if (input.type === 'agents.status') return response({ ok: true, result: { agents: [{ id: 'codex', tool: 'codex', available: true,
        capabilities: { read: true, list: true, send: true }, execution: { tool: 'codex', controlSurface: 'cli' }, api: { source: 'computer', configured: true, accountId: account } }] } });
      return response(await handle(input));
    }
    return response({ events: [], nextSeq: 0, lastSeq: 0, hasMore: false });
  }) as FetchLike);
});
afterEach(() => { resetRemoteForTests(); setHubFetch(null); });

test('explicit submit uses a verified exact source/target ticket and saves its own operation receipt', async () => {
  await pair(); const reading = await prepareCooperation('pc', source, target);
  expect(commands.some(command => command.type === 'session.send')).toBe(false);
  const result = await sendCooperation('pc', reading, '用户明确发送');
  expect(result.state).toBe('sent');
  expect(commands.filter(command => command.type === 'session.send')).toEqual([expect.objectContaining({ sourceSessionKey: source, sessionKey: target,
    cooperationTicket: 'd'.repeat(64), operationId: result.operationId, accountId: account, text: '用户明确发送' })]);
  expect(await readCooperationReceipts(cooperationReceiptOwner('pc'), source)).toEqual([result]);
  expect(await readCooperationReceipts(cooperationReceiptOwner('different-computer'), source)).toEqual([]);
  expect(JSON.stringify([...mockSettings.values()])).not.toContain('d'.repeat(64)); // restart does not revive authorization
});
test('A-B-A cannot reuse a ticket, even when the old account is selected again', async () => {
  await pair(); const reading = await prepareCooperation('pc', source, target);
  account = 'api_bbbbbbbb'; await loadAgentProfiles('pc'); account = 'api_aaaaaaaa'; await loadAgentProfiles('pc');
  await expect(sendCooperation('pc', reading, 'old')).rejects.toThrow();
  expect(commands.some(command => command.type === 'session.send')).toBe(false);
});
test('a known local refusal after receipt storage is retained as not sent and does not become a pending network mutation', async () => {
  await pair(); const reading = await prepareCooperation('pc', source, target);
  mockBeforeWrite = async () => { account = 'api_bbbbbbbb'; await loadAgentProfiles('pc'); };
  await expect(sendCooperation('pc', reading, 'cancel before dispatch')).rejects.toThrow();
  expect(commands.some(command => command.type === 'session.send')).toBe(false);
  expect((await readCooperationReceipts(cooperationReceiptOwner('pc'), source))[0].state).toBe('not_sent');
});
test('an uncertain receipt blocks another explicit send until the user checks the target', async () => {
  await pair(); const reading = await prepareCooperation('pc', source, target);
  handle = () => ({ ok: true, result: { via: 'background', receiptId: 'other-operation' } });
  await expect(sendCooperation('pc', reading, 'once')).rejects.toThrow('未确认');
  await expect(sendCooperation('pc', reading, 'again')).rejects.toThrow('待核对');
  expect(commands.filter(command => command.type === 'session.send')).toHaveLength(1);
  const saved = await readCooperationReceipts(cooperationReceiptOwner('pc'), source); expect(saved[0].state).toBe('unconfirmed');
  await saveCooperationReceipt(cooperationReceiptOwner('pc'), { ...saved[0], state: 'acknowledged' });
  expect((await readCooperationReceipts('different-owner', source))).toEqual([]);
});
test.each(['missing-hub', 'cross-agent', 'same-task', 'expired'])('%s cannot dispatch a cross-task turn', async variant => {
  if (variant === 'missing-hub') support = false; await pair();
  if (variant !== 'expired') await expect(prepareCooperation('pc', source, variant === 'same-task' ? source : variant === 'cross-agent' ? 'claude:other' : target)).rejects.toThrow();
  else { const reading = await prepareCooperation('pc', source, target); reading.expiresAt = 0; await expect(sendCooperation('pc', reading, 'old')).rejects.toThrow(); }
  expect(commands.some(command => command.type === 'session.send')).toBe(false);
});
test.each(['foreign-source', 'foreign-target', 'archived', 'read-only', 'running', 'child', 'wrong-agent'])('preparation rejects %s returned by an old or incorrect Bridge', variant => {
  const raw = preparation();
  if (variant === 'foreign-source') raw.source.sessionKey = 'codex:other';
  if (variant === 'foreign-target') raw.target.sessionKey = 'codex:other';
  if (variant === 'archived') raw.target.archived = true;
  if (variant === 'read-only') raw.target.controlSurface = 'read-only';
  if (variant === 'running') raw.target.status = 'running';
  if (variant === 'child') raw.target.parentSessionKey = source;
  if (variant === 'wrong-agent') raw.target.tool = 'claude';
  expect(parseCooperationReading(raw, source, target, 'scope')).toBeUndefined();
});
test('native sender assertions remain unverified navigation only and arbitrary origin properties are dropped', () => {
  expect(messageOrigin({ kind: 'delegation', sourceSessionKey: 'claude:source', verification: 'native_reported', token: 'secret' })).toEqual({ kind: 'delegation', sourceSessionKey: 'claude:source', verification: 'native_reported' });
  expect(messageOrigin({ kind: 'delegation', sourceSessionKey: 'codex:source', verification: 'bridge_receipt' })).toEqual({ kind: 'delegation' });
  expect(messageOrigin({ kind: 'user_cross_task', sourceSessionKey: source, targetSessionKey: source, receiptId: '1'.repeat(36), verification: 'bridge_receipt' })).toBeUndefined();
  expect(cooperationCandidate({ ...session(target), controllable: false }, source)).toBe(false);
});
