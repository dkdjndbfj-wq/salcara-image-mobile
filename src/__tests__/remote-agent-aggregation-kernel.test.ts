import { setHubFetch, type FetchLike } from '../remote/client';
import { createHash } from 'node:crypto';
import { approvalStateKey, bootRemote, cachedModels, connectStation, getRemoteState, interruptSession, lastAgent, listModels, loadAgentProfiles,
  loadSessions, openSession, pairRemoteQr, pairScannedRemoteQr, parseRemoteQr, parseScannedRemoteQr, rememberAgent, resetRemoteForTests, respondApproval,
  sendToSession, setAgentApi, startSession, syncSessionEvents, timelineKey, useSavedConnection } from '../remote/store';

const mockSettings = new Map<string, string>(), mockSecrets = new Map<string, string>();
let mockUuid = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `0199aaa1-1234-4678-9abc-${String(++mockUuid).padStart(12, '0')}`,
  getRandomBytesAsync: async (size: number) => new Uint8Array(size).fill(7) }));
jest.mock('../storage/database', () => ({ getSetting: async (key: string) => mockSettings.get(key) ?? null,
  setSetting: async (key: string, value: string | null) => { if (value === null) mockSettings.delete(key); else mockSettings.set(key, value); } }));
jest.mock('../storage/secure-keys', () => ({ getProviderKey: async () => null }));
jest.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'this-device-only', getItemAsync: async (key: string) => mockSecrets.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { mockSecrets.set(key, value); }, deleteItemAsync: async (key: string) => { mockSecrets.delete(key); } }));

const origin = 'https://aggregation-fixture.example', hubUrl = `${origin}/salcara-hub/v1`;
const device = { deviceId: 'pc', name: 'Fixture', os: 'windows', tools: [], projects: [], online: true, lastSeen: 1 };
const caps = { list: true, read: true, send: true, interrupt: true, approval: true, questions: true, subagents: true,
  attachments: true, imageInput: true, imageOutput: true, modelOverride: true };
const info = (id = 'hermes', key = `${id}:original`) => ({ sessionKey: key, tool: id, client: id, title: 'Synthetic task', cwd: 'C:/fixture', updatedAt: 1, status: 'idle', controllable: true, controlSurface: 'cli' });
let account: string, capabilities: Record<string, boolean> | undefined, commands: Record<string, unknown>[];
let commandHandler: (input: Record<string, unknown>) => unknown | Promise<unknown>;
let eventRows: unknown[];
let readEvents: (endpoint: string) => unknown | Promise<unknown>;
let adapterIds: string[];
const status = () => ({ agents: adapterIds.map(id => ({ id, tool: id, name: id, controlSurface: 'cli', apiFamily: 'shared',
  available: true, remoteSendSupported: true, capabilities, api: { accountId: account, source: 'phone', configured: true } })) });
const defaultCommand = (input: Record<string, unknown>): unknown => {
  if (input.type === 'agents.status' || input.type === 'agents.api.set') return { ok: true, result: status() };
  if (input.type === 'sessions.list') return { ok: true, result: { sessions: [info(String(input.tool))] } };
  if (input.type === 'session.open') return { ok: true, result: { session: info(String(input.sessionKey).split(':')[0], String(input.sessionKey)), events: [] } };
  if (input.type === 'session.start') return { ok: true, result: { sessionKey: `${input.tool}:created` } };
  if (input.type === 'models.list') return { ok: true, result: { models: ['synthetic-model'] } };
  return { ok: true, result: {} };
};
const response = (value: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });
async function pair(load = true) {
  await bootRemote([]); await connectStation(origin);
  await pairRemoteQr(parseRemoteQr(JSON.stringify({ type: 'salcara-remote-pair', version: 1, hubUrl, deviceId: 'pc', deviceName: 'Fixture', ticket: 'b'.repeat(64), expiresAt: Date.now() + 120000 })));
  if (load) await loadAgentProfiles('pc');
}
beforeEach(() => {
  resetRemoteForTests(); mockSettings.clear(); mockSecrets.clear(); mockUuid = 0;
  account = 'api_11111111'; capabilities = { ...caps }; commands = []; eventRows = []; commandHandler = defaultCommand;
  adapterIds = ['hermes', 'helper'];
  readEvents = endpoint => new URL(endpoint).searchParams.get('limit') === '1' ? { events: [], nextSeq: 0, lastSeq: 0, hasMore: false }
    : { events: eventRows, nextSeq: 3, lastSeq: 3, hasMore: false };
  setHubFetch((async (endpoint, init) => {
    if (endpoint.endsWith('/ping')) return response({ service: 'salcara-hub', protocol: 'salcara-remote', protocolVersion: 1, authModes: ['device-pairing'], capabilities: ['device.identity.v1', 'pair.qr.v1', 'session.remote.v1', 'pair.revoke.v1', 'commands.idempotency.v1'] });
    if (endpoint.endsWith('/app/pair/qr')) return response({ pair_token: 'a'.repeat(64), device });
    if (endpoint.endsWith('/app/devices')) return response({ devices: [device] });
    if (endpoint.endsWith('/app/commands')) { const input = JSON.parse(String(init.body)).command; commands.push(input); return response(await commandHandler(input)); }
    return response(await readEvents(endpoint));
  }) as FetchLike);
});
afterEach(() => { resetRemoteForTests(); setHubFetch(null); });

