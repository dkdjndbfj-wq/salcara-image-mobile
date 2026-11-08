import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { AppState } from 'react-native';
import { MainEffortControl, type MainEffortControlProps } from '../remote/MainComposer';
import { hapticEffort } from '../remote/haptics';
import { ComposerOptionMenu } from '../remote/ComposerPopover';

jest.mock('../components/Icon', () => ({ Icon: () => null }));
jest.mock('../components/ui', () => ({ useReducedMotion: () => true }));
jest.mock('../remote/haptics', () => ({ hapticEffort: jest.fn(), hapticModelTick: jest.fn(), hapticModelCommit: jest.fn() }));
jest.mock('@react-native-community/slider', () => {
  const React = require('react'), { View } = require('react-native');
  return { __esModule: true, default: (props: Record<string, unknown>) => React.createElement(View, props) };
});

let listeners: Set<(next: string) => void>;
beforeEach(() => {
  jest.useFakeTimers(); jest.clearAllMocks(); AppState.currentState = 'active'; listeners = new Set();
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, callback) => {
    const change = callback as (next: string) => void; listeners.add(change); return { remove: () => listeners.delete(change) };
  });
});
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

async function mount(extra: Partial<MainEffortControlProps> = {}) {
  const props: MainEffortControlProps = { levels: ['', 'low', 'medium', 'high'], value: 'low', scopeKey: 'pc-a|api-a|model-a', onSelect: jest.fn(), ...extra };
  return { props, view: await render(<MainEffortControl {...props} />) };
}

test('tap opens only effort controls without silently selecting another level', async () => {
  const { props, view } = await mount();
  await fireEvent.press(view.getByTestId('remote-effort-chip'));
  expect(view.getByTestId('main-effort-preview').props.children).toBe('Low');
  expect(view.queryByText('模型')).toBeNull();
  expect(view.getByTestId('main-effort-slider').props.maximumValue).toBe(3);
  expect(view.queryByText('Ultra')).toBeNull();
  expect(props.onSelect).not.toHaveBeenCalled();
  await fireEvent(view.getByTestId('main-effort-slider'), 'valueChange', 3);
  expect(view.getByTestId('main-effort-preview').props.children).toBe('High');
  expect(props.onSelect).not.toHaveBeenCalled();
  await fireEvent(view.getByTestId('main-effort-slider'), 'slidingComplete', 3);
  expect(props.onSelect).not.toHaveBeenCalled();
  expect(view.getByTestId('main-effort-popover')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('关闭推理强度选择'));
  expect(props.onSelect).toHaveBeenCalledTimes(1);
  expect(props.onSelect).toHaveBeenCalledWith('high');
  expect(hapticEffort).toHaveBeenCalledWith('high');
  expect(view.queryByTestId('main-effort-popover')).toBeNull();
});

test('default is selected on the slider and the panel has no reset, model or API entry', async () => {
  const { props, view } = await mount();
  await fireEvent.press(view.getByTestId('remote-effort-chip'));
  expect(view.queryByText('重置')).toBeNull();
  await fireEvent(view.getByTestId('main-effort-slider'), 'slidingComplete', 0);
  expect(props.onSelect).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('关闭推理强度选择'));
  expect(props.onSelect).toHaveBeenCalledWith('');
  await fireEvent.press(view.getByTestId('remote-effort-chip'));
  expect(view.queryByLabelText('更换推理模型')).toBeNull();
  expect(view.queryByText('API')).toBeNull();
});

test.each(['scopeKey', 'levels', 'value', 'disabled'] as const)('a stale release after %s changes cannot commit into the new owner', async changed => {
  const { props, view } = await mount();
  await fireEvent.press(view.getByTestId('remote-effort-chip'));
  const release = view.getByTestId('main-effort-slider').props.onSlidingComplete;
  const updates = { scopeKey: { scopeKey: 'pc-b|api-b|model-b' }, levels: { levels: ['', 'low', 'high'] as const }, value: { value: 'medium' as const }, disabled: { disabled: true } };
  await view.rerender(<MainEffortControl {...props} {...updates[changed]} />);
  await act(() => release(3));
  expect(props.onSelect).not.toHaveBeenCalled();
  expect(view.queryByTestId('main-effort-popover')).toBeNull();
});

