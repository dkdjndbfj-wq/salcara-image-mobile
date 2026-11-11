import { clearPreferredAgent, readPreferredAgent, rememberPreferredAgent, type AgentPreferenceScope } from '../remote/agent-preferences';

const mockValues = new Map<string, string | null>();
const mockWrite = jest.fn(async (key: string, value: string | null) => { mockValues.set(key, value); });
jest.mock('../storage/database', () => ({ getSetting: async (key: string) => mockValues.get(key) ?? null,
  setSetting: (key: string, value: string | null) => mockWrite(key, value) }));
const relay: AgentPreferenceScope = { kind: 'remote', connectionId: 'relay-a', deviceId: 'pc' };
const bot: AgentPreferenceScope = { kind: 'remote', connectionId: 'bot-group-a', deviceId: 'pc' };
const direct: AgentPreferenceScope = { kind: 'direct', connectionId: 'fingerprint-binding-a', deviceId: 'pc' };
beforeEach(() => { mockValues.clear(); mockWrite.mockClear(); });

test('old global Agent is not silently applied to any computer or connection mode', async () => {
  mockValues.set('remote_last_agent_v1', 'claude');
  expect(await readPreferredAgent(relay)).toBeNull();
  expect(await readPreferredAgent(bot)).toBeNull();
  expect(await readPreferredAgent(direct)).toBeNull();
  expect(await readPreferredAgent(null)).toBeNull();
});

test('relay, Bot groups, same-Hub devices and direct fingerprints retain independent choices after re-read', async () => {
  const scopes: AgentPreferenceScope[] = [relay, bot, direct, { ...bot, connectionId: 'bot-group-b' },
    { ...relay, deviceId: 'pc-other' }, { ...direct, connectionId: 'fingerprint-binding-b' }];
  const choices = ['claude', 'codex', 'deepseek-harness', 'gemini', 'opencode', 'claude-desktop'];
  await Promise.all(scopes.map((scope, index) => rememberPreferredAgent(scope, choices[index])));
  expect(await Promise.all(scopes.map(readPreferredAgent))).toEqual(choices);
  await clearPreferredAgent(bot);
  expect(await Promise.all(scopes.map(readPreferredAgent))).toEqual(choices.map((choice, index) => index === 1 ? null : choice));
});

test('queued writes snapshot the target and preserve invocation order', async () => {
  const mutable = { ...relay };
  const one = rememberPreferredAgent(mutable, 'claude');
  mutable.deviceId = 'wrong-pc';
  const two = rememberPreferredAgent(relay, 'codex');
  await Promise.all([one, two]);
  expect(await readPreferredAgent(relay)).toBe('codex');
  expect(await readPreferredAgent(mutable)).toBeNull();
});

test('invalid scopes and corrupted values do not become executable Agent choices', async () => {
  await rememberPreferredAgent(relay, 'codex');
  const key = [...mockValues.keys()][0];
  mockValues.set(key, '{"agent":"claude"}');
  expect(await readPreferredAgent(relay)).toBeNull();
  await expect(rememberPreferredAgent({ ...relay, deviceId: '' }, 'codex')).rejects.toThrow();
  await expect(rememberPreferredAgent(relay, '../invalid')).rejects.toThrow();
  expect(await readPreferredAgent({ ...direct, connectionId: '' })).toBeNull();
});