test.each(['text', 'enum'] as const)('cold-start Hermes %s clarification reads host-advertised capabilities after start/open', async inputType => {
  capabilities!.questions = false; await pair();
  const key = 'hermes:created', nativeId = 'native-prompt-1', approvalId = 'hermes:created:native-prompt-1';
  const question = { id: nativeId, question: 'Which value?', inputType, required: true, allowCustom: true,
    ...(inputType === 'enum' ? { options: [{ label: 'raw, choice' }] } : {}) };
  commandHandler = input => {
    if (input.type === 'session.start') capabilities!.questions = true;
    if (input.type === 'session.open') return { ok: true, result: { session: info('hermes', key), events: [{
      type: 'approval.request', deviceId: 'pc', sessionKey: key, tool: 'hermes', ts: Date.now(), approvalId,
      kind: 'question', title: 'Hermes 需要补充信息', questionMode: 'hermes', questions: [question],
      approvalOptions: { version: 1, decisions: ['allow'] },
    }] } };
    return defaultCommand(input);
  };
  expect(await startSession('pc', { tool: 'hermes', cwd: 'C:/fixture', prompt: 'synthetic', approval: 'ask' })).toBe(key);
  expect(commands.some(input => input.type === 'session.open')).toBe(false);
  await openSession('pc', key);
  const sequence = commands.map(input => input.type);
  expect(sequence.lastIndexOf('agents.status')).toBeGreaterThan(sequence.indexOf('session.open'));
  expect(sequence.indexOf('session.open')).toBeGreaterThan(sequence.indexOf('session.start'));
  expect(getRemoteState().agents.pc.list.find(profile => profile.id === 'hermes')?.capabilities?.questions).toBe(true);
  expect(getRemoteState().timelines[timelineKey('pc', key)].items.find(item => item.kind === 'approval')).toMatchObject({
    state: 'pending', questionMode: 'hermes', questions: [question], approvalOptions: { version: 1, decisions: ['allow'] },
  });
  const answer = inputType === 'enum' ? 'raw, choice' : 'custom text';
  await respondApproval({ approvalId, deviceId: 'pc', sessionKey: key }, 'allow', undefined, { [nativeId]: [answer] });
  const responses = commands.filter(input => input.type === 'approval.respond');
  expect(responses).toHaveLength(1);
  expect(responses[0]).toMatchObject({ approvalId, sessionKey: key, decision: 'allow', answers: { [nativeId]: [answer] } });
  expect(responses[0]).not.toHaveProperty('message');
});

