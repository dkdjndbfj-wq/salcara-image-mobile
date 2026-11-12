import type { Command, ExecutionTicket, FetchLike } from '../remote/client';
import type { PendingDelivery } from '../remote/delivery';

const mockDisk = new Map<string, string>();
let mockFailKey: string | undefined, mockUuid = 0;
jest.mock('../storage/database', () => ({
  getSetting: async (key: string) => mockDisk.get(key) ?? null,
  setSetting: async (key: string, value: string | null) => {
    if (key === mockFailKey) throw new Error('fixture disk write unavailable');
    if (value === null) mockDisk.delete(key); else mockDisk.set(key, value);
  },
}));
jest.mock('expo-crypto', () => ({ randomUUID: () => `0199aaa1-1234-4678-9abc-${String(++mockUuid).padStart(12, '0')}` }));

function loadRuntime() {
  jest.resetModules();
  return {
    client: require('../remote/client') as typeof import('../remote/client'),
    durable: require('../remote/durable-commands') as typeof import('../remote/durable-commands'),
    delivery: require('../remote/delivery') as typeof import('../remote/delivery'),
    task: require('../remote/new-task') as typeof import('../remote/new-task'),
  };
}
let runtime: ReturnType<typeof loadRuntime>;
const ledgerKey = 'remote.durable.commands.v2';
const operationId = '0199aaa1-1234-4678-9abc-999999999991', intentId = '0199aaa1-1234-4678-9abc-999999999992';
const owner = { url: 'https://cancel-fixture.invalid', pairToken: 'fixture' };
const queueOwner = () => ({ owner, scope: 'paired', deviceId: 'pc', intentId, active: () => true });
const execution = () => ({ ...queueOwner(), command: {
  type: 'session.start', tool: 'codex', cwd: 'C:/fixture', prompt: 'original prompt', approval: 'ask', operationId: intentId,
} as Command, bound: async () => undefined });
const response = (json: unknown, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(json) });

function host() {
  const ticket: ExecutionTicket = { operationId, ticket: 'original-signed-ticket', storageEpoch: 'original-epoch', dispatchNotAfter: Date.now() + 600_000 };
  const calls: Array<{ path: string; body: Record<string, any> }> = [];
  const fixture: {
    state: string; cancel: 'success' | '503' | 'claim' | 'lost-success';
    completedOk: boolean; completedResult: Record<string, unknown>; code?: string;
    readGate?: () => Promise<ReturnType<typeof response>>;
    attach: () => void;
  } = { state: 'prepared', cancel: 'success', completedOk: true, completedResult: { sessionKey: 'codex:created' }, attach: () => undefined };
  const current = () => ({ ...ticket, state: fixture.state, ok: fixture.state === 'completed' ? fixture.completedOk : false,
    ...(fixture.state === 'completed' ? { result: fixture.completedResult, ...(!fixture.completedOk ? { error: 'original task failed', code: 'upstream_rejected' } : {}) } : {}),
    ...(fixture.state === 'cancelled' ? { cancelled: true, code: 'operation_cancelled', error: '该待发任务已撤回，未发送到电脑' } : {}),
    ...(fixture.state === 'not_dispatched' ? { code: fixture.code ?? 'offline_queue_registration_failed', error: '原任务未派发' } : {}),
  });
  fixture.attach = () => runtime.client.setHubFetch((async (url, init) => {
    const path = new URL(String(url)).pathname, body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ path, body });
    if (path === '/app/commands/prepare') {
      expect(body.requestId).toBe(intentId); return response({ ...ticket, state: 'prepared' });
    }
    if (path === '/app/operations') {
      const params = new URL(String(url)).searchParams;
      expect(params.get('operationId')).toBe(operationId); expect(params.get('ticket')).toBe(ticket.ticket);
      if (fixture.readGate) { const gate = fixture.readGate; fixture.readGate = undefined; return gate(); }
      return response(current());
    }
    if (path === '/app/commands') {
      expect(body).toMatchObject({ requestId: operationId, executionTicket: ticket.ticket, command: { operationId } });
      fixture.state = 'queued'; return response({ state: 'queued', ok: false });
    }
    if (path === '/app/operations/cancel') {
      expect(body).toEqual({ deviceId: 'pc', operationId, ticket: ticket.ticket });
      expect(JSON.parse(mockDisk.get(ledgerKey)!)[0]).toMatchObject({ intentId, ticket, cancelRequested: true });
      if (fixture.cancel === '503') return response({ ok: false, operationId, code: 'operation_cancel_unavailable', error: '撤回结果暂未确认', retryable: true }, 503);
      if (fixture.cancel === 'claim') { fixture.state = 'pending'; return response({ ok: false, operationId, state: 'pending', code: 'operation_not_cancellable', error: '任务已开始发送，无法撤回' }, 409); }
      fixture.state = 'cancelled';
      if (fixture.cancel === 'lost-success') throw new Error('fixture lost cancel response');
      return response({ ...ticket, state: 'cancelled', ok: true, code: 'operation_cancelled', cancelled: true, retryable: false });
    }
    if (path === '/app/operations/ack') return response({ ok: true });
    throw new Error(`Unexpected fixture endpoint ${path}`);
  }) as FetchLike);
  fixture.attach();
  return { fixture, calls, ticket, count: (path: string) => calls.filter(call => call.path === path).length };
}
async function seedQueued() {
  const result = host();
  await expect(runtime.durable.executeDurableCommand(execution())).rejects.toMatchObject({ code: 'command_receipt_pending' });
  expect(result.count('/app/commands')).toBe(1);
  return result;
}
beforeEach(() => { mockDisk.clear(); mockFailKey = undefined; mockUuid = 0; runtime = loadRuntime(); });
afterEach(() => { runtime.client.setHubFetch(null); });

