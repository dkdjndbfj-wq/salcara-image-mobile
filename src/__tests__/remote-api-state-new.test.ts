import { setHubFetch, type FetchLike, type HubEvent } from '../remote/client';
import { bootRemote, cachedModels, connectStation, getRemoteState, listModels, loadAgentProfiles, onApprovalAlert, openSession, pairRemoteQr, parseRemoteQr, remoteDeliveryScope, resetRemoteForTests, respondApproval, sendToSession, setAgentApi, startSession, syncSessionEvents, timelineKey } from '../remote/store';
import { resetDeliveryForTests } from '../remote/delivery';

const mockSettings = new Map<string, string>();
const mockSecrets = new Map<string, string>();
let mockUuid = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `0199aaa1-1234-4678-9abc-${String(++mockUuid).padStart(12, '0')}` }));
jest.mock('../storage/database', () => ({ getSetting: async (key: string) => mockSettings.get(key) ?? null,
  setSetting: async (key: string, value: string | null) => { if (value === null) mockSettings.delete(key); else mockSettings.set(key, value); } }));
jest.mock('../storage/secure-keys', () => ({ getProviderKey: async () => null }));
jest.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'this-device-only',
  getItemAsync: async (key: string) => mockSecrets.get(key) ?? null, setItemAsync: async (key: string, value: string) => { mockSecrets.set(key, value); },
  deleteItemAsync: async (key: string) => { mockSecrets.delete(key); } }));
const origin = 'https://fixture.example';
const hubUrl = `${origin}/salcara-hub/v1`;
const device = { deviceId: 'pc', name: 'Fixture', os: 'windows', tools: [], projects: [], online: true, lastSeen: 1 };
const session = { sessionKey: 'codex:original', tool: 'codex', client: 'Codex App', title: '原对话', cwd: 'C:\\fixture', updatedAt: 1, status: 'idle', controllable: true };
const response = (value: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });
const status = (codex = '原 API', claude = '原 Claude') => ({ agents: [
  { id: 'codex', available: true, api: { name: codex, model: codex === '备用' ? 'deepseek-chat' : 'gpt-5-codex', source: 'phone', configured: true, accountId: codex === '备用' ? 'api_22222222' : 'api_11111111' } },
  { id: 'claude', available: true, api: { name: claude, model: 'claude-sonnet', source: 'phone', configured: true, accountId: 'api_33333333' } },
] });
function transport(handler: (url: URL, command?: Record<string, unknown>) => unknown | Promise<unknown>): FetchLike {
  return (async (endpoint, init) => {
    if (endpoint.endsWith('/ping')) return response({ service: 'salcara-hub', protocol: 'salcara-remote', protocolVersion: 1, authModes: ['device-pairing'], capabilities: ['device.identity.v1', 'pair.qr.v1', 'session.remote.v1', 'pair.revoke.v1', 'events.cursor.v1', 'commands.idempotency.v1'] });
    if (endpoint.endsWith('/app/pair/qr')) return response({ pair_token: 'a'.repeat(64), device });
    if (endpoint.endsWith('/app/devices')) return response({ devices: [device] });
    return response(await handler(new URL(endpoint), endpoint.endsWith('/app/commands') ? JSON.parse(String(init.body)).command : undefined));
  }) as FetchLike;
}
async function waitForReady(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('fixture did not reach the expected command');
}

test('question retry carries the same receipt UUID and exact answers to the durable Hub', async () => {
  const writes: Array<Record<string, unknown>> = [];
  const base = transport(() => ({ ok: true, result: {} }));
  setHubFetch(async (endpoint, init) => {
    if (endpoint.endsWith('/app/commands')) {
      const body = JSON.parse(String(init.body));
      if (body.command?.type === 'approval.respond') {
        writes.push(body); if (writes.length === 1) throw new Error('fixture lost acknowledgement');
      }
    }
    return base(endpoint, init);
  });
  await pair();
  const target = { approvalId: 'q', deviceId: 'pc', sessionKey: 'codex:original' };
  const receipt = { requestId: '0199aaa1-1234-4678-9abc-000000000001', retrying: false, scope: remoteDeliveryScope(), signal: new AbortController().signal };
  await expect(respondApproval(target, 'allow', undefined, { choice: [' A '] }, receipt)).rejects.toMatchObject({ status: 0 });
  await respondApproval(target, 'allow', undefined, { choice: [' A '] }, { ...receipt, retrying: true });
  expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
  expect(writes[1]).toMatchObject({ requestId: receipt.requestId, command: { answers: { choice: [' A '] } } });
});

