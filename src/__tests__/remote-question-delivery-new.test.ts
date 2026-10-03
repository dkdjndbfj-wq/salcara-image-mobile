import { HubError } from '../remote/client';
import { DELIVERY_RETRY_WINDOW_MS } from '../remote/offline-policy';
import { deliverQuestionAnswer, questionRetryDelay } from '../remote/question-delivery';

jest.mock('expo-crypto', () => ({ randomUUID: () => '0199aaa1-1234-4678-9abc-000000000001' }));
beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(1_900_000_000_000); });
afterEach(() => { jest.useRealTimers(); });
const context = () => ({ signal: new AbortController().signal, active: () => true });
const advance = (ms: number) => jest.advanceTimersByTimeAsync(ms);

test('a completed computer acknowledgement finishes once without a retry or timer', async () => {
  const perform = jest.fn(async () => undefined);
  await deliverQuestionAnswer({ ...context(), perform });
  expect(perform).toHaveBeenCalledWith(expect.any(String), false);
  expect(perform).toHaveBeenCalledTimes(1); expect(jest.getTimerCount()).toBe(0);
});

test('network loss retries the same UUID after backoff, never a fresh request', async () => {
  const perform = jest.fn(async (_requestId: string, _retrying: boolean) => undefined).mockRejectedValueOnce(new HubError('lost'));
  const recover = jest.fn(async () => undefined);
  const pending = deliverQuestionAnswer({ ...context(), perform, recover });
  await advance(1999); expect(perform).toHaveBeenCalledTimes(1);
  await advance(1); await pending;
  expect(perform).toHaveBeenNthCalledWith(2, perform.mock.calls[0][0], true);
  expect(recover).toHaveBeenCalledTimes(1);
});

test.each([
  new HubError('revoked', 403), new HubError('invalid answer', 200),
  new HubError('delivery uncertain', 409, 'command_delivery_uncertain'),
  new HubError('receipt conflict', 409, 'request_id_conflict'),
  new HubError('old hub', 200, 'question_retry_unsupported'),
])('permanent errors stop waiting rather than repeatedly mutating: %s', async (error) => {
  const perform = jest.fn(async () => { throw error; });
  await expect(deliverQuestionAnswer({ ...context(), perform })).rejects.toBe(error);
  expect(perform).toHaveBeenCalledTimes(1); expect(jest.getTimerCount()).toBe(0);
});

test('a resolved/revoked question found by recovery stops before redispatch', async () => {
  let active = true;
  const perform = jest.fn(async () => { throw new HubError('lost'); });
  const pending = deliverQuestionAnswer({ ...context(), active: () => active, perform, recover: async () => { active = false; } });
  const assertion = expect(pending).rejects.toMatchObject({ name: 'QuestionDeliveryCancelled' });
  await advance(2000); await assertion;
  expect(perform).toHaveBeenCalledTimes(1);
});

test('leaving the session cancels backoff immediately and does not leak timers', async () => {
  const controller = new AbortController();
  const perform = jest.fn(async () => { throw new HubError('offline'); });
  const pending = deliverQuestionAnswer({ ...context(), signal: controller.signal, perform });
  const assertion = expect(pending).rejects.toMatchObject({ name: 'QuestionDeliveryCancelled' });
  await advance(0); controller.abort(); await assertion;
  expect(jest.getTimerCount()).toBe(0); await advance(300_000); expect(perform).toHaveBeenCalledTimes(1);
});

test('question expiry while offline stops without sending a late answer', async () => {
  const perform = jest.fn(async () => { throw new HubError('offline'); });
  const pending = deliverQuestionAnswer({ ...context(), expiresAt: Date.now() + 500, perform });
  const assertion = expect(pending).rejects.toMatchObject({ code: 'question_expired' });
  await advance(500); await assertion; expect(perform).toHaveBeenCalledTimes(1);
});

test('backgrounded phone waits locally without network calls and resumes on foreground', async () => {
  let foreground = false;
  const perform = jest.fn(async () => undefined), recover = jest.fn(async () => undefined);
  const pending = deliverQuestionAnswer({ ...context(), canSend: () => foreground, perform, recover });
  await advance(5000); expect(perform).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled();
  foreground = true; await advance(5000); await pending;
  expect(perform).toHaveBeenCalledTimes(1); expect(perform).toHaveBeenCalledWith(expect.any(String), false);
});

test('backoff is bounded and clock rollback cannot extend receipt safety', async () => {
  expect(questionRetryDelay(0)).toBe(2000); expect(questionRetryDelay(30)).toBe(300_000);
  const perform = jest.fn(async () => { throw new HubError('offline'); });
  const pending = deliverQuestionAnswer({ ...context(), perform });
  const assertion = expect(pending).rejects.toMatchObject({ code: 'question_clock_changed' });
  await advance(0); jest.setSystemTime(Date.now() - 60_000); await advance(2000); await assertion;
  expect(perform).toHaveBeenCalledTimes(1);
});

test('unbounded questions cannot outlive the Hub receipt retention window', async () => {
  const perform = jest.fn(async () => { throw new HubError('offline'); });
  const pending = deliverQuestionAnswer({ ...context(), perform });
  const assertion = expect(pending).rejects.toMatchObject({ code: 'question_expired' });
  await advance(0); jest.setSystemTime(Date.now() + DELIVERY_RETRY_WINDOW_MS); await advance(2000); await assertion;
  expect(perform).toHaveBeenCalledTimes(1);
});
