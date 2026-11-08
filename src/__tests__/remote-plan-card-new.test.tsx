import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import { shareGeneratedFile, writeGeneratedFile } from '../agent/files';
import { PlanPreview, PlanSummaryCard } from '../remote/PlanCard';
import type { TimelineItem } from '../remote/store';

jest.mock('../components/Icon', () => ({ Icon: () => null }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => undefined) }));
jest.mock('../agent/files', () => ({ writeGeneratedFile: jest.fn(), shareGeneratedFile: jest.fn(async () => undefined) }));

type PlanItem = Extract<TimelineItem, { kind: 'tool' }>;
const body = '# 修复方案\n\n先检查 **同步状态**。\n\n- 保留草稿\n- 验证重连';
const plan = (overrides: Partial<PlanItem> = {}): PlanItem => ({ kind: 'tool', tool: 'plan', planKind: 'proposal', id: 'plan-1', title: '方案', output: body, status: 'done', ts: 1, ...overrides });
const generated = { id: 'generated-plan', uri: 'file:///generated-files/plan/PLAN.md', name: 'PLAN.md', mimeType: 'text/markdown', size: 88 };

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(Clipboard.setStringAsync).mockResolvedValue(undefined as never);
  jest.mocked(writeGeneratedFile).mockReturnValue(generated);
  jest.mocked(shareGeneratedFile).mockResolvedValue(undefined);
  jest.spyOn(require('react-native'), 'useWindowDimensions').mockReturnValue({ width: 390, height: 844, scale: 1, fontScale: 1 });
});
afterEach(() => { jest.restoreAllMocks(); });

test('completed plan renders a compact excerpt and copies or exports the full original text only on request', async () => {
  const item = plan(), open = jest.fn();
  const view = await render(<PlanSummaryCard block={{ type: 'plan', id: item.id, item, steps: [] }} onOpen={open} />);
  expect(view.getByText('修复方案')).toBeTruthy();
  expect(view.queryByText('# 修复方案')).toBeNull();
  expect(view.getByTestId('remote-plan-summary-markdown')).toHaveStyle({ maxHeight: 72, overflow: 'hidden' });
  expect(writeGeneratedFile).not.toHaveBeenCalled(); expect(shareGeneratedFile).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('查看完整计划'));
  expect(open).toHaveBeenCalledWith(item);
  await fireEvent.press(view.getByLabelText('复制计划'));
  expect(Clipboard.setStringAsync).toHaveBeenCalledWith(body);
  expect(view.getByText('已复制计划')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('导出计划 PLAN.md'));
  expect(writeGeneratedFile).toHaveBeenCalledWith('PLAN.md', body);
  expect(shareGeneratedFile).toHaveBeenCalledWith(generated);
  expect(view.queryByText('执行计划')).toBeNull();
});

test.each([
  ['running', body], ['done', '   \n'], ['failed', body],
] as const)('plan with status %s and incomplete or empty content does not copy or export', async (status, output) => {
  const view = await render(<PlanPreview item={plan({ status, output })} onClose={jest.fn()} />);
  expect(view.getByLabelText('复制计划')).toBeDisabled();
  expect(view.getByLabelText('导出计划 PLAN.md')).toBeDisabled();
  await fireEvent.press(view.getByLabelText('复制计划'));
  await fireEvent.press(view.getByLabelText('导出计划 PLAN.md'));
  expect(Clipboard.setStringAsync).not.toHaveBeenCalled(); expect(writeGeneratedFile).not.toHaveBeenCalled(); expect(shareGeneratedFile).not.toHaveBeenCalled();
});

test('full plan follows authoritative updates, fits narrow screens, and closes from its controls', async () => {
  const close = jest.fn(), item = plan({ status: 'running' });
  const view = await render(<PlanPreview item={item} onClose={close} />);
  expect(view.getByText('计划详情')).toBeTruthy();
  expect(view.getByTestId('remote-plan-panel')).toHaveStyle({ width: 390 });
  await view.rerender(<PlanPreview item={plan({ output: '# 最终方案\n\n完整的新正文' })} onClose={close} />);
  expect(view.getByText('最终方案')).toBeTruthy(); expect(view.queryByText('修复方案')).toBeNull();
  await fireEvent.press(view.getByLabelText('复制计划'));
  expect(Clipboard.setStringAsync).toHaveBeenLastCalledWith('# 最终方案\n\n完整的新正文');
  await fireEvent.press(view.getByLabelText('关闭计划详情'));
  expect(close).toHaveBeenCalledTimes(1);
  await fireEvent.press(view.getByTestId('remote-plan-backdrop', { includeHiddenElements: true }));
  expect(close).toHaveBeenCalledTimes(2);
  await fireEvent(view.getByTestId('remote-plan-panel'), 'accessibilityEscape');
  expect(close).toHaveBeenCalledTimes(3);
  await view.rerender(<PlanPreview onClose={close} />);
  expect(view.queryByText('计划详情')).toBeNull();
});

test('wide screens use a bounded right panel and link actions receive the current target', async () => {
  jest.spyOn(require('react-native'), 'useWindowDimensions').mockReturnValue({ width: 1440, height: 900, scale: 1, fontScale: 1 });
  const openLink = jest.fn();
  const view = await render(<PlanPreview item={plan({ output: '# 方案\n\n[查看文件](src/example.ts)' })} onClose={jest.fn()} onOpenLink={openLink} />);
  expect(view.getByTestId('remote-plan-panel')).toHaveStyle({ width: 600 });
  await fireEvent.press(view.getByText('查看文件'));
  expect(openLink).toHaveBeenCalledWith('src/example.ts');
});

test('failed export remains retryable and an in-flight export is not duplicated', async () => {
  let reject!: (reason: Error) => void;
  jest.mocked(shareGeneratedFile).mockImplementationOnce(() => new Promise<void>((_, no) => { reject = no; }));
  const view = await render(<PlanPreview item={plan()} onClose={jest.fn()} />);
  await fireEvent.press(view.getByLabelText('导出计划 PLAN.md'));
  expect(view.getByLabelText('导出计划 PLAN.md')).toBeDisabled();
  await fireEvent.press(view.getByLabelText('导出计划 PLAN.md'));
  expect(shareGeneratedFile).toHaveBeenCalledTimes(1);
  await act(async () => { reject(new Error('分享不可用')); });
  expect(view.getByText('分享不可用')).toBeTruthy();
  expect(view.getByLabelText('导出计划 PLAN.md')).not.toBeDisabled();
  await fireEvent.press(view.getByLabelText('导出计划 PLAN.md'));
  expect(shareGeneratedFile).toHaveBeenCalledTimes(2);
});

test('feedback from a previous revision does not appear on an updated plan', async () => {
  let finish!: () => void;
  jest.mocked(Clipboard.setStringAsync).mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(undefined as never); }));
  const view = await render(<PlanPreview item={plan()} onClose={jest.fn()} />);
  await fireEvent.press(view.getByLabelText('复制计划'));
  await view.rerender(<PlanPreview item={plan({ output: '# 更新后正文' })} onClose={jest.fn()} />);
  await act(async () => { finish(); });
  expect(view.queryByText('已复制计划')).toBeNull();
  await fireEvent.press(view.getByLabelText('复制计划'));
  expect(Clipboard.setStringAsync).toHaveBeenLastCalledWith('# 更新后正文');
});
