import { setHubFetch, type FetchLike } from '../remote/client';
import { pendingDelivery } from '../remote/delivery';
import { parseAgentStatus } from '../remote/projection';
import { bootRemote, cachedModels, canOpenOnDesktop, connectStation, getRemoteState, loadAgentProfiles, listModels, openOnDesktop, pairRemoteQr, parseRemoteQr, remoteDeliveryScope,
  resetRemoteForTests, respondApproval, sendToSession } from '../remote/store';

const mockSettings = new Map<string, string>(), mockSecrets = new Map<string, string>();
jest.mock('../storage/database', () => ({ getSetting: async (key: string) => mockSettings.get(key) ?? null,
  setSetting: async (key: string, value: string) => { mockSettings.set(key, value); } }));
jest.mock('../storage/secure-keys', () => ({ getProviderKey: async () => null }));
jest.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'fixture', getItemAsync: async (key: string) => mockSecrets.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { mockSecrets.set(key, value); }, deleteItemAsync: async (key: string) => { mockSecrets.delete(key); } }));
jest.mock('expo-crypto', () => ({ randomUUID: () => require('node:crypto').randomUUID() }));

const key = 'codex:11111111-2222-4333-8444-555555555555';
const origin = 'https://native-model-fixture.example';
const device = { deviceId: 'pc', name: 'Fixture', os: 'windows', tools: [], projects: [], online: true, lastSeen: 1 };
const reply = (value: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });
const desktopCaps = { list: true, read: true, send: true, modelOverride: true };
let live: Record<string, unknown>, lose = false, wrongDirectorySource = false, modelGate: (() => Promise<void>) | undefined;
const writes: Array<{ requestId: string; command: Record<string, unknown> }> = [];
const status = () => ({ agents: [{ id: 'codex', available: true, remoteSendSupported: true,
  api: { configured: true, source: 'computer', name: 'CLI API', model: 'cli-model', accountId: 'api_aaaaaaaa' }, desktopLive: live }] });
async function pair() {
  await bootRemote([]); await connectStation(origin);
  await pairRemoteQr(parseRemoteQr(JSON.stringify({ type: 'salcara-remote-pair', version: 1, hubUrl: `${origin}/salcara-hub/v1`,
    deviceId: 'pc', deviceName: 'Fixture', ticket: 'b'.repeat(64), expiresAt: Date.now() + 120000 })));
  await loadAgentProfiles('pc');
}
beforeEach(() => {
  resetRemoteForTests(); mockSettings.clear(); mockSecrets.clear(); writes.length = 0; lose = false; wrongDirectorySource = false; modelGate = undefined;
  live = { active: true, expiresAt: Date.now() + 120000, sessionKeys: [key], capabilities: desktopCaps,
    modelOverrideTransport: 'codex-tool-schema-v1', modelOptions: { model: true, thinking: ['low', 'high'] },
    accountId: 'api_bbbbbbbb', apiName: 'Desktop API', apiModel: 'desktop-model' };
  const transport: FetchLike = async (endpoint, init) => {
    if (endpoint.endsWith('/ping')) return reply({ service: 'salcara-hub', protocol: 'salcara-remote', protocolVersion: 1,
      authModes: ['device-pairing'], capabilities: ['device.identity.v1', 'pair.qr.v1', 'session.remote.v1', 'pair.revoke.v1', 'commands.idempotency.v1'] });
    if (endpoint.endsWith('/app/pair/qr')) return reply({ pair_token: 'a'.repeat(64), device });
    if (endpoint.endsWith('/app/devices')) return reply({ devices: [device] });
    if (!endpoint.endsWith('/app/commands')) throw new Error('Unexpected fixture endpoint');
    const body = JSON.parse(String(init.body));
    if (body.command.type === 'agents.status') return reply({ ok: true, result: status() });
    writes.push(body);
    if (body.command.type === 'models.list') {
      await modelGate?.();
      const model = body.command.controlSurface === 'desktop' ? 'desktop-model' : 'cli-model';
      return reply({ ok: true, result: { models: [model], ...(body.command.controlSurface === 'desktop' ? { controlSurface: wrongDirectorySource ? 'cli' : 'desktop', accountId: body.command.accountId } : {}), modelCapabilities: { [model]: { source: 'codex-model-list', reasoningKnown: true,
        reasoningEfforts: ['low', 'medium', 'high', 'ultra'] } } } });
    }
    if (lose) { lose = false; throw new Error('Synthetic lost acknowledgement'); }
    return reply({ ok: true, result: {} });
  };
  setHubFetch(transport);
});
afterEach(() => { resetRemoteForTests(); setHubFetch(null); });

