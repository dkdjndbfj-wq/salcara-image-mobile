import { resetDeliveryForTests, retiredDeliveryScopes, retireDeliveryScope } from '../remote/delivery';
import { deliverQuestionAnswer } from '../remote/question-delivery';
import { blockQuestionReceipt, finishQuestionReceipt, markQuestionAttempt, pendingQuestionReceipts, pendingQuestionReceiptsForDevice,
  prepareQuestionReceipt, resetQuestionOutboxForTests, retireQuestionScope, type QuestionReceipt } from '../remote/question-outbox';

const key = 'remote_question_outbox_v1';
const deliveryKey = 'remote_pending_delivery_v1';
const fenceKey = 'remote_retired_delivery_scopes_v1';
const oldScope = 'station|credential:revoked';
const otherScope = 'station|credential:still-paired';
const target = { scope: oldScope, deviceId: 'pc', sessionKey: 'codex:original' };
const answer = { ...target, approvalId: 'question-main', decision: 'allow' as const, answers: { value: ['private old answer'] }, message: 'private old message' };
const mockSettings = new Map<string, string>();
let mockUuid = 3000;
let mockFailReadKey: string | undefined;
let mockFailWriteKey: string | undefined;
const mockRead = jest.fn(async (name: string): Promise<string | null> => mockSettings.get(name) ?? null);
const mockWrite = jest.fn(async (name: string, value: string) => { mockSettings.set(name, value); });
jest.mock('../storage/database', () => ({ getSetting: (name: string) => mockRead(name), setSetting: (name: string, value: string) => mockWrite(name, value) }));
jest.mock('expo-crypto', () => ({ randomUUID: () => `0199aaa1-1234-4678-9abc-${String(++mockUuid).padStart(12, '0')}` }));
function fixture(index = 1, scope = oldScope): QuestionReceipt {
  const now = Date.now();
  return { ...answer, scope, approvalId: `question-${index}`, requestId: `0199aaa1-1234-4678-9abc-${String(index).padStart(12, '0')}`,
    createdAt: now, lastObservedAt: now, attempted: true };
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
beforeEach(() => {
  resetDeliveryForTests(); resetQuestionOutboxForTests(); mockSettings.clear(); mockUuid = 3000;
  mockFailReadKey = undefined; mockFailWriteKey = undefined;
  mockRead.mockImplementation(async name => {
    if (name === mockFailReadKey) throw new Error('private SQLite read error');
    return mockSettings.get(name) ?? null;
  });
  mockWrite.mockImplementation(async (name, value) => {
    if (name === mockFailWriteKey) throw new Error('private SQLite write error');
    mockSettings.set(name, value);
  });
  mockRead.mockClear(); mockWrite.mockClear();
});

test('retiring twenty active answers releases slots and erases frozen text only for the retired scope', async () => {
  mockSettings.set(key, JSON.stringify(Array.from({ length: 20 }, (_, index) => fixture(index + 1))));
  await expect(prepareQuestionReceipt({ ...answer, scope: otherScope })).rejects.toThrow('核对待确认');
  await retireQuestionScope(oldScope);
  expect(JSON.parse(mockSettings.get(key)!)).toEqual([]);
  expect(mockSettings.get(key)).not.toContain('private old');
  const fresh = await prepareQuestionReceipt({ ...answer, scope: otherScope });
  expect(fresh).toMatchObject({ scope: otherScope, attempted: false });
  await expect(prepareQuestionReceipt(answer)).rejects.toMatchObject({ code: 'question_scope_retired' });
  expect((await pendingQuestionReceipts({ ...target, scope: otherScope }))[0].requestId).toBe(fresh.requestId);
});

test('retiring accumulated UUID tombstones releases the record ceiling and preserves another unknown answer', async () => {
  const old = Array.from({ length: 2047 }, (_, index) => ({ ...fixture(index + 1), blocked: 'question_clock_changed' }));
  const other = { ...fixture(2048, otherScope), blocked: 'command_delivery_uncertain', answers: { value: ['keep this valid unknown answer'] }, message: 'keep this message' };
  mockSettings.set(key, JSON.stringify([...old, other]));
  await expect(prepareQuestionReceipt({ ...answer, scope: otherScope })).rejects.toThrow('核对待确认');
  await retireQuestionScope(oldScope);
  expect(JSON.parse(mockSettings.get(key)!)).toEqual([expect.objectContaining({ requestId: other.requestId, scope: otherScope,
    answers: other.answers, message: other.message, attempted: true, blocked: 'command_delivery_uncertain' })]);
  expect(mockSettings.get(key)).not.toContain('private old');
  const fresh = await prepareQuestionReceipt({ ...answer, scope: otherScope });
  expect(fresh.requestId).not.toBe(other.requestId);
  expect(await pendingQuestionReceipts({ ...target, scope: otherScope })).toEqual(expect.arrayContaining([expect.objectContaining({ requestId: other.requestId, answers: other.answers })]));
});

test('retirement is shared with delivery and cannot be undone by late finish, block or restart', async () => {
  const original = await prepareQuestionReceipt(answer);
  const other = await prepareQuestionReceipt({ ...answer, scope: otherScope });
  await retireQuestionScope(oldScope);
  await finishQuestionReceipt(original); await blockQuestionReceipt(original, 'command_delivery_uncertain');
  resetDeliveryForTests(); resetQuestionOutboxForTests();
  expect(await pendingQuestionReceipts(target)).toEqual([]);
  expect(await pendingQuestionReceiptsForDevice(oldScope, target.deviceId)).toEqual([]);
  await expect(prepareQuestionReceipt(answer)).rejects.toMatchObject({ code: 'question_scope_retired' });
  await expect(markQuestionAttempt(original)).rejects.toMatchObject({ code: 'question_scope_retired' });
  expect(await pendingQuestionReceipts({ ...target, scope: otherScope })).toEqual([expect.objectContaining({ requestId: other.requestId, answers: other.answers, message: other.message })]);
});

test('a delivery-only fence also blocks every question mutation and filters obsolete answers', async () => {
  const original = await prepareQuestionReceipt(answer);
  await retireDeliveryScope(oldScope);
  await expect(markQuestionAttempt(original)).rejects.toMatchObject({ code: 'question_scope_retired' });
  await expect(prepareQuestionReceipt(answer)).rejects.toMatchObject({ code: 'question_scope_retired' });
  expect(await pendingQuestionReceipts(target)).toEqual([]);
  expect(JSON.parse(mockSettings.get(key)!)).toEqual([]);
});

test.each(['lookup', 'prepare'] as const)('a slow question disk read cannot restore a retired scope: %s', async operation => {
  const original = fixture(); mockSettings.set(key, JSON.stringify([original]));
  const snapshot = mockSettings.get(key)!;
  const entered = deferred<void>(), release = deferred<string | null>();
  let held = false;
  mockRead.mockImplementation(async name => {
    if (name === key && !held) { held = true; entered.resolve(); return release.promise; }
    return mockSettings.get(name) ?? null;
  });
  const oldRead = operation === 'lookup' ? pendingQuestionReceipts(target) : prepareQuestionReceipt(answer);
  const outcome = oldRead.catch(error => error);
  await entered.promise;
  const retiring = retireQuestionScope(oldScope);
  expect(await retiredDeliveryScopes()).toContain(oldScope);
  release.resolve(snapshot);
  const result = await outcome; await retiring;
  if (operation === 'lookup') expect(result).toEqual([]);
  else expect(result).toMatchObject({ code: 'question_scope_retired' });
  expect(JSON.parse(mockSettings.get(key)!)).toEqual([]);
});

test('a prepare write that commits after the shared fence cannot publish an obsolete receipt', async () => {
  const entered = deferred<void>(), release = deferred<void>();
  let held = false;
  mockWrite.mockImplementation(async (name, value) => {
    if (name === key && !held) { held = true; entered.resolve(); await release.promise; }
    mockSettings.set(name, value);
  });
  const preparing = prepareQuestionReceipt(answer).catch(error => error);
  await entered.promise;
  const retiring = retireQuestionScope(oldScope);
  expect(await retiredDeliveryScopes()).toContain(oldScope);
  let completed = false; void retiring.then(() => { completed = true; });
  await Promise.resolve(); expect(completed).toBe(false);
  release.resolve();
  expect(await preparing).toMatchObject({ code: 'question_scope_retired' });
  await retiring;
  expect(JSON.parse(mockSettings.get(key)!)).toEqual([]);
});

test('an attempted-answer write in flight cannot authorize perform after the shared fence commits', async () => {
  const original = await prepareQuestionReceipt(answer);
  const entered = deferred<void>(), release = deferred<void>();
  let held = false;
  mockWrite.mockImplementation(async (name, value) => {
    if (name === key && !held) { held = true; entered.resolve(); await release.promise; }
    mockSettings.set(name, value);
  });
  const perform = jest.fn(async () => undefined);
  const sending = deliverQuestionAnswer({ receipt: original, signal: new AbortController().signal, active: () => true,
    beforeAttempt: () => markQuestionAttempt(original), perform }).catch(error => error);
  await entered.promise;
  const retiring = retireQuestionScope(oldScope);
  expect(await retiredDeliveryScopes()).toContain(oldScope);
  release.resolve();
  expect(await sending).toMatchObject({ code: 'question_scope_retired' });
  await retiring;
  expect(perform).not.toHaveBeenCalled(); expect(JSON.parse(mockSettings.get(key)!)).toEqual([]);
});

test('question cleanup failure keeps its disk owner but the committed fence blocks it after restart and cleanup retries', async () => {
  const original = await prepareQuestionReceipt(answer);
  const other = await prepareQuestionReceipt({ ...answer, scope: otherScope });
  const before = mockSettings.get(key); mockFailWriteKey = key;
  await expect(retireQuestionScope(oldScope)).rejects.toThrow('write error');
  expect(mockSettings.get(key)).toBe(before); expect(JSON.parse(mockSettings.get(fenceKey)!)).toContain(oldScope);
  resetDeliveryForTests(); resetQuestionOutboxForTests(); mockFailWriteKey = undefined;
  await expect(markQuestionAttempt(original)).rejects.toMatchObject({ code: 'question_scope_retired' });
  await expect(prepareQuestionReceipt(answer)).rejects.toMatchObject({ code: 'question_scope_retired' });
  expect(await pendingQuestionReceipts(target)).toEqual([]);
  await retireQuestionScope(oldScope);
  expect(await pendingQuestionReceipts({ ...target, scope: otherScope })).toEqual([expect.objectContaining({ requestId: other.requestId, answers: other.answers })]);
});

test('a rejected fence write never clears any question owner and can safely retry', async () => {
  const original = fixture(); mockSettings.set(key, JSON.stringify([original])); mockFailWriteKey = fenceKey;
  await expect(retireQuestionScope(oldScope)).rejects.toThrow('write error');
  expect(JSON.parse(mockSettings.get(key)!)).toEqual([original]);
  expect(mockWrite.mock.calls.filter(([name]) => name === key)).toHaveLength(0);
  expect(mockSettings.has(fenceKey)).toBe(false);
  mockFailWriteKey = undefined;
  await retireQuestionScope(oldScope);
  expect(JSON.parse(mockSettings.get(key)!)).toEqual([]);
});

test.each([key, deliveryKey, fenceKey])('unknown disk read failures never clear or overwrite an old answer: %s', async failedKey => {
  const original = fixture(); mockSettings.set(key, JSON.stringify([original])); mockFailReadKey = failedKey;
  const before = new Map(mockSettings);
  await expect(retireQuestionScope(oldScope)).rejects.toBeInstanceOf(Error);
  expect(mockWrite.mock.calls.filter(([name]) => name === key)).toHaveLength(0);
  expect(mockSettings.get(key)).toBe(before.get(key));
  mockFailReadKey = undefined;
  await retireQuestionScope(oldScope);
  expect(JSON.parse(mockSettings.get(key)!)).toEqual([]);
});

test.each(['', '{"partial":', '{}', 'null',
  JSON.stringify([fixture(), { ...fixture(2), approvalId: 'question-1' }]),
  JSON.stringify([fixture(), { ...fixture(2), requestId: fixture().requestId }]),
  JSON.stringify([{ ...fixture(), requestId: null }]),
])('empty, malformed or duplicate question ownership fails closed without being washed by retirement: %s', async encoded => {
  mockSettings.set(key, encoded);
  await expect(prepareQuestionReceipt(answer)).rejects.toThrow('记录损坏');
  await expect(retireQuestionScope(oldScope)).rejects.toThrow('记录损坏');
  expect(mockSettings.get(key)).toBe(encoded);
  expect(mockWrite.mock.calls.filter(([name]) => name === key)).toHaveLength(0);
});

test('an unreadable shared fence never publishes or marks a question receipt', async () => {
  const original = fixture(); mockSettings.set(key, JSON.stringify([original])); mockSettings.set(fenceKey, '{"partial":');
  await expect(markQuestionAttempt(original)).rejects.toThrow('手机待确认记录暂时无法读取');
  await expect(prepareQuestionReceipt(answer)).rejects.toThrow('手机待确认记录暂时无法读取');
  expect(JSON.parse(mockSettings.get(key)!)).toEqual([original]); expect(mockWrite).not.toHaveBeenCalled();
});

test('the same answer UUID in separate valid credential scopes remains independently owned', async () => {
  const original = fixture(); const other = { ...fixture(2, otherScope), requestId: original.requestId };
  mockSettings.set(key, JSON.stringify([original, other]));
  await retireQuestionScope(oldScope);
  expect(await pendingQuestionReceipts({ ...target, scope: otherScope })).toEqual([expect.objectContaining({ requestId: other.requestId, approvalId: other.approvalId })]);
});