test('an unadvertised Hermes question stays gated and repeated history repair cannot poll profiles indefinitely', async () => {
  capabilities!.questions = false; await pair();
  commandHandler = input => input.type === 'session.open' ? { ok: true, result: { session: info(), events: [{
    type: 'approval.request', deviceId: 'pc', sessionKey: 'hermes:original', tool: 'hermes', ts: Date.now(), approvalId: 'q',
    kind: 'question', title: 'Hermes 需要补充信息', questionMode: 'hermes', questions: [{ id: 'native', question: 'Text?',
      inputType: 'text', required: true, allowCustom: true }], approvalOptions: { version: 1, decisions: ['allow'] },
  }] } } : defaultCommand(input);
  await openSession('pc', 'hermes:original');
  await openSession('pc', 'hermes:original', { background: true });
  await openSession('pc', 'hermes:original');
  expect(commands.filter(input => input.type === 'agents.status')).toHaveLength(2);
  await expect(respondApproval({ approvalId: 'q', deviceId: 'pc', sessionKey: 'hermes:original' }, 'allow', undefined, { native: ['text'] }))
    .rejects.toMatchObject({ code: 'agent_capability_unavailable' });
  expect(commands.some(input => input.type === 'approval.respond')).toBe(false);
  capabilities!.questions = true;
  await openSession('pc', 'hermes:original', { refreshAgentProfile: true });
  expect(commands.filter(input => input.type === 'agents.status')).toHaveLength(3);
  expect(getRemoteState().agents.pc.list.find(profile => profile.id === 'hermes')?.capabilities?.questions).toBe(true);
});

test('a post-open Hermes profile read failure preserves the successful snapshot and never restarts creation', async () => {
  capabilities!.questions = false; await pair();
  commandHandler = input => input.type === 'agents.status'
    ? { ok: false, error: 'status temporarily unavailable', code: 'agent_unavailable' } : defaultCommand(input);
  const key = await startSession('pc', { tool: 'hermes', cwd: 'C:/fixture', prompt: 'synthetic', approval: 'ask' });
  await expect(openSession('pc', key)).resolves.toBeUndefined();
  expect(getRemoteState().timelines[timelineKey('pc', key)]).toMatchObject({ session: { sessionKey: key }, loading: false });
  expect(getRemoteState().timelines[timelineKey('pc', key)].error).toBeUndefined();
  expect(getRemoteState().agents.pc.list.find(profile => profile.id === 'hermes')?.capabilities?.questions).toBe(false);
  await openSession('pc', key, { background: true });
  expect(commands.filter(input => input.type === 'session.start')).toHaveLength(1);
  expect(commands.filter(input => input.type === 'agents.status')).toHaveLength(2);
});

test('a creation-only model capability accepts the first turn but refuses later overrides and effort', async () => {
  capabilities!.modelOverride=false;capabilities!.startModelOverride=true;await pair();
  await expect(startSession('pc',{tool:'hermes',cwd:'C:/fixture',prompt:'synthetic',approval:'ask',model:'synthetic-model'})).resolves.toBe('hermes:created');
  expect(commands.find(input=>input.type==='session.start')).toMatchObject({tool:'hermes',model:'synthetic-model',accountId:account});
  const before=commands.length;
  await expect(sendToSession('pc','hermes:original','next',{model:'synthetic-model'})).rejects.toMatchObject({code:'agent_capability_unavailable'});
  await expect(startSession('pc',{tool:'hermes',cwd:'C:/fixture',prompt:'synthetic',approval:'ask',model:'synthetic-model',effort:'high'})).rejects.toMatchObject({code:'agent_capability_unavailable'});
  expect(commands).toHaveLength(before);
});

test('extension directories and new tasks keep their registered namespace and exact account despite a shared API family', async () => {
  await pair(); await loadSessions('pc', 'hermes');
  expect(commands.find(input => input.type === 'sessions.list')).toMatchObject({ tool: 'hermes', limit: 10 });
  expect(commands.find(input => input.type === 'sessions.list')).not.toHaveProperty('client');
  expect(getRemoteState().sessions.pc.list.map(item => item.sessionKey)).toEqual(['hermes:original']);
  expect(await startSession('pc', { tool: 'hermes', cwd: 'C:/fixture', prompt: 'synthetic', approval: 'ask' })).toBe('hermes:created');
  expect(commands.find(input => input.type === 'session.start')).toMatchObject({ tool: 'hermes', accountId: account });
  await sendToSession('pc', 'hermes:original', 'continue synthetic');
  expect(commands.find(input => input.type === 'session.send')).toMatchObject({ sessionKey: 'hermes:original', accountId: account });
});

