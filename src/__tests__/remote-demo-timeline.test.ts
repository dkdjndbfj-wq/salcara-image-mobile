import { buildBlocks, conversationBlocks, subagentStatus } from '../remote/blocks';
import { demoConversationTimeline, type DemoMessage } from '../remote/demo-timeline';
import { turnStats } from '../remote/thread-stats';

const seeded: DemoMessage[] = [
  { id: 1, role: 'user', text: 'Inspect the task.' },
  { id: 2, role: 'assistant', text: 'First commentary.', code: 'synthetic code' },
];

test.each(['code', 'work'] as const)('the %s fixture preserves prose boundaries and carries explicit execution evidence', mode => {
  const items = demoConversationTimeline(seeded, mode, 'codex', 'session-a');
  const source = buildBlocks(items, false);
  const blocks = conversationBlocks(source, 'codex');
  expect(blocks.map(block => block.type)).toEqual(['user', 'assistant', 'activity', 'assistant', 'activity', 'assistant']);
  const command = items.find(item => item.kind === 'tool' && item.tool === 'command');
  expect(command).toMatchObject({ status: 'done', durationMs: 9000, exitCode: 0 });
  const subagent = source.find(block => block.type === 'subagent');
  expect(subagent?.type === 'subagent' && subagentStatus(subagent, 'codex')).toBe('done');
  const preview = items.find(item => item.kind === 'tool' && item.browser);
  expect(preview).toMatchObject({ browser: { pageId: 'session-a:demo-preview' } });
  const final = items.filter(item => item.kind === 'message').at(-1);
  expect(final).toMatchObject({ kind: 'message', messagePhase: 'final_answer', final: true });
  expect(final?.kind === 'message' && final.text).toContain('示例数据');
  expect(turnStats(items).get(final!.id)).toEqual({ durationMs: 16_000 });
  expect(blocks.filter(block => block.completedChanges?.length)).toHaveLength(1);
  expect(blocks.at(-1)).toMatchObject({ type: 'assistant', item: { id: final!.id }, completedChanges: expect.any(Array) });
  // Replay the exact screenshot's edit/progress/test sequence as it arrives.
  // No earlier completed edit should expose the end-of-task summary.
  const finalIndex = items.findIndex(item => item.id === final!.id);
  for (let end = 1; end <= finalIndex; end++) {
    expect(conversationBlocks(buildBlocks(items.slice(0, end), false), 'codex').some(block => block.completedChanges?.length)).toBe(false);
  }
});

test('later simulated messages stay as plain messages without replaying seed actions', () => {
  const later: DemoMessage[] = [{ id: 3, role: 'user', text: 'Follow up.' }, { id: 4, role: 'assistant', text: 'Example reply.' }];
  const initial = demoConversationTimeline(seeded, 'code', 'claude', 'session-a');
  const continued = demoConversationTimeline([...seeded, ...later], 'code', 'claude', 'session-a');
  expect(continued.slice(0, initial.length)).toEqual(initial);
  expect(continued.slice(initial.length).map(item => item.kind)).toEqual(['message', 'message']);
  expect(continued.filter(item => item.kind === 'tool')).toHaveLength(initial.filter(item => item.kind === 'tool').length);
});
