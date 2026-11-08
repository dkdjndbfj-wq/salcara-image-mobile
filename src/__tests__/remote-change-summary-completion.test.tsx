import React from 'react';
import { View } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import { buildBlocks, conversationBlocks } from '../remote/blocks';
import { BlockRow, ThreadUi } from '../remote/thread-rows';
import type { TimelineItem } from '../remote/store';

jest.mock('../storage/database', () => ({ getSetting: async () => null, setSetting: async () => undefined }));

const edit = (id = 'edit', turnId?: string): TimelineItem => ({ kind: 'tool', id, tool: 'file_change', title: `修改 ${id}.ts`, status: 'done', turnId, ts: 1 });
const reply = (id = 'reply', turnId?: string, commentary = false): TimelineItem => ({ kind: 'message', id, role: 'assistant', text: id, final: true, messagePhase: commentary ? 'commentary' : 'final_answer', turnId, ts: 2 });
const terminal = (turnId?: string): TimelineItem => ({ kind: 'turn', id: `end:${turnId}`, turnId, status: 'completed', ts: 3 });
const command = (turnId?: string): TimelineItem => ({ kind: 'tool', id: 'test', tool: 'command', title: '运行测试', status: 'running', turnId, ts: 4 });

function Execution({ items, active = false }: { items: TimelineItem[]; active?: boolean }) {
  return <View>{conversationBlocks(buildBlocks(items, active), 'codex', active).map(block => <BlockRow key={block.id} block={block} tool="codex" onOpenChild={jest.fn()} />)}</View>;
}

function expectRenderedBefore(view: Awaited<ReturnType<typeof render>>, first: string, second: string) {
  const rendered = JSON.stringify(view.toJSON());
  expect(rendered).toContain(first); expect(rendered).toContain(second);
  expect(rendered.indexOf(first)).toBeLessThan(rendered.indexOf(second));
}

test('one completed changes card follows the final reply and all intervening verification work', async () => {
  const items: TimelineItem[] = [edit('implementation', 'task'), reply('修改完成，继续验证', 'task', true),
    { ...command('task'), status: 'done' } as TimelineItem, reply('最终结果：全部验证通过', 'task'), terminal('task')];
  const view = await render(<Execution items={items} />);
  expect(view.getAllByTestId('conversation-changes-card')).toHaveLength(1);
  expectRenderedBefore(view, 'execution-row:test', '最终结果：全部验证通过');
  expectRenderedBefore(view, '最终结果：全部验证通过', 'conversation-changes-card');
});

test('one final card groups repeated paths while review receives every original edit in order', async () => {
  const first: TimelineItem = { kind: 'tool', id: 'first-version', tool: 'file_change', title: '修改 src/app.ts', status: 'done', turnId: 'task', ts: 1,
    diff: '--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-before\n+middle\n' };
  const second: TimelineItem = { kind: 'tool', id: 'second-version', tool: 'file_change', title: '修改 src/app.ts', status: 'done', turnId: 'task', ts: 3,
    diff: '--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-middle\n+after\n' };
  const review = jest.fn();
  const view = await render(<ThreadUi.Provider value={{ openDiff: jest.fn(), openChanges: review, openImage: jest.fn(), requestAttachment: jest.fn() }}>
    <Execution items={[first, reply('继续完善同一个文件', 'task', true), second, reply('两轮修改均已验证', 'task'), terminal('task')]} />
  </ThreadUi.Provider>);
  expect(view.getAllByTestId('conversation-changes-card')).toHaveLength(1);
  expect(view.getByText('已编辑 1 个文件')).toBeTruthy();
  expect(view.getAllByLabelText('查看修改文件 src/app.ts')).toHaveLength(1);
  expectRenderedBefore(view, '两轮修改均已验证', 'conversation-changes-card');
  await fireEvent.press(view.getByLabelText('查看本组文件变更'));
  expect(review).toHaveBeenCalledTimes(1);
  expect(review).toHaveBeenCalledWith([
    expect.objectContaining({ id: 'first-version', path: 'src/app.ts', diff: first.diff }),
    expect.objectContaining({ id: 'second-version', path: 'src/app.ts', diff: second.diff }),
  ]);
});

test('a queued user message after completion stays below the previous task result card', async () => {
  const queued: TimelineItem = { kind: 'message', id: 'queued-after-result', role: 'user', text: '排队等待：下一项任务', final: true, local: true, ts: 4 };
  const view = await render(<Execution items={[edit('completed', 'task'), reply('当前任务已完成', 'task'), queued]} />);
  expect(view.getAllByTestId('conversation-changes-card')).toHaveLength(1);
  expectRenderedBefore(view, '当前任务已完成', 'conversation-changes-card');
  expectRenderedBefore(view, 'conversation-changes-card', '排队等待：下一项任务');
});