test('extension absence and omitted capabilities never inherit a built-in action contract', async () => {
  await pair(false); const before = commands.length;
  await expect(loadSessions('pc', 'hermes')).rejects.toMatchObject({ code: 'agent_capability_unavailable' });
  await expect(startSession('pc', { tool: 'hermes', cwd: 'C:/fixture', prompt: 'synthetic', approval: 'ask' })).rejects.toMatchObject({ code: 'agent_capability_unavailable' });
  expect(commands).toHaveLength(before);
  capabilities = undefined; await loadAgentProfiles('pc');
  await expect(sendToSession('pc', 'hermes:original', 'synthetic')).rejects.toMatchObject({ code: 'agent_capability_unavailable' });
  expect(commands.some(input => input.type === 'session.send')).toBe(false);
});

test.each(['send', 'interrupt', 'approval', 'questions', 'modelOverride', 'attachments', 'imageInput'] as const)('explicit capability %s is enforced before a side effect', async capability => {
  capabilities![capability] = false; await pair(); const before = commands.length;
  const operation = capability === 'interrupt' ? interruptSession('pc', 'hermes:original')
    : capability === 'approval' || capability === 'questions' ? respondApproval({ approvalId: 'q', deviceId: 'pc', sessionKey: 'hermes:original' }, 'allow', undefined, capability === 'questions' ? { choice: ['A'] } : undefined)
    : startSession('pc', { tool: 'hermes', cwd: 'C:/fixture', prompt: 'synthetic', approval: 'ask', ...(capability === 'modelOverride' ? { model: 'synthetic' } : {}),
      ...(capability === 'attachments' || capability === 'imageInput' ? { images: [{ uri: 'file://synthetic', base64: 'YQ==', mime: 'image/png' as const, width: 1, height: 1 }] } : {}) });
  await expect(operation).rejects.toMatchObject({ code: 'agent_capability_unavailable' });
  expect(commands).toHaveLength(before);
});

test('foreign snapshot metadata is rejected and wrong-tool history/incremental messages cannot poison a matching key', async () => {
  await pair();
  commandHandler = input => input.type === 'session.open' ? { ok: true, result: { session: { ...info(), tool: 'claude' }, events: [] } } : defaultCommand(input);
  await expect(openSession('pc', 'hermes:original')).rejects.toThrow('会话身份');
  commandHandler = input => input.type === 'session.open' ? { ok: true, result: { session: info(), events: [
    { type: 'message', deviceId: 'pc', sessionKey: 'hermes:original', tool: 'claude', id: 'foreign-history', role: 'assistant', text: 'wrong history', ts: 1, final: true },
  ] } } : defaultCommand(input);
  await openSession('pc', 'hermes:original');
  eventRows = [
    { type: 'session.updated', deviceId: 'pc', sessionKey: 'hermes:original', tool: 'hermes', seq: 1, ts: 1, session: { ...info(), tool: 'claude', cwd: 'C:/foreign' } },
    { type: 'message', deviceId: 'pc', sessionKey: 'hermes:original', tool: 'claude', seq: 2, id: 'foreign-live', role: 'assistant', text: 'wrong live', ts: 2, final: true },
    { type: 'message', deviceId: 'pc', sessionKey: 'hermes:original', tool: 'hermes', seq: 3, id: 'own-live', role: 'assistant', text: 'correct live', ts: 3, final: true },
  ];
  await syncSessionEvents('pc', 'hermes:original');
  expect(getRemoteState().timelines[timelineKey('pc', 'hermes:original')].session).toMatchObject({ tool: 'hermes', cwd: 'C:/fixture' });
  expect(getRemoteState().timelines[timelineKey('pc', 'hermes:original')].items.map(item => item.id)).toEqual(['own-live']);
});

