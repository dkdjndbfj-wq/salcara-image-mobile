import { nextBackgroundSyncBatch } from '../remote/background-sync';

type Task = { key: string };
const keyOf = (task: Task) => task.key;

test('rotates through more active conversations while keeping each batch bounded', () => {
  const tasks = Array.from({ length: 9 }, (_, index) => ({ key: `task-${index}` }));
  const first = nextBackgroundSyncBatch(tasks, null, new Set(), keyOf, 4);
  const second = nextBackgroundSyncBatch(tasks, first.cursorKey, new Set(), keyOf, 4);
  const third = nextBackgroundSyncBatch(tasks, second.cursorKey, new Set(), keyOf, 4);

  expect(first.items.map(keyOf)).toEqual(['task-0', 'task-1', 'task-2', 'task-3']);
  expect(second.items.map(keyOf)).toEqual(['task-4', 'task-5', 'task-6', 'task-7']);
  expect(third.items.map(keyOf)).toEqual(['task-8', 'task-0', 'task-1', 'task-2']);
  expect([first, second, third].every(batch => batch.items.length <= 4)).toBe(true);
});

test('skips in-flight conversations without preventing later rows from receiving a sync slot', () => {
  const tasks = Array.from({ length: 7 }, (_, index) => ({ key: `task-${index}` }));
  const batch = nextBackgroundSyncBatch(tasks, 'task-2', new Set(['task-2', 'task-3', 'task-4']), keyOf, 3);

  expect(batch.items.map(keyOf)).toEqual(['task-5', 'task-6', 'task-0']);
  expect(batch.cursorKey).toBe('task-1');
});

test('removing the cursor item restarts safely and an empty directory resets rotation', () => {
  const tasks = [{ key: 'task-a' }, { key: 'task-b' }, { key: 'task-c' }];
  expect(nextBackgroundSyncBatch(tasks, 'removed-task', new Set(), keyOf, 2).items.map(keyOf)).toEqual(['task-a', 'task-b']);
  expect(nextBackgroundSyncBatch([], 'task-b', new Set(), keyOf)).toEqual({ items: [], cursorKey: null });
});
