import { HubError } from '../remote/client';
import { DELIVERY_RETRY_WINDOW_MS } from '../remote/offline-policy';
import { deliverQuestionAnswer } from '../remote/question-delivery';
import { blockQuestionReceipt, finishQuestionReceipt, markQuestionAttempt, markQuestionRejected, pendingQuestionReceipts, prepareQuestionReceipt, reconcileQuestionReceipts, resetQuestionOutboxForTests } from '../remote/question-outbox';
const mockSettings = new Map<string, string>();
let mockUuid = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `0199aaa1-1234-4678-9abc-${String(++mockUuid).padStart(12, '0')}` }));
jest.mock('../storage/database', () => ({ getSetting: async (key: string) => mockSettings.get(key) ?? null,
  setSetting: async (key: string, value: string) => { mockSettings.set(key, value); } }));
const target = { scope: 'paired|credential-a', deviceId: 'pc', sessionKey: 'codex:original' };
const answer = { ...target, approvalId: 'question-a', decision: 'allow' as const, answers: { value: [' A ', ''] } };
beforeEach(() => { mockSettings.clear(); resetQuestionOutboxForTests(); jest.useFakeTimers(); jest.setSystemTime(1_900_000_000_000); });
afterEach(() => jest.useRealTimers());
test('definite rejection survives restart and only a strictly newer head can unlock a still-pending card', async () => {
 const receipt = await prepareQuestionReceipt(answer); await markQuestionAttempt(receipt);
 jest.advanceTimersByTime(10); const rejectedAt = Date.now();
 expect(await markQuestionRejected(receipt)).toBe(true);
 resetQuestionOutboxForTests();
 expect((await pendingQuestionReceipts(target))[0]).toMatchObject({ requestId: receipt.requestId, decision: 'allow', attempted: true, blocked: 'approval_rejected', rejectedAt });
 // Even an empty old snapshot is not allowed to clear the newer refusal lock.
 await reconcileQuestionReceipts(target, [], rejectedAt - 1);
 await reconcileQuestionReceipts(target, [], rejectedAt);
 expect(await pendingQuestionReceipts(target)).toHaveLength(1);
 await expect(prepareQuestionReceipt({ ...answer, decision: 'deny' })).rejects.toMatchObject({ code: 'approval_rejected' });
 await reconcileQuestionReceipts({ ...target, scope: 'other-scope' }, [], rejectedAt + 1);
 expect(await pendingQuestionReceipts(target)).toHaveLength(1);
 await reconcileQuestionReceipts(target, [answer.approvalId], rejectedAt + 1);
 expect(await pendingQuestionReceipts(target)).toEqual([]);
 expect((await prepareQuestionReceipt({ ...answer, decision: 'deny' })).requestId).not.toBe(receipt.requestId);
});

test.each(['restored', 'uncertain'] as const)('an old %s attempt cannot become a definite rejection marker', async scenario => {
 const original = await prepareQuestionReceipt(answer); await markQuestionAttempt(original);
 if (scenario === 'uncertain') await blockQuestionReceipt(original, 'command_delivery_uncertain');
 const candidate = scenario === 'restored' ? (await pendingQuestionReceipts(target))[0] : original;
 expect(await markQuestionRejected(candidate)).toBe(false);
 expect((await pendingQuestionReceipts(target))[0].rejectedAt).toBeUndefined();
 await reconcileQuestionReceipts(target, [answer.approvalId], Date.now() + 1);
 expect((await pendingQuestionReceipts(target))[0].requestId).toBe(original.requestId);
});

