import { clockText, formatDuration, formatTokens, quoteFor, runningSince, searchBlocks, turnStats } from '../remote/thread-stats';
import type { TimelineItem } from '../remote/store';

const items: TimelineItem[] = [
  { kind: 'turn', id: 't1', status: 'started', ts: 1_000 },
  { kind: 'message', id: 'u1', role: 'user', text: '修一下登录', final: true, ts: 1_000 },
  { kind: 'message', id: 'a1', role: 'assistant', text: '先看看', final: true, ts: 2_000 },
  { kind: 'message', id: 'child', role: 'assistant', text: '子任务回复', final: true, ts: 3_000, parentId: 'task' },
  { kind: 'message', id: 'a2', role: 'assistant', text: '修好了', final: true, ts: 50_000 },
  { kind: 'turn', id: 't2', status: 'completed', ts: 81_000, usage: { inputTokens: 12_000, outputTokens: 345 } },
  { kind: 'turn', id: 't3', status: 'started', ts: 90_000 },
];

test('turn stats attach duration and tokens to the last top-level reply of each turn', () => {
  const stats = turnStats(items);
  expect(stats.get('a2')).toEqual({ durationMs: 80_000, tokens: 12_345 });
  expect(stats.has('a1')).toBe(false);
  expect(stats.has('child')).toBe(false);
});

test('a history without start markers only shows reported tokens', () => {
  const stats = turnStats([
    { kind: 'message', id: 'a', role: 'assistant', text: 'x', final: true, ts: 1 },
    { kind: 'turn', id: 'done', status: 'completed', ts: 2 },
    { kind: 'message', id: 'b', role: 'assistant', text: 'y', final: true, ts: 3 },
    { kind: 'turn', id: 'done2', status: 'completed', ts: 4, usage: { outputTokens: 900 } },
  ]);
  expect(stats.has('a')).toBe(false);
  expect(stats.get('b')).toEqual({ tokens: 900 });
});

test('running clock starts at the newest open turn', () => {
  expect(runningSince(items)).toBe(90_000);
  expect(runningSince(items.slice(0, 6))).toBeUndefined();
  expect(clockText(83_000)).toBe('1:23');
  expect(clockText(3_723_000)).toBe('1:02:03');
});

test('formatting, quoting and search', () => {
  expect(formatDuration(42_000)).toBe('42 秒');
  expect(formatDuration(80_000)).toBe('1 分 20 秒');
  expect(formatTokens(12_345)).toBe('12K');
  expect(formatTokens(1_500)).toBe('1.5K');
  expect(quoteFor('第一行\n第二行\n```js\ncode\n```')).toBe('> 第一行\n> 第二行\n> [代码]\n\n');
  const blocks = [{ type: 'user', item: { text: '登录页报错' } }, { type: 'activity' }, { type: 'assistant', item: { text: '已修复登录' } }, { type: 'turn', item: { error: 'rate limit' } }];
  expect(searchBlocks(blocks, '登录')).toEqual([0, 2]);
  expect(searchBlocks(blocks, 'RATE')).toEqual([3]);
  expect(searchBlocks(blocks, '  ')).toEqual([]);
});
