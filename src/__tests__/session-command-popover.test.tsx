import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { SessionCommandPopover } from '../remote/SessionCommandPopover';
import type { SessionCommandTransport } from '../remote/session-commands';

const mockReadActions = jest.fn(), mockApplyAction = jest.fn(), mockReadWorkflows = jest.fn(), mockReview = jest.fn();
let mockScope = 'hub-1';
jest.mock('../remote/store', () => ({ nativeSessionActionScope: () => mockScope, sessionWorkflowScope: () => mockScope,
  readNativeSessionActions: (...args: unknown[]) => mockReadActions(...args), applyNativeSessionAction: (...args: unknown[]) => mockApplyAction(...args),
  readSessionWorkflows: (...args: unknown[]) => mockReadWorkflows(...args), applySessionWorkflow: (...args: unknown[]) => mockReview(...args) }));
const mockAppState = { currentState: 'active', addEventListener: jest.fn((..._args: unknown[]) => ({ remove: jest.fn() })) };
jest.mock('react-native/Libraries/AppState/AppState', () => ({ __esModule: true, default: {
  get currentState() { return mockAppState.currentState; }, addEventListener: (...args: unknown[]) => mockAppState.addEventListener(...args),
} }));
jest.mock('../remote/ComposerPopover', () => ({ ComposerPopover: ({ children, visible, onClose }: any) => {
  const React = require('react'), { View, Pressable } = require('react-native');
  return visible ? React.createElement(View, null, children, React.createElement(Pressable, { testID: 'close-command', onPress: onClose })) : null;
} }));
const actions = (scope = mockScope, sessionKey = 'codex:s', revision = 'r1') => ({ scope, value: { sessionKey, revision, title: 'Current task', archived: false, actions: ['fork', 'archive'] } });
const workflows = (scope = mockScope) => ({ scope, value: { sessionKey: 'codex:s', revision: 'r1', canReview: true, goalSupported: false, goalActions: [] } });
const result = (action = 'fork') => ({ sessionKey: 'codex:s', operationId: 'op-1', action, state: 'completed', session: { sessionKey: 'codex:branch' } });
const props = () => ({ visible: true, scopeKey: 'selection-1', deviceId: 'pc', sessionKey: 'codex:s', command: 'fork' as const, onClose: jest.fn(), onFork: jest.fn(), onArchive: jest.fn(), onReviewStarted: jest.fn() });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => { jest.clearAllMocks(); mockScope = 'hub-1'; mockAppState.currentState = 'active'; mockReadActions.mockReset().mockImplementation(async () => actions()); mockReadWorkflows.mockReset().mockImplementation(async () => workflows()); mockApplyAction.mockReset().mockResolvedValue(result()); mockReview.mockReset().mockResolvedValue({ sessionKey: 'codex:s', kind: 'review', state: 'requested' }); });

test('opening reads only and an explicit fork navigates only on its confirmed receipt', async () => {
  const callbacks = props(), ui = await render(<SessionCommandPopover {...callbacks} />);
  expect(mockReadActions).toHaveBeenCalledTimes(1); expect(mockApplyAction).not.toHaveBeenCalled();
  await fireEvent.press(ui.getByRole('button', { name: '创建分支' }));
  expect(mockApplyAction).toHaveBeenCalledWith('pc', 'codex:s', actions(), 'fork');
  expect(callbacks.onFork).toHaveBeenCalledWith('codex:branch'); expect(callbacks.onClose).toHaveBeenCalledTimes(1);
});

test('review checks native permission and submits only uncommitted changes', async () => {
  const callbacks = props(), ui = await render(<SessionCommandPopover {...callbacks} command="review" />);
  expect(mockReview).not.toHaveBeenCalled(); expect(ui.getByText('审查未提交的更改')).toBeTruthy();
  await fireEvent.press(ui.getByRole('button', { name: '开始审查' }));
  expect(mockReview).toHaveBeenCalledWith('pc', 'codex:s', workflows(), { kind: 'review', target: { type: 'uncommittedChanges' } }); expect(callbacks.onReviewStarted).toHaveBeenCalledTimes(1);
  mockReadWorkflows.mockResolvedValue({ ...workflows(), value: { ...workflows().value, canReview: false } });
  const disabled = await render(<SessionCommandPopover {...props()} command="review" />); await fireEvent.press(disabled.getByRole('button', { name: '开始审查' })); expect(mockReview).toHaveBeenCalledTimes(1);
});

