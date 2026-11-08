import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { ContextBar, type ContextBarHandle } from '../remote/ContextBar';
import type { SessionContextReading } from '../remote/store';

const mockRead = jest.fn<Promise<SessionContextReading>, unknown[]>();
const mockCompact = jest.fn<Promise<SessionContextReading>, unknown[]>();
let mockScope = 'a';
jest.mock('react-native/Libraries/AppState/AppState', () => ({ __esModule: true, default: { currentState: 'active', addEventListener: jest.fn(() => ({ remove: jest.fn() })) } }));
jest.mock('../remote/store', () => ({ readSessionContext: (...args: unknown[]) => mockRead(...args), compactSessionContext: (...args: unknown[]) => mockCompact(...args), sessionContextScope: () => mockScope }));
const reading = (key = 'codex:s', scope = 'a'): SessionContextReading => ({ scope, value: { sessionKey: key, revision: 'r1', canCompact: true,
  snapshot: { usedTokens: 40000, windowTokens: 200000, source: 'codex_token_usage', basis: 'last_request', windowKind: 'model', measuredAt: 1 } } });
const props = { deviceId: 'pc', sessionKey: 'codex:s', scopeKey: 'a', active: true, canCompact: true, busy: false, signalVersion: '0' };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const advance = async (ms = 150) => { await act(async () => { jest.advanceTimersByTime(ms); await Promise.resolve(); }); };
const openDetails = async (ui: Awaited<ReturnType<typeof render>>) => fireEvent.press(ui.getByTestId('context-indicator-button'));
beforeEach(() => { jest.useFakeTimers(); mockScope = 'a'; mockRead.mockReset().mockResolvedValue(reading()); mockCompact.mockReset(); });
afterEach(() => { jest.useRealTimers(); });

test('opens native usage from a compact ring and never treats acceptance as completion', async () => {
  const pending = deferred<SessionContextReading>(); mockCompact.mockReturnValue(pending.promise);
  const ui = await render(<ContextBar {...props} />); await advance();
  expect(ui.queryByText('20%')).toBeNull();
  expect(ui.getByLabelText('上下文状态，20% 已用')).toBeTruthy();
  await openDetails(ui);
  expect(ui.getByText('20%')).toBeTruthy();
  expect(ui.getByText('40,000 / 200,000 tokens')).toBeTruthy();
  expect(mockCompact).not.toHaveBeenCalled();
  await fireEvent.press(ui.getByLabelText('压缩上下文'));
  await fireEvent.press(ui.getByLabelText('压缩上下文'));
  expect(mockCompact).toHaveBeenCalledTimes(1); expect(ui.getByText('正在提交')).toBeTruthy();
  await act(async () => pending.resolve({ ...reading(), value: { ...reading().value, canCompact: false, snapshot: undefined, compaction: { state: 'requested', blocking: true, startedAt: 1, updatedAt: 1 } } }));
  expect(ui.getByText('等待压缩')).toBeTruthy(); expect(ui.queryByText('已压缩')).toBeNull();
  await ui.unmount();
});
test('a response from a previous session cannot become the current context', async () => {
  const old = deferred<SessionContextReading>(); mockRead.mockReturnValueOnce(old.promise);
  const ui = await render(<ContextBar {...props} />); await advance();
  mockScope = 'b'; mockRead.mockResolvedValue({ ...reading('codex:other', 'b'), value: { sessionKey: 'codex:other', revision: 'r2', canCompact: false } });
  await ui.rerender(<ContextBar {...props} sessionKey="codex:other" scopeKey="b" />); await advance();
  await act(async () => old.resolve(reading()));
  expect(ui.queryByLabelText('上下文状态，20% 已用')).toBeNull();
  await openDetails(ui);
  expect(ui.getByText('—')).toBeTruthy(); expect(ui.getByText('尚无上下文用量')).toBeTruthy();
  await ui.unmount();
});
test('network failure shows an unconfirmed state and never resends the compact mutation', async () => {
  mockCompact.mockRejectedValue(new Error('网络中断'));
  const ui = await render(<ContextBar {...props} />); await advance();
  await openDetails(ui);
  mockRead.mockRejectedValue(new Error('电脑离线'));
  await fireEvent.press(ui.getByLabelText('压缩上下文'));
  expect(ui.getByText('压缩结果未确认')).toBeTruthy();
  await advance(); await advance(3200); await advance();
  expect(mockCompact).toHaveBeenCalledTimes(1);
  expect(ui.getByText('电脑离线')).toBeTruthy();
  expect(ui.getByText('压缩结果未确认')).toBeTruthy();
  await ui.unmount();
});
test('busy runtime, changed source and background component cannot dispatch compact', async () => {
  const ref = React.createRef<ContextBarHandle>();
  const ui = await render(<ContextBar {...props} ref={ref} busy />); await advance();
  await openDetails(ui);
  await fireEvent.press(ui.getByLabelText('压缩上下文')); expect(mockCompact).not.toHaveBeenCalled();
  await ui.rerender(<ContextBar {...props} ref={ref} />); mockScope = 'changed';
  await fireEvent.press(ui.getByLabelText('压缩上下文')); expect(mockCompact).not.toHaveBeenCalled();
  await ui.rerender(<ContextBar {...props} ref={ref} active={false} />);
  expect(ui.queryByLabelText('压缩上下文')).toBeNull(); expect(ref.current?.compact()).toBe(false); expect(mockCompact).not.toHaveBeenCalled();
  await ui.unmount();
});

