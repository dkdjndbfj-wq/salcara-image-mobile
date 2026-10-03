import { setHubFetch, type Effort, type FetchLike } from '../remote/client';
import { pendingDelivery, resetDeliveryForTests } from '../remote/delivery';
import { effortLabel } from '../remote/effort';
import { desktopLiveFor } from '../remote/projection';
import { loadThreadPrefs, saveThreadPrefs } from '../remote/thread-prefs';
import { bootRemote, connectStation, getRemoteState, loadAgentProfiles, pairRemoteQr, parseRemoteQr, remoteDeliveryScope, resetRemoteForTests, sendToSession, startSession } from '../remote/store';

const mockSettings = new Map<string, string>();
const mockSecrets = new Map<string, string>();
let mockUuid = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `0199aaa1-1234-4678-9abc-${String(++mockUuid).padStart(12, '0')}` }));
jest.mock('../storage/database', () => ({
  getSetting: async (key: string) => mockSettings.get(key) ?? null,
  setSetting: async (key: string, value: string | null) => { if (value === null) mockSettings.delete(key); else mockSettings.set(key, value); },
}));
jest.mock('../storage/secure-keys', () => ({ getProviderKey: async () => null }));
jest.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'this-device-only',
  getItemAsync: async (key: string) => mockSecrets.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { mockSecrets.set(key, value); },
  deleteItemAsync: async (key: string) => { mockSecrets.delete(key); },
}));

const origin = 'https://effort-fixture.example';
const sessionKey = 'codex:0199aaa1-1234-4678-9abc-000000000001';
const device = { deviceId: 'pc', name: 'Fixture', os: 'windows', tools: [], projects: [], online: true, lastSeen: 1 };
const reply = (value: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });
let commands: Array<{ requestId: string; command: Record<string, unknown> }>;
let loseAcknowledgement: boolean;
let desktopLive: boolean;

async function pair() {
  await bootRemote([]);
  await connectStation(origin);
  await pairRemoteQr(parseRemoteQr(JSON.stringify({ type: 'salcara-remote-pair', version: 1,
    hubUrl: `${origin}/salcara-hub/v1`, deviceId: 'pc', deviceName: 'Fixture', ticket: 'b'.repeat(64), expiresAt: Date.now() + 120_000 })));
}
const prefsKey = () => `${getRemoteState().connectionId}|pc|${sessionKey}`;

beforeEach(() => {
  resetRemoteForTests(); mockSettings.clear(); mockSecrets.clear(); mockUuid = 0;
  commands = []; loseAcknowledgement = false; desktopLive = false;
  const transport: FetchLike = async (endpoint, init) => {
    if (endpoint.endsWith('/ping')) return reply({ service: 'salcara-hub', protocol: 'salcara-remote', protocolVersion: 1,
      authModes: ['device-pairing'], capabilities: ['device.identity.v1', 'pair.qr.v1', 'session.remote.v1', 'pair.revoke.v1', 'commands.idempotency.v1'] });
    if (endpoint.endsWith('/app/pair/qr')) return reply({ pair_token: 'a'.repeat(64), device });
    if (endpoint.endsWith('/app/devices')) return reply({ devices: [device] });
    if (!endpoint.endsWith('/app/commands')) throw new Error(`Unexpected fixture request: ${endpoint}`);
    const body = JSON.parse(String(init.body));
    if (body.command.type === 'agents.status') return reply({ ok: true, result: { agents: [{ id: 'codex', available: true,
      api: { name: 'fixture', model: 'gpt-fixture', configured: true, source: 'computer', accountId: 'api_fixture' },
      ...(desktopLive ? { desktopLive: { active: true, expiresAt: Date.now() + 60_000, sessionKeys: [sessionKey] } } : {}),
    }] } });
    if (!['session.start', 'session.send'].includes(body.command.type)) throw new Error(`Unexpected fixture command: ${body.command.type}`);
    commands.push(body);
    if (loseAcknowledgement && body.command.type === 'session.send') { loseAcknowledgement = false; throw new Error('fixture lost acknowledgement'); }
    return reply({ ok: true, result: body.command.type === 'session.start' ? { sessionKey: 'codex:new' } : {} });
  };
  setHubFetch(transport);
});
afterEach(() => { resetRemoteForTests(); setHubFetch(null); });