test('API mutation invalidates every model catalog in the declared family including late refills', async () => {
  await pair(); await listModels('pc', 'hermes'); await listModels('pc', 'helper');
  let release!: (value: unknown) => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  commandHandler = input => input.type === 'models.list' ? (entered(), new Promise(resolve => { release = resolve; })) : defaultCommand(input);
  const delayed = listModels('pc', 'helper'); await started; account = 'api_22222222';
  await setAgentApi('pc', 'hermes', account);
  expect(cachedModels('pc', 'hermes')).toBeUndefined(); expect(cachedModels('pc', 'helper')).toBeUndefined();
  release({ ok: true, result: { models: ['stale-model'] } }); await expect(delayed).rejects.toThrow('API');
  expect(cachedModels('pc', 'helper')).toBeUndefined();
});

test('extension selection is remembered without treating arbitrary desktop suffixes as another API family', async () => {
  await pair(); await rememberAgent('hermes'); expect(await lastAgent()).toBe('hermes');
  await rememberAgent('invalid:agent'); expect(await lastAgent()).toBe('hermes');
});

test('model directories do not require override permission, but explicit API model changes do', async () => {
  capabilities!.modelOverride = false; await pair();
  expect((await listModels('pc', 'hermes')).models).toEqual(['synthetic-model']);
  const before = commands.length;
  await expect(setAgentApi('pc', 'hermes', account, 'explicit-model')).rejects.toMatchObject({ code: 'agent_capability_unavailable' });
  expect(commands).toHaveLength(before);
  await setAgentApi('pc', 'hermes', account);
  expect(commands[commands.length - 1]).toMatchObject({ type: 'agents.api.set', agent: 'hermes', accountId: account });
});

test.each(['list', 'read'] as const)('explicit %s denial blocks its snapshot operation', async capability => {
  capabilities![capability] = false; await pair(); const before = commands.length;
  await expect(capability === 'list' ? loadSessions('pc', 'hermes') : openSession('pc', 'hermes:original')).rejects.toMatchObject({ code: 'agent_capability_unavailable' });
  expect(commands).toHaveLength(before);
});

test.each(['desktop', 'read-only'] as const)('extension %s snapshot claims cannot enter native history', async controlSurface => {
  await pair(); commandHandler = input => input.type === 'session.open' ? { ok: true, result: { session: { ...info(), controlSurface }, events: [] } } : defaultCommand(input);
  await expect(openSession('pc', 'hermes:original')).rejects.toThrow('会话身份');
  const before = commands.length;
  await expect(openSession('pc', 'hermes:original', { controlSurface: 'desktop' })).rejects.toMatchObject({ code: 'agent_capability_unavailable' });
  await expect(sendToSession('pc', 'hermes:original', 'synthetic', { surface: 'desktop' })).rejects.toMatchObject({ code: 'agent_capability_unavailable' });
  expect(commands).toHaveLength(before);
});

test('a foreign new-task namespace is rejected instead of mounting the wrong conversation', async () => {
  await pair(); commandHandler = input => input.type === 'session.start' ? { ok: true, result: { sessionKey: 'claude:foreign' } } : defaultCommand(input);
  await expect(startSession('pc', { tool: 'hermes', cwd: 'C:/fixture', prompt: 'synthetic', approval: 'ask' })).rejects.toMatchObject({ name: 'DeliveryPendingError', retryable: false });
  expect(getRemoteState().timelines[timelineKey('pc', 'claude:foreign')]).toBeUndefined();
});

test('an accepted extension answer immediately resolves its own pending question', async () => {
  await pair(); commandHandler = input => input.type === 'session.open' ? { ok: true, result: { session: info(), events: [
    { type: 'approval.request', deviceId: 'pc', sessionKey: 'hermes:original', tool: 'hermes', ts: Date.now(), approvalId: 'q', kind: 'question', title: 'Synthetic question' },
  ] } } : defaultCommand(input);
  await openSession('pc', 'hermes:original'); expect(getRemoteState().approvals[approvalStateKey('pc', 'hermes:original', 'q')]).toBeDefined();
  await respondApproval({ approvalId: 'q', deviceId: 'pc', sessionKey: 'hermes:original' }, 'allow', undefined, { choice: ['A'] });
  expect(getRemoteState().approvals[approvalStateKey('pc', 'hermes:original', 'q')]).toBeUndefined();
  expect(getRemoteState().timelines[timelineKey('pc', 'hermes:original')].items.find(item => item.kind === 'approval')).toMatchObject({ state: 'allow' });
});

