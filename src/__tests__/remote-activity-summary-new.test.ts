import { buildBlocks, conversationBlocks, subagentStatus, type Block } from '../remote/blocks';
import type { TimelineItem } from '../remote/store';

type Subtask = Extract<Block, { type: 'subagent' }>;
const task = (id: string, keys?: string[]): Subtask => ({ type: 'subagent', id: `sub:${id}`, item: {
  kind: 'tool', id, tool: 'subagent', title: `任务 ${id}`, status: 'done', childSessionKeys: keys, ts: 1,
}, children: [] });

test('tools, plans and multiple subagents fold into one activity between the real messages', () => {
  const source: TimelineItem[] = [
    { kind: 'message', id: 'u', role: 'user', text: '修复', final: true, ts: 1 },
    { kind: 'tool', id: 'read', tool: 'read', title: '读代码', status: 'done', ts: 2 },
    { kind: 'tool', id: 'plan', tool: 'plan', title: '计划', output: '✓ 分析\n▸ 修改\n○ 测试', status: 'running', ts: 3 },
    { ...task('a', ['codex:a']).item, ts: 4 }, { ...task('b', ['codex:b']).item, ts: 5 },
    { kind: 'message', id: 'child', role: 'assistant', text: '子任务内部回复', parentId: 'a', final: true, ts: 6 },
    { kind: 'tool', id: 'edit', tool: 'file_change', title: '修改 main.ts', diff: '--- a/main.ts\n+++ b/main.ts\n-old\n+new', status: 'done', ts: 7 },
    { kind: 'message', id: 'a-final', role: 'assistant', text: '主回复', final: true, ts: 8 },
  ];
  const folded = conversationBlocks(buildBlocks(source, true), 'codex');
  expect(folded.map((block) => block.type)).toEqual(['user', 'activity', 'assistant']);
  const activity = folded[1];
  if (activity.type !== 'activity') throw new Error('missing summary');
  expect(activity.parts.map((part) => part.type)).toEqual(['work', 'plan', 'subagent', 'subagent', 'work']);
  expect(activity.subagentCount).toBe(2);
  expect(activity.summary).toContain('2 个子智能体'); expect(activity.summary).toContain('计划 1/3');
  expect(activity.files).toEqual([expect.objectContaining({ path: 'main.ts', add: 1, del: 1 })]);
  expect(activity.live).toBe(true);
  expect(folded.filter((block) => block.type === 'assistant')).toEqual([expect.objectContaining({ item: expect.objectContaining({ text: '主回复' }) })]);
});

test('subagent counts use unique real handles across spawn/wait and support one call with many children', () => {
  const spawn = task('spawn', ['codex:a', 'codex:b']);
  spawn.children = [{ kind: 'tool', id: 'state:c', tool: 'subagent', title: '子智能体 c', parentId: 'spawn', childSessionKeys: ['codex:c'], status: 'running', ts: 1 }];
  const wait = task('wait', ['codex:a', 'codex:c']);
  const [folded] = conversationBlocks([spawn, wait]);
  expect(folded).toMatchObject({ type: 'activity', subagentCount: 3, live: true });
});

test('Claude tasks without independent session handles remain distinct without inventing navigation', () => {
  const [folded] = conversationBlocks([task('claude-one'), task('claude-two')], 'claude');
  expect(folded).toMatchObject({ type: 'activity', subagentCount: 2, live: false });
  if (folded.type !== 'activity') throw new Error('missing');
  expect(folded.parts).toEqual([task('claude-one'), task('claude-two')]);
});

test('a completed Codex spawn, even with an acknowledgement, does not claim the child finished', () => {
  const spawn = task('spawn', ['codex:a']); spawn.item.output = 'spawn acknowledged';
  expect(subagentStatus(spawn, 'codex')).toBe('unknown');
  spawn.item.childSessionKeys = undefined;
  expect(subagentStatus(spawn, 'codex')).toBe('unknown');
  spawn.children = [{ kind: 'tool', id: 'real-status', tool: 'subagent', title: '状态未返回', parentId: 'spawn', status: 'running', ts: 1 }];
  expect(subagentStatus(spawn, 'codex')).toBe('running');
});

test('multiple actual child statuses distinguish still-running, all-completed and failure', () => {
  const spawn = task('spawn', ['codex:a', 'codex:b']);
  spawn.children = ['a', 'b'].map((id) => ({ kind: 'tool', id, tool: 'subagent', title: id, parentId: 'spawn', childSessionKeys: [`codex:${id}`], status: 'done', ts: 1 }));
  expect(subagentStatus(spawn, 'codex')).toBe('done');
  spawn.children[1] = { ...spawn.children[1], status: 'running' } as TimelineItem;
  expect(subagentStatus(spawn, 'codex')).toBe('running');
  spawn.children[1] = { ...spawn.children[1], status: 'failed' } as TimelineItem;
  expect(subagentStatus(spawn, 'codex')).toBe('failed');
  expect(conversationBlocks([spawn], 'codex')[0]).toMatchObject({ live: false, summary: '2 个子智能体 · 有失败' });
});