test('double presses issue one mutation and refresh never replays an uncertain revision', async () => {
  const callbacks = props(), pending = deferred<any>(); mockApplyAction.mockReturnValue(pending.promise);
  const ui = await render(<SessionCommandPopover {...callbacks} />), button = ui.getByRole('button', { name: '创建分支' });
  await fireEvent.press(button); await fireEvent.press(button); expect(mockApplyAction).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve({ ...result(), state: 'unconfirmed' }));
  expect(callbacks.onFork).not.toHaveBeenCalled(); expect(ui.getByText('操作结果尚未确认，请刷新状态')).toBeTruthy();
  await fireEvent.press(ui.getByRole('button', { name: '刷新状态' })); await fireEvent.press(ui.getByRole('button', { name: '创建分支' }));
  expect(mockReadActions).toHaveBeenCalledTimes(2); expect(mockApplyAction).toHaveBeenCalledTimes(1);
});

test.each(['scope', 'hidden', 'background', 'close', 'unmount'])('%s invalidates late mutation callbacks', async scenario => {
  const callbacks = props(), pending = deferred<any>(); mockApplyAction.mockReturnValue(pending.promise);
  const ui = await render(<SessionCommandPopover {...callbacks} />); await fireEvent.press(ui.getByRole('button', { name: '创建分支' }));
  if (scenario === 'scope') { mockScope = 'hub-2'; await ui.rerender(<SessionCommandPopover {...callbacks} scopeKey="selection-2" />); }
  else if (scenario === 'hidden') await ui.rerender(<SessionCommandPopover {...callbacks} visible={false} />);
  else if (scenario === 'background') { mockAppState.currentState = 'background'; await act(async () => { (mockAppState.addEventListener.mock.calls[0][1] as (state: string) => void)('background'); }); }
  else if (scenario === 'close') await fireEvent.press(ui.getByTestId('close-command'));
  else await ui.unmount();
  await act(async () => pending.resolve(result())); expect(callbacks.onFork).not.toHaveBeenCalled();
});

test('a late old-session read cannot expose its action in the new session', async () => {
  const pending = deferred<any>(); mockReadActions.mockReturnValueOnce(pending.promise);
  const callbacks = props(), ui = await render(<SessionCommandPopover {...callbacks} />);
  mockScope = 'hub-2'; mockReadActions.mockResolvedValue({ ...actions('hub-2', 'codex:next'), value: { ...actions('hub-2', 'codex:next').value, title: 'New task', actions: [] } });
  await ui.rerender(<SessionCommandPopover {...callbacks} sessionKey="codex:next" scopeKey="selection-2" />);
  await act(async () => pending.resolve(actions('hub-1')));
  expect(ui.queryByText('Current task')).toBeNull(); expect(ui.getByText('New task')).toBeTruthy();
  await fireEvent.press(ui.getByRole('button', { name: '创建分支' })); expect(mockApplyAction).not.toHaveBeenCalled();
});

test('an injected Direct transport never reaches Hub operations', async () => {
  const transport: SessionCommandTransport = { scope: () => 'direct-1', isCurrent: () => true, readActions: jest.fn().mockResolvedValue(actions('direct-1')), applyAction: jest.fn().mockResolvedValue(result('archive')), readWorkflows: jest.fn(), applyReview: jest.fn() };
  const callbacks = props(), ui = await render(<SessionCommandPopover {...callbacks} command="archive" transport={transport} />);
  await fireEvent.press(ui.getByRole('button', { name: '归档对话' }));
  expect(transport.applyAction).toHaveBeenCalledTimes(1); expect(callbacks.onArchive).toHaveBeenCalledTimes(1);
  expect(mockReadActions).not.toHaveBeenCalled(); expect(mockApplyAction).not.toHaveBeenCalled(); expect(mockReadWorkflows).not.toHaveBeenCalled(); expect(mockReview).not.toHaveBeenCalled();
});
