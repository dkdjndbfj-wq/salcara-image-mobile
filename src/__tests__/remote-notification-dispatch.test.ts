import { createNotificationDispatcher, type NotificationDispatchItem } from '../remote/notification-dispatch';

const item = (id: string, urgent = false, scope = 'a'): NotificationDispatchItem<string> => ({ id, scope, urgent, value: id });
beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(2_000_000); });
afterEach(() => jest.useRealTimers());

test('ordinary completions in a burst produce one batch without dropping any task', () => {
  const deliver = jest.fn(), dispatcher = createNotificationDispatcher(deliver);
  for (let i = 0; i < 6; i++) dispatcher.enqueue(item(`task-${i}`));
  jest.advanceTimersByTime(999); expect(deliver).not.toHaveBeenCalled();
  jest.advanceTimersByTime(1);
  expect(deliver).toHaveBeenCalledTimes(1);
  expect(deliver.mock.calls[0][0].map((entry: NotificationDispatchItem<string>) => entry.id)).toEqual(Array.from({ length: 6 }, (_, i) => `task-${i}`));
  dispatcher.dispose();
});

test('failure upgrades an ordinary pending result without showing contradictory success', () => {
  const deliver = jest.fn(), dispatcher = createNotificationDispatcher(deliver);
  dispatcher.enqueue(item('turn'));
  dispatcher.enqueue({ ...item('turn', true), value: 'failed' });
  dispatcher.enqueue({ ...item('turn'), value: 'late reply' });
  jest.advanceTimersByTime(100);
  expect(deliver.mock.calls[0][0]).toEqual([{ ...item('turn', true), value: 'failed' }]);
  jest.advanceTimersByTime(5000); expect(deliver).toHaveBeenCalledTimes(1);
  dispatcher.dispose();
});

test('urgent tasks do not wait for a per-session or global ordinary cooldown', () => {
  const deliver = jest.fn(), dispatcher = createNotificationDispatcher(deliver);
  dispatcher.enqueue(item('done')); jest.advanceTimersByTime(1000);
  dispatcher.enqueue(item('failed', true)); jest.advanceTimersByTime(100);
  expect(deliver).toHaveBeenCalledTimes(2);
  dispatcher.enqueue(item('approval', true)); jest.advanceTimersByTime(100);
  expect(deliver).toHaveBeenCalledTimes(3);
  dispatcher.dispose();
});

test('ordinary results cannot immediately replace a visible urgent notice', () => {
  const deliver = jest.fn(), dispatcher = createNotificationDispatcher(deliver);
  dispatcher.enqueue(item('failed', true)); jest.advanceTimersByTime(100);
  dispatcher.enqueue(item('done')); jest.advanceTimersByTime(3999);
  expect(deliver).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(1); expect(deliver).toHaveBeenCalledTimes(2);
  dispatcher.dispose();
});

test('a burst of urgent requests is grouped but every request is retained', () => {
  const deliver = jest.fn(), dispatcher = createNotificationDispatcher(deliver);
  for (let i = 0; i < 20; i++) dispatcher.enqueue(item(`approval-${i}`, true));
  jest.advanceTimersByTime(100);
  expect(deliver).toHaveBeenCalledTimes(1);
  expect(deliver.mock.calls[0][0]).toHaveLength(20);
  dispatcher.dispose();
});

test('a second urgent notice preserves the first still-visible task in the summary', () => {
  const deliver = jest.fn(), dispatcher = createNotificationDispatcher(deliver);
  dispatcher.enqueue(item('failed', true)); jest.advanceTimersByTime(100);
  dispatcher.enqueue(item('approval', true)); jest.advanceTimersByTime(100);
  expect(deliver.mock.calls[1][0].map((entry: NotificationDispatchItem<string>) => entry.id)).toEqual(['failed', 'approval']);
  dispatcher.cancel('a', 'approval');
  dispatcher.enqueue(item('question', true)); jest.advanceTimersByTime(100);
  expect(deliver.mock.calls[2][0].map((entry: NotificationDispatchItem<string>) => entry.id)).toEqual(['failed', 'question']);
  dispatcher.dispose();
});

test('same ids on different computers never replace one another', () => {
  const deliver = jest.fn(), dispatcher = createNotificationDispatcher(deliver);
  dispatcher.enqueue(item('same', false, 'a')); dispatcher.enqueue(item('same', false, 'b'));
  jest.advanceTimersByTime(1000); expect(deliver.mock.calls[0][0]).toHaveLength(2);
  dispatcher.dispose();
});

test('expired or resolved approvals are removed before delivery', () => {
  const deliver = jest.fn(), dispatcher = createNotificationDispatcher(deliver);
  dispatcher.enqueue({ ...item('expired', true), expiresAt: Date.now() + 50 });
  dispatcher.enqueue(item('resolved', true)); dispatcher.cancel('a', 'resolved');
  jest.advanceTimersByTime(200); expect(deliver).not.toHaveBeenCalled();
  dispatcher.dispose();
});

test('a changed connection or a hidden app cannot receive stale queued toasts', () => {
  const deliver = jest.fn(), dispatcher = createNotificationDispatcher(deliver);
  let current = true;
  dispatcher.enqueue({ ...item('done'), isCurrent: () => current });
  current = false; jest.advanceTimersByTime(1000);
  expect(deliver).not.toHaveBeenCalled();
  dispatcher.enqueue(item('another')); dispatcher.cancelScope('a');
  jest.advanceTimersByTime(1000); expect(deliver).not.toHaveBeenCalled();
  dispatcher.dispose();
});

test('continuous results do not keep moving the original batching deadline', () => {
  const deliver = jest.fn(), dispatcher = createNotificationDispatcher(deliver);
  dispatcher.enqueue(item('first')); jest.advanceTimersByTime(900);
  dispatcher.enqueue(item('second')); jest.advanceTimersByTime(100);
  expect(deliver).toHaveBeenCalledTimes(1);
  expect(deliver.mock.calls[0][0]).toHaveLength(2);
  dispatcher.dispose();
});

test('unmount clears timers and queued notifications', () => {
  const deliver = jest.fn(), dispatcher = createNotificationDispatcher(deliver);
  dispatcher.enqueue(item('done')); dispatcher.enqueue(item('failed', true));
  dispatcher.dispose(); dispatcher.enqueue(item('after'));
  jest.runAllTimers(); expect(deliver).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});
