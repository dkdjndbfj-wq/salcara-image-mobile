import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { RemoteTerminalPage } from '../remote/RemoteTerminalPage';

const mockOpen = jest.fn(), mockRead = jest.fn(), mockInput = jest.fn(), mockResize = jest.fn(), mockClose = jest.fn(), mockDispose = jest.fn();
const mockWrite = jest.fn();
jest.mock('../remote/workspace-terminal', () => ({
  captureWorkspaceTerminal: jest.fn(() => ({ open: mockOpen, read: mockRead, input: mockInput, resize: mockResize, close: mockClose, dispose: mockDispose })),
  terminalDimensions: (cols: number, rows: number) => ({ cols, rows }),
}));
jest.mock('../remote/TerminalSurface', () => {
  const React = require('react'), { View } = require('react-native');
  return { TerminalSurface: React.forwardRef((props: any, ref: any) => {
    React.useImperativeHandle(ref, () => ({ writeBase64: mockWrite, writeText: jest.fn(), clear: jest.fn(), focus: jest.fn(), setEnabled: jest.fn() }));
    React.useEffect(() => { props.onReady(); }, []);
    return React.createElement(View, { testID: 'terminal-surface', ...props });
  }) };
});
const selection = { deviceId: 'pc', sessionKey: 'codex:session', agentId: 'codex', surface: 'cli' as const, cwd: 'C:/project' };
const empty = { terminalId: 'terminal-id', cursor: 0, startCursor: 0, dataBase64: '', truncated: false, exited: false, exitCode: 0, nextSequence: 1 };
beforeEach(() => { jest.useFakeTimers(); jest.clearAllMocks(); mockOpen.mockResolvedValue(empty); mockRead.mockResolvedValue(empty); mockInput.mockResolvedValue(undefined); mockResize.mockResolvedValue(undefined); mockClose.mockResolvedValue(undefined); });
afterEach(() => { jest.useRealTimers(); });

test('background tabs retain the PTY and output without creating another shell', async () => {
  const view = await render(<RemoteTerminalPage {...selection} active />);
  await act(async () => {});
  expect(mockOpen).toHaveBeenCalledTimes(1);
  await view.rerender(<RemoteTerminalPage {...selection} active={false} />);
  expect(mockOpen).toHaveBeenCalledTimes(1); expect(mockDispose).not.toHaveBeenCalled();
  await act(async () => { jest.advanceTimersByTime(300); });
  expect(mockRead.mock.calls.length).toBeGreaterThan(1);
  await view.unmount(); expect(mockDispose).toHaveBeenCalledTimes(1);
});
test('typing batches ordered input and Ctrl+C remains an actual control character', async () => {
  const view = await render(<RemoteTerminalPage {...selection} />); await act(async () => {});
  await act(async () => { view.getByTestId('terminal-surface').props.onInput('p'); view.getByTestId('terminal-surface').props.onInput('wd\r'); jest.advanceTimersByTime(20); });
  expect(mockInput).toHaveBeenCalledWith('pwd\r');
  await fireEvent.press(view.getByLabelText('终端 Ctrl+C'));
  await act(async () => { jest.advanceTimersByTime(20); });
  expect(mockInput).toHaveBeenLastCalledWith('\x03');
  await view.unmount();
});
test('ending a PTY stops polling instead of turning a successful close into an error', async () => {
  const view = await render(<RemoteTerminalPage {...selection} />); await act(async () => {});
  await fireEvent.press(view.getByLabelText('结束电脑终端')); await act(async () => {});
  const reads = mockRead.mock.calls.length;
  await act(async () => { jest.advanceTimersByTime(1000); });
  expect(mockClose).toHaveBeenCalledTimes(1); expect(mockRead).toHaveBeenCalledTimes(reads);
  expect(view.getByLabelText('新建电脑终端')).toBeTruthy();
  await view.unmount();
});

test('a restored terminal tab does not spawn a new shell until the user reopens it', async () => {
  const view=await render(<RemoteTerminalPage {...selection} active connectOnMount={false}/>);
  await act(async()=>{jest.advanceTimersByTime(1000);});
  expect(mockOpen).not.toHaveBeenCalled();expect(mockRead).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('新建电脑终端'));
  await act(async()=>{});
  expect(mockOpen).toHaveBeenCalledTimes(1);await view.unmount();
});

test('an old terminal resize failure cannot disable its replacement session', async () => {
  let rejectResize!: (reason: Error) => void;
  mockResize.mockReturnValueOnce(new Promise<void>((_resolve, reject) => { rejectResize = reject; }));
  const view = await render(<RemoteTerminalPage {...selection} />); await act(async () => {});
  await act(async () => { view.getByTestId('terminal-surface').props.onResize(100, 30); jest.advanceTimersByTime(120); });
  expect(mockResize).toHaveBeenCalledTimes(1);
  await view.rerender(<RemoteTerminalPage {...selection} sessionKey="codex:replacement" />); await act(async () => {});
  await act(async () => { rejectResize(new Error('old resize failed')); });
  expect(view.queryByText('old resize failed')).toBeNull();
  expect(view.getByTestId('terminal-surface').props.enabled).toBe(true);
  await fireEvent.press(view.getByLabelText('终端 Ctrl+C'));
  await act(async () => { jest.advanceTimersByTime(20); });
  expect(mockInput).toHaveBeenLastCalledWith('\x03');
  await view.unmount();
});

test.each(['resolve', 'reject'] as const)('a late terminal close %s cannot change its replacement session', async outcome => {
  let resolveClose!: () => void, rejectClose!: (reason: Error) => void;
  mockClose.mockReturnValueOnce(new Promise<void>((resolve, reject) => { resolveClose = resolve; rejectClose = reject; }));
  const view = await render(<RemoteTerminalPage {...selection} />); await act(async () => {});
  await fireEvent.press(view.getByLabelText('结束电脑终端'));
  await view.rerender(<RemoteTerminalPage {...selection} sessionKey="codex:replacement" />); await act(async () => {});
  await act(async () => { if (outcome === 'resolve') resolveClose(); else rejectClose(new Error('old close failed')); });
  expect(view.queryByText('old close failed')).toBeNull();
  expect(view.queryByLabelText('新建电脑终端')).toBeNull();
  expect(view.getByTestId('terminal-surface').props.enabled).toBe(true);
  await view.unmount();
});
