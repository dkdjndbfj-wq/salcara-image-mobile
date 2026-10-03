import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { Animated, Text } from 'react-native';
import { ProgrammingPanel } from '../remote/ProgrammingUi';

const mockDismiss = jest.fn();
jest.mock('../components/Icon', () => ({ Icon: () => null }));
jest.mock('../components/ui', () => ({ useReducedMotion: () => true, dismissKeyboardAndBlur: () => mockDismiss() }));

beforeEach(() => {
  jest.clearAllMocks();
  // Use the real native panel, with deterministic completion of the zero-time
  // reduced-motion animation. Navigation suites use a separate visibility host.
  jest.spyOn(Animated, 'timing').mockImplementation((value, config) => ({
    start: callback => {
      if (value instanceof Animated.Value && typeof config.toValue === 'number') value.setValue(config.toValue);
      callback?.({ finished: true });
    },
    stop: () => undefined, reset: () => undefined,
  }));
});
afterEach(() => jest.restoreAllMocks());

test('the real native panel mounts no initially hidden content and removes it after closing', async () => {
  const props = { title: '测试选择器', onClose: jest.fn() };
  const view = await render(<ProgrammingPanel {...props} visible={false}><Text>仅显示时可见</Text></ProgrammingPanel>);
  expect(view.queryByText('仅显示时可见')).toBeNull();
  await view.rerender(<ProgrammingPanel {...props} visible><Text>仅显示时可见</Text></ProgrammingPanel>);
  expect(view.getByText('仅显示时可见')).toBeTruthy();
  await view.rerender(<ProgrammingPanel {...props} visible={false}><Text>仅显示时可见</Text></ProgrammingPanel>);
  expect(view.queryByText('仅显示时可见')).toBeNull();
});

test('a locked real native panel hides close affordance and ignores Android back until unlocked', async () => {
  const close = jest.fn();
  const props = { visible: true, title: '测试选择器', onClose: close };
  const view = await render(<ProgrammingPanel {...props} dismissible={false}><Text>保存中</Text></ProgrammingPanel>);
  expect(view.queryByRole('button', { name: '关闭' })).toBeNull();
  const requestClose = view.root?.props.onRequestClose;
  expect(typeof requestClose).toBe('function');
  await act(async () => requestClose());
  expect(close).not.toHaveBeenCalled();
  expect(mockDismiss).not.toHaveBeenCalled();
  await view.rerender(<ProgrammingPanel {...props}><Text>已可关闭</Text></ProgrammingPanel>);
  await fireEvent.press(view.getByRole('button', { name: '关闭' }));
  expect(close).toHaveBeenCalledTimes(1);
  expect(mockDismiss).toHaveBeenCalledTimes(1);
});
