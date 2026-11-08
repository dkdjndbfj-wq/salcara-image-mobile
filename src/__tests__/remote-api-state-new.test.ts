import { setHubFetch, type FetchLike, type HubEvent } from '../remote/client';
import { approvalStateKey, bootRemote, cachedModels, connectStation, getRemoteState, listModels, loadAgentProfiles, onApprovalAlert, openSession, pairRemoteQr, parseRemoteQr, remoteDeliveryScope, resetRemoteForTests, respondApproval, sendToSession, setAgentApi, snapshotQuestionCommand, startSession, syncSessionEvents, timelineKey, type TimelineItem } from '../remote/store';
import { pendingDelivery, resetDeliveryForTests } from '../remote/delivery';
import * as FileSystem from 'expo-file-system/legacy';
import { sha256 } from '@noble/hashes/sha2.js';

const mockSettings = new Map<string, string>();
const mockSecrets = new Map<string, string>();
let mockUuid = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `0199aaa1-1234-4678-9abc-${String(++mockUuid).padStart(12, '0')}` }));
jest.mock('expo-file-system/legacy', () => ({ documentDirectory: 'file://private-documents/', EncodingType: { Base64: 'base64' },
  getInfoAsync: jest.fn(), readAsStringAsync: jest.fn(), makeDirectoryAsync: jest.fn(), copyAsync: jest.fn() }));
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
const nativeApprovalStatus = (approval = true) => ({ agents: [{ ...status().agents[0], desktopLive: {
  active: true, expiresAt: Date.now() + 60000, sessionKeys: ['codex:11111111-2222-4333-8444-555555555555'], approvalTransport: 'codex-hook-v1',
  capabilities: { list: true, read: true, send: true, approval, interrupt: false, attachments: false, modelOverride: false },
} }] });
function transport(handler: (url: URL, command?: Record<string, unknown>) => unknown | Promise<unknown>, extraCapabilities: string[] = []): FetchLike {
  return (async (endpoint, init) => {
    if (endpoint.endsWith('/ping')) return response({ service: 'salcara-hub', protocol: 'salcara-remote', protocolVersion: 1, authModes: ['device-pairing'], capabilities: ['device.identity.v1', 'pair.qr.v1', 'session.remote.v1', 'pair.revoke.v1', 'events.cursor.v1', 'commands.idempotency.v1', ...extraCapabilities] });
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

test('question recovery queries the same receipt UUID and exact original command', async () => {
  const writes: Array<Record<string, unknown>> = [];
  const base = transport(() => ({ ok: true, result: {} }), ['commands.receipt-only.v1']);
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
  const receipt = { requestId: '0199aaa1-1234-4678-9abc-000000000001', retrying: false, scope: remoteDeliveryScope(), signal: new AbortController().signal,
    command: snapshotQuestionCommand(target, 'allow', undefined, { choice: [' A '] }) };
  await expect(respondApproval(target, 'allow', undefined, { choice: [' A '] }, receipt)).rejects.toMatchObject({ status: 0 });
  await respondApproval(target, 'allow', undefined, { choice: [' A '] }, { ...receipt, retrying: true });
  expect(writes).toHaveLength(2); expect(writes[1]).toEqual({ ...writes[0], receiptOnly: true });
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
  const session = { sessionKey: 'codex:11111111-2222-4333-8444-555555555555', tool: 'codex', client: 'Codex App', title: 'Native', cwd: 'C:\\fixture', updatedAt: 1, status: 'waiting_approval', controllable: true };
  const commands: Record<string, unknown>[] = [];
  const native = { ...session, controlSurface: 'desktop' };
  const approvalId = '11111111-2222-4333-8444-555555555555';
  setHubFetch(transport((url, command) => {
    if (command) commands.push(command);
    if (command?.type === 'agents.status') return { ok: true, result: nativeApprovalStatus() };
    if (url.pathname.endsWith('/events')) return { events: [], nextSeq: 0, lastSeq: 0, hasMore: false };
    if (command?.type === 'session.open' || command?.type === 'desktop.session.open') return { ok: true, result: { session: native, events: [{ type: 'approval.request', approvalId,
      deviceId: 'pc', sessionKey: session.sessionKey, tool: 'codex', ts: Date.now(), kind: 'command', title: 'Bash', expiresAt: Date.now() + 60000, approvalTransport: 'codex-hook-v1' }] } };
    return { ok: true, result: { accepted: true } };
  }));
  await pair(); await loadAgentProfiles('pc'); await openSession('pc', session.sessionKey);
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

test('withdrawing native approval capability keeps a cached hook pending without sending any decision', async () => {
  const session = { sessionKey: 'codex:11111111-2222-4333-8444-555555555555', tool: 'codex', client: 'Codex App', title: 'Native', cwd: 'C:\\fixture', updatedAt: 1, status: 'waiting_approval', controllable: true };
  let allowed = true; const decisions: string[] = [];
  const approvalId = '11111111-2222-4333-8444-555555555557';
  setHubFetch(transport((url, command) => {
    if (command?.type === 'agents.status') return { ok: true, result: nativeApprovalStatus(allowed) };
    if (url.pathname.endsWith('/events')) return { events: [], nextSeq: 0, lastSeq: 0, hasMore: false };
    if (command?.type === 'session.open' || command?.type === 'desktop.session.open') return { ok: true, result: {
      session: { ...session, controlSurface: 'desktop' }, events: [{ type: 'approval.request', approvalId,
        deviceId: 'pc', sessionKey: session.sessionKey, tool: 'codex', ts: Date.now(), kind: 'command', title: 'Bash',
        expiresAt: Date.now() + 60000, approvalTransport: 'codex-hook-v1' }],
    } };
    if (command?.type === 'desktop.approval.respond' || command?.type === 'approval.respond') decisions.push(command.type as string);
    return { ok: true, result: {} };
  }));
  await pair(); await loadAgentProfiles('pc'); await openSession('pc', session.sessionKey);
  allowed = false; await loadAgentProfiles('pc');
  await expect(respondApproval({ approvalId, deviceId: 'pc', sessionKey: session.sessionKey, controlSurface: 'desktop' }, 'allow'))
    .rejects.toMatchObject({ code: 'desktop_capability_unavailable' });
  expect(decisions).toHaveLength(0);
  expect(getRemoteState().timelines[timelineKey('pc', session.sessionKey)].items.find(item => item.kind === 'approval')).toMatchObject({ state: 'pending' });
});

test('native approval options still restrict an otherwise valid desktop request', async () => {
  const session = { sessionKey: 'codex:11111111-2222-4333-8444-555555555555', tool: 'codex', client: 'Codex App', title: 'Native', cwd: 'C:\\fixture', updatedAt: 1, status: 'waiting_approval', controllable: true };
  const commands: Record<string, unknown>[] = [];
  const approvalId = '11111111-2222-4333-8444-555555555556';
  setHubFetch(transport((url, command) => {
    if (command) commands.push(command);
    if (command?.type === 'agents.status') return { ok: true, result: nativeApprovalStatus() };
    if (url.pathname.endsWith('/events')) return { events: [], nextSeq: 0, lastSeq: 0, hasMore: false };
    if (command?.type === 'session.open' || command?.type === 'desktop.session.open') return { ok: true, result: { session: { ...session, controlSurface: 'desktop' }, events: [{ type: 'approval.request', approvalId,
      deviceId: 'pc', sessionKey: session.sessionKey, tool: 'codex', ts: Date.now(), kind: 'command', title: 'Bash', expiresAt: Date.now() + 60000,
      approvalTransport: 'codex-hook-v1', approvalOptions: { version: 1, decisions: ['deny'] } }] } };
    return { ok: true, result: { accepted: true } };
  }));
  await pair(); await loadAgentProfiles('pc'); await openSession('pc', session.sessionKey);
  const target = { approvalId, deviceId: 'pc', sessionKey: session.sessionKey, controlSurface: 'desktop' as const };
  await expect(respondApproval(target, 'allow')).rejects.toMatchObject({ code: 'approval_decision_unsupported' });
  expect(commands.some(value => value.type === 'desktop.approval.respond' || value.type === 'approval.respond')).toBe(false);
  await respondApproval(target, 'deny');
  expect(commands.filter(value => value.type === 'desktop.approval.respond')).toHaveLength(1);
  expect(commands.some(value => value.type === 'approval.respond')).toBe(false);
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

test.each([false, true])('restoring the computer default validates that source instead of the old phone override (denied=%s)', async denied => {
  const original = { ...status(), apis: [{ id: 'api_11111111', name: '原 API', models: [], sourceType: 'api_key',
    remoteEligibility: { supported: false, reason: 'station_mismatch', apiRemote: true, accountRemote: false } }] };
  const restored = { ...original, agents: original.agents.map(agent => agent.id === 'codex'
    ? { ...agent, api: { ...agent.api, source: 'computer', accountId: 'api_22222222', name: '电脑默认' } } : agent) };
  const writes: Record<string, unknown>[] = [];
  setHubFetch(transport((_url, command) => {
    if (command?.type === 'agents.api.set') {
      writes.push(command);
      return denied ? { ok: false, code: 'source_station_denied', error: '电脑默认 API 不适用于本站' } : { ok: true, result: restored };
    }
    return { ok: true, result: original };
  }, ['station.guard.v1']));
  await pair(); await loadAgentProfiles('pc');
  const selection = setAgentApi('pc', 'codex', '');
  if (denied) {
    await expect(selection).rejects.toMatchObject({ code: 'source_station_denied' });
    expect(getRemoteState().agents.pc.list.find(agent => agent.id === 'codex')?.api)
      .toMatchObject({ source: 'phone', accountId: 'api_11111111', model: 'gpt-5-codex' });
  } else {
    await expect(selection).resolves.toMatchObject({ api: { source: 'computer', accountId: 'api_22222222', model: 'gpt-5-codex' } });
  }
  expect(writes).toEqual([{ type: 'agents.api.set', agent: 'codex', accountId: '' }]);
  expect(getRemoteState().connection).toBe('open');
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
  expect(getRemoteState().approvals[approvalStateKey('pc', session.sessionKey, 'q')]).toBeTruthy();
  events = [{ type: 'approval.resolved', deviceId: 'pc', sessionKey: session.sessionKey, tool: 'codex', seq: 2, ts: Date.now(), approvalId: 'q', decision: 'allow', by: 'phone' }];
  await syncSessionEvents('pc', session.sessionKey); const count = alert.mock.calls.length;
  events = [request(3, Date.now() + 60000)]; await syncSessionEvents('pc', session.sessionKey);
  expect(getRemoteState().approvals[approvalStateKey('pc', session.sessionKey, 'q')]).toBeUndefined(); expect(alert).toHaveBeenCalledTimes(count);
  events = [{ ...request(4, Date.now() + 60000), approvalId: 'expires' }]; await syncSessionEvents('pc', session.sessionKey);
  expect(getRemoteState().approvals[approvalStateKey('pc', session.sessionKey, 'expires')]).toBeTruthy();
  events = [{ ...request(5, Date.now() - 1), approvalId: 'expires' }]; await syncSessionEvents('pc', session.sessionKey);
  expect(getRemoteState().approvals[approvalStateKey('pc', session.sessionKey, 'expires')]).toBeUndefined(); unlisten();
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
  await sendToSession('pc', session.sessionKey, '同一个任务', { retryRequestId: requestId, model: 'gpt-5-codex', effort: 'low' });
  expect(sends).toHaveLength(2);
  expect(sends[1]).toEqual(sends[0]);
  expect([...mockSettings.values()].join()).not.toContain(requestId);
});

test.each([false, true])('a default same-text new submission cannot reuse an old image/API receipt (uploaded=%s)', async (attachmentsUploaded) => {
  const writes: Record<string, unknown>[] = [];
  setHubFetch(transport((_url, command) => {
    if (command) writes.push(command);
    return { ok: true, result: {} };
  }));
  await pair();
  const oldReceipt = { scope: remoteDeliveryScope(), deviceId: 'pc', sessionKey: session.sessionKey, surface: 'cli',
    text: 'same text', requestId: '0199aaa1-1234-4678-9abc-000000000091', createdAt: Date.now(), attempted: true, safeRetry: true,
    attachments: [`att_${'a'.repeat(32)}`], attachmentsUploaded,
    attachmentSources: [{ id: `att_${'a'.repeat(32)}`, uri: 'file://original-image.png', mime: 'image/png', width: 40, height: 40 }],
    sendOptions: { accountId: 'api_11111111', model: 'old-model', effort: 'high' } };
  mockSettings.set('remote_pending_delivery_v1', JSON.stringify([oldReceipt]));
  resetDeliveryForTests();
  await expect(sendToSession('pc', session.sessionKey, 'same text', {
    accountId: 'api_22222222', model: 'new-model', effort: 'low',
    images: [{ uri: 'file://different-image.png', base64: 'bmV3LWltYWdl', mime: 'image/png', width: 40, height: 40 }],
  })).rejects.toMatchObject({ name: 'DeliveryPendingError', retryable: false });
  expect(writes).toHaveLength(0);
  const preserved = await pendingDelivery(remoteDeliveryScope(), 'pc', session.sessionKey);
  expect(preserved).toMatchObject(oldReceipt);
  expect(getRemoteState().timelines[timelineKey('pc', session.sessionKey)]?.items ?? []).toHaveLength(0);

  // Even an exact receipt ID is not permission to substitute different bytes.
  await expect(sendToSession('pc', session.sessionKey, 'same text', {
    retryRequestId: oldReceipt.requestId,
    images: [{ uri: 'file://different-image.png', base64: 'bmV3LWltYWdl', mime: 'image/png', width: 40, height: 40 }],
  })).rejects.toMatchObject({ name: 'DeliveryPendingError', retryable: false });
  expect(writes).toHaveLength(0);
  expect(await pendingDelivery(remoteDeliveryScope(), 'pc', session.sessionKey)).toMatchObject(oldReceipt);
});

test.each(['wrong-id', 'receipt-already-completed'] as const)('a stale explicit retry cannot create a new task: %s', async reason => {
  const sends: Record<string, unknown>[] = [];
  setHubFetch(transport((_url, command) => {
    if (command?.type === 'session.send') {
      sends.push(command);
      if (sends.length === 1) throw new Error('fixture lost acknowledgement');
    }
    return { ok: true, result: {} };
  }));
  await pair();
  await expect(sendToSession('pc', session.sessionKey, 'same text', { model: 'old-model' })).rejects.toMatchObject({ retryable: true });
  const oldReceipt = await pendingDelivery(remoteDeliveryScope(), 'pc', session.sessionKey);
  expect(oldReceipt).toBeDefined();
  if (reason === 'receipt-already-completed') {
    await sendToSession('pc', session.sessionKey, 'same text', { retryRequestId: oldReceipt!.requestId });
    expect(await pendingDelivery(remoteDeliveryScope(), 'pc', session.sessionKey)).toBeUndefined();
  }
  const before = sends.length;
  const retryRequestId = reason === 'wrong-id' ? '0199aaa1-1234-4678-9abc-000000000099' : oldReceipt!.requestId;
  await expect(sendToSession('pc', session.sessionKey, 'same text', { retryRequestId, model: 'new-model' }))
    .rejects.toMatchObject({ name: 'DeliveryPendingError', retryable: false });
  expect(sends).toHaveLength(before);
  const preserved = await pendingDelivery(remoteDeliveryScope(), 'pc', session.sessionKey);
  if (reason === 'wrong-id') expect(preserved).toMatchObject({ requestId: oldReceipt!.requestId, sendOptions: oldReceipt!.sendOptions });
  else expect(preserved).toBeUndefined();
});

test.each(['original-bytes', 'replaced-bytes', 'legacy-no-digest'] as const)('an interrupted image upload restores only the frozen source: %s', async sourceState => {
  const originalBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8dMAAAAASUVORK5CYII=';
  const replacedBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const digest = Array.from(sha256(new TextEncoder().encode(originalBase64)), byte => byte.toString(16).padStart(2, '0')).join('');
  const sourceUri = `${FileSystem.documentDirectory ?? 'file://private-documents/'}remote-delivery/original.png`;
  const writes: Record<string, unknown>[] = [];
  setHubFetch(transport((_url, command) => {
    if (command) writes.push(command);
    if (command?.type === 'attachment.put' && writes.length === 1) throw new Error('first image upload disconnected');
    return { ok: true, result: {} };
  }));
  await pair();
  await expect(sendToSession('pc', session.sessionKey, 'original image task', {
    accountId: 'api_11111111', model: 'old-model', effort: 'high', surface: 'cli',
    images: [{ uri: sourceUri, base64: originalBase64, mime: 'image/png', width: 1, height: 1 }],
  })).rejects.toMatchObject({ name: 'DeliveryPendingError', retryable: false });
  const original = await pendingDelivery(remoteDeliveryScope(), 'pc', session.sessionKey);
  expect(original).toMatchObject({ attachmentsUploaded: false, attachmentSources: [{ uri: sourceUri, digest }],
    sendOptions: { accountId: 'api_11111111', model: 'old-model', effort: 'high' } });
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ type: 'attachment.put', id: original!.attachments![0], data: originalBase64 });
  expect(mockSettings.get('remote_pending_delivery_v1')).not.toContain(originalBase64);
  const restoredReceipt = sourceState === 'legacy-no-digest'
    ? { ...original!, attachmentSources: original!.attachmentSources!.map(({ digest: _digest, ...source }) => source) }
    : original!;
  const frozenReceipt = { requestId: restoredReceipt.requestId, text: restoredReceipt.text, surface: restoredReceipt.surface,
    attachments: restoredReceipt.attachments, attachmentsUploaded: false, attachmentSources: restoredReceipt.attachmentSources, sendOptions: restoredReceipt.sendOptions };
  mockSettings.set('remote_pending_delivery_v1', JSON.stringify([restoredReceipt]));
  resetDeliveryForTests();
  expect(await pendingDelivery(remoteDeliveryScope(), 'pc', session.sessionKey)).toMatchObject(frozenReceipt);
  const stat = jest.spyOn(FileSystem, 'getInfoAsync').mockResolvedValue({ exists: true, isDirectory: false, uri: sourceUri, size: 68, modificationTime: 1 });
  const read = jest.spyOn(FileSystem, 'readAsStringAsync').mockResolvedValue(sourceState === 'replaced-bytes' ? replacedBase64 : originalBase64);
  try {
    const retry = sendToSession('pc', session.sessionKey, original!.text, { retryRequestId: original!.requestId,
      accountId: 'api_22222222', model: 'new-model', effort: 'low', surface: 'desktop' });
    if (sourceState === 'original-bytes') {
      await retry;
      expect(writes).toHaveLength(3);
      expect(writes[1]).toEqual(writes[0]);
      expect(writes[2]).toEqual({ type: 'session.send', sessionKey: session.sessionKey, text: original!.text,
        controlSurface: 'cli', operationId: original!.requestId, accountId: 'api_11111111', model: 'old-model', effort: 'high', attachments: original!.attachments });
      expect(await pendingDelivery(remoteDeliveryScope(), 'pc', session.sessionKey)).toBeUndefined();
    } else {
      await expect(retry).rejects.toMatchObject({ name: 'DeliveryPendingError', retryable: false, requestId: original!.requestId });
      expect(writes).toHaveLength(1);
      expect(await pendingDelivery(remoteDeliveryScope(), 'pc', session.sessionKey)).toMatchObject(frozenReceipt);
      expect(writes.some(command => command.type === 'session.send')).toBe(false);
    }
    expect(stat).toHaveBeenCalledWith(sourceUri);
    expect(read).toHaveBeenCalledWith(sourceUri, { encoding: FileSystem.EncodingType.Base64 });
  } finally { stat.mockRestore(); read.mockRestore(); }
});

test('an exact already-uploaded image receipt retries its frozen payload without reading local image files', async () => {
  const writes: Record<string, unknown>[] = [];
  setHubFetch(transport((_url, command) => {
    if (command) writes.push(command);
    return { ok: true, result: {} };
  }));
  await pair();
  const oldReceipt = { scope: remoteDeliveryScope(), deviceId: 'pc', sessionKey: session.sessionKey, surface: 'cli',
    text: 'same text', requestId: '0199aaa1-1234-4678-9abc-000000000091', createdAt: Date.now(), attempted: true, safeRetry: true,
    attachments: [`att_${'a'.repeat(32)}`], attachmentsUploaded: true,
    attachmentSources: [{ id: `att_${'a'.repeat(32)}`, uri: 'file://removed-original-image.png', mime: 'image/png', width: 40, height: 40 }],
    sendOptions: { accountId: 'api_11111111', model: 'old-model', effort: 'high' } };
  mockSettings.set('remote_pending_delivery_v1', JSON.stringify([oldReceipt]));
  resetDeliveryForTests();
  const stat = jest.spyOn(FileSystem, 'getInfoAsync').mockRejectedValue(new Error('local image was removed'));
  const read = jest.spyOn(FileSystem, 'readAsStringAsync').mockRejectedValue(new Error('must not read uploaded image'));
  try {
    await sendToSession('pc', session.sessionKey, oldReceipt.text, { retryRequestId: oldReceipt.requestId,
      accountId: 'api_22222222', model: 'new-model', effort: 'low', surface: 'desktop' });
    expect(stat).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
    expect(writes).toEqual([{ type: 'session.send', sessionKey: session.sessionKey, text: oldReceipt.text,
      controlSurface: 'cli', operationId: oldReceipt.requestId, accountId: 'api_11111111', model: 'old-model', effort: 'high', attachments: oldReceipt.attachments }]);
    expect(await pendingDelivery(remoteDeliveryScope(), 'pc', session.sessionKey)).toBeUndefined();
  } finally { stat.mockRestore(); read.mockRestore(); }
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
  const pending = await pendingDelivery(remoteDeliveryScope(), 'pc', session.sessionKey);
  resetDeliveryForTests();
  await sendToSession('pc', session.sessionKey, 'native task', { retryRequestId: pending!.requestId, surface: 'cli' });
  expect(sends[1]).toEqual(sends[0]); expect(sends[1]).toMatchObject({ controlSurface: 'desktop', operationId: expect.any(String) });
});

test('same-text CLI sends accepted in one millisecond keep separate local rows and match only their own client IDs', async () => {
  const now = jest.spyOn(Date, 'now').mockReturnValue(1896912000000);
  try {
    const sends: Record<string, unknown>[] = []; let events: HubEvent[] = [];
    setHubFetch(transport((url, command) => {
      if (command?.type === 'session.send') { sends.push(command); return { ok: true, result: {} }; }
      if (command) return { ok: true, result: { session, events: [] } };
      if (url.searchParams.get('limit') === '1') return { events: [], nextSeq: 0, lastSeq: 0 };
      return { events, nextSeq: events.at(-1)?.seq ?? Number(url.searchParams.get('after') ?? 0), lastSeq: events.at(-1)?.seq ?? 0 };
    }));
    await pair(); await openSession('pc', session.sessionKey);
    await sendToSession('pc', session.sessionKey, 'repeat prompt');
    await sendToSession('pc', session.sessionKey, 'repeat prompt');
    const timeline = () => getRemoteState().timelines[timelineKey('pc', session.sessionKey)];
    const locals = timeline().items.filter((item): item is Extract<TimelineItem, { kind: 'message' }> => item.kind === 'message' && item.local === true);
    expect(locals).toHaveLength(2); expect(new Set(locals.map(item => item.id)).size).toBe(2);
    expect(locals.map(item => item.clientId)).toEqual(sends.map(item => item.operationId));
    const echo = (index: number): HubEvent => ({ type: 'message', deviceId: 'pc', sessionKey: session.sessionKey, tool: 'codex', seq: index + 1,
      ts: Date.now(), id: `confirmed-${index}`, role: 'user', text: 'repeat prompt', final: true, clientId: String(sends[index].operationId) });
    events = [echo(0)]; await syncSessionEvents('pc', session.sessionKey);
    expect(timeline().items.filter(item => item.kind === 'message' && item.local)).toEqual([expect.objectContaining({ id: locals[1].id, clientId: sends[1].operationId })]);
    events = [echo(1)]; await syncSessionEvents('pc', session.sessionKey);
    expect(timeline().items.some(item => item.kind === 'message' && item.local)).toBe(false);
    expect(timeline().items.filter(item => item.kind === 'message').map(item => item.id)).toEqual(['confirmed-0', 'confirmed-1']);
  } finally { now.mockRestore(); }
});

test.each(['codex', 'claude'] as const)('%s message skills stay frozen through optimistic send, retry and exact echo', async tool => {
  const currentSession = { ...session, sessionKey: `${tool}:original`, tool, client: `${tool} CLI`, controlSurface: 'cli' };
  const sends: Record<string, unknown>[] = []; let events: HubEvent[] = [];
  const capabilities = { list: true, read: true, send: true, interrupt: true, approval: true, questions: true, subagents: true,
    attachments: true, imageInput: true, imageOutput: true, modelOverride: true, features: true };
  setHubFetch(transport((url, command) => {
    if (command?.type === 'agents.status') return { ok: true, result: { agents: status().agents.map(agent => ({ ...agent, capabilities })) } };
    if (command?.type === 'session.send') { sends.push(command); if (sends.length === 1) throw new Error('lost acknowledgement'); return { ok: true, result: {} }; }
    if (command) return { ok: true, result: { session: currentSession, events: [] } };
    if (url.searchParams.get('limit') === '1') return { events: [], nextSeq: 0, lastSeq: 0 };
    return { events, nextSeq: events.at(-1)?.seq ?? Number(url.searchParams.get('after') ?? 0), lastSeq: events.at(-1)?.seq ?? 0 };
  }));
  await pair(); await loadAgentProfiles('pc'); await openSession('pc', currentSession.sessionKey);
  const originalSkills = [{ name: 'review', path: `C:/${tool}/review/SKILL.md` }];
  const inputSkills = originalSkills.map(skill => ({ ...skill }));
  const send = sendToSession('pc', currentSession.sessionKey, 'body with literal $other', { skills: inputSkills });
  inputSkills[0].path = 'mutated';
  await expect(send).rejects.toMatchObject({ retryable: true });
  const timeline = () => getRemoteState().timelines[timelineKey('pc', currentSession.sessionKey)];
  const pending = await pendingDelivery(remoteDeliveryScope(), 'pc', currentSession.sessionKey);
  expect(timeline().items.find(item => item.kind === 'message')).toMatchObject({ skills: originalSkills, clientId: pending!.requestId });
  await sendToSession('pc', currentSession.sessionKey, 'body with literal $other', { retryRequestId: pending!.requestId,
    skills: [{ name: 'different', path: 'C:/different/SKILL.md' }] });
  expect(sends[1]).toEqual(sends[0]);
  expect(timeline().items.filter(item => item.kind === 'message')).toHaveLength(1);
  events = [{ type: 'message', deviceId: 'pc', sessionKey: currentSession.sessionKey, tool, seq: 1, ts: Date.now(), id: 'echo',
    role: 'user', text: 'body with literal $other', final: true, clientId: pending!.requestId }];
  await syncSessionEvents('pc', currentSession.sessionKey);
  expect(timeline().items.find(item => item.kind === 'message')).toMatchObject({ id: 'echo', skills: originalSkills, text: 'body with literal $other' });
});

test('switching sessions with identical message IDs and text cannot borrow the other Agent skill metadata', async () => {
  setHubFetch(transport((url, command) => {
    if (command?.type === 'session.open') {
      const tool = String(command.sessionKey).split(':')[0];
      return { ok: true, result: { session: { ...session, tool, sessionKey: command.sessionKey, client: `${tool} CLI` }, events: [{
        type: 'message', deviceId: 'pc', sessionKey: command.sessionKey, tool, ts: 1, id: 'same-message-id', clientId: 'same-receipt', role: 'user', text: 'same body', final: true,
        ...(tool === 'codex' ? { skills: [{ name: 'review', path: 'C:/codex/review/SKILL.md' }] } : {}),
      }] } };
    }
    if (command?.type === 'agents.status') return { ok: true, result: status() };
    return { events: [], nextSeq: 0, lastSeq: 0 };
  }));
  await pair(); await loadAgentProfiles('pc');
  await openSession('pc', 'codex:original'); await openSession('pc', 'claude:original');
  const codex = getRemoteState().timelines[timelineKey('pc','codex:original')].items.find(item => item.kind === 'message');
  const claude = getRemoteState().timelines[timelineKey('pc','claude:original')].items.find(item => item.kind === 'message');
  expect(codex).toMatchObject({ skills: [{ name: 'review', path: 'C:/codex/review/SKILL.md' }] });
  expect(claude?.kind === 'message' ? claude.skills : undefined).toBeUndefined();
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

test('API mutation during a durable new task image upload is refused until its receipt is reconciled', async () => {
  let releaseImage!: (value: unknown) => void, entered!: () => void;
  const uploaded = new Promise<void>(resolve => { entered = resolve; }), writes: string[] = [];
  setHubFetch(transport((_url, command) => {
    writes.push(String(command?.type));
    if (command?.type === 'attachment.put') { entered(); return new Promise(resolve => { releaseImage = resolve; }); }
    return { ok: true, result: { sessionKey: 'codex:created' } };
  }));
  await pair(); const start = startSession('pc', { tool: 'codex', cwd: 'C:\\fixture', prompt: 'task fixture', approval: 'ask',
    images: [{ uri: 'file://fixture-photo', base64: 'AQID', mime: 'image/jpeg', width: 1, height: 1 }] }); await uploaded;
  await expect(setAgentApi('pc', 'codex', 'api_22222222')).rejects.toThrow('API 正在切换');
  releaseImage({ ok: true, result: {} });
  await expect(start).resolves.toBe('codex:created');
  expect(writes).toEqual(['attachment.put', 'session.start']);
});

test('disconnecting during attachment upload cannot dispatch the task through a later connection', async () => {
  let release!: (value: unknown) => void, entered!: () => void;
  const uploaded = new Promise<void>(resolve => { entered = resolve; }), writes: string[] = [];
  setHubFetch(transport((_url, command) => {
    writes.push(String(command?.type)); entered(); return new Promise(resolve => { release = resolve; });
  }));
  await pair(); const start = startSession('pc', { tool: 'codex', cwd: 'C:\\fixture', prompt: 'task fixture', approval: 'ask',
    images: [{ uri: 'file://fixture-photo', base64: 'AQID', mime: 'image/jpeg', width: 1, height: 1 }] }); await uploaded;
  resetRemoteForTests(); release({ ok: true, result: {} });
  await expect(start).rejects.toMatchObject({ name: 'DeliveryPendingError' }); expect(writes).toEqual(['attachment.put']);
});
