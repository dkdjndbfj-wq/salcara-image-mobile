import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import { shareGeneratedFile, writeGeneratedFile } from '../agent/files';
import { PlanPreview, PlanSummaryCard } from '../remote/PlanCard';
import { buildBlocks, conversationBlocks, planSteps } from '../remote/blocks';
import { applyEvent, EMPTY_TIMELINE, mergeHistory, type TimelineItem } from '../remote/store';
import type { HubEvent } from '../remote/client';

jest.mock('../components/Icon', () => ({ Icon: () => null }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => undefined) }));
jest.mock('../agent/files', () => ({ writeGeneratedFile: jest.fn(), shareGeneratedFile: jest.fn(async () => undefined) }));

type TaskItem = Extract<TimelineItem, { kind: 'tool' }>;
const snapshot = (id: string, output = '✓ #1 检查来源\n▸ #2 修复问题\n○ #3 验证重连', extra: Partial<TaskItem> = {}): TaskItem => ({
  kind: 'tool', tool: 'plan', planKind: 'tasks', id, title: '任务列表 · 1/3', output, outputFinal: true, status: 'done', ts: 1, ...extra,
});
const event = (id: string, seq: number, output: string): Extract<HubEvent, { type: 'tool' }> => ({
  type: 'tool', kind: 'plan', planKind: 'tasks', id, title: '任务列表', output, outputFinal: true, status: 'done',
  deviceId: 'fixture-computer', sessionKey: 'claude:fixture-task', tool: 'claude', ts: seq, seq,
});
const generated = { id: 'generated-tasks', uri: 'file:///generated-files/tasks/TASKS.md', name: 'TASKS.md', mimeType: 'text/markdown', size: 88 };

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(Clipboard.setStringAsync).mockResolvedValue(undefined as never);
  jest.mocked(writeGeneratedFile).mockReturnValue(generated);
  jest.mocked(shareGeneratedFile).mockResolvedValue(undefined);
  jest.spyOn(require('react-native'), 'useWindowDimensions').mockReturnValue({ width: 390, height: 844, scale: 1, fontScale: 1 });
});
afterEach(() => { jest.restoreAllMocks(); });

test('a confirmed Task snapshot shows task progress without claiming every task is finished or starting Plan Mode', async () => {
  const item = snapshot('tasks:first'), open = jest.fn();
  const view = await render(<PlanSummaryCard block={{ type: 'plan', id: item.id, item, steps: planSteps(item.output) }} onOpen={open} />);
  expect(view.getByText('任务列表 · 1/3')).toBeTruthy();
  expect(view.getByText('#2 修复问题')).toBeTruthy();
  expect(view.queryByText('计划')).toBeNull();
  expect(view.queryByText('全部任务已完成')).toBeNull();
  await fireEvent.press(view.getByLabelText('查看完整任务列表'));
  expect(open).toHaveBeenCalledWith(item);
  await fireEvent.press(view.getByLabelText('复制任务列表'));
  expect(Clipboard.setStringAsync).toHaveBeenLastCalledWith(item.output);
  expect(view.getByText('已复制任务列表')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('导出任务列表 TASKS.md'));
  expect(writeGeneratedFile).toHaveBeenCalledWith('TASKS.md', item.output);
  expect(shareGeneratedFile).toHaveBeenCalledWith(generated);
});

test('empty confirmed list replaces old rows and does not look like a plan still being generated', async () => {
  const closed = jest.fn();
  const view = await render(<PlanPreview item={snapshot('tasks:first')} onClose={closed} />);
  expect(view.getByText('任务详情')).toBeTruthy();
  await view.rerender(<PlanPreview item={snapshot('tasks:cleared', '', { title: '任务列表 · 已清空' })} onClose={closed} />);
  expect(view.getByText('暂无任务')).toBeTruthy();
  expect(view.queryByText(/#2 修复问题/)).toBeNull();
  expect(view.queryByText('尚无计划正文')).toBeNull();
  expect(view.getByLabelText('复制任务列表')).toBeDisabled();
  await fireEvent.press(view.getByLabelText('关闭任务详情'));
  expect(closed).toHaveBeenCalledTimes(1);
});

test('async export feedback cannot leak from a task snapshot to a plan with the same id and text', async () => {
  let finish!: () => void;
  jest.mocked(Clipboard.setStringAsync).mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(undefined as never); }));
  const item = snapshot('same-id');
  const view = await render(<PlanPreview item={item} onClose={jest.fn()} />);
  await fireEvent.press(view.getByLabelText('复制任务列表'));
  await view.rerender(<PlanPreview item={{ ...item, planKind: 'proposal' }} onClose={jest.fn()} />);
  await act(async () => { finish(); });
  expect(view.queryByText('已复制任务列表')).toBeNull();
  expect(view.queryByText('已复制计划')).toBeNull();
});