test('a previous popup release cannot close or change a reopened popup with the same scope', async () => {
  const { props, view } = await mount();
  await fireEvent.press(view.getByTestId('remote-effort-chip'));
  const release = view.getByTestId('main-effort-slider').props.onSlidingComplete;
  await fireEvent.press(view.getByLabelText('关闭推理强度选择'));
  await fireEvent.press(view.getByTestId('remote-effort-chip'));
  await act(() => release(3));
  expect(props.onSelect).not.toHaveBeenCalled();
  expect(view.getByTestId('main-effort-popover')).toBeTruthy();
  await fireEvent(view.getByTestId('main-effort-slider'), 'slidingComplete', 2);
  expect(props.onSelect).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('关闭推理强度选择'));
  expect(props.onSelect).toHaveBeenCalledWith('medium');
});

test('previous popup close cannot affect its replacement', async () => {
  const { props, view } = await mount();
  await fireEvent.press(view.getByTestId('remote-effort-chip'));
  // Capture the original composite handler, as RNTL's fireEvent traversal does.
  // Calling fireEvent on a removed host would be ignored before reaching our guard.
  const capturedPress = (label: string) => {
    let fiber = view.getByLabelText(label).unstable_fiber;
    while (fiber) {
      const handler = fiber.memoizedProps?.onPress;
      if (typeof handler === 'function') return handler;
      fiber = fiber.return;
    }
    throw new Error(`Missing press handler: ${label}`);
  };
  const close = capturedPress('关闭推理强度选择');
  await fireEvent.press(view.getByLabelText('关闭推理强度选择'));
  await fireEvent.press(view.getByTestId('remote-effort-chip'));
  await act(() => { close(); });

  expect(view.getByTestId('main-effort-popover')).toBeTruthy();
});

test('backgrounding cancels the popup and cannot replay its release after returning', async () => {
  const { props, view } = await mount();
  await fireEvent.press(view.getByTestId('remote-effort-chip'));
  const release = view.getByTestId('main-effort-slider').props.onSlidingComplete;
  await fireEvent(view.getByTestId('main-effort-slider'), 'slidingComplete', 3);
  await act(() => { AppState.currentState = 'background'; listeners.forEach(change => change('background')); });
  expect(view.queryByTestId('main-effort-popover')).toBeNull();
  await act(() => { AppState.currentState = 'active'; listeners.forEach(change => change('active')); });
  await fireEvent.press(view.getByTestId('remote-effort-chip'));
  await act(() => release(3));
  expect(props.onSelect).not.toHaveBeenCalled();
  expect(view.getByTestId('main-effort-popover')).toBeTruthy();
});

test('an empty catalog or locked composer cannot open, and invalid slider values cannot select', async () => {
  const { props, view } = await mount({ disabled: true });
  await fireEvent.press(view.getByTestId('remote-effort-chip'));
  expect(view.queryByTestId('main-effort-popover')).toBeNull();
  await view.rerender(<MainEffortControl {...props} disabled={false} levels={[]} />);
  await fireEvent.press(view.getByTestId('remote-effort-chip'));
  expect(view.queryByTestId('main-effort-popover')).toBeNull();
  await view.rerender(<MainEffortControl {...props} disabled={false} />);
  await fireEvent.press(view.getByTestId('remote-effort-chip'));
  const slider = view.getByTestId('main-effort-slider');
  for (const invalid of [-1, .5, 4, NaN]) await fireEvent(slider, 'slidingComplete', invalid);
  expect(props.onSelect).not.toHaveBeenCalled();
  await fireEvent(slider, 'slidingComplete', 1);
  await fireEvent.press(view.getByLabelText('关闭推理强度选择'));
  expect(props.onSelect).not.toHaveBeenCalled();
});

test('returning to the original effort before closing leaves the setting unchanged', async () => {
  const { props, view } = await mount();
  await fireEvent.press(view.getByTestId('remote-effort-chip'));
  await fireEvent(view.getByTestId('main-effort-slider'), 'slidingComplete', 3);
  await fireEvent(view.getByTestId('main-effort-slider'), 'slidingComplete', 1);
  await fireEvent.press(view.getByLabelText('关闭推理强度选择'));
  expect(props.onSelect).not.toHaveBeenCalled();
  expect(hapticEffort).not.toHaveBeenCalled();
  expect(view.queryByTestId('main-effort-popover')).toBeNull();
});