test('queue cancellation journals its original identity and never creates another business command', async () => {
  const { ticket, count } = await seedQueued();
  await expect(runtime.durable.withdrawDurableQueue(queueOwner())).resolves.toMatchObject({ state: 'cancelled', completion: { ok: false, code: 'operation_cancelled' } });
  await expect(runtime.durable.withdrawDurableQueue(queueOwner())).resolves.toMatchObject({ state: 'cancelled' });
  expect([count('/app/commands/prepare'), count('/app/commands'), count('/app/operations/cancel')]).toEqual([1, 1, 1]);
  expect(JSON.parse(mockDisk.get(ledgerKey)!)[0]).toMatchObject({ intentId, ticket, cancelRequested: true });
});

test('a failed cancellation journal write sends neither cancel nor another task', async () => {
  const { count } = await seedQueued();
  mockFailKey = ledgerKey;
  await expect(runtime.durable.withdrawDurableQueue(queueOwner())).rejects.toThrow('fixture disk write unavailable');
  expect(count('/app/operations/cancel')).toBe(0); expect(count('/app/commands')).toBe(1);
  expect(JSON.parse(mockDisk.get(ledgerKey)!)[0].cancelRequested).toBeUndefined();
});

test('503 and a full module restart retain cancel intent and the same ticket', async () => {
  const { fixture, ticket, count } = await seedQueued(); fixture.cancel = '503';
  await expect(runtime.durable.withdrawDurableQueue(queueOwner())).rejects.toMatchObject({ code: 'operation_cancel_unavailable' });
  expect(JSON.parse(mockDisk.get(ledgerKey)!)[0]).toMatchObject({ ticket, cancelRequested: true });
  runtime = loadRuntime(); fixture.attach();
  await expect(runtime.durable.durableQueueAction(queueOwner())).resolves.toBe('reconcile');
  await expect(runtime.durable.executeDurableCommand(execution())).rejects.toMatchObject({ code: 'operation_cancel_unavailable' });
  fixture.cancel = 'success';
  await expect(runtime.durable.withdrawDurableQueue(queueOwner())).resolves.toMatchObject({ state: 'cancelled' });
  expect([count('/app/commands/prepare'), count('/app/commands'), count('/app/operations/cancel')]).toEqual([1, 1, 2]);
});

test('a lost successful cancellation reply recovers by GET without claiming task success', async () => {
  const { fixture, count } = await seedQueued(); fixture.cancel = 'lost-success';
  await expect(runtime.durable.withdrawDurableQueue(queueOwner())).resolves.toMatchObject({ state: 'cancelled', completion: { ok: false } });
  expect(count('/app/operations/cancel')).toBe(1); expect(count('/app/commands')).toBe(1);
});

test('claim wins: later original completion returns its session key without another cancel or business send', async () => {
  const { fixture, count } = await seedQueued(); fixture.cancel = 'claim';
  await expect(runtime.durable.withdrawDurableQueue(queueOwner())).rejects.toMatchObject({ code: 'operation_not_cancellable' });
  expect(JSON.parse(mockDisk.get(ledgerKey)!)[0].cancelRequested).toBe(true);
  fixture.state = 'completed'; runtime = loadRuntime(); fixture.attach();
  await expect(runtime.durable.durableQueueAction(queueOwner())).resolves.toBe('reconcile');
  await expect(runtime.durable.withdrawDurableQueue(queueOwner())).resolves.toMatchObject({
    state: 'completed', completion: { ok: true, result: { sessionKey: 'codex:created' } },
  });
  expect([count('/app/commands/prepare'), count('/app/commands'), count('/app/operations/cancel')]).toEqual([1, 1, 1]);
  expect(JSON.parse(mockDisk.get(ledgerKey)!)[0].completed.code).not.toBe('operation_cancelled');
});

test.each(['pending', 'uncertain'])('%s is never converted to cancelled or resent', async state => {
  const { fixture, count } = await seedQueued(); fixture.state = state;
  await expect(runtime.durable.withdrawDurableQueue(queueOwner())).rejects.toMatchObject({ code: 'operation_not_cancellable' });
  expect(JSON.parse(mockDisk.get(ledgerKey)!)[0].completed).toBeUndefined();
  expect(count('/app/operations/cancel')).toBe(0); expect(count('/app/commands')).toBe(1);
});