test('a completed result keeps sending blocked until its runtime finishes', async () => {
  const onBusyChange = jest.fn();
  const result = reading(); result.value.compaction = { state: 'completed', blocking: true, startedAt: 1, updatedAt: 2 };
  result.value.canCompact = false; mockRead.mockResolvedValue(result);
  const ui = await render(<ContextBar {...props} onBusyChange={onBusyChange} />); await advance();
  await openDetails(ui);
  expect(ui.getByText('已压缩')).toBeTruthy(); expect(onBusyChange).toHaveBeenLastCalledWith(true);
  await fireEvent.press(ui.getByLabelText('压缩上下文')); expect(mockCompact).not.toHaveBeenCalled();
  mockRead.mockResolvedValue({ ...result, value: { ...result.value, canCompact: true, compaction: { ...result.value.compaction!, blocking: false } } });
  await advance(3100); await advance();
  expect(onBusyChange).toHaveBeenLastCalledWith(false);
  await ui.unmount();
});

test('an unconfirmed but finished operation releases sending without replaying it', async () => {
  const onBusyChange = jest.fn(); mockCompact.mockRejectedValue(new Error('网络中断'));
  const ui = await render(<ContextBar {...props} onBusyChange={onBusyChange} />); await advance();
  await openDetails(ui);
  mockRead.mockResolvedValue({ ...reading(), value: { ...reading().value, compaction: { state: 'unconfirmed', blocking: false, startedAt: 1, updatedAt: 2 } } });
  await fireEvent.press(ui.getByLabelText('压缩上下文'));
  expect(onBusyChange).toHaveBeenLastCalledWith(true);
  await advance(3200); await advance();
  expect(ui.getByText('压缩结果未确认')).toBeTruthy(); expect(onBusyChange).toHaveBeenLastCalledWith(false);
  await advance(3500); expect(mockCompact).toHaveBeenCalledTimes(1);
  await ui.unmount();
});

test('the command shortcut uses the same admission and duplicate guard as the button', async () => {
  const ref = React.createRef<ContextBarHandle>(), pending = deferred<SessionContextReading>();
  mockCompact.mockReturnValue(pending.promise);
  const ui = await render(<ContextBar {...props} ref={ref} />);
  expect(ref.current?.compact()).toBe(false); await advance();
  await openDetails(ui);
  await act(async () => { expect(ref.current?.compact()).toBe(true); expect(ref.current?.compact()).toBe(false); });
  await fireEvent.press(ui.getByLabelText('压缩上下文'));
  expect(mockCompact).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve(reading()));
  mockScope = 'changed'; expect(ref.current?.compact()).toBe(false);
  await ui.unmount(); expect(ref.current).toBeNull();
});