test('a popup from a scope left and later returned to still cannot apply stale input', async () => {
  const { props, view } = await mount();
  await fireEvent.press(view.getByTestId('remote-effort-chip'));
  const release = view.getByTestId('main-effort-slider').props.onSlidingComplete;
  await view.rerender(<MainEffortControl {...props} scopeKey="pc-b" />);
  await view.rerender(<MainEffortControl {...props} />);
  await fireEvent.press(view.getByTestId('remote-effort-chip'));
  await act(() => release(3));
  expect(props.onSelect).not.toHaveBeenCalled();
  expect(view.getByTestId('main-effort-popover')).toBeTruthy();
});

test('permission menu has three concise choices, keeps blocked access disabled and applies the exact selected mode', async () => {
  const select = jest.fn();
  const view = await render(<ComposerOptionMenu visible value="ask" onSelect={select} onClose={jest.fn()} options={[
    { value: 'ask', label: '请求批准' }, { value: 'auto_review', label: '帮我批准' }, { value: 'full_access', label: '完全访问权限', danger: true, disabled: true },
  ]} />);
  expect(view.getAllByRole('radio')).toHaveLength(3);
  expect(view.getByRole('radio', { name: '请求批准' }).props.accessibilityState.checked).toBe(true);
  expect(view.queryByText('跟随电脑')).toBeNull();
  expect(view.queryByText('应用到下一条消息')).toBeNull();
  await fireEvent.press(view.getByRole('radio', { name: '完全访问权限' }));
  expect(select).not.toHaveBeenCalled();
  await fireEvent.press(view.getByRole('radio', { name: '帮我批准' }));
  expect(select).toHaveBeenCalledWith('auto_review');
});

test('a permission action cannot replay into another connection or after dismiss/reopen', async () => {
  const select = jest.fn(), close = jest.fn();
  const props = { visible: true, value: 'ask', options: [{ value: 'ask', label: '请求批准' }, { value: 'auto_review', label: '帮我批准' }], onSelect: select, onClose: close, scopeKey: 'pc-a' };
  const view = await render(<ComposerOptionMenu {...props} />);
  let fiber = view.getByRole('radio', { name: '帮我批准' }).unstable_fiber;
  while (fiber && typeof fiber.memoizedProps?.onPress !== 'function') fiber = fiber.return;
  const stale = fiber!.memoizedProps.onPress;
  await view.rerender(<ComposerOptionMenu {...props} scopeKey="pc-b" />);
  await act(() => stale());
  expect(select).not.toHaveBeenCalled();
  await view.rerender(<ComposerOptionMenu {...props} visible={false} />);
  await view.rerender(<ComposerOptionMenu {...props} />);
  await act(() => stale());
  expect(select).not.toHaveBeenCalled();
  await fireEvent.press(view.getByRole('radio', { name: '帮我批准' }));
  expect(select).toHaveBeenCalledWith('auto_review');
});

test('a slash request waits for reported effort levels, then closes on background without replaying', async () => {
  const onClose = jest.fn();
  const { props, view } = await mount({ open: true, levels: [], onClose });
  expect(view.queryByTestId('main-effort-popover')).toBeNull();
  await view.rerender(<MainEffortControl {...props} levels={['', 'low', 'high']} />);
  expect(view.getByTestId('main-effort-popover')).toBeTruthy();
  await act(() => { AppState.currentState = 'background'; listeners.forEach(change => change('background')); });
  expect(onClose).toHaveBeenCalledTimes(1);
  await act(() => { AppState.currentState = 'active'; listeners.forEach(change => change('active')); });
  await view.rerender(<MainEffortControl {...props} levels={['', 'low', 'medium', 'high']} />);
  expect(view.queryByTestId('main-effort-popover')).toBeNull();
  await view.rerender(<MainEffortControl {...props} open={false} levels={['', 'low', 'high']} />);
  await view.rerender(<MainEffortControl {...props} open levels={['', 'low', 'high']} />);
  expect(view.getByTestId('main-effort-popover')).toBeTruthy();
});