test('activity summarizes only its latest task snapshot while keeping independent plans and the original timeline', () => {
  const items: TimelineItem[] = [snapshot('tasks:old'),
    { kind: 'tool', tool: 'plan', id: 'codex-checklist', title: '计划', output: '✓ 设计\n○ 实施', status: 'done', ts: 2 },
    snapshot('tasks:new', '✓ #1 检查来源\n✓ #2 修复问题\n▸ #3 验证重连', { ts: 3 }),
  ];
  const [block] = conversationBlocks(buildBlocks(items, false), 'claude');
  expect(block.type).toBe('activity');
  if (block.type !== 'activity') throw new Error('missing activity');
  expect(block.summary).toContain('任务列表');
  expect(block.summary).toContain('计划 1/2');
  expect(block.live).toBe(false);
  expect(block.parts.map(part => part.type === 'plan' ? part.item.id : part.id)).toEqual(['codex-checklist', 'tasks:new']);
  expect(items).toHaveLength(3);
});

test('a new pending task after completion or clearing survives history replay and preserves terminal tool fences', () => {
  const completed = event('tasks:complete', 10, '✓ #1 第一项');
  const cleared = event('tasks:clear', 11, '');
  const added = event('tasks:new', 12, '○ #2 新任务');
  let timeline = applyEvent(applyEvent(applyEvent(EMPTY_TIMELINE, completed), cleared), added);
  timeline = mergeHistory(timeline, undefined, [completed, cleared]);
  const [block] = conversationBlocks(buildBlocks(timeline.items, false), 'claude');
  expect(block.type).toBe('activity');
  if (block.type !== 'activity') throw new Error('missing activity');
  expect(block.summary).toContain('任务列表');
  expect(block.parts.filter(part => part.type === 'plan')).toHaveLength(1);
  const latest = block.parts.find(part => part.type === 'plan');
  expect(latest && latest.type === 'plan' && latest.item.output).toBe('○ #2 新任务');
  expect(timeline.items.find(item => item.id === added.id)).toMatchObject({ planKind: 'tasks', status: 'done' });
  const terminal: Extract<HubEvent, { type: 'tool' }> = { ...event('tool:one', 13, 'done'), kind: 'command', planKind: undefined };
  timeline = applyEvent(applyEvent(timeline, terminal), { ...terminal, seq: 14, status: 'running', output: '' });
  expect(timeline.items.find(item => item.id === terminal.id)).toMatchObject({ status: 'done', output: 'done' });
});

test('partial known tasks remain explicitly partial instead of claiming a full list', async () => {
  const item = snapshot('tasks:partial', '✓ #7 已完成的一项', { title: '任务列表 · 已知 1/1' });
  const view = await render(<PlanSummaryCard block={{ type: 'plan', id: item.id, item, steps: planSteps(item.output) }} />);
  expect(view.getByText('任务列表 · 已知 1/1')).toBeTruthy();
  expect(view.queryByText('全部任务已完成')).toBeNull();
});

test('bounded task snapshots disclose their displayed range in the card and full preview', async () => {
  const item = snapshot('tasks:bounded', '○ #1 核对\n…其余任务未显示', { title: '任务列表 · 0/512', detail: '显示前 1/512 项' });
  const view = await render(<PlanSummaryCard block={{ type: 'plan', id: item.id, item, steps: planSteps(item.output) }} />);
  expect(view.getByText('显示前 1/512 项')).toBeTruthy();
  await view.rerender(<PlanPreview item={item} onClose={jest.fn()} />);
  expect(view.getByText('显示前 1/512 项')).toBeTruthy();
});

test('task lists in independent parent scopes and before separate messages remain separate', () => {
  const parentA = snapshot('tasks:a', '○ #1 A', { parentId: 'parent-a' });
  const parentB = snapshot('tasks:b', '○ #1 B', { parentId: 'parent-b' });
  const block = (item: TaskItem) => ({ type: 'plan' as const, id: item.id, item, steps: planSteps(item.output) });
  const [nested] = conversationBlocks([block(parentA), block(parentB)], 'claude');
  expect(nested.type === 'activity' && nested.parts.length).toBe(2);
  const parts = conversationBlocks([block(snapshot('earlier')), { type: 'assistant', id: 'reply', item: { kind: 'message', role: 'assistant', id: 'reply', text: '已完成这一阶段', final: true, ts: 2 } }, block(snapshot('later'))], 'claude');
  expect(parts.map(part => part.type)).toEqual(['activity', 'assistant', 'activity']);
});

test('unknown plan category or a task marker on an ordinary tool does not create a task list', () => {
  const malformed = { ...event('bad', 1, '○ spoofed'), planKind: 'tasks-unknown' } as unknown as HubEvent;
  const command: HubEvent = { ...event('command', 2, '○ ordinary output'), kind: 'command' };
  const timeline = applyEvent(applyEvent(EMPTY_TIMELINE, malformed), command);
  for (const item of timeline.items) expect(item).not.toHaveProperty('planKind');
});