test.each(['minimal', 'low', 'medium', 'high', 'xhigh'] as const)('the real preference and command chain preserves %s for both start and send', async (effort: Effort) => {
  await pair();
  await saveThreadPrefs(prefsKey(), { model: 'gpt-fixture', effort, apiIdentity: 'computer:api_fixture' });
  expect(JSON.parse(mockSettings.get('remote_thread_prefs_v1')!)[prefsKey()]).toEqual({ model: 'gpt-fixture', effort, apiIdentity: 'computer:api_fixture' });
  const restored = await loadThreadPrefs(prefsKey());
  await startSession('pc', { tool: 'codex', cwd: 'C:\\fixture', prompt: 'new task', approval: 'ask', ...restored });
  await sendToSession('pc', sessionKey, 'next task', restored);
  expect(commands.map((item) => item.command.effort)).toEqual([effort, effort]);
  expect(commands.map((item) => item.command.type)).toEqual(['session.start', 'session.send']);
});

test('old Minimal preferences restore as Minimal while unsupported legacy strengths are discarded', async () => {
  mockSettings.set('remote_thread_prefs_v1', JSON.stringify({ legacy: { effort: 'minimal' }, invalid: { model: 'gpt-fixture', effort: 'imagined' } }));
  const old = await loadThreadPrefs('legacy');
  expect(old).toEqual({ effort: 'minimal' }); expect(effortLabel(old.effort)).toBe('Minimal');
  expect(await loadThreadPrefs('invalid')).toEqual({ model: 'gpt-fixture' });
});

test('clearing an override persists Default and omits effort from both real commands', async () => {
  await pair();
  await saveThreadPrefs(prefsKey(), { model: 'gpt-fixture', effort: 'xhigh' });
  await saveThreadPrefs(prefsKey(), { model: 'gpt-fixture' });
  const restored = await loadThreadPrefs(prefsKey());
  expect(restored).toEqual({ model: 'gpt-fixture' }); expect(effortLabel(restored.effort)).toBe('Default');
  expect(JSON.parse(mockSettings.get('remote_thread_prefs_v1')!)[prefsKey()]).not.toHaveProperty('effort');
  await startSession('pc', { tool: 'codex', cwd: 'C:\\fixture', prompt: 'new task', approval: 'ask', ...restored });
  await sendToSession('pc', sessionKey, 'next task', restored);
  for (const item of commands) expect(item.command).not.toHaveProperty('effort');
});

test.each(['minimal', 'xhigh'] as const)('a restored %s receipt keeps its request and effort after preferences change and desktop Live begins', async (effort: Effort) => {
  await pair();
  loseAcknowledgement = true;
  await expect(sendToSession('pc', sessionKey, 'same task', { model: 'gpt-frozen', effort })).rejects.toMatchObject({ retryable: true });
  const original = JSON.parse(mockSettings.get('remote_pending_delivery_v1')!)[0];
  expect(original.sendOptions).toEqual({ model: 'gpt-frozen', effort });
  await saveThreadPrefs(prefsKey(), { model: 'gpt-new', effort: 'low' });
  resetDeliveryForTests();
  expect(await pendingDelivery(remoteDeliveryScope(), 'pc', sessionKey)).toMatchObject({ requestId: original.requestId, sendOptions: original.sendOptions });
  desktopLive = true; await loadAgentProfiles('pc');
  expect(desktopLiveFor(getRemoteState().agents.pc.list[0], sessionKey)).toBe(true);
  // The hidden composer supplies no new effort; the durable receipt still owns the retry.
  await sendToSession('pc', sessionKey, 'same task', { model: 'gpt-new' });
  expect(commands).toHaveLength(2); expect(commands[1]).toEqual(commands[0]);
  expect(commands[1]).toMatchObject({ requestId: original.requestId, command: { model: 'gpt-frozen', effort } });
  expect(await pendingDelivery(remoteDeliveryScope(), 'pc', sessionKey)).toBeUndefined();
});

test('a frozen Default receipt does not pick up a later XHigh selection on retry', async () => {
  await pair(); loseAcknowledgement = true;
  await expect(sendToSession('pc', sessionKey, 'same task')).rejects.toMatchObject({ retryable: true });
  resetDeliveryForTests();
  await sendToSession('pc', sessionKey, 'same task', { effort: 'xhigh' });
  expect(commands).toHaveLength(2); expect(commands[1]).toEqual(commands[0]);
  expect(commands[1].command).not.toHaveProperty('effort');
});
