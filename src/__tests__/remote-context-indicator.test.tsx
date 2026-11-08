import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { ContextIndicator } from '../remote/ContextIndicator';
import type { SessionContext } from '../remote/session-context';

const mockPresses = new Map<string, () => void>();
jest.mock('react-native', () => {
  const React = require('react'), native = jest.requireActual('react-native');
  return Object.create(Object.getPrototypeOf(native), { ...Object.getOwnPropertyDescriptors(native), Pressable: {
    configurable: true, enumerable: true, value: React.forwardRef((props: any, ref: any) => {
      if (props.accessibilityLabel) mockPresses.set(props.accessibilityLabel, props.onPress);
      return React.createElement(native.Pressable, { ...props, ref });
    }),
  } });
});
const mockAppState = { currentState: 'active', addEventListener: jest.fn((..._args: unknown[]) => ({ remove: jest.fn() })) };
jest.mock('react-native/Libraries/AppState/AppState', () => ({ __esModule: true, default: {
  get currentState() { return mockAppState.currentState; }, addEventListener: (...args: any[]) => mockAppState.addEventListener(...args),
} }));
jest.mock('../components/Icon', () => ({ Icon: () => null }));
const value = (usedTokens = 40000, windowTokens: number | undefined = 200000): SessionContext => ({
  sessionKey: 'codex:s', revision: 'r1', canCompact: true,
  snapshot: { usedTokens, windowTokens, source: 'codex_token_usage', basis: 'last_request', measuredAt: 1 },
});
const open = (ui: Awaited<ReturnType<typeof render>>) => fireEvent.press(ui.getByTestId('context-indicator-button'));
beforeEach(() => { mockAppState.currentState = 'active'; mockPresses.clear(); });

test('the ring is quiet until opened and showing usage never refreshes or compacts', async () => {
  const refresh = jest.fn(), compact = jest.fn();
  const ui = await render(<ContextIndicator scopeKey="pc/session" value={value()} canCompact onRefresh={refresh} onCompact={compact} />);
  expect(ui.queryByText('上下文')).toBeNull();
  const trigger = ui.getByTestId('context-indicator-button');
  expect(StyleSheet.flatten(typeof trigger.props.style === 'function' ? trigger.props.style({ pressed: false }) : trigger.props.style)).toEqual(expect.objectContaining({ width: 44, height: 44 }));
  await open(ui);
  expect(ui.getByText('20%')).toBeTruthy(); expect(ui.getByText('40,000 / 200,000 tokens')).toBeTruthy();
  expect(refresh).not.toHaveBeenCalled(); expect(compact).not.toHaveBeenCalled();
  await fireEvent.press(ui.getByLabelText('刷新上下文')); expect(refresh).toHaveBeenCalledTimes(1);
  await fireEvent.press(ui.getByTestId('context-usage-popover-backdrop'));
  expect(ui.queryByText('20%')).toBeNull(); expect(compact).not.toHaveBeenCalled();
});

test('missing measurements and unknown capacity never render zero percent or a progress arc', async () => {
  const ui = await render(<ContextIndicator scopeKey="pc/session" unavailableReason="开始对话后显示上下文用量" />);
  expect(ui.queryByTestId('context-usage-arc')).toBeNull();
  await open(ui); expect(ui.getByText('—')).toBeTruthy(); expect(ui.getByText('开始对话后显示上下文用量')).toBeTruthy();
  const unbounded = value(); delete unbounded.snapshot!.windowTokens;
  await ui.rerender(<ContextIndicator scopeKey="pc/session" value={unbounded} />);
  expect(ui.queryByTestId('context-usage-arc')).toBeNull(); expect(ui.queryByText('0%')).toBeNull();
  expect(ui.getByText('40,000 tokens')).toBeTruthy(); expect(ui.getByText('窗口大小未知')).toBeTruthy();
});