test.each(['baseline', 'snapshot'] as const)('read capability revoked during %s prevents late snapshot publication', async stage => {
  await pair(); let release!: (value: unknown) => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  if (stage === 'baseline') readEvents = () => (entered(), new Promise(resolve => { release = resolve; }));
  else commandHandler = input => input.type === 'session.open' ? (entered(), new Promise(resolve => { release = resolve; })) : defaultCommand(input);
  const pending = openSession('pc', 'hermes:original'); await started;
  capabilities!.read = false; await loadAgentProfiles('pc');
  release(stage === 'baseline' ? { events: [], nextSeq: 0, lastSeq: 0, hasMore: false }
    : { ok: true, result: { session: info(), events: [{ type: 'message', deviceId: 'pc', sessionKey: 'hermes:original', tool: 'hermes', id: 'late', role: 'assistant', text: 'late snapshot', ts: 1 }] } });
  await expect(pending).rejects.toMatchObject({ code: 'agent_capability_unavailable' });
  if (stage === 'baseline') expect(commands.some(input => input.type === 'session.open')).toBe(false);
  expect(getRemoteState().timelines[timelineKey('pc', 'hermes:original')].items).toEqual([]);
});

test.each(['question', '__proto__'])('identical request ID %s remains isolated across adapter conversations', async approvalId => {
  await pair();
  commandHandler = input => input.type === 'session.open' ? { ok: true, result: { session: info(String(input.sessionKey).split(':')[0]), events: [
    { type: 'approval.request', deviceId: 'pc', sessionKey: input.sessionKey, tool: String(input.sessionKey).split(':')[0], ts: Date.now(), approvalId, kind: 'question', title: 'Synthetic question' },
  ] } } : defaultCommand(input);
  await openSession('pc', 'hermes:original'); await openSession('pc', 'helper:original');
  expect(Object.values(getRemoteState().approvals).map(item => item.sessionKey).sort()).toEqual(['helper:original', 'hermes:original']);
  await respondApproval({ approvalId, deviceId: 'pc', sessionKey: 'hermes:original' }, 'allow', undefined, { choice: ['A'] });
  expect(Object.values(getRemoteState().approvals).map(item => item.sessionKey)).toEqual(['helper:original']);
  expect(getRemoteState().timelines[timelineKey('pc', 'helper:original')].items.find(item => item.kind === 'approval')).toMatchObject({ state: 'pending' });
  await openSession('pc', 'hermes:original');
  expect(getRemoteState().approvals[approvalStateKey('pc', 'helper:original', approvalId)]).toBeDefined();
});

test('an extension named all cannot collide with the aggregate directory request slot', async () => {
  adapterIds = ['all']; await pair(); let release!: (value: unknown) => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  commandHandler = input => input.type === 'sessions.list' && input.tool === 'all' ? (entered(), new Promise(resolve => { release = resolve; })) : defaultCommand(input);
  const pending = loadSessions('pc', 'all'); await started; await loadSessions('pc');
  release({ ok: true, result: { sessions: [info('all')] } }); await pending;
  expect(getRemoteState().sessions.pc.pages?.all?.loading).toBe(false);
  expect(getRemoteState().sessions.pc.list.some(item => item.sessionKey === 'all:original')).toBe(true);
});

test.each(['directory', 'incremental'] as const)('late %s replies respect revoked adapter capability', async stage => {
  await pair(); let release!: (value: unknown) => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  if (stage === 'incremental') {
    await openSession('pc', 'hermes:original');
    readEvents = () => (entered(), new Promise(resolve => { release = resolve; }));
  } else commandHandler = input => input.type === 'sessions.list' ? (entered(), new Promise(resolve => { release = resolve; })) : defaultCommand(input);
  const pending = stage === 'directory' ? loadSessions('pc', 'hermes') : syncSessionEvents('pc', 'hermes:original');
  await started; capabilities![stage === 'directory' ? 'list' : 'read'] = false; await loadAgentProfiles('pc');
  release(stage === 'directory' ? { ok: true, result: { sessions: [info()] } }
    : { events: [{ type: 'message', deviceId: 'pc', sessionKey: 'hermes:original', tool: 'hermes', id: 'revoked', role: 'assistant', text: 'revoked', ts: 1, seq: 1 }], nextSeq: 1, lastSeq: 2, hasMore: true });
  await expect(pending).rejects.toMatchObject({ code: 'agent_capability_unavailable' });
  if (stage === 'directory') expect(getRemoteState().sessions.pc.list).toEqual([]);
  else expect(getRemoteState().timelines[timelineKey('pc', 'hermes:original')].items).toEqual([]);
});