test('process restart restores exact answer, original deadline and attempted UUID', async () => {
 const original = await prepareQuestionReceipt(answer); await markQuestionAttempt(original);
 resetQuestionOutboxForTests(); const restored = (await pendingQuestionReceipts(target))[0];
 expect(restored).toMatchObject({ requestId: original.requestId, createdAt: original.createdAt, attempted: true, answers: { value: [' A ', ''] } });
 const perform = jest.fn(async () => undefined);
 await deliverQuestionAnswer({ receipt: restored, signal: new AbortController().signal, active: () => true, beforeAttempt: () => markQuestionAttempt(restored), perform });
 expect(perform).toHaveBeenCalledWith(original.requestId, true);
 await finishQuestionReceipt(restored); expect(await pendingQuestionReceipts(target)).toEqual([]);
});
test('durable record exists before the first dispatch', async () => {
 const receipt = await prepareQuestionReceipt(answer);
 const perform = jest.fn(async () => { expect((await pendingQuestionReceipts(target))[0]).toMatchObject({ attempted: true, requestId: receipt.requestId }); });
 await deliverQuestionAnswer({ receipt, signal: new AbortController().signal, active: () => true, beforeAttempt: () => markQuestionAttempt(receipt), perform });
 expect(perform).toHaveBeenCalledWith(receipt.requestId, false);
});

test('the exact command is captured before storage waits and survives restart without following edited UI objects', async () => {
 const input = { ...answer, answers: { value: ['original'] }, command: { type: 'approval.respond' as const, approvalId: answer.approvalId,
   sessionKey: target.sessionKey, decision: answer.decision, answers: { value: ['original'] }, accountId: 'api_original', controlSurface: 'cli' as const } };
 const preparing = prepareQuestionReceipt(input);
 input.command.accountId = 'api_changed'; input.command.answers.value[0] = 'changed'; input.answers.value[0] = 'changed';
 const receipt = await preparing;
 expect(receipt.command).toMatchObject({ accountId: 'api_original', answers: { value: ['original'] } });
 receipt.command!.accountId = 'caller-mutated'; resetQuestionOutboxForTests();
 expect((await pendingQuestionReceipts(target))[0].command).toMatchObject({ accountId: 'api_original', answers: { value: ['original'] } });
});

test('an attempted legacy receipt cannot acquire a new source; an unattempted one can capture before sending', async () => {
 const command = { type: 'approval.respond' as const, approvalId: answer.approvalId, sessionKey: target.sessionKey,
   decision: answer.decision, answers: answer.answers, accountId: 'api_original', controlSurface: 'cli' as const };
 const first = await prepareQuestionReceipt(answer); await markQuestionAttempt(first);
 await expect(prepareQuestionReceipt({ ...answer, command })).rejects.toMatchObject({ code: 'question_source_unconfirmed' });
 expect((await pendingQuestionReceipts(target))[0]).toMatchObject({ requestId: first.requestId, attempted: true });
 await finishQuestionReceipt(first); const unattempted = await prepareQuestionReceipt(answer);
 expect(await prepareQuestionReceipt({ ...answer, command })).toMatchObject({ requestId: unattempted.requestId, attempted: false, command });
});

