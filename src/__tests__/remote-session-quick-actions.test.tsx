import React from 'react';
import { fireEvent, render, act } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { SessionQuickActionsSheet } from '../remote/SessionQuickActionsSheet';
import type { AgentProfile, SessionInfo } from '../remote/client';

const mockClipboard = jest.fn<Promise<void>, [string]>(async () => undefined);
const mockToast = jest.fn();
const mockActions = new Map<string, () => void>();
jest.mock('expo-clipboard', () => ({ setStringAsync: (...args: [string]) => mockClipboard(...args) }));
jest.mock('../components/ui', () => {
  const React = require('react'), { View, Text, Pressable } = require('react-native');
  return { showToast: (...args: unknown[]) => mockToast(...args), AppDialog: ({ visible, title, actions, children }: any) => visible
    ? React.createElement(View, null, React.createElement(Text, null, title), children,
      ...actions.map((action: any) => { mockActions.set(action.label, action.onPress); return React.createElement(Pressable, { key: action.label, accessibilityRole: 'button', accessibilityLabel: action.label, disabled: action.disabled, onPress: action.onPress }, React.createElement(Text, null, action.label)); })) : null };
});
jest.mock('../components/Icon', () => ({ Icon: () => null }));
jest.mock('../components/MotionPressable', () => ({ useReducedMotion: () => true, MotionPressable: require('react-native').Pressable }));
jest.mock('../remote/store', () => ({ hubSupportsSessionActions: () => true }));
jest.mock('../remote/SessionActionsSheet', () => {
  const React = require('react'), { View, Text, Pressable } = require('react-native');
  return { SessionActionsSheet: ({ visible, onArchive, onFork }: any) => visible
    ? React.createElement(View, { testID: 'session-management' }, React.createElement(Text, null, '会话管理'), React.createElement(Pressable, { accessibilityLabel: '执行归档', onPress: onArchive }),
      React.createElement(Pressable, { accessibilityLabel: '执行分叉', onPress: () => onFork('codex:forked-thread') })) : null };
});

const agent: AgentProfile = { id: 'codex', name: '编程', tool: 'codex', available: true, remoteSendSupported: true,
  capabilities: { list: true, read: true, send: true, interrupt: true, approval: true, questions: true, subagents: true, attachments: true, imageInput: true, imageOutput: true, modelOverride: true, sessionActions: true },
  api: { name: '主力 API', model: '', protocol: 'responses', configured: true, pending: false, source: 'computer' } };
const session: SessionInfo = { sessionKey: 'codex:thread-123', tool: 'codex', client: 'Codex App', title: '订单修复', cwd: 'C:\\work\\shop',
  updatedAt: 1, status: 'running', controllable: true, controlSurface: 'cli' };
function props(extra: Record<string, unknown> = {}) { return { visible: true, deviceId: 'work-pc', connectionId: 'a'.repeat(64), deviceName: '工作电脑', agent, session,
  onClose: jest.fn(), onOpenSession: jest.fn(), onArchive: jest.fn(), ...extra }; }
beforeEach(() => { mockClipboard.mockClear(); mockToast.mockClear(); mockActions.clear(); });
function retainedPress(node: { unstable_fiber: any }): () => void {
  let fiber = node.unstable_fiber;
  while (fiber && typeof fiber.memoizedProps?.onPress !== 'function') fiber = fiber.return;
  return fiber.memoizedProps.onPress;
}

test('row actions copy a scoped deep link, useful Markdown and the original working directory', async () => {
  const input = props(), view = await render(<SessionQuickActionsSheet {...input} />);
  await fireEvent.press(view.getByLabelText('复制深度链接'));
  expect(mockClipboard).toHaveBeenCalledWith(expect.stringContaining('salcara://remote/thread?'));
  expect(mockClipboard).toHaveBeenLastCalledWith(expect.stringContaining('connection=' + 'a'.repeat(64)));
  expect(mockToast).toHaveBeenLastCalledWith('深度链接已复制', 'checkCircle');
  await view.rerender(<SessionQuickActionsSheet {...input} visible={false}/>);
  await view.rerender(<SessionQuickActionsSheet {...input}/>);
  await fireEvent.press(view.getByLabelText('复制 Markdown'));
  expect(mockClipboard.mock.calls.at(-1)?.[0]).toContain('## [订单修复]');
  expect(mockClipboard.mock.calls.at(-1)?.[0]).toContain('C:\\work\\shop');
  await view.rerender(<SessionQuickActionsSheet {...input} visible={false}/>);
  await view.rerender(<SessionQuickActionsSheet {...input}/>);
  await fireEvent.press(view.getByLabelText('复制工作目录'));
  expect(mockClipboard).toHaveBeenLastCalledWith('C:\\work\\shop');
});