test('a late old terminal cannot move its completed card below a newer running task', async () => {
  const next: TimelineItem = { kind: 'message', id: 'next-task', role: 'user', text: '新任务：继续实现', final: true, turnId: 'new', ts: 4 };
  const view = await render(<Execution active items={[edit('old', 'old'), reply('旧任务最终结果', 'old'), next,
    edit('new', 'new'), command('new'), { ...terminal('old'), ts: 7 }]} />);
  expect(view.getAllByTestId('conversation-changes-card')).toHaveLength(1);
  expect(view.getByLabelText('查看修改文件 old.ts')).toBeTruthy();
  expect(view.queryByLabelText('查看修改文件 new.ts')).toBeNull();
  expect(view.getByTestId('execution-row:test')).toBeTruthy();
  expectRenderedBefore(view, '旧任务最终结果', 'conversation-changes-card');
  expectRenderedBefore(view, 'conversation-changes-card', '新任务：继续实现');
});

test('a completed file edit remains an ordinary row while the rest of its turn runs', async () => {
  const view = await render(<Execution items={[edit(), reply('继续验证', undefined, true), command()]} active />);
  expect(view.getByTestId('execution-row:edit')).toBeTruthy();
  expect(view.queryByTestId('conversation-changes-card')).toBeNull();
});

test('an idle gap and commentary do not establish turn completion', async () => {
  const view = await render(<Execution items={[edit(), reply('继续验证', undefined, true)]} />);
  expect(view.queryByTestId('conversation-changes-card')).toBeNull();
  await view.rerender(<Execution items={[edit(), reply()]} active />);
  expect(view.queryByTestId('conversation-changes-card')).toBeNull();
  await view.rerender(<Execution items={[edit(), reply(), terminal()]} />);
  expect(view.getByTestId('conversation-changes-card')).toBeTruthy();
});

test('a child in another activity suppresses the summary until the child also finishes', async () => {
  const child = (status: 'running' | 'done'): TimelineItem[] => [
    { kind: 'tool', id: 'spawn', tool: 'subagent', title: '审查布局', status: 'done', childSessionKeys: ['codex:child'], ts: 2 },
    { kind: 'tool', id: 'child-state', parentId: 'spawn', tool: 'subagent', title: '布局审查', status, childSessionKeys: ['codex:child'], ts: 3 },
  ];
  const items = (status: 'running' | 'done') => [edit(), reply('交给子任务', undefined, true), ...child(status), reply(), terminal()];
  const view = await render(<Execution items={items('running')} />);
  expect(view.getByTestId('execution-row:edit')).toBeTruthy();
  expect(view.queryByTestId('conversation-changes-card')).toBeNull();
  await view.rerender(<Execution items={items('done')} />);
  expect(view.getByTestId('conversation-changes-card')).toBeTruthy();
});

test('older completed cards remain while a newer identified turn runs without a user boundary', async () => {
  const view = await render(<Execution items={[edit('old', 'old-turn'), reply('旧任务完成', 'old-turn'), terminal('old-turn'), edit('new', 'new-turn'), command('new-turn')]} active />);
  expect(view.getAllByTestId('conversation-changes-card')).toHaveLength(1);
  expect(view.getByLabelText('查看修改文件 old.ts')).toBeTruthy();
  expect(view.queryByLabelText('查看修改文件 new.ts')).toBeNull();
});

test('legacy user boundaries retain the old completed summary', async () => {
  const user: TimelineItem = { kind: 'message', id: 'new-user', role: 'user', text: '继续下一项', final: true, ts: 4 };
  const view = await render(<Execution items={[edit('old'), reply(), user, edit('new'), command()]} active />);
  expect(view.getAllByTestId('conversation-changes-card')).toHaveLength(1);
  expect(view.getByLabelText('查看修改文件 old.ts')).toBeTruthy();
});

test('a locally queued prompt does not make the still-active turn historical', async () => {
  const queued: TimelineItem = { kind: 'message', id: 'queued', role: 'user', text: '稍后继续', final: true, local: true, ts: 4 };
  const view = await render(<Execution items={[edit(), reply(), queued]} active />);
  expect(view.queryByTestId('conversation-changes-card')).toBeNull();
});

test.each(['completed', 'failed', 'interrupted'] as const)('a terminal %s turn can reveal its file summary without a final reply', async status => {
  const view = await render(<Execution items={[edit(), { ...terminal(), status } as TimelineItem]} />);
  expect(view.getByTestId('conversation-changes-card')).toBeTruthy();
});

test('parent completion clears stale root reasoning without changing the original event', async () => {
  const reasoning: TimelineItem = { kind: 'reasoning', id: 'thought', text: '检查中', final: false, turnId: 'a', ts: 0 };
  const view = await render(<Execution items={[reasoning, edit('edit', 'a'), reply('完成', 'a'), terminal('a')]} />);
  expect(view.getByTestId('conversation-changes-card')).toBeTruthy();
  expect(reasoning.final).toBe(false);
});