test('native models come from the applied desktop account, not the CLI account or cache', async () => {
  await pair(); await listModels('pc', 'codex');
  const catalog = await listModels('pc', 'codex', true, { controlSurface: 'desktop', sessionKey: key });
  expect(writes[1].command).toEqual({ type: 'models.list', tool: 'codex', refresh: true, controlSurface: 'desktop', sessionKey: key,
    agent: 'codex-desktop', accountId: 'api_bbbbbbbb' });
  expect(catalog.models).toEqual(['desktop-model']); expect(catalog.modelCapabilities?.['desktop-model'].reasoningEfforts).toEqual(['low', 'high']);
  expect(cachedModels('pc', 'codex')?.models).toEqual(['cli-model']);
});

test.each(['missing-transport', 'missing-options', 'false-capability', 'missing-account', 'expired'] as const)('native overrides fail closed for %s', async reason => {
  if (reason === 'missing-transport') delete live.modelOverrideTransport;
  if (reason === 'missing-options') delete live.modelOptions;
  if (reason === 'false-capability') live.capabilities = { ...desktopCaps, modelOverride: false };
  if (reason === 'missing-account') delete live.accountId;
  if (reason === 'expired') live.expiresAt = Date.now() - 1;
  await pair();
  await expect(listModels('pc', 'codex', false, { controlSurface: 'desktop', sessionKey: key })).rejects.toThrow();
  await expect(sendToSession('pc', key, 'no', { surface: 'desktop', model: 'desktop-model' })).rejects.toThrow(); expect(writes).toEqual([]);
});

test('native sends use exact model and applied source, reject unsupported effort and stale account', async () => {
  await pair();
  await sendToSession('pc', key, 'yes', { surface: 'desktop', model: 'desktop-model', effort: 'high' });
  expect(writes[0].command).toMatchObject({ model: 'desktop-model', effort: 'high', accountId: 'api_bbbbbbbb', controlSurface: 'desktop' });
  await expect(sendToSession('pc', key, 'no', { surface: 'desktop', model: 'desktop-model', effort: 'ultra' })).rejects.toThrow();
  await expect(sendToSession('pc', key, 'no', { surface: 'desktop', model: 'desktop-model', accountId: 'api_aaaaaaaa' })).rejects.toThrow();
  expect(writes).toHaveLength(1);
});

test('a source change during the first storage wait cannot retarget an already clicked model', async () => {
  await pair();
  const pending = sendToSession('pc', key, 'frozen-at-click', { surface: 'desktop', model: 'desktop-model' });
  getRemoteState().agents.pc.list[0].desktopLive!.accountId = 'api_cccccccc';
  await expect(pending).rejects.toMatchObject({ code: 'request_scope_changed' }); expect(writes).toEqual([]);
});

test('a directory response after applied-source replacement cannot authorize a later choice', async () => {
  await pair(); let finish!: () => void, started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  modelGate = () => { started(); return new Promise<void>(resolve => { finish = resolve; }); };
  const result = listModels('pc', 'codex', false, { controlSurface: 'desktop', sessionKey: key });
  await ready; live.accountId = 'api_cccccccc'; await loadAgentProfiles('pc'); finish();
  await expect(result).rejects.toThrow(); expect(cachedModels('pc', 'codex')).toBeUndefined();
});

test('a host that ignores desktop directory routing cannot supply CLI models as native choices', async () => {
  await pair(); wrongDirectorySource = true;
  await expect(listModels('pc', 'codex', false, { controlSurface: 'desktop', sessionKey: key })).rejects.toThrow('模型来源');
  expect(cachedModels('pc', 'codex')).toBeUndefined();
});

