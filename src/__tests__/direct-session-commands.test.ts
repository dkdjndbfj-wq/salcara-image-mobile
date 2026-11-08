import { createDirectSessionCommands } from '../remote/direct-session-commands';

jest.mock('expo-crypto', () => ({ randomUUID: () => '11111111-2222-4333-8444-555555555555' }));
const operationId = '11111111-2222-4333-8444-555555555555', sessionKey = 'codex:source';
const actions = { sessionKey, revision: 'r1', title: 'Current task', archived: false, actions: ['fork', 'archive'] };
const workflows = { sessionKey, revision: 'r1', canReview: true, goalSupported: false, goalActions: [] };
const fork = { sessionKey, operationId, action: 'fork', state: 'completed', session: { sessionKey: 'codex:branch', tool: 'codex', client: 'Codex', title: 'Branch', cwd: '/project', updatedAt: 1, status: 'idle', controllable: true } };
let sequence = 0;
function setup() {
  let current = true;
  const scope = `direct-commands-${++sequence}`, send = jest.fn(), guard = () => { if (!current) throw new Error('来源已变化'); }, need = jest.fn();
  const options = { scope, sessionKey, isCurrent: () => current, guard, need, send, base: { tool: 'codex', sessionKey, controlSurface: 'cli' as const, accountId: 'api-1' } };
  return { send, need, owner: createDirectSessionCommands(options), remake: () => createDirectSessionCommands(options), invalidate: () => { current = false; } };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

test('fork uses the captured Direct account, revision and correlated operation receipt', async () => {
  const { owner, send } = setup(); send.mockResolvedValueOnce(actions).mockResolvedValueOnce(fork);
  const reading = await owner.readActions(); expect(send).toHaveBeenCalledTimes(1);
  await expect(owner.applyAction(reading, 'fork')).resolves.toMatchObject({ state: 'completed', session: { sessionKey: 'codex:branch' } });
  expect(send).toHaveBeenLastCalledWith({ type: 'session.action', tool: 'codex', sessionKey, controlSurface: 'cli', accountId: 'api-1', action: 'fork', expectedRevision: 'r1', operationId }, 110000);
});

test('review starts only an explicit uncommitted-change review with a valid turn receipt', async () => {
  const { owner, send } = setup(); send.mockResolvedValueOnce(workflows).mockResolvedValueOnce({ sessionKey, operationId, kind: 'review', state: 'requested', turnId: 'turn-1' });
  const reading = await owner.readWorkflows(); await expect(owner.applyReview(reading)).resolves.toMatchObject({ state: 'requested', turnId: 'turn-1' });
  expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'session.workflow', kind: 'review', target: { type: 'uncommittedChanges' }, expectedRevision: 'r1', operationId }), 110000);
});

test.each(['wrong-operation', 'wrong-session', 'missing-fork'])('rejects %s receipts and preserves ambiguity across remounts', async variant => {
  const { owner, send, remake } = setup(); send.mockResolvedValueOnce(actions);
  const reading = await owner.readActions(), bad = { ...fork, ...(variant === 'wrong-operation' ? { operationId: 'foreign' } : variant === 'wrong-session' ? { sessionKey: 'codex:foreign' } : { session: undefined }) };
  send.mockResolvedValueOnce(bad); await expect(owner.applyAction(reading, 'fork')).rejects.toThrow('未确认');
  const remounted = remake(); send.mockResolvedValueOnce(actions);
  const refreshed = await remounted.readActions(); expect(refreshed.value.actions).toEqual([]);
  await expect(remounted.applyAction(reading, 'fork')).rejects.toThrow('尚未确认');
  expect(send.mock.calls.filter(call => call[0].type === 'session.action')).toHaveLength(1);
});

test('pending and unconfirmed operations never replay; an advanced revision requires a new manual action', async () => {
  const { owner, send } = setup(); send.mockResolvedValueOnce(actions); const reading = await owner.readActions();
  const pending = deferred<unknown>(); send.mockReturnValueOnce(pending.promise); const first = owner.applyAction(reading, 'archive');
  await expect(owner.applyAction(reading, 'archive')).rejects.toThrow('尚未确认');
  pending.resolve({ sessionKey, operationId, action: 'archive', state: 'unconfirmed' }); await first;
  send.mockResolvedValueOnce(actions); expect((await owner.readActions()).value.actions).toEqual([]);
  send.mockResolvedValueOnce({ ...actions, revision: 'r2' }); const fresh = await owner.readActions(); expect(fresh.value.actions).toContain('archive');
  expect(send.mock.calls.filter(call => call[0].type === 'session.action')).toHaveLength(1);
  send.mockResolvedValueOnce({ sessionKey, operationId, action: 'archive', state: 'completed' }); await owner.applyAction(fresh, 'archive');
  expect(send.mock.calls.filter(call => call[0].type === 'session.action')).toHaveLength(2);
});

test('missing capabilities, foreign scope and changed source cannot dispatch', async () => {
  const { owner, send, need, invalidate } = setup(); send.mockResolvedValue(actions); const reading = await owner.readActions();
  await expect(owner.applyAction({ ...reading, scope: 'hub:foreign' }, 'archive')).rejects.toThrow('确认');
  await expect(owner.applyAction({ ...reading, value: { ...reading.value, actions: [] } }, 'fork')).rejects.toThrow('确认');
  need.mockImplementation(() => { throw new Error('未开放'); }); await expect(owner.readWorkflows()).rejects.toThrow('未开放'); need.mockReset();
  invalidate(); await expect(owner.applyAction(reading, 'archive')).rejects.toThrow('来源已变化'); expect(send).toHaveBeenCalledTimes(1);
});

test('late reads and review receipts are rejected after source changes', async () => {
  const first = setup(), pending = deferred<unknown>(); first.send.mockReturnValueOnce(pending.promise); const read = first.owner.readActions(); first.invalidate(); pending.resolve(actions); await expect(read).rejects.toThrow('来源已变化');
  const second = setup(); second.send.mockResolvedValueOnce(workflows); const reading = await second.owner.readWorkflows(); const receipt = deferred<unknown>(); second.send.mockReturnValueOnce(receipt.promise);
  const review = second.owner.applyReview(reading); second.invalidate(); receipt.resolve({ sessionKey, operationId, kind: 'review', state: 'requested', turnId: 'turn-1' }); await expect(review).rejects.toThrow('来源已变化');
});