test('a measured zero is distinct from unknown and over-capacity counts stay truthful with a bounded arc', async () => {
  const ui = await render(<ContextIndicator scopeKey="pc/session" value={value(0)} />);
  await open(ui); expect(ui.getByText('0%')).toBeTruthy(); expect(ui.getByText('0 / 200,000 tokens')).toBeTruthy();
  await ui.rerender(<ContextIndicator scopeKey="pc/session" value={value(250000)} />);
  expect(ui.getByText('125%')).toBeTruthy(); expect(ui.getByText('250,000 / 200,000 tokens')).toBeTruthy();
  // Native SVG represents a zero dash offset as null (the platform default).
  expect(ui.getByTestId('context-usage-arc').props.strokeDashoffset ?? 0).toBe(0);
});

test('estimated readings identify their estimate without inventing extra precision', async () => {
  const estimated = value(155555); estimated.snapshot!.estimated = true;
  const ui = await render(<ContextIndicator scopeKey="pc/session" value={estimated} />);
  expect(ui.getByLabelText('上下文状态，约 78% 已用')).toBeTruthy(); await open(ui);
  expect(ui.getByText('≈ 78%')).toBeTruthy();
});

test('closing, changing scope and entering the background invalidate retained action presses', async () => {
  const refresh = jest.fn(), compact = jest.fn();
  const props = { scopeKey: 'pc/a', value: value(), canCompact: true, onRefresh: refresh, onCompact: compact };
  const ui = await render(<ContextIndicator {...props} />); await open(ui);
  const oldCompact = mockPresses.get('压缩上下文')!, oldRefresh = mockPresses.get('刷新上下文')!;
  await fireEvent.press(ui.getByTestId('context-usage-popover-backdrop'));
  await act(async () => { oldCompact(); oldRefresh(); });
  expect(compact).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled();
  await open(ui); const previousScopePress = mockPresses.get('压缩上下文')!, previousScopeRead = mockPresses.get('刷新上下文')!;
  await ui.rerender(<ContextIndicator {...props} scopeKey="pc/b" />);
  expect(ui.queryByTestId('context-usage-popover')).toBeNull();
  await act(async () => { previousScopePress(); previousScopeRead(); }); expect(compact).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled();
  await ui.rerender(<ContextIndicator {...props} />); await open(ui);
  const backgroundPress = mockPresses.get('压缩上下文')!;
  mockAppState.currentState = 'background'; await act(async () => backgroundPress()); expect(compact).not.toHaveBeenCalled();
});

test('an inactive composer hides its portal and cannot reopen or replay a prior menu', async () => {
  const refresh = jest.fn(), nextRefresh = jest.fn();
  const ui = await render(<ContextIndicator scopeKey="pc/a" value={value()} onRefresh={refresh} />); await open(ui);
  const oldRefresh = mockPresses.get('刷新上下文')!;
  await ui.rerender(<ContextIndicator scopeKey="pc/a" value={value()} active={false} onRefresh={nextRefresh} />);
  expect(ui.queryByTestId('context-usage-popover')).toBeNull();
  await open(ui); expect(ui.queryByTestId('context-usage-popover')).toBeNull();
  await act(async () => oldRefresh()); expect(refresh).not.toHaveBeenCalled(); expect(nextRefresh).not.toHaveBeenCalled();
  await ui.rerender(<ContextIndicator scopeKey="pc/a" value={value()} active onRefresh={nextRefresh} />);
  expect(ui.queryByTestId('context-usage-popover')).toBeNull();
  await act(async () => oldRefresh()); expect(nextRefresh).not.toHaveBeenCalled();
});

test('a retained enabled action cannot bypass updated busy state', async () => {
  const compact = jest.fn(), refresh = jest.fn();
  const props = { scopeKey: 'pc/a', value: value(), canCompact: true, onCompact: compact, onRefresh: refresh };
  const ui = await render(<ContextIndicator {...props} />); await open(ui);
  const oldCompact = mockPresses.get('压缩上下文')!, oldRefresh = mockPresses.get('刷新上下文')!;
  await ui.rerender(<ContextIndicator {...props} compactDisabled refreshDisabled loading />);
  await act(async () => { oldCompact(); oldRefresh(); }); expect(compact).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled();
});