test('expiring a captured command removes its answer content while retaining a readable tombstone', async () => {
 const command = { type: 'approval.respond' as const, approvalId: answer.approvalId, sessionKey: target.sessionKey,
   decision: answer.decision, answers: answer.answers, accountId: 'api_original', controlSurface: 'cli' as const };
 const first = await prepareQuestionReceipt({ ...answer, command });
 jest.setSystemTime(Date.now() + DELIVERY_RETRY_WINDOW_MS + 1);
 await prepareQuestionReceipt({ ...answer, approvalId: 'new-question' });
 resetQuestionOutboxForTests();
 expect((await pendingQuestionReceipts(target)).find(item => item.requestId === first.requestId)).toMatchObject({ blocked: 'question_expired' });
 expect((await pendingQuestionReceipts(target)).find(item => item.requestId === first.requestId)?.command).toBeUndefined();
});
test('expired or uncertain records never become a new answer on restart', async () => {
 const receipt = await prepareQuestionReceipt(answer); await blockQuestionReceipt(receipt, 'command_delivery_uncertain'); resetQuestionOutboxForTests();
 await expect(prepareQuestionReceipt(answer)).rejects.toMatchObject({ code: 'command_delivery_uncertain' });
 expect((await pendingQuestionReceipts(target))[0].requestId).toBe(receipt.requestId);
 await finishQuestionReceipt(receipt); const next = await prepareQuestionReceipt(answer);
 jest.setSystemTime(Date.now() + DELIVERY_RETRY_WINDOW_MS); resetQuestionOutboxForTests();
 expect((await pendingQuestionReceipts(target))[0]).toMatchObject({ requestId: next.requestId, blocked: 'question_expired' });
 await expect(markQuestionAttempt(next)).rejects.toMatchObject({ code: 'question_expired' });
});
test('clock rollback is persisted and cannot extend recovery deadline', async () => {
 const receipt = await prepareQuestionReceipt(answer); jest.setSystemTime(Date.now() + 10000); await pendingQuestionReceipts(target);
 jest.setSystemTime(Date.now() - 5000); expect((await pendingQuestionReceipts(target))[0].blocked).toBe('question_clock_changed');
 resetQuestionOutboxForTests(); jest.setSystemTime(receipt.createdAt + 30000);
 await expect(prepareQuestionReceipt(answer)).rejects.toMatchObject({ code: 'question_clock_changed' });
});
test('scope isolation, fresh reconciliation and correction preserve ownership', async () => {
 const first = await prepareQuestionReceipt(answer); const other = await prepareQuestionReceipt({ ...answer, scope: 'other-station|credential-b' });
 await expect(prepareQuestionReceipt({ ...answer, answers: { value: ['changed'] } })).rejects.toBeInstanceOf(HubError);
 await reconcileQuestionReceipts(target, []); expect(await pendingQuestionReceipts(target)).toEqual([]);
 expect((await pendingQuestionReceipts({ ...target, scope: other.scope }))[0].requestId).toBe(other.requestId);
 const corrected = await prepareQuestionReceipt({ ...answer, answers: { value: ['corrected'] } }); expect(corrected.requestId).not.toBe(first.requestId);
});
test('invalid local data fails closed instead of allowing an untracked replay', async () => {
 mockSettings.set('remote_question_outbox_v1', 'broken'); await expect(prepareQuestionReceipt(answer)).rejects.toThrow('记录损坏');
 mockSettings.set('remote_question_outbox_v1', JSON.stringify([{ ...answer, requestId: 'broken' }]));
 await expect(prepareQuestionReceipt(answer)).rejects.toThrow('记录损坏');
});
test('a rejected clock observation is persisted before throwing', async () => {
 const receipt = await prepareQuestionReceipt(answer); jest.setSystemTime(receipt.createdAt - 1);
 await expect(prepareQuestionReceipt(answer)).rejects.toMatchObject({ code: 'question_clock_changed' });
 jest.setSystemTime(receipt.createdAt + 20000); resetQuestionOutboxForTests();
 await expect(prepareQuestionReceipt(answer)).rejects.toMatchObject({ code: 'question_clock_changed' });
});

test('a snapshot started before receipt creation cannot retire its original UUID', async () => {
 const started = Date.now(); jest.setSystemTime(started + 1); const receipt = await prepareQuestionReceipt(answer);
 await reconcileQuestionReceipts(target, [], started);
 expect((await pendingQuestionReceipts(target))[0].requestId).toBe(receipt.requestId);
 jest.setSystemTime(started + 2); await reconcileQuestionReceipts(target, [], Date.now());
 expect(await pendingQuestionReceipts(target)).toEqual([]);
});

test('unreachable expired pairings become UUID tombstones without blocking new answers', async () => {
 const originals = [];
 for (let i = 0; i < 20; i++) originals.push(await prepareQuestionReceipt({ ...answer, scope: `old-station-${i}` }));
 await expect(prepareQuestionReceipt(answer)).rejects.toThrow('核对待确认');
 jest.setSystemTime(Date.now() + DELIVERY_RETRY_WINDOW_MS + 1);
 const fresh = await prepareQuestionReceipt(answer); expect(fresh.attempted).toBe(false);
 await expect(prepareQuestionReceipt({ ...answer, scope: originals[0].scope })).rejects.toMatchObject({ code: 'question_expired' });
 const tombstone = (await pendingQuestionReceipts({ ...target, scope: originals[0].scope }))[0];
 expect(tombstone.requestId).toBe(originals[0].requestId); expect(tombstone.answers).toBeUndefined();
});