test.each(['retry', 'foreign-family-receipt'] as const)('a persisted extension handover retains exact identity during %s', async scenario => {
  const other = 'https://aggregation-backup.example/salcara-hub/v1';
  const operationId = '10000000-0000-4000-8000-000000000001';
  setHubFetch((async (endpoint, init) => {
    if (endpoint.endsWith('/ping')) return response({ service: 'salcara-hub', protocol: 'salcara-remote', protocolVersion: 1, authModes: ['device-pairing'], capabilities: ['device.identity.v1', 'pair.qr.v1', 'session.remote.v1', 'pair.revoke.v1', 'commands.idempotency.v1', 'pair.single-phone.v1'] });
    if (endpoint.endsWith('/app/pair/qr')) return response({ pair_token: 'a'.repeat(64), computerId: 'physical-fixture', device });
    if (endpoint.endsWith('/app/devices')) return response({ devices: [device] });
    if (endpoint.endsWith('/app/commands')) {
      const input = JSON.parse(String(init.body)).command; commands.push(input);
      if (scenario === 'foreign-family-receipt' && endpoint.startsWith(other) && input.type === 'remote.station.receipt') return response({ ok: true, result: {
        committed: true, operationId, payloadHash: createHash('sha256').update([other, 'pc', 'physical-fixture', 'hermes', account, '', ''].join('\u0000') + '\u0000source-only-v1').digest('hex'), hubUrl: other, deviceId: 'pc',
      } });
      if (scenario === 'foreign-family-receipt' && endpoint.startsWith(other) && input.type === 'agents.status') return response({ ok: true, result: {
        agents: status().agents.filter(agent => agent.id === 'helper').map(agent => ({ ...agent, apiFamily: 'hermes' })),
      } });
      return response(defaultCommand(input));
    }
    return response({ events: [], nextSeq: 0, lastSeq: 0, hasMore: false });
  }) as FetchLike);
  await bootRemote([]);
  const qr = (url: string) => parseScannedRemoteQr(JSON.stringify({ type: 'salcara-remote-pair', version: 1, hubUrl: url, deviceId: 'pc', computerId: 'physical-fixture', deviceName: 'Fixture', ticket: 'b'.repeat(64), expiresAt: Date.now() + 120000 }));
  await pairScannedRemoteQr(qr(hubUrl)); const fromConnectionId = getRemoteState().connectionId!;
  await pairScannedRemoteQr(qr(other)); const targetConnectionId = getRemoteState().connectionId!;
  await useSavedConnection(fromConnectionId, true);
  mockSettings.set('remote_station_handover_v1', JSON.stringify({ operationId, fromConnectionId, targetConnectionId, deviceId: 'pc', createdAt: Date.now(), agent: 'hermes', accountId: account, sourceOnly: true }));
  if (scenario === 'foreign-family-receipt') {
    resetRemoteForTests(); await bootRemote([]);
    expect(getRemoteState().connectionId).toBe(fromConnectionId);
    expect(mockSettings.has('remote_station_handover_v1')).toBe(true);
    expect(commands.some(input => input.type === 'remote.station.receipt')).toBe(true);
    return;
  }
  await useSavedConnection(targetConnectionId);
  expect(commands.find(input => input.type === 'remote.station.switch')).toMatchObject({ operationId, agent: 'hermes', accountId: account, sourceOnly: true });
  expect(getRemoteState().connectionId).toBe(targetConnectionId);
  expect(mockSettings.has('remote_station_handover_v1')).toBe(false);
});
