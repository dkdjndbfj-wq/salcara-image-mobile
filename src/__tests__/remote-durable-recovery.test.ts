import { executeDurableCommand, durableExecutionId } from '../remote/durable-commands';
import { commitDurableEvents, loadDurableEvents } from '../remote/durable-events';
import { setHubFetch, type Command, type FetchLike, type SessionEventsPage } from '../remote/client';

const mockDisk = new Map<string, string>();
let mockFail = false;
jest.mock('../storage/database', () => ({ getSetting: async (key: string) => mockDisk.get(key) ?? null,
  setSetting: async (key: string, value: string) => { if (mockFail) throw new Error('disk full'); mockDisk.set(key, value); } }));
const operationId = '0199aaa1-1234-4678-9abc-000000000002';
const intentId = '0199aaa1-1234-4678-9abc-000000000001';
const owner = { url: 'https://station.test', pairToken: 'fixture' };
const input = (): Parameters<typeof executeDurableCommand>[0] => ({ owner, scope: 'paired', deviceId: 'pc', intentId,
  command: { type: 'session.send', sessionKey: 'codex:one', text: 'hello', controlSurface: 'cli', operationId: intentId } as Command,
  active: () => true, bound: async () => undefined });
const ticket = () => ({ operationId, ticket: 'signed-fixture', dispatchNotAfter: Date.now() + 600_000, storageEpoch: 'epoch-one' });
function wire(handler: (path: string, body: Record<string, unknown>) => unknown | Promise<unknown>) {
  setHubFetch((async (url, init) => ({ ok: true, status: 200, text: async () => JSON.stringify(await handler(new URL(String(url)).pathname, init?.body ? JSON.parse(String(init.body)) : {})) })) as FetchLike);
}
beforeEach(() => { mockDisk.clear(); mockFail = false; });
afterEach(() => { setHubFetch(null); });

test('ticket and final result commit before dispatch and ACK, execution keeps the server UUID', async () => {
  const issued = ticket(), actions: string[] = [];
  wire((path, body) => {
    actions.push(path);
    if (path.endsWith('/prepare')) return { ...issued, state: 'prepared' };
    if (path === '/app/operations') return { ...issued, state: 'prepared', ok: true };
    if (path === '/app/commands') {
      expect(mockDisk.get('remote.durable.commands.v2')).toContain('signed-fixture');
      expect(body).toMatchObject({ requestId: operationId, executionTicket: issued.ticket, command: { operationId } });
      return { ok: true, result: { accepted: true, operationId } };
    }
    expect(JSON.parse(mockDisk.get('remote.durable.commands.v2')!)[0].completed).toMatchObject({ ok: true, result: { accepted: true } });
    return { ok: true };
  });
  await expect(executeDurableCommand(input())).resolves.toMatchObject({ accepted: true });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(actions).toEqual(['/app/commands/prepare', '/app/operations', '/app/commands', '/app/operations/ack']);
  expect(await durableExecutionId('paired', 'pc', intentId)).toBe(operationId);
  expect(await durableExecutionId('other', 'pc', intentId)).toBe(intentId);
});

test('failed ticket commit never dispatches and the same prepare intent is retained by the server', async () => {
  const issued = ticket(), calls: string[] = [];
  wire(path => { calls.push(path); mockFail = true; return { ...issued, state: 'prepared' }; });
  await expect(executeDurableCommand(input())).rejects.toThrow('disk full');
  expect(calls).toEqual(['/app/commands/prepare']);
});

test('lost response resumes from saved ticket and completed status without executing again', async () => {
  const issued = ticket(); let sends = 0, prepares = 0;
  wire(path => {
    if (path.endsWith('/prepare')) { prepares++; return { ...issued, state: 'prepared' }; }
    if (path === '/app/operations') return { ...issued, state: sends ? 'completed' : 'prepared', ok: true, ...(sends ? { result: { accepted: true } } : {}) };
    if (path === '/app/commands') { sends++; throw new Error('lost response'); }
    return { ok: true };
  });
  await expect(executeDurableCommand(input())).rejects.toThrow();
  await expect(executeDurableCommand(input())).resolves.toEqual({ accepted: true });
  expect([sends, prepares]).toEqual([1, 1]);
});

test.each(['queued', 'pending', 'uncertain', 'expired'])('%s status never causes a new dispatch or prepare identity', async state => {
  const issued = ticket(); const calls: string[] = [];
  wire(path => { calls.push(path); return path.endsWith('/prepare') ? { ...issued, state: 'prepared' } : { ...issued, state, ok: true }; });
  await expect(executeDurableCommand(input())).rejects.toThrow();
  await expect(executeDurableCommand(input())).rejects.toThrow();
  expect(calls.filter(path => path.endsWith('/prepare'))).toHaveLength(1);
  expect(calls).not.toContain('/app/commands');
});

