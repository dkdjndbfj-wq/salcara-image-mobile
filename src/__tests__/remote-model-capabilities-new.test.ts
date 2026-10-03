import { setHubFetch, type FetchLike } from '../remote/client';
import { reportedEfforts } from '../remote/effort';
import { bootRemote, cachedModels, connectStation, listModels, pairRemoteQr, parseRemoteQr, resetRemoteForTests } from '../remote/store';

const mockSettings = new Map<string, string>();
const mockSecrets = new Map<string, string>();
jest.mock('../storage/database', () => ({ getSetting: async (key: string) => mockSettings.get(key) ?? null,
  setSetting: async (key: string, value: string | null) => { if (value === null) mockSettings.delete(key); else mockSettings.set(key, value); } }));
jest.mock('../storage/secure-keys', () => ({ getProviderKey: async () => null }));
jest.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'this-device-only',
  getItemAsync: async (key: string) => mockSecrets.get(key) ?? null, setItemAsync: async (key: string, value: string) => { mockSecrets.set(key, value); },
  deleteItemAsync: async (key: string) => { mockSecrets.delete(key); } }));

const origin = 'https://model-capabilities-fixture.example';
const device = { deviceId: 'pc', name: 'Fixture', os: 'windows', tools: [], projects: [], online: true, lastSeen: 1 };
const reply = (value: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });
let catalog: unknown;
const requests: Record<string, unknown>[] = [];
async function pair() {
  await bootRemote([]); await connectStation(origin);
  await pairRemoteQr(parseRemoteQr(JSON.stringify({ type: 'salcara-remote-pair', version: 1, hubUrl: `${origin}/salcara-hub/v1`,
    deviceId: 'pc', deviceName: 'Fixture', ticket: 'b'.repeat(64), expiresAt: Date.now() + 120000 })));
}
beforeEach(() => {
  resetRemoteForTests(); mockSettings.clear(); mockSecrets.clear(); requests.length = 0; catalog = {};
  const transport: FetchLike = async (endpoint, init) => {
    if (endpoint.endsWith('/ping')) return reply({ service: 'salcara-hub', protocol: 'salcara-remote', protocolVersion: 1,
      authModes: ['device-pairing'], capabilities: ['device.identity.v1', 'pair.qr.v1', 'session.remote.v1', 'pair.revoke.v1'] });
    if (endpoint.endsWith('/app/pair/qr')) return reply({ pair_token: 'a'.repeat(64), device });
    if (endpoint.endsWith('/app/devices')) return reply({ devices: [device] });
    if (endpoint.endsWith('/app/commands')) {
      const command = JSON.parse(String(init.body)).command; requests.push(command);
      if (command.type === 'models.list') return reply({ ok: true, result: catalog });
    }
    throw new Error(`Unexpected fixture request: ${endpoint}`);
  };
  setHubFetch(transport);
});
afterEach(() => { resetRemoteForTests(); setHubFetch(null); });

test('the real model-list chain retains only explicit per-model runtime capabilities', async () => {
  catalog = { models: ['family-one', 'family-two', 'relay-gpt-name', 'missing-efforts'], modelCapabilities: {
    'family-one': { source: 'codex-model-list', reasoningKnown: true, reasoningEfforts: ['high', 'low', 'high', 'imagined', 'ultra'], inputModalities: ['text', 'image', 'invented'] },
    'family-two': { source: 'codex-model-list', reasoningKnown: true, reasoningEfforts: ['medium'], inputModalities: ['text'] },
    'relay-gpt-name': { source: 'relay-model-list', reasoningKnown: true, reasoningEfforts: ['xhigh'], inputModalities: ['image'] },
    'missing-efforts': { source: 'codex-model-list', reasoningKnown: true },
    'foreign-id': { source: 'codex-model-list', reasoningKnown: true, reasoningEfforts: ['xhigh'] },
  } };
  await pair();
  const result = await listModels('pc', 'codex', true);
  expect(result.modelCapabilities?.['family-one']).toEqual({ source: 'codex-model-list', reasoningKnown: true, reasoningEfforts: ['low', 'high', 'ultra'], inputModalities: ['text', 'image'] });
  expect(reportedEfforts(result.modelCapabilities?.['family-two'])).toEqual(['medium']);
  expect(result.modelCapabilities?.['family-two']?.inputModalities).toEqual(['text']);
  expect(result.modelCapabilities?.['relay-gpt-name']).toEqual({ source: 'relay-model-list', reasoningKnown: false });
  expect(reportedEfforts(result.modelCapabilities?.['missing-efforts'])).toEqual([]);
  expect(result.modelCapabilities).not.toHaveProperty('foreign-id');
  expect(requests).toEqual([{ type: 'models.list', tool: 'codex', refresh: true }]);
});

test('a refreshed same-ID relay group replaces older capabilities rather than merging them', async () => {
  catalog = { models: ['same-id'], modelCapabilities: { 'same-id': { source: 'codex-model-list', reasoningKnown: true, reasoningEfforts: ['low', 'xhigh'] } } };
  await pair(); await listModels('pc', 'codex', true);
  expect(reportedEfforts(cachedModels('pc', 'codex')?.modelCapabilities?.['same-id'])).toEqual(['low', 'xhigh']);
  catalog = { models: ['same-id'] };
  await listModels('pc', 'codex', true);
  expect(cachedModels('pc', 'codex')?.modelCapabilities?.['same-id']).toEqual({ source: 'unknown', reasoningKnown: false });
});

test('a known empty effort list stays distinct from missing metadata and invalid model IDs are not presented', async () => {
  catalog = { models: ['none-reported', 'unknown', 'none-reported', '', 'with\nnewline', ' padded ', 42], modelCapabilities: {
    'none-reported': { source: 'codex-model-list', reasoningKnown: true, reasoningEfforts: [] },
  } };
  await pair();
  const result = await listModels('pc', 'codex');
  expect(result.models).toEqual(['none-reported', 'unknown']);
  expect(result.modelCapabilities?.['none-reported']).toEqual({ source: 'codex-model-list', reasoningKnown: true, reasoningEfforts: [] });
  expect(result.modelCapabilities?.unknown).toEqual({ source: 'unknown', reasoningKnown: false });
});