test('uncertain native delivery retries the exact model and stops after the desktop source changes', async () => {
  await pair(); lose = true;
  await expect(sendToSession('pc', key, 'frozen', { surface: 'desktop', model: 'desktop-model', effort: 'high' })).rejects.toMatchObject({ retryable: true });
  const receipt = await pendingDelivery(remoteDeliveryScope(), 'pc', key);
  live.accountId = 'api_cccccccc'; await loadAgentProfiles('pc');
  await expect(sendToSession('pc', key, 'frozen', { retryRequestId: receipt!.requestId, model: 'other-model' })).rejects.toThrow();
  expect(writes).toHaveLength(1); expect((await pendingDelivery(remoteDeliveryScope(), 'pc', key))?.sendOptions).toMatchObject({ model: 'desktop-model', effort: 'high', accountId: 'api_bbbbbbbb' });
});

test('public capability projection removes unknown strengths and credential-shaped labels', () => {
  live.modelOptions = { model: true, thinking: ['high', 'invented', 'high'] }; live.apiName = 'sk-fixture';
  const parsed = parseAgentStatus(status()).agents[0];
  expect(parsed.desktopLive?.modelOptions?.thinking).toEqual(['high']); expect(parsed.desktopLive?.apiName).toBeUndefined();
  expect(parsed.desktopLive?.accountId).toBe('api_bbbbbbbb');
});

test('desktop navigation and hook approvals bind the applied source rather than the CLI API', async () => {
  live.capabilities = { ...desktopCaps, navigate: true, approval: true }; live.approvalTransport = 'codex-hook-v1';
  await pair(); await openOnDesktop('pc', key);
  const approvalId = '11111111-2222-4333-8444-666666666666';
  getRemoteState().timelines[`pc|${key}`] = { loading: false, items: [{ kind: 'approval', id: approvalId, approval: 'command', title: 'Fixture', state: 'pending',
    ts: Date.now(), expiresAt: Date.now() + 60000, approvalTransport: 'codex-hook-v1' }] };
  await respondApproval({ deviceId: 'pc', sessionKey: key, approvalId, controlSurface: 'desktop' }, 'allow');
  expect(writes.map(row => row.command.type)).toEqual(['desktop.navigate', 'desktop.approval.respond']);
  expect(writes.map(row => row.command.accountId)).toEqual(['api_bbbbbbbb', 'api_bbbbbbbb']);
});

test.each(['missing', 'false', 'expired', 'other-thread', 'other-device', 'claude-label'] as const)('native navigation requires explicit current host capability: %s', async variant => {
  live.capabilities = { ...desktopCaps, navigate: variant === 'missing' ? undefined : variant !== 'false' };
  if (variant === 'expired') live.expiresAt = Date.now() - 1;
  await pair();
  const requestedKey = variant === 'other-thread' ? 'codex:99999999-2222-4333-8444-555555555555'
    : variant === 'claude-label' ? key.replace('codex:', 'claude:') : key;
  const requestedDevice = variant === 'other-device' ? 'other-pc' : 'pc';
  expect(canOpenOnDesktop(requestedKey, 'Claude Desktop', requestedDevice)).toBe(false);
  await expect(openOnDesktop(requestedDevice, requestedKey, 'Claude Desktop')).rejects.toMatchObject({ code: 'desktop_capability_unavailable' });
  expect(writes).toHaveLength(0);
});

test('a visible native navigation action cannot dispatch after capability withdrawal', async () => {
  live.capabilities = { ...desktopCaps, navigate: true };
  await pair(); expect(canOpenOnDesktop(key, undefined, 'pc')).toBe(true);
  live.capabilities = { ...desktopCaps, navigate: false }; await loadAgentProfiles('pc');
  await expect(openOnDesktop('pc', key)).rejects.toMatchObject({ code: 'desktop_capability_unavailable' });
  expect(writes).toHaveLength(0);
});