test('an original business failure stays a failure, distinct from cancellation', async () => {
  const { fixture, count } = await seedQueued(); fixture.state = 'completed'; fixture.completedOk = false; fixture.completedResult = {};
  await expect(runtime.durable.withdrawDurableQueue(queueOwner())).resolves.toMatchObject({
    state: 'completed', completion: { ok: false, code: 'upstream_rejected', error: 'original task failed' },
  });
  expect(count('/app/operations/cancel')).toBe(0); expect(count('/app/commands')).toBe(1);
});

test.each(['offline_queue_unavailable', 'offline_queue_registration_failed'])('GET not_dispatched accepts %s and preserves the original nonexecution fact', async code => {
  const { fixture, count } = await seedQueued(); fixture.state = 'not_dispatched'; fixture.code = code;
  await expect(runtime.durable.withdrawDurableQueue(queueOwner())).resolves.toMatchObject({ state: 'not_dispatched', completion: { ok: false, code } });
  await expect(runtime.durable.executeDurableCommand(execution())).rejects.toMatchObject({ code });
  expect(count('/app/operations/cancel')).toBe(0); expect(count('/app/commands')).toBe(1);
});

test('a cancellation committed during a stale prepared read blocks the final dispatch fence', async () => {
  const { fixture, ticket, count } = await seedQueued();
  let release!: () => void, observed!: () => void;
  const began = new Promise<void>(resolve => { observed = resolve; });
  fixture.readGate = () => new Promise(resolve => { release = () => resolve(response({ ...ticket, state: 'prepared', ok: true })); observed(); });
  const executing = runtime.durable.executeDurableCommand(execution());
  const rejection = expect(executing).rejects.toMatchObject({ code: 'operation_cancel_unavailable' });
  await began; fixture.cancel = '503';
  await expect(runtime.durable.withdrawDurableQueue(queueOwner())).rejects.toMatchObject({ code: 'operation_cancel_unavailable' });
  release(); await rejection;
  expect(count('/app/commands')).toBe(1); expect(count('/app/commands/prepare')).toBe(1);
});

async function pendingNew(prompt: string): Promise<PendingDelivery> {
  const text = runtime.task.encodeNewTask({ version: 1, tool: 'codex', cwd: 'C:/fixture', prompt, approval: 'ask', workspaceMode: 'code', images: [] });
  const sessionKey = runtime.task.newSessionReceiptKey('codex', false);
  await expect(runtime.delivery.deliverMessage({ scope: 'paired', deviceId: 'pc', sessionKey, surface: 'cli', text, idempotent: true, durableProtocol: 2,
    perform: async () => { throw new runtime.client.HubError('queued fixture', 409, 'command_receipt_pending'); },
  })).rejects.toThrow();
  return (await runtime.delivery.pendingDelivery('paired', 'pc', sessionKey))!;
}

test('old cancel completion cannot remove, pause or accept a newer pending receipt', async () => {
  const old = await pendingNew('first');
  await runtime.delivery.cancelPendingDelivery(old.scope, old.deviceId, old.sessionKey);
  const next = await pendingNew('second'); expect(next.requestId).not.toBe(old.requestId);
  await expect(runtime.delivery.settleQueuedDelivery(old.scope, old.deviceId, old.sessionKey, old.requestId)).resolves.toBeUndefined();
  await expect(runtime.delivery.settleQueuedDelivery(old.scope, old.deviceId, old.sessionKey, old.requestId, 'codex:created')).resolves.toBeUndefined();
  await expect(runtime.delivery.pausePendingDelivery(old.scope, old.deviceId, old.sessionKey, old.requestId)).rejects.toThrow();
  expect(await runtime.delivery.pendingDelivery(next.scope, next.deviceId, next.sessionKey)).toMatchObject({ requestId: next.requestId, text: next.text });
  expect((await runtime.delivery.pendingDelivery(next.scope, next.deviceId, next.sessionKey))!.pausedByStop).not.toBe(true);
});

test('a verified original new-session result restores its key despite a paused retry fence', async () => {
  const pending = await pendingNew('keep original');
  await runtime.delivery.pausePendingDelivery(pending.scope, pending.deviceId, pending.sessionKey, pending.requestId);
  await runtime.delivery.settleQueuedDelivery(pending.scope, pending.deviceId, pending.sessionKey, pending.requestId, 'codex:created');
  let reconciled = 0;
  await runtime.delivery.deliverMessage({ scope: pending.scope, deviceId: pending.deviceId, sessionKey: pending.sessionKey, surface: 'cli', text: pending.text,
    expectedRequestId: pending.requestId, idempotent: true, perform: async receipt => {
      expect(receipt.requestId).toBe(pending.requestId); expect(receipt.acceptedSessionKey).toBe('codex:created'); reconciled++;
      return { sessionKey: receipt.acceptedSessionKey!, retain: true };
    } });
  expect(reconciled).toBe(1);
  expect(await runtime.delivery.pendingDelivery(pending.scope, pending.deviceId, pending.sessionKey)).toMatchObject({ requestId: pending.requestId, pausedByStop: true, acceptedSessionKey: 'codex:created' });
});