test('a Hub without durable receipts refuses automatic question redispatch', async () => {
  let writes = 0;
  const base = transport(() => ({ ok: true, result: {} }));
  setHubFetch(async (endpoint, init) => {
    if (endpoint.endsWith('/ping')) return response({ service: 'salcara-hub', protocol: 'salcara-remote', protocolVersion: 1, authModes: ['device-pairing'], capabilities: ['device.identity.v1', 'pair.qr.v1', 'session.remote.v1', 'pair.revoke.v1'] });
    if (endpoint.endsWith('/app/commands') && JSON.parse(String(init.body)).command?.type === 'approval.respond') writes += 1;
    return base(endpoint, init);
  });
  await pair();
  await expect(respondApproval({ approvalId: 'q', deviceId: 'pc', sessionKey: 'codex:original' }, 'allow', undefined, { choice: ['A'] },
    { requestId: '0199aaa1-1234-4678-9abc-000000000001', retrying: true, scope: remoteDeliveryScope(), signal: new AbortController().signal })).rejects.toMatchObject({ code: 'question_retry_unsupported' });
  expect(writes).toBe(0);
});

test.each(['scope', 'cancel', 'expired'] as const)('stale question delivery cannot issue a command: %s', async (reason) => {
  let writes = 0;
  setHubFetch(transport((_url, command) => { if (command?.type === 'approval.respond') writes += 1; return { ok: true, result: {} }; }));
  await pair();
  const controller = new AbortController(); if (reason === 'cancel') controller.abort();
  await expect(respondApproval({ approvalId: 'q', deviceId: 'pc', sessionKey: 'codex:original' }, 'allow', undefined, { choice: ['A'] }, {
    requestId: '0199aaa1-1234-4678-9abc-000000000001', retrying: false,
    scope: reason === 'scope' ? 'another-station|credential' : remoteDeliveryScope(), signal: controller.signal,
    ...(reason === 'expired' ? { expiresAt: Date.now() - 1 } : {}),
  })).rejects.toMatchObject({ code: reason === 'expired' ? 'question_expired' : 'request_scope_changed' });
  expect(writes).toBe(0);
});
async function pair() {
  await bootRemote([]); await connectStation(origin);
  await pairRemoteQr(parseRemoteQr(JSON.stringify({ type: 'salcara-remote-pair', version: 1, hubUrl, deviceId: 'pc', deviceName: 'Fixture', ticket: 'b'.repeat(64), expiresAt: Date.now() + 120000 })));
}
beforeEach(() => { resetRemoteForTests(); mockSettings.clear(); mockSecrets.clear(); mockUuid = 0; });
afterEach(() => { resetRemoteForTests(); setHubFetch(null); });