test('server command digest cannot be changed on recovery and source switch cannot dispatch', async () => {
  const issued = ticket(); let active = true;
  wire(path => { if (path.endsWith('/prepare')) { active = false; return { ...issued, state: 'prepared' }; } throw new Error('must not execute'); });
  await expect(executeDurableCommand({ ...input(), active: () => active })).rejects.toMatchObject({ code: 'aborted' });
  expect(mockDisk.size).toBe(0);
  wire(path => path.endsWith('/prepare') ? { ...issued, state: 'prepared' } : { ...issued, state: 'pending', ok: true });
  await expect(executeDurableCommand(input())).rejects.toMatchObject({ code: 'command_receipt_pending' });
  await expect(executeDurableCommand({ ...input(), command: { ...input().command, text: 'changed' } as Command })).rejects.toMatchObject({ code: 'request_id_conflict' });
});

test('result disk failure leaves the Hub result unacknowledged', async () => {
  const issued = ticket(), calls: string[] = [];
  wire(path => { calls.push(path);
    if (path.endsWith('/prepare')) return { ...issued, state: 'prepared' };
    if (path === '/app/operations') { mockFail = true; return { ...issued, state: 'completed', ok: true, result: { accepted: true } }; }
    return { ok: true };
  });
  await expect(executeDurableCommand(input())).rejects.toThrow('disk full');
  expect(calls).not.toContain('/app/operations/ack');
});

test('accepted reply remains attached to its original scope if the UI switches during execution', async () => {
  const issued = ticket(); let active = true;
  wire(path => {
    if (path.endsWith('/prepare')) return { ...issued, state: 'prepared' };
    if (path === '/app/operations') return { ...issued, state: 'prepared', ok: true };
    if (path === '/app/commands') { active = false; return { ok: true, result: { accepted: true } }; }
    return { ok: true };
  });
  await expect(executeDurableCommand({ ...input(), active: () => active })).resolves.toEqual({ accepted: true });
  expect(JSON.parse(mockDisk.get('remote.durable.commands.v2')!)[0]).toMatchObject({ scope: 'paired', completed: { ok: true } });
});

const event = (seq: number, text = 'one') => ({ type: 'message', deviceId: 'pc', sessionKey: 'codex:one', tool: 'codex', ts: seq, seq, id: 'message', role: 'assistant', text, final: false });
const page = (events: unknown[], epoch = 'epoch-one'): SessionEventsPage => ({ events: [], durableEvents: events, storageEpoch: epoch,
  scannedEventCount: events.length, nextSeq: Number((events.at(-1) as { seq: number }).seq), lastSeq: 10, hasMore: false, resetRequired: false });

test('events survive reload, compact cumulative fragments, retain future records and isolate bindings', async () => {
  await commitDurableEvents('paired', 'pc', 'codex:one', page([event(1)]));
  await commitDurableEvents('paired', 'pc', 'codex:one', page([event(2, 'one two'), { ...event(3), type: 'future.payload', custom: 'keep' }]));
  const stored = JSON.parse(mockDisk.get('remote.durable.events.v1')!)[0];
  expect(stored.events).toHaveLength(2);
  expect(stored.events[1].custom).toBe('keep');
  expect(await loadDurableEvents('paired', 'pc', 'codex:one')).toMatchObject({ through: 3, events: [{ text: 'one two' }] });
  expect(await loadDurableEvents('other', 'pc', 'codex:one')).toBeUndefined();
});

test('event commit failure cannot advance durable cursor; epoch reset retains prior content', async () => {
  await commitDurableEvents('paired', 'pc', 'codex:one', page([event(9)]));
  mockFail = true;
  await expect(commitDurableEvents('paired', 'pc', 'codex:one', page([event(10)]))).rejects.toThrow();
  expect(await loadDurableEvents('paired', 'pc', 'codex:one')).toMatchObject({ through: 9 });
  mockFail = false;
  await commitDurableEvents('paired', 'pc', 'codex:one', page([{ ...event(1, 'new epoch'), id: 'second' }], 'epoch-two'));
  expect(await loadDurableEvents('paired', 'pc', 'codex:one')).toMatchObject({ epoch: 'epoch-two', through: 1, events: [{ text: 'one' }, { text: 'new epoch' }] });
});