test('directory-less and malformed-session rows cannot copy a broken deep link or path', async () => {
  const view = await render(<SessionQuickActionsSheet {...props({ session: { ...session, cwd: '', sessionKey: 'other:wrong' } })} />);
  expect(view.getByLabelText('复制深度链接').props.accessibilityState.disabled).toBe(true);
  expect(view.getByLabelText('复制工作目录').props.accessibilityState.disabled).toBe(true);
  await act(async () => retainedPress(view.getByLabelText('复制深度链接'))());
  await act(async () => retainedPress(view.getByLabelText('复制工作目录'))());
  expect(mockClipboard).not.toHaveBeenCalled();
});

test('archive completion dismisses both menu layers and reports success', async () => {
  const input = props(), view = await render(<SessionQuickActionsSheet {...input} />);
  await fireEvent.press(view.getByLabelText('管理会话'));
  expect(view.getByTestId('session-management')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('执行归档'));
  expect(input.onClose).toHaveBeenCalled(); expect(input.onArchive).toHaveBeenCalled();
  expect(mockToast).toHaveBeenLastCalledWith('对话已归档', 'checkCircle');
});

test('fork opens the returned conversation through the dedicated guarded route', async () => {
  const onOpenSession = jest.fn(), onOpenFork = jest.fn();
  const view = await render(<SessionQuickActionsSheet {...props({ onOpenSession, onOpenFork })} />);
  await fireEvent.press(view.getByLabelText('管理会话'));
  await fireEvent.press(view.getByLabelText('执行分叉'));
  expect(onOpenFork).toHaveBeenCalledWith('codex:forked-thread');
  expect(onOpenSession).not.toHaveBeenCalled();
});

test('the compact menu has no close row; clicking outside closes without invoking an action', async () => {
  const input = props(), view = await render(<SessionQuickActionsSheet {...input}/>);
  expect(StyleSheet.flatten(view.getByTestId('session-quick-actions').props.style).width).toBe(232);
  expect(view.queryByText('关闭')).toBeNull();
  const press = retainedPress(view.getByLabelText('复制会话信息'));
  await fireEvent.press(view.getByTestId('session-quick-actions-backdrop'));
  await act(async () => press());
  expect(input.onClose).toHaveBeenCalledTimes(1); expect(mockClipboard).not.toHaveBeenCalled();
});

test('the native back / web escape callback dismisses the menu once', async () => {
  const input = props(), view = await render(<SessionQuickActionsSheet {...input}/>);
  let fiber = view.getByTestId('session-quick-actions').unstable_fiber;
  while (fiber && typeof fiber.memoizedProps?.onRequestClose !== 'function') fiber = fiber.return;
  if (!fiber) throw new Error('Modal close callback not found');
  const close = fiber.memoizedProps.onRequestClose;
  await act(async () => { close(); close(); });
  expect(input.onClose).toHaveBeenCalledTimes(1); expect(mockClipboard).not.toHaveBeenCalled();
});

test('actions retained from a different device or session cannot copy or open the replacement row', async () => {
  const input = props(), view = await render(<SessionQuickActionsSheet {...input}/>);
  const copy = retainedPress(view.getByLabelText('复制会话信息'));
  const open = retainedPress(view.getByLabelText('打开对话'));
  await view.rerender(<SessionQuickActionsSheet {...input} deviceId="other-pc" session={{ ...session, sessionKey: 'codex:other' }}/>);
  await act(async () => { copy(); open(); });
  expect(mockClipboard).not.toHaveBeenCalled(); expect(input.onOpenSession).not.toHaveBeenCalled(); expect(input.onClose).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('复制会话信息'));
  expect(mockClipboard).toHaveBeenCalledWith(expect.stringContaining('codex:other'));
});
