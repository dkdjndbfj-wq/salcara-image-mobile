import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { SessionActionsSheet } from '../remote/SessionActionsSheet';
import { ArchivedSessions } from '../remote/ArchivedSessions';
import type { NativeSessionActionsReading } from '../remote/session-actions';

const mockRead = jest.fn(), mockApply = jest.fn(), mockArchived = jest.fn(), mockRename = jest.fn();
let mockScope = 'a';
const mockActions = new Map<string, () => void>();
jest.mock('../remote/store', () => ({ useRemote: () => ({}), nativeSessionActionScope: () => mockScope, remoteDeliveryScope: () => 'pair-a',
  readNativeSessionActions: (...args: unknown[]) => mockRead(...args), applyNativeSessionAction: (...args: unknown[]) => mockApply(...args),
  readArchivedSessions: (...args: unknown[]) => mockArchived(...args) }));
jest.mock('../remote/thread-titles', () => ({ renameThread: (...args: unknown[]) => mockRename(...args) }));
jest.mock('../components/ui', () => {
  const React = require('react'), { View, Text, Pressable } = require('react-native');
  return { showToast: jest.fn(), AppDialog: ({ visible, title, actions, children }: any) => visible ? <View><Text>{title}</Text>{children}
    {actions.map((action: any) => { mockActions.set(action.label, action.onPress); return <Pressable key={action.label} accessibilityLabel={action.label} disabled={action.disabled} onPress={action.onPress}><Text>{action.label}</Text></Pressable>; })}</View> : null };
});
const reading = (scope = 'a'): NativeSessionActionsReading => ({ scope, value: { sessionKey: 'codex:s', revision: 'r1', title: '原名称', archived: false, actions: ['rename', 'archive', 'fork'] } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const props = () => ({ visible: true, deviceId: 'pc', sessionKey: 'codex:s', onClose: jest.fn(), onFork: jest.fn(), onArchive: jest.fn() });
beforeEach(() => { mockScope = 'a'; mockRead.mockReset().mockResolvedValue(reading()); mockApply.mockReset(); mockArchived.mockReset(); mockRename.mockReset().mockResolvedValue(undefined); mockActions.clear(); });
test('native fork waits for confirmation and suppresses repeated taps', async () => {
  const pending = deferred<unknown>(); mockApply.mockReturnValue(pending.promise);
  const input = props(), ui = await render(<SessionActionsSheet {...input} />);
  await fireEvent.press(ui.getByLabelText('创建分支')); await fireEvent.press(ui.getByLabelText('创建分支'));
  expect(mockApply).toHaveBeenCalledTimes(1); expect(input.onFork).not.toHaveBeenCalled();
  await act(async () => pending.resolve({ state: 'completed', session: { sessionKey: 'codex:branch' } }));
  expect(input.onFork).toHaveBeenCalledWith('codex:branch'); await ui.unmount();
});
test('unconfirmed action never navigates, retries, or presents success', async () => {
  mockApply.mockResolvedValue({ state: 'unconfirmed', error: '原生结果未确认' });
  const input = props(), ui = await render(<SessionActionsSheet {...input} />);
  await fireEvent.press(ui.getByLabelText('创建分支'));
  expect(ui.getByText('原生结果未确认')).toBeTruthy(); expect(ui.queryByLabelText('创建分支')).toBeNull(); expect(input.onFork).not.toHaveBeenCalled();
  expect(mockApply).toHaveBeenCalledTimes(1); await ui.unmount();
});
test('a changed account is fenced even before React renders the new selection', async () => {
  const ui = await render(<SessionActionsSheet {...props()} />), old = mockActions.get('创建分支')!;
  mockScope = 'b'; await act(async () => old()); expect(mockApply).not.toHaveBeenCalled(); await ui.unmount();
});
test('closing and reopening the same sheet cannot revive captured actions', async () => {
  const input = props(), ui = await render(<SessionActionsSheet {...input} />), old = mockActions.get('创建分支')!, oldClose = mockActions.get('关闭')!;
  await ui.rerender(<SessionActionsSheet {...input} visible={false} />); await ui.rerender(<SessionActionsSheet {...input} />);
  await act(async () => { old(); oldClose(); }); expect(mockApply).not.toHaveBeenCalled(); expect(input.onClose).not.toHaveBeenCalled(); await ui.unmount();
});
test.each(['account', 'unmount'])('late completion cannot open another conversation after %s', async change => {
  const pending = deferred<unknown>(); mockApply.mockReturnValue(pending.promise);
  const input = props(), ui = await render(<SessionActionsSheet {...input} />); await fireEvent.press(ui.getByLabelText('创建分支'));
  if (change === 'account') mockScope = 'b'; else await ui.unmount();
  await act(async () => pending.resolve({ state: 'completed', session: { sessionKey: 'codex:branch' } }));
  expect(input.onFork).not.toHaveBeenCalled(); expect(input.onClose).not.toHaveBeenCalled(); if (change === 'account') await ui.unmount();
});
test('native rename clears the phone alias only after native success', async () => {
  mockApply.mockResolvedValue({ state: 'completed' });
  const ui = await render(<SessionActionsSheet {...props()} />); await fireEvent.press(ui.getByLabelText('重命名'));
  await fireEvent.changeText(ui.getByLabelText('原生会话名称'), '新的名称'); await fireEvent.press(ui.getByLabelText('保存'));
  expect(mockApply).toHaveBeenCalledWith('pc', 'codex:s', expect.anything(), 'rename', '新的名称');
  expect(mockRename).toHaveBeenCalledWith('pc', 'codex:s', '', 'pair-a'); await ui.unmount();
});
test('missing SDK/runtime support remains an explicit unavailable catalog', async () => {
  mockRead.mockResolvedValue({ ...reading(), value: { ...reading().value, actions: [], unavailableReason: '当前版本不支持' } });
  const ui = await render(<SessionActionsSheet {...props()} />); expect(ui.getByText('当前版本不支持')).toBeTruthy(); expect(ui.queryByLabelText('创建分支')).toBeNull(); await ui.unmount();
});
test('archive restore performs a fresh native read and never writes after source changes', async () => {
  const session = { sessionKey: 'codex:s', title: '已归档', archived: true };
  mockArchived.mockResolvedValue({ sessions: [session], nextCursor: '', scope: 'a' });
  const pending = deferred<unknown>(); mockRead.mockReturnValue(pending.promise); const onRestored = jest.fn();
  const ui = await render(<ArchivedSessions deviceId="pc" tool="codex" onRestored={onRestored} />);
  await fireEvent.press(ui.getByLabelText('恢复已归档')); mockScope = 'b';
  await act(async () => pending.resolve({ ...reading(), value: { ...reading().value, archived: true, actions: ['unarchive'] } }));
  expect(mockApply).not.toHaveBeenCalled(); expect(onRestored).not.toHaveBeenCalled(); await ui.unmount();
});