test('a queued local message before the final reply does not hide the completed card', async () => {
  const local: TimelineItem = { kind: 'message', id: 'queued-steer', role: 'user', text: '接下来继续', final: true, local: true, ts: 2 };
  const view = await render(<Execution items={[edit('edit', 'a'), local, reply('完成', 'a'), terminal('a')]} />);
  expect(view.getByTestId('conversation-changes-card')).toBeTruthy();
});

const spawn = (keys = ['codex:child']): TimelineItem => ({ kind: 'tool', id: 'spawn', tool: 'subagent', title: '检查子任务', status: 'done', childSessionKeys: keys, turnId: 'old', ts: 2 });
const childTurn = (turnId: string, status: 'started' | 'completed', seq: number): TimelineItem => ({ kind: 'turn', id: `${turnId}:${status}`, parentId: 'spawn', turnId, status, seq, ts: seq });
const childReply = (parentId = 'spawn'): TimelineItem => ({ ...reply('子任务完成'), parentId, ts: 5 } as TimelineItem);
const oldAndNew = (children: TimelineItem[], keys?: string[]): TimelineItem[] => [edit('old', 'old'), spawn(keys), ...children,
  reply('父任务完成', 'old'), terminal('old'), { kind: 'message', id: 'new-user', role: 'user', text: '开始新任务', final: true, turnId: 'new', ts: 6 }, edit('new', 'new'), command('new')];

test('an older parent stays pending until every child turn has a matching terminal boundary', async () => {
  const first = childTurn('child-first', 'started', 3), second = childTurn('child-second', 'started', 4);
  const view = await render(<Execution items={oldAndNew([first, second])} active />);
  expect(view.queryByTestId('conversation-changes-card')).toBeNull();
  await view.rerender(<Execution items={oldAndNew([first, second, childTurn('child-first', 'completed', 5)])} active />);
  expect(view.queryByTestId('conversation-changes-card')).toBeNull();
  await view.rerender(<Execution items={oldAndNew([first, second, childTurn('child-first', 'completed', 5), childTurn('child-second', 'completed', 6)])} active />);
  expect(view.getAllByTestId('conversation-changes-card')).toHaveLength(1);
  expect(view.getByLabelText('查看修改文件 old.ts')).toBeTruthy();
});

test('child terminal cursors supersede an older start even when the array arrives out of order', async () => {
  const stale: TimelineItem = { kind: 'reasoning', id: 'child-thought', parentId: 'spawn', turnId: 'child', text: '检查中', final: false, seq: 2, ts: 2 };
  const view = await render(<Execution items={oldAndNew([stale, childTurn('child', 'completed', 5), childTurn('child', 'started', 1)])} active />);
  expect(view.getByLabelText('查看修改文件 old.ts')).toBeTruthy();
});

test('a spawn acknowledgement needs completion proof for its referenced child', async () => {
  const view = await render(<Execution items={oldAndNew([])} active />);
  expect(view.queryByTestId('conversation-changes-card')).toBeNull();
  await view.rerender(<Execution items={oldAndNew([childReply()])} active />);
  expect(view.getByLabelText('查看修改文件 old.ts')).toBeTruthy();
});

test('one child reply does not complete multiple known children or a different parent', async () => {
  const view = await render(<Execution items={oldAndNew([childReply()], ['codex:child-a', 'codex:child-b'])} active />);
  expect(view.queryByTestId('conversation-changes-card')).toBeNull();
  await view.rerender(<Execution items={oldAndNew([childReply('another-parent')])} active />);
  expect(view.queryByTestId('conversation-changes-card')).toBeNull();
});

test('legacy history without a navigable child handle does not add an unprovable completion requirement', async () => {
  const view = await render(<Execution items={oldAndNew([], [])} active />);
  expect(view.getByLabelText('查看修改文件 old.ts')).toBeTruthy();
});

test.each(['failed', 'interrupted'] as const)('one %s child does not establish completion for another missing child', async status => {
  const first: TimelineItem = { kind: 'tool', id: 'child-a-state', parentId: 'spawn', tool: 'subagent', title: '子任务 A',
    status, childSessionKeys: ['codex:a'], ts: 3 };
  const second: TimelineItem = { kind: 'tool', id: 'child-b-state', parentId: 'spawn', tool: 'subagent', title: '子任务 B',
    status: 'done', childSessionKeys: ['codex:b'], ts: 4 };
  const view = await render(<Execution items={oldAndNew([first], ['codex:a', 'codex:b'])} active />);
  expect(view.queryByTestId('conversation-changes-card')).toBeNull();
  expect(view.getByText(`检查子任务 · ${status === 'failed' ? '失败' : '被中断'}`)).toBeTruthy();
  await view.rerender(<Execution items={oldAndNew([first, second], ['codex:a', 'codex:b'])} active />);
  expect(view.getByLabelText('查看修改文件 old.ts')).toBeTruthy();
});
