import { clockText, formatDuration, formatTokens, quoteFor, runningSince, runningTurnHeading, searchBlocks, turnStats } from '../remote/thread-stats';
import type { TimelineItem } from '../remote/store';
import { buildBlocks, conversationBlocks } from '../remote/blocks';

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

test('reported native turn duration wins over wall-clock skew', () => {
  const stats = turnStats([
    { kind: 'turn', id: 't1', status: 'started', ts: 1_000 },
    { kind: 'message', id: 'a1', role: 'assistant', text: '完成', final: true, ts: 1_020 },
    { kind: 'turn', id: 't1:done', status: 'completed', durationMs: 987, ts: 5_000 },
  ]);
  expect(stats.get('a1')).toEqual({ durationMs: 987 });
});

test('search reaches folded outputs, paths, diffs, plans and child messages once per rendered block', () => {
  const timeline: TimelineItem[] = [
    { kind: 'message', id: 'intro', role: 'user', text: '开始', final: true, ts: 1 },
    { kind: 'tool', id: 'command', tool: 'command', title: '运行测试', detail: 'npm test -- workspace', output: 'NeedleOutput', status: 'done', ts: 2 },
    { kind: 'tool', id: 'edit', tool: 'file_change', title: '修改', diff: '--- a/src/NeedlePath.ts\n+++ b/src/NeedlePath.ts\n-old\n+NeedleDiff', status: 'done', ts: 3 },
    { kind: 'tool', id: 'plan', tool: 'plan', title: '计划', output: '✓ NeedlePlan', status: 'done', ts: 4 },
    { kind: 'tool', id: 'child', tool: 'subagent', title: '检查', status: 'done', ts: 5, childSessionKeys: ['codex:child'] },
    { kind: 'message', id: 'child-reply', parentId: 'child', role: 'assistant', text: 'NeedleChild', final: true, ts: 6 },
    { kind: 'message', id: 'final', role: 'assistant', text: '完成', final: true, ts: 7 },
  ];
  const blocks = conversationBlocks(buildBlocks(timeline, false), 'codex');
  for (const text of ['needleoutput', 'WORKSPACE', 'needlepath', 'needlediff', 'needleplan', 'needlechild']) {
    const hits = searchBlocks(blocks, text);
    expect(hits).toHaveLength(1);
    expect(blocks[hits[0]].type).toBe('activity');
  }
  expect(searchBlocks(blocks, 'codex:child')).toEqual([]);
  expect(searchBlocks(blocks, 'not loaded')).toEqual([]);
});

test('search does not inspect arbitrary metadata or binary attachment fields', () => {
  expect(searchBlocks([{ type: 'user', item: { text: 'visible', clientId: 'secret-id', attachments: [{ base64: 'hidden-image' }] } }], 'secret-id')).toEqual([]);
  expect(searchBlocks([{ type: 'user', item: { text: 'visible', attachments: [{ base64: 'hidden-image' }] } }], 'hidden-image')).toEqual([]);
});

test('commentary and failed turns never receive another turn statistics', () => {
  const stats = turnStats([
    { kind: 'turn', id: 'start', status: 'started', ts: 1 },
    { kind: 'message', id: 'failed-reply', role: 'assistant', text: '尝试中', final: true, ts: 2 },
    { kind: 'turn', id: 'failed', status: 'failed', ts: 3 },
    { kind: 'message', id: 'progress', role: 'assistant', text: '过程', messagePhase: 'commentary', final: true, ts: 4 },
    { kind: 'turn', id: 'done', status: 'completed', durationMs: 5, usage: { outputTokens: 20 }, ts: 5 },
  ]);
  expect(stats.size).toBe(0);
});

test('late completion stays with its host turn and does not stop the next turn clock', () => {
  const history: TimelineItem[] = [
    { kind: 'turn', id: 'start-a', turnId: 'a', status: 'started', ts: 1_000 },
    { kind: 'message', id: 'answer-a', turnId: 'a', role: 'assistant', text: '第一轮完成', final: true, ts: 2_000 },
    { kind: 'turn', id: 'start-b', turnId: 'b', status: 'started', ts: 3_000 },
    { kind: 'message', id: 'answer-b', turnId: 'b', role: 'assistant', text: '第二轮完成', final: true, ts: 5_000 },
    { kind: 'turn', id: 'end-a', turnId: 'a', status: 'completed', durationMs: 1_000, usage: { outputTokens: 10 }, ts: 6_000 },
  ];
  expect(turnStats(history).get('answer-a')).toEqual({ durationMs: 1_000, tokens: 10 });
  expect(turnStats(history).has('answer-b')).toBe(false);
  expect(runningSince(history)).toBe(3_000);
  const completed = [...history, { kind: 'turn' as const, id: 'end-b', turnId: 'b', status: 'completed' as const, durationMs: 9_000, ts: 12_000 }];
  expect(turnStats(completed).get('answer-b')).toEqual({ durationMs: 9_000 });
  expect(runningSince(completed)).toBeUndefined();
});

test('recovered final reply after its completion gets only its own reported duration', () => {
  const stats = turnStats([
    { kind: 'turn', id: 'end-a', turnId: 'a', status: 'completed', durationMs: 16_000, ts: 20_000 },
    { kind: 'message', id: 'answer-a', turnId: 'a', role: 'assistant', text: '恢复后的回答', final: true, messagePhase: 'final_answer', ts: 21_000 },
    { kind: 'message', id: 'progress-b', turnId: 'b', role: 'assistant', text: '过程', final: true, messagePhase: 'commentary', ts: 22_000 },
    { kind: 'turn', id: 'end-b', turnId: 'b', status: 'completed', durationMs: 1_000, ts: 23_000 },
  ]);
  expect(stats.get('answer-a')).toEqual({ durationMs: 16_000 });
  expect(stats.has('progress-b')).toBe(false);
});

test('a user boundary without turn IDs prevents old reply statistics from leaking forward', () => {
  const stats = turnStats([
    { kind: 'message', id: 'old-answer', role: 'assistant', text: '上一轮回答', final: true, ts: 1 },
    { kind: 'message', id: 'new-prompt', role: 'user', text: '下一轮', final: true, ts: 2 },
    { kind: 'turn', id: 'done', status: 'completed', durationMs: 10_000, ts: 3 },
  ]);
  expect(stats.size).toBe(0);
});

test('the live heading uses only the first current reply and an observed start marker', () => {
  const source: TimelineItem[] = [
    { kind: 'turn', id: 'start-b', turnId: 'b', status: 'started', ts: 3_000 },
    { kind: 'message', id: 'old', turnId: 'a', role: 'assistant', text: '迟到的旧内容', final: true, ts: 4_000 },
    { kind: 'message', id: 'child', turnId: 'b', parentId: 'child-task', role: 'assistant', text: '子任务内容', final: true, ts: 4_000 },
    { kind: 'message', id: 'progress', turnId: 'b', role: 'assistant', text: '开始检查', messagePhase: 'commentary', final: true, ts: 5_000 },
    { kind: 'message', id: 'more', turnId: 'b', role: 'assistant', text: '更多进度', messagePhase: 'commentary', final: true, ts: 6_000 },
    { kind: 'turn', id: 'end-a', turnId: 'a', status: 'completed', ts: 7_000 },
  ];
  expect(runningTurnHeading(source)).toEqual({ messageId: 'progress', startedAt: 3_000 });
  expect(runningTurnHeading(source.slice(1))).toBeUndefined();
  expect(runningTurnHeading([...source, { kind: 'turn', id: 'end-b', turnId: 'b', status: 'completed', ts: 8_000 }])).toBeUndefined();
});
