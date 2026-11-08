import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { SessionWorkflowsSheet } from '../remote/SessionWorkflowsSheet';
const mockRead = jest.fn(), mockApply = jest.fn(), mockToast = jest.fn(), mockActions = new Map<string, () => void>();
let mockScope = 'source-a';
jest.mock('react-native/Libraries/AppState/AppState', () => ({ __esModule: true, default: { currentState: 'active', addEventListener: jest.fn(() => ({ remove: jest.fn() })) } }));
jest.mock('../remote/store', () => ({ useRemote: () => ({ timelines: {} }), timelineKey: () => 'pc|codex:s', sessionWorkflowScope: () => mockScope,
  readSessionWorkflows: (...args: unknown[]) => mockRead(...args), applySessionWorkflow: (...args: unknown[]) => mockApply(...args) }));
jest.mock('../components/ui', () => {
  const React = require('react'), { View, Text, Pressable } = require('react-native');
  return { showToast: (...args: unknown[]) => mockToast(...args), AppDialog: ({ visible, title, children, actions }: any) => visible ? <View><Text>{title}</Text>{children}
    {actions.map((action: any) => { mockActions.set(action.label, action.onPress); return <Pressable key={action.label} accessibilityLabel={action.label} disabled={action.disabled} onPress={action.onPress}><Text>{action.label}</Text></Pressable>; })}</View> : null };
});
const catalog = () => ({ scope: mockScope, value: { sessionKey: 'codex:s', revision: 'r1', canReview: true, goalSupported: true, goalActions: ['set'] } });
const props = () => ({ visible: true, deviceId: 'pc', sessionKey: 'codex:s', onClose: jest.fn() });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => { mockScope = 'source-a'; mockRead.mockReset().mockImplementation(async () => catalog()); mockApply.mockReset(); mockToast.mockReset(); mockActions.clear(); });
test('review exposes a real target and waits for native acknowledgment', async () => {
  const pending = deferred<unknown>(); mockApply.mockReturnValue(pending.promise);
  const input = props(), ui = await render(<SessionWorkflowsSheet {...input} />);
  await fireEvent.press(ui.getByLabelText('代码审查')); await fireEvent.press(ui.getByLabelText('指定提交')); await fireEvent.changeText(ui.getByPlaceholderText('提交 SHA'), 'a123456');
  await fireEvent.press(ui.getByLabelText('开始审查')); await fireEvent.press(ui.getByLabelText('开始审查'));
  expect(mockApply).toHaveBeenCalledTimes(1); expect(mockApply).toHaveBeenCalledWith('pc', 'codex:s', expect.anything(), { kind: 'review', target: { type: 'commit', sha: 'a123456' } });
  expect(input.onClose).not.toHaveBeenCalled();
  await act(async () => pending.resolve({ state: 'requested', turnId: 'native-turn' }));
  expect(input.onClose).toHaveBeenCalledTimes(1); expect(mockToast).toHaveBeenCalledWith('审查已开始', 'checkCircle'); await ui.unmount();
});
test('an empty optional token budget is omitted, never invented', async () => {
  mockApply.mockResolvedValue({ state: 'completed' }); const ui = await render(<SessionWorkflowsSheet {...props()} />);
  await fireEvent.press(ui.getByLabelText('设置目标')); await fireEvent.changeText(ui.getByLabelText('任务目标'), '核对项目所有来源'); await fireEvent.press(ui.getByLabelText('设置目标'));
  expect(mockApply).toHaveBeenCalledWith('pc', 'codex:s', expect.anything(), { kind: 'goal.set', objective: '核对项目所有来源' });
  expect(mockToast).toHaveBeenCalledWith('目标已设置', 'checkCircle'); await ui.unmount();
});
test('pausing a goal is an exact goal operation and is not a turn interrupt', async () => {
  mockRead.mockResolvedValue({ ...catalog(), value: { ...catalog().value, canReview: false, goalActions: ['pause'], goal: { objective: '继续处理', status: 'active', tokensUsed: 150, tokenBudget: null } } });
  mockApply.mockResolvedValue({ state: 'completed' }); const ui = await render(<SessionWorkflowsSheet {...props()} />);
  expect(ui.getByText('150 tokens')).toBeTruthy(); await fireEvent.press(ui.getByLabelText('暂停目标'));
  expect(mockApply).toHaveBeenCalledWith('pc', 'codex:s', expect.anything(), { kind: 'goal.pause' }); await ui.unmount();
});
test.each(['source', 'unmount'])('late review acknowledgments are silent after %s change', async change => {
  const pending = deferred<unknown>(); mockApply.mockReturnValue(pending.promise); const input = props(), ui = await render(<SessionWorkflowsSheet {...input} />);
  await fireEvent.press(ui.getByLabelText('代码审查')); await fireEvent.press(ui.getByLabelText('开始审查'));
  if (change === 'source') mockScope = 'source-b'; else await ui.unmount();
  await act(async () => pending.resolve({ state: 'requested', turnId: 'native-turn' }));
  expect(input.onClose).not.toHaveBeenCalled(); expect(mockToast).not.toHaveBeenCalled(); if (change === 'source') await ui.unmount();
});
test('old form actions cannot execute after closing and reopening the same sheet', async () => {
  const input = props(), ui = await render(<SessionWorkflowsSheet {...input} />); await fireEvent.press(ui.getByLabelText('代码审查')); const old = mockActions.get('开始审查')!;
  await ui.rerender(<SessionWorkflowsSheet {...input} visible={false} />); await ui.rerender(<SessionWorkflowsSheet {...input} />);
  await act(async () => old()); expect(mockApply).not.toHaveBeenCalled(); await ui.unmount();
});
test('synchronous admission rejection clears busy without faking completion', async () => {
  mockApply.mockImplementation(() => { throw new Error('API 已变化'); }); const ui = await render(<SessionWorkflowsSheet {...props()} />);
  await fireEvent.press(ui.getByLabelText('代码审查')); await fireEvent.press(ui.getByLabelText('开始审查'));
  expect(ui.queryByText('处理中…')).toBeNull(); expect(mockToast).not.toHaveBeenCalled(); await ui.unmount();
});