test('Claude uses the actual Task terminal state even with empty output or stale child tool state', () => {
  const parent = task('claude');
  parent.children = [{ kind: 'tool', id: 'read', tool: 'read', title: '读文件', status: 'running', parentId: 'claude', ts: 1 }];
  expect(subagentStatus(parent, 'claude')).toBe('done');
  parent.item.status = 'running'; expect(subagentStatus(parent, 'claude')).toBe('running');
  parent.item.status = 'failed'; expect(subagentStatus(parent, 'claude')).toBe('failed');
});

test('orphan progress remains uncertain rather than fabricating a completed child', () => {
  const orphan = task('orphan'); orphan.unlinked = true;
  orphan.children = [{ kind: 'message', id: 'trace', role: 'assistant', text: '内部摘要', final: true, parentId: 'orphan', ts: 1 }];
  expect(subagentStatus(orphan, 'claude')).toBe('unknown');
});

test('folding does not cross user/reply/error boundaries and preserves stable ids as progress arrives', () => {
  const one = task('one'), two = task('two');
  const notice: Block = { type: 'notice', id: 'n', item: { kind: 'notice', id: 'n', level: 'error', text: '真实错误', ts: 1 } };
  const turn: Block = { type: 'turn', id: 't', item: { kind: 'turn', id: 't', status: 'interrupted', ts: 1 } };
  expect(conversationBlocks([one, notice, two, turn]).map((block) => block.type)).toEqual(['activity', 'notice', 'activity', 'turn']);
  expect(conversationBlocks([one])[0].id).toBe(conversationBlocks([one, two])[0].id);
});

test('a later wait updates earlier spawn summaries across replies without mutating original history', () => {
  const spawn = task('spawn', ['codex:a']);
  spawn.children = [{ kind: 'tool', id: 'spawn:a', parentId: 'spawn', tool: 'subagent', title: 'a', childSessionKeys: ['codex:a'], status: 'running', output: '处理中', ts: 2 }];
  const wait = task('wait', ['codex:a']);
  wait.children = [{ kind: 'tool', id: 'wait:a', parentId: 'wait', tool: 'subagent', title: 'a', childSessionKeys: ['codex:a'], status: 'done', output: '已完成', ts: 4 }];
  const reply: Block = { type: 'assistant', id: 'm:reply', item: { kind: 'message', id: 'reply', role: 'assistant', text: '主回复', final: true, ts: 3 } };
  const folded = conversationBlocks([spawn, reply, wait], 'codex');
  expect(folded.map((block) => block.type)).toEqual(['activity', 'assistant', 'activity']);
  expect(folded[0]).toMatchObject({ live: false, parts: [{ children: [{ status: 'done', output: '已完成' }] }] });
  expect(folded[2]).toMatchObject({ live: false });
  expect(spawn.children[0]).toMatchObject({ status: 'running', output: '处理中' });
});

test('missing status for one of several children cannot claim they all completed', () => {
  const spawn = task('spawn', ['codex:a', 'codex:b']);
  spawn.children = [{ kind: 'tool', id: 'spawn:a', parentId: 'spawn', tool: 'subagent', title: 'a', childSessionKeys: ['codex:a'], status: 'done', ts: 2 }];
  expect(subagentStatus(spawn, 'codex')).toBe('unknown');
});

test('an older child record arriving later in the array cannot override a newer failure', () => {
  const recent = task('recent', ['codex:a']);
  recent.children = [{ kind: 'tool', id: 'recent:a', parentId: 'recent', tool: 'subagent', title: 'a', childSessionKeys: ['codex:a'], status: 'failed', output: '失败原因', ts: 30 }];
  const old = task('old', ['codex:a']);
  old.children = [{ kind: 'tool', id: 'old:a', parentId: 'old', tool: 'subagent', title: 'a', childSessionKeys: ['codex:a'], status: 'running', ts: 10 }];
  const folded = conversationBlocks([recent, old], 'codex');
  expect(folded[0]).toMatchObject({ live: false, subagentCount: 1, summary: '1 个子智能体 · 有失败' });
});

test('notFound stops an earlier spinner using only the parent real receiver, without inventing child handles', () => {
  const spawn = task('spawn', ['codex:a']);
  spawn.children = [{ kind: 'tool', id: 'spawn:child:a', parentId: 'spawn', tool: 'subagent', title: '子智能体 a', childSessionKeys: ['codex:a'], status: 'running', ts: 2 }];
  const wait = task('wait', ['codex:a']);
  wait.children = [{ kind: 'tool', id: 'wait:child:a', parentId: 'wait', tool: 'subagent', title: '子智能体 a', status: 'failed', output: '子会话不可用', ts: 4 }];
  const [folded] = conversationBlocks([spawn, wait], 'codex');
  expect(folded).toMatchObject({ live: false, subagentCount: 1 });
  if (folded.type !== 'activity' || folded.parts[1].type !== 'subagent') throw new Error('missing');
  expect(folded.parts[1].children).toHaveLength(1);
  expect(folded.parts[1].children[0]).not.toHaveProperty('childSessionKeys');
});