test('actual native hook approval preserves the desktop executor and UUID, never sends a CLI answer', async () => {
  const commands: Record<string, unknown>[] = [];
  const native = { ...session, controlSurface: 'desktop' };
  const approvalId = '11111111-2222-4333-8444-555555555555';
  setHubFetch(transport((url, command) => {
    if (command) commands.push(command);
    if (url.pathname.endsWith('/events')) return { events: [], nextSeq: 0, lastSeq: 0, hasMore: false };
    if (command?.type === 'session.open') return { ok: true, result: { session: native, events: [{ type: 'approval.request', approvalId,
      deviceId: 'pc', sessionKey: session.sessionKey, tool: 'codex', ts: Date.now(), kind: 'command', title: 'Bash', expiresAt: Date.now() + 60000, approvalTransport: 'codex-hook-v1' }] } };
    return { ok: true, result: { accepted: true } };
  }));
  await pair(); await openSession('pc', session.sessionKey);
  const target = { approvalId, deviceId: 'pc', sessionKey: session.sessionKey, controlSurface: 'desktop' as const };
  await expect(respondApproval(target, 'allow_session')).rejects.toMatchObject({ code: 'desktop_capability_unavailable' });
  await expect(respondApproval(target, 'allow', undefined, { question: ['not a permission'] })).rejects.toMatchObject({ code: 'desktop_capability_unavailable' });
  await respondApproval(target, 'allow');
  const command = commands.find(value => value.type === 'desktop.approval.respond');
  expect(command).toMatchObject({ sessionKey: session.sessionKey, approvalId, controlSurface: 'desktop', decision: 'allow', operationId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  expect(commands.some(value => value.type === 'approval.respond')).toBe(false);
  expect(getRemoteState().timelines[timelineKey('pc', session.sessionKey)].items.find(item => item.kind === 'approval')).toMatchObject({ state: 'allow', by: 'phone' });
});

test('native approvals without an actual trusted hook item stay disabled even after the lease disappears', async () => {
  let writes = 0;
  setHubFetch(transport(() => { writes++; return { ok: true, result: {} }; })); await pair();
  const before = writes;
  await expect(respondApproval({ approvalId: 'old', deviceId: 'pc', sessionKey: session.sessionKey, controlSurface: 'desktop' }, 'allow')).rejects.toMatchObject({ code: 'desktop_capability_unavailable' });
  expect(writes).toBe(before);
});

test('conversation API mutation clears old model catalog and rejects its delayed refill', async () => {
  let release!: (value: unknown) => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const commands: Record<string, unknown>[] = [];
  setHubFetch(transport((_url, command) => {
    if (command?.type === 'models.list') { started(); return new Promise((resolve) => { release = resolve; }); }
    if (command?.type === 'agents.api.set') { commands.push(command); return { ok: true, result: status('备用') }; }
    return { ok: true, result: status() };
  }));
  await pair(); await loadAgentProfiles('pc');
  const oldModels = listModels('pc', 'codex').catch((error) => error);
  await entered;
  const selected = await setAgentApi('pc', 'codex', 'api_22222222', '', session.sessionKey);
  expect(selected?.api.model).toBe('deepseek-chat');
  release({ ok: true, result: { models: ['old-model'], api: '原 API' } });
  expect((await oldModels).message).toMatch(/API 或连接已切换/);
  expect(cachedModels('pc', 'codex')).toBeUndefined();
  expect(commands).toEqual([{ type: 'agents.api.set', agent: 'codex', accountId: 'api_22222222', sessionKey: session.sessionKey }]);
  expect(getRemoteState().agents.pc.list.find((item) => item.id === 'codex')?.api.name).toBe('备用');
});

test('a status read begun during the mutation cannot later restore the old API card', async () => {
  let releaseMutation!: (value: unknown) => void, releaseStatus!: (value: unknown) => void;
  setHubFetch(transport((_url, command) => command?.type === 'agents.api.set'
    ? new Promise((resolve) => { releaseMutation = resolve; }) : new Promise((resolve) => { releaseStatus = resolve; })));
  await pair();
  const mutation = setAgentApi('pc', 'codex', 'api_22222222');
  await Promise.resolve();
  const read = loadAgentProfiles('pc'); await Promise.resolve();
  await waitForReady(() => typeof releaseMutation === 'function' && typeof releaseStatus === 'function');
  releaseMutation({ ok: true, result: status('备用') }); await mutation;
  releaseStatus({ ok: true, result: status() }); await read;
  expect(getRemoteState().agents.pc.list.find((item) => item.id === 'codex')?.api.name).toBe('备用');
});

test('API changes on one computer are serialized across Agent families', async () => {
  const releases = new Map<string, (value: unknown) => void>();
  setHubFetch(transport((_url, command) => new Promise((resolve) => { releases.set(String(command?.agent), resolve); })));
  await pair();
  const first = setAgentApi('pc', 'codex', 'api_22222222').catch((error) => error); await Promise.resolve();
  await waitForReady(() => releases.has('codex'));
  await expect(setAgentApi('pc', 'claude', 'api_33333333')).rejects.toThrow('API 正在切换');
  expect(releases.has('claude')).toBe(false);
  releases.get('codex')!({ ok: true, result: status('备用', '原 Claude') });
  await first;
  const second = setAgentApi('pc', 'claude', 'api_33333333'); await Promise.resolve();
  await waitForReady(() => releases.has('claude'));
  releases.get('claude')!({ ok: true, result: status('备用', '新 Claude') }); await second;
  expect(getRemoteState().agents.pc.list.find((item) => item.id === 'claude')?.api.name).toBe('新 Claude');
});

test('resolved or expired replay never resurrects a phone approval badge or alert', async () => {
  let events: HubEvent[] = [];
  const request = (seq: number, expiresAt: number): Extract<HubEvent, { type: 'approval.request' }> => ({ type: 'approval.request', deviceId: 'pc', sessionKey: session.sessionKey, tool: 'codex', seq, ts: Date.now(), approvalId: 'q', kind: 'question', title: '问题', questions: [{ id: 'choice', question: '选哪个' }], expiresAt });
  setHubFetch(transport((url, command) => command ? { ok: true, result: { session, events: [] } }
    : url.searchParams.get('limit') === '1' ? { events: [], nextSeq: 0, lastSeq: 0 }
      : { events, nextSeq: events.at(-1)?.seq ?? Number(url.searchParams.get('after') ?? 0), lastSeq: events.at(-1)?.seq ?? 0 }));
  await pair(); await openSession('pc', session.sessionKey);
  const alert = jest.fn(); const unlisten = onApprovalAlert(alert);
  events = [request(1, Date.now() + 60000)]; await syncSessionEvents('pc', session.sessionKey);
  expect(getRemoteState().approvals.q).toBeTruthy();
  events = [{ type: 'approval.resolved', deviceId: 'pc', sessionKey: session.sessionKey, tool: 'codex', seq: 2, ts: Date.now(), approvalId: 'q', decision: 'allow', by: 'phone' }];
  await syncSessionEvents('pc', session.sessionKey); const count = alert.mock.calls.length;
  events = [request(3, Date.now() + 60000)]; await syncSessionEvents('pc', session.sessionKey);
  expect(getRemoteState().approvals.q).toBeUndefined(); expect(alert).toHaveBeenCalledTimes(count);
  events = [{ ...request(4, Date.now() + 60000), approvalId: 'expires' }]; await syncSessionEvents('pc', session.sessionKey);
  expect(getRemoteState().approvals.expires).toBeTruthy();
  events = [{ ...request(5, Date.now() - 1), approvalId: 'expires' }]; await syncSessionEvents('pc', session.sessionKey);
  expect(getRemoteState().approvals.expires).toBeUndefined(); unlisten();
});

test('after a lost reply, retry keeps the original receipt model and effort even across local restart', async () => {
  const sends: Record<string, unknown>[] = [];
  setHubFetch(transport((_url, command) => {
    if (command?.type === 'session.send') {
      sends.push(command);
      if (sends.length === 1) throw new Error('network disconnected');
      return { ok: true, result: {} };
    }
    return {};
  }));
  await pair();
  await expect(sendToSession('pc', session.sessionKey, '同一个任务', { model: 'deepseek-chat', effort: 'high' })).rejects.toMatchObject({ retryable: true });
  const persisted = JSON.parse(mockSettings.get('remote_pending_delivery_v1')!);
  expect(persisted[0].sendOptions).toEqual({ model: 'deepseek-chat', effort: 'high' });
  const requestId = persisted[0].requestId;
  await expect(setAgentApi('pc', 'codex', 'api_22222222', '', session.sessionKey)).rejects.toThrow('先核对待确认消息');
  resetDeliveryForTests();
  await sendToSession('pc', session.sessionKey, '同一个任务', { model: 'gpt-5-codex', effort: 'low' });
  expect(sends).toHaveLength(2);
  expect(sends[1]).toEqual(sends[0]);
  expect([...mockSettings.values()].join()).not.toContain(requestId);
});

test('definitive provider rejection clears optimistic running so changing API remains available', async () => {
  setHubFetch(transport((url, command) => command?.type === 'session.send' ? { ok: false, error: 'model_not_found' }
    : command ? { ok: true, result: { session, events: [] } } : { events: [], nextSeq: 0, lastSeq: 0 }));
  await pair(); await openSession('pc', session.sessionKey);
  await expect(sendToSession('pc', session.sessionKey, '测试接口')).rejects.toMatchObject({ message: 'model_not_found' });
  const timeline = getRemoteState().timelines[timelineKey('pc', session.sessionKey)];
  expect(timeline.session?.status).toBe('idle');
  expect(timeline.items).toHaveLength(0);
});

test('the original desktop executor and operation UUID survive a lost reply and restart', async () => {
  const sends: Record<string, unknown>[] = [];
  setHubFetch(transport((_url, command) => {
    if (command?.type === 'session.send') { sends.push(command); if (sends.length === 1) throw new Error('lost acknowledgement'); }
    return { ok: true, result: {} };
  }));
  await pair();
  await expect(sendToSession('pc', session.sessionKey, 'native task', { surface: 'desktop' })).rejects.toMatchObject({ retryable: true });
  resetDeliveryForTests();
  await sendToSession('pc', session.sessionKey, 'native task', { surface: 'cli' });
  expect(sends[1]).toEqual(sends[0]); expect(sends[1]).toMatchObject({ controlSurface: 'desktop', operationId: expect.any(String) });
});

test('unmounted API pickers cannot bypass the store lock to send or start another mutation', async () => {
  let release!: (value: unknown) => void; let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const writes: string[] = [];
  setHubFetch(transport((_url, command) => {
    writes.push(String(command?.type));
    if (command?.type === 'agents.api.set') { entered(); return new Promise(resolve => { release = resolve; }); }
    return { ok: true, result: {} };
  }));
  await pair(); const mutation = setAgentApi('pc', 'codex', 'api_22222222'); await started;
  await expect(sendToSession('pc', session.sessionKey, 'too early')).rejects.toThrow('API 正在切换');
  await expect(setAgentApi('pc', 'codex', 'api_33333333')).rejects.toThrow('API 正在切换');
  expect(writes).toEqual(['agents.api.set']); release({ ok: true, result: status('备用') }); await mutation;
});

test('API mutation during image upload prevents a new task from dispatching with mixed configuration', async () => {
  let releaseImage!: (value: unknown) => void, releaseApi!: (value: unknown) => void, entered!: () => void;
  const uploaded = new Promise<void>(resolve => { entered = resolve; }), writes: string[] = [];
  setHubFetch(transport((_url, command) => {
    writes.push(String(command?.type));
    if (command?.type === 'attachment.put') { entered(); return new Promise(resolve => { releaseImage = resolve; }); }
    if (command?.type === 'agents.api.set') return new Promise(resolve => { releaseApi = resolve; });
    return { ok: true, result: {} };
  }));
  await pair(); const start = startSession('pc', { tool: 'codex', cwd: 'C:\\fixture', prompt: 'task fixture', approval: 'ask',
    images: [{ uri: 'fixture://photo', base64: 'AQID', mime: 'image/jpeg', width: 1, height: 1 }] }); await uploaded;
  const mutation = setAgentApi('pc', 'codex', 'api_22222222');
  const startFailure = expect(start).rejects.toThrow('API 正在切换');
  releaseImage({ ok: true, result: {} });
  await startFailure;
  await waitForReady(() => typeof releaseApi === 'function');
  releaseApi({ ok: true, result: status('备用') }); await mutation;
  expect(writes).toEqual(['attachment.put', 'agents.api.set']);
});

test('disconnecting during attachment upload cannot dispatch the task through a later connection', async () => {
  let release!: (value: unknown) => void, entered!: () => void;
  const uploaded = new Promise<void>(resolve => { entered = resolve; }), writes: string[] = [];
  setHubFetch(transport((_url, command) => {
    writes.push(String(command?.type)); entered(); return new Promise(resolve => { release = resolve; });
  }));
  await pair(); const start = startSession('pc', { tool: 'codex', cwd: 'C:\\fixture', prompt: 'task fixture', approval: 'ask',
    images: [{ uri: 'fixture://photo', base64: 'AQID', mime: 'image/jpeg', width: 1, height: 1 }] }); await uploaded;
  resetRemoteForTests(); release({ ok: true, result: {} });
  await expect(start).rejects.toThrow('连接已切换'); expect(writes).toEqual(['attachment.put']);
});
