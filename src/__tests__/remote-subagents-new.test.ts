import { buildBlocks } from '../remote/blocks';
import { applyEvent, applyRecoveredEvent, EMPTY_TIMELINE } from '../remote/store';
import type { HubEvent } from '../remote/client';
import type { TimelineItem } from '../remote/store';
jest.mock('../storage/database', () => ({ getSetting: async () => null, setSetting: async () => undefined }));
jest.mock('../storage/secure-keys', () => ({ getProviderKey: async () => '' }));

test('Claude internal conversation is grouped under its actual Task and not leaked into the main answer', () => {
  const items: TimelineItem[] = [
    { kind: 'tool', id: 'task', tool: 'subagent', title: '检查测试', status: 'done', ts: 1 },
    { kind: 'message', id: 'internal', role: 'assistant', text: '正在读测试', final: true, parentId: 'task', ts: 2 },
    { kind: 'tool', id: 'read', tool: 'read', title: '读取 tests.ts', status: 'done', parentId: 'task', ts: 3 },
    { kind: 'message', id: 'main', role: 'assistant', text: '修改完成', final: true, ts: 4 },
  ];
  const blocks = buildBlocks(items, false);
  expect(blocks.map((item) => item.type)).toEqual(['subagent', 'assistant']);
  expect(blocks[0]).toMatchObject({ children: [{ id: 'internal' }, { id: 'read' }] });
});

test('Codex child status/results/real conversation handle survive event folding and recovery', () => {
  const base = { deviceId: 'pc', sessionKey: 'codex:parent', tool: 'codex' as const, ts: 1 };
  const started: HubEvent = { ...base, type: 'tool', id: 'spawn:child:real', kind: 'subagent', title: '子智能体', parentId: 'spawn', childSessionKeys: ['codex:real'], status: 'running' };
  let timeline = applyEvent(EMPTY_TIMELINE, started);
  timeline = applyEvent(timeline, { ...started, status: 'done', output: '通过全部测试', ts: 2 });
  timeline = applyRecoveredEvent(timeline, started);
  expect(timeline.items).toHaveLength(1);
  expect(timeline.items[0]).toMatchObject({ parentId: 'spawn', childSessionKeys: ['codex:real'], status: 'done', output: '通过全部测试' });
});

test('nested subtask progress stays in the outer task even when child events arrive first', () => {
  const blocks = buildBlocks([
    { kind: 'message', id: 'deep', role: 'assistant', text: '嵌套过程', final: true, parentId: 'inner', ts: 1 },
    { kind: 'tool', id: 'inner', tool: 'subagent', title: '内部任务', status: 'done', parentId: 'outer', ts: 2 },
    { kind: 'tool', id: 'outer', tool: 'subagent', title: '主子任务', status: 'done', ts: 3 },
  ], false);
  expect(blocks).toHaveLength(1);
  expect(blocks[0]).toMatchObject({ type: 'subagent', item: { id: 'outer' }, children: [{ id: 'deep' }, { id: 'inner' }] });
});

test('unlinked child progress stays visible without fabricating an independent Claude conversation', () => {
  const blocks = buildBlocks([{ kind: 'message', id: 'child', role: 'assistant', text: '内部回复', final: true, ts: 1, parentId: 'task-before-cache' }], false);
  expect(blocks[0]).toMatchObject({ type: 'subagent', unlinked: true, children: [{ id: 'child' }] });
  if (blocks[0].type !== 'subagent') throw new Error('missing');
  expect(blocks[0].item.childSessionKeys).toBeUndefined();
});

test('Claude to-do output renders as the same plan card as Codex', () => {
  const blocks = buildBlocks([{ kind: 'tool', id: 'todos', tool: 'plan', title: '计划 · 1/3', status: 'done', output: '✓ 检查接口\n▸ 修改手机\n○ 回归测试', ts: 1 }], false);
  expect(blocks[0]).toMatchObject({ type: 'plan', steps: [{ text: '检查接口', status: 'done' }, { text: '修改手机', status: 'active' }, { text: '回归测试', status: 'pending' }] });
});

test('question events carry bounded form metadata and resolved/expired prompts cannot resurrect', () => {
  const event: HubEvent = { deviceId: 'pc', sessionKey: 'codex:parent', tool: 'codex', ts: Date.now(), type: 'approval.request', approvalId: 'q', kind: 'question', title: '选择', questions: [{ id: 'choice', question: '怎么做', required: true }], questionMode: 'codex', expiresAt: Date.now() + 1000 };
  let timeline = applyEvent(EMPTY_TIMELINE, event);
  expect(timeline.items[0]).toMatchObject({ kind: 'approval', questions: event.questions, state: 'pending' });
  timeline = applyEvent(timeline, { ...event, type: 'approval.resolved', approvalId: 'q', decision: 'allow', by: 'phone' });
  timeline = applyEvent(timeline, event);
  expect(timeline.items[0]).toMatchObject({ state: 'allow' });
  expect(applyEvent(EMPTY_TIMELINE, { ...event, expiresAt: Date.now() - 1 }).items[0]).toMatchObject({ state: 'deny', by: 'timeout' });
});
