import React from 'react';
import { View } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import { BlockRow, ThreadUi } from '../remote/thread-rows';
import { buildBlocks, conversationBlocks } from '../remote/blocks';
import { executionLabel } from '../remote/execution-presentation';
import type { TimelineItem } from '../remote/store';

jest.mock('../storage/database', () => ({ getSetting: async () => null, setSetting: async () => undefined }));

const prose = (id: string, text: string, phase: 'commentary' | 'final_answer' = 'commentary'): TimelineItem => ({ kind: 'message', id, role: 'assistant', text, final: true, messagePhase: phase, ts: 1 });
const cmd = (id: string, status: 'done' | 'running' = 'done'): TimelineItem => ({ kind: 'tool', id, tool: 'command', title: `运行 ${id}`, detail: `${id} --verify`, output: `${id} output`, status, durationMs: status === 'done' ? 9000 : undefined, ts: 2 });

test('prose, file edits, commands and named subagents remain visible in chronological order', async () => {
  const items: TimelineItem[] = [
    prose('intro', '先检查登录组件与断点。'),
    { kind: 'tool', id: 'edit', tool: 'file_change', title: '修改 src/app.ts', detail: 'src/app.ts', status: 'done', ts: 2 },
    cmd('lint'),
    prose('progress', '修改已完成，现在检查窄屏。'),
    { kind: 'tool', id: 'child', tool: 'subagent', title: '审查布局', childSessionKeys: ['codex:layout'], status: 'done', ts: 3 },
    { kind: 'tool', id: 'child-state', parentId: 'child', tool: 'subagent', title: '布局检查', childSessionKeys: ['codex:layout'], status: 'done', output: '布局符合预期', ts: 4 },
    cmd('test'), prose('answer', '验证通过。', 'final_answer'),
  ];
  const blocks = conversationBlocks(buildBlocks(items, false), 'codex');
  const view = await render(<ThreadUi.Provider value={{ openDiff: jest.fn(), openImage: jest.fn(), requestAttachment: jest.fn(), childTitle: () => 'Layout review', presentation: 'tablet' }}>
    <View>{blocks.map(block => <BlockRow key={block.id} block={block} tool="codex" onOpenChild={jest.fn()} />)}</View>
  </ThreadUi.Provider>);
  expect(view.queryByLabelText('展开处理摘要')).toBeNull();
  expect(view.queryByText('过程说明')).toBeNull();
  expect(view.getByText('Layout review · 已完成')).toBeTruthy();
  expect(view.queryByText('布局符合预期')).toBeNull();
  const tree = JSON.stringify(view.toJSON());
  const positions = ['先检查登录组件与断点。', 'execution-row:edit', 'execution-row:lint', '修改已完成，现在检查窄屏。', 'execution-row:child', 'execution-row:test', '验证通过。'].map(value => tree.indexOf(value));
  expect(positions.every(value => value >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  await fireEvent.press(view.getByLabelText('审查布局：子任务详情'));
  await fireEvent.press(view.getByLabelText('查看执行详情：布局检查'));
  expect(view.getByText('布局符合预期')).toBeTruthy();
});

test('live command updates preserve another row disclosure and completed output stays inline', async () => {
  const tree = (status: 'running' | 'done') => <View>{conversationBlocks(buildBlocks([cmd('lint'), cmd('test', status), ...(status === 'done' ? [prose('final', '完成。', 'final_answer')] : [])], status === 'running'), 'codex').map(block => <BlockRow key={block.id} block={block} tool="codex" onOpenChild={jest.fn()} />)}</View>;
  const view = await render(tree('running'));
  await fireEvent.press(view.getByLabelText('查看命令详情：运行 lint'));
  expect(view.getByText('lint output')).toBeTruthy();
  expect(view.queryByText('test output')).toBeNull();
  await view.rerender(tree('done'));
  expect(view.getByLabelText('查看命令详情：运行 lint').props.accessibilityState.expanded).toBe(true);
  expect(view.getByText('lint output')).toBeTruthy();
  expect(view.getByText('已在 9 秒 内运行 test')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('查看命令详情：运行 test'));
  expect(view.getByText('$ test --verify')).toBeTruthy();
  expect(view.getByText('test output')).toBeTruthy();
});

test('image details are fetched only when expanded and unknown counts are never invented', async () => {
  const request = jest.fn();
  const image: TimelineItem = { kind: 'tool', id: 'image', tool: 'image_view', title: '查看截图', status: 'done', ts: 1, attachments: [{ id: 'att_image', mime: 'image/png' }] };
  const [block] = conversationBlocks(buildBlocks([image], false), 'codex');
  const view = await render(<ThreadUi.Provider value={{ openDiff: jest.fn(), openImage: jest.fn(), requestAttachment: request }}><BlockRow block={block} tool="codex" onOpenChild={jest.fn()} /></ThreadUi.Provider>);
  expect(view.getByText('已查看 1 张图像')).toBeTruthy();
  expect(request).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('查看执行详情：查看截图'));
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0][0]).toEqual(image.attachments![0]);
  expect(executionLabel({ ...image, attachments: undefined })).toBe('已查看图片');
});

test.each(['failed', 'interrupted'] as const)('a %s execution never claims a completed action', status => {
  const item = cmd('test') as Extract<TimelineItem, { kind: 'tool' }>;
  expect(executionLabel({ ...item, status })).toBe(`命令${status === 'failed' ? '失败' : '已中断'} · test · 9 秒`);
});
