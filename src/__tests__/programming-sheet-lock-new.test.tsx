import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { Animated, PanResponder, Text, type GestureResponderEvent, type PanResponderGestureState } from 'react-native';
import { Sheet } from '../components/ui';

jest.mock('../components/Icon', () => ({ Icon: () => null }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('../components/MotionPressable', () => {
  const React = require('react'); const { Pressable, View } = require('react-native');
  return {
    useReducedMotion: () => true,
    MotionPressable: ({ children, wrapperStyle: _wrapperStyle, scaleTo: _scaleTo, ...props }: Record<string, unknown>) => React.createElement(Pressable, props, children),
    Appear: ({ children }: Record<string, unknown>) => React.createElement(View, null, children),
  };
});

type PanConfig = Parameters<typeof PanResponder.create>[0];
let mockPans: PanConfig[];
function event(dx = 0): GestureResponderEvent {
  return { nativeEvent: { pageX: 20 + dx } } as GestureResponderEvent;
}
function gesture(overrides: Partial<PanResponderGestureState> = {}): PanResponderGestureState {
  return { stateID: 1, moveX: 0, moveY: 0, x0: 0, y0: 0, dx: 0, dy: 0, vx: 0, vy: 0, numberActiveTouches: 1, _accountsForMovesUpTo: 0, ...overrides };
}
const perform = async (callback: () => unknown) => { await act(async () => { callback(); }); };

beforeEach(() => {
  mockPans = [];
  jest.spyOn(PanResponder, 'create').mockImplementation(config => { mockPans.push(config); return { panHandlers: {} }; });
  jest.spyOn(Animated.Value.prototype, 'setValue');
  jest.spyOn(Animated, 'spring').mockImplementation((value, config) => ({
    start: callback => { if (value instanceof Animated.Value && typeof config.toValue === 'number') value.setValue(config.toValue); callback?.({ finished: true }); },
    stop: () => undefined, reset: () => undefined,
  }));
});
afterEach(() => jest.restoreAllMocks());

test.each(['page', 'sheet'] as const)('locked %s declines both dismissal gestures and hardware/back closure', async presentation => {
  const close = jest.fn();
  const view = await render(<Sheet visible title="连接电脑" presentation={presentation} dismissible={false} onClose={close}><Text>正在连接</Text></Sheet>);
  const bottom = mockPans[0]; const page = mockPans[1];
  expect(bottom.onMoveShouldSetPanResponder?.(event(), gesture({ dy: 80 }))).toBe(false);
  expect(page.onMoveShouldSetPanResponder?.(event(160), gesture({ dx: 160 }))).toBe(false);
  await perform(() => view.root?.props.onRequestClose());
  await fireEvent.press(view.getByRole('button', { name: presentation === 'page' ? '返回' : '关闭' }));
  expect(close).not.toHaveBeenCalled();
});

test.each(['page', 'sheet'] as const)('active %s gesture returns to zero if it becomes locked before release', async presentation => {
  const close = jest.fn();
  const view = await render(<Sheet visible title="保存 API" presentation={presentation} onClose={close}><Text>保存前</Text></Sheet>);
  // These are the callbacks retained by the original useRef, not the unused objects constructed on rerender.
  const callbacks = mockPans[presentation === 'page' ? 1 : 0];
  const move = presentation === 'page' ? gesture({ dx: 180, vx: 1 }) : gesture({ dy: 180, vy: 1 });
  expect(callbacks.onMoveShouldSetPanResponder?.(event(move.dx), move)).toBe(true);
  await perform(() => callbacks.onPanResponderMove?.(event(move.dx), move));
  expect(Animated.Value.prototype.setValue).toHaveBeenCalledWith(180);
  await view.rerender(<Sheet visible title="保存 API" presentation={presentation} dismissible={false} onClose={close}><Text>正在保存</Text></Sheet>);
  jest.mocked(Animated.spring).mockClear(); jest.mocked(Animated.Value.prototype.setValue).mockClear();
  await perform(() => callbacks.onPanResponderRelease?.(event(move.dx), move));
  expect(close).not.toHaveBeenCalled();
  expect(Animated.spring).toHaveBeenCalledWith(expect.any(Animated.Value), expect.objectContaining({ toValue: 0, useNativeDriver: true }));
  expect(Animated.Value.prototype.setValue).toHaveBeenLastCalledWith(0);
});

test.each(['page', 'sheet'] as const)('default %s remains dismissible without the new optional prop', async presentation => {
  const close = jest.fn();
  const view = await render(<Sheet visible title="测试页" presentation={presentation} onClose={close}><Text>内容</Text></Sheet>);
  const callbacks = mockPans[presentation === 'page' ? 1 : 0];
  const move = presentation === 'page' ? gesture({ dx: 160, vx: 1 }) : gesture({ dy: 160, vy: 1 });
  expect(callbacks.onMoveShouldSetPanResponder?.(event(move.dx), move)).toBe(true);
  await perform(() => callbacks.onPanResponderRelease?.(event(move.dx), move));
  await perform(() => view.root?.props.onRequestClose());
  await fireEvent.press(view.getByRole('button', { name: presentation === 'page' ? '返回' : '关闭' }));
  expect(close).toHaveBeenCalledTimes(3);
});

test('unlocking an already mounted page re-enables its original gesture callbacks', async () => {
  const close = jest.fn();
  const view = await render(<Sheet visible title="等待保存" presentation="page" dismissible={false} onClose={close}><Text>忙碌</Text></Sheet>);
  const callbacks = mockPans[1]; const move = gesture({ dx: 160 });
  expect(callbacks.onMoveShouldSetPanResponder?.(event(160), move)).toBe(false);
  await view.rerender(<Sheet visible title="等待保存" presentation="page" onClose={close}><Text>已完成</Text></Sheet>);
  expect(callbacks.onMoveShouldSetPanResponder?.(event(160), move)).toBe(true);
  await perform(() => callbacks.onPanResponderRelease?.(event(160), move));
  expect(close).toHaveBeenCalledTimes(1);
});
