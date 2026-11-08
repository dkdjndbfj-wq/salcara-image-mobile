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
  await fireEvent.press(presentation === 'page' ? view.getByRole('button', { name: '返回' }) : view.getByTestId('sheet-backdrop'));
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
  await fireEvent.press(presentation === 'page' ? view.getByRole('button', { name: '返回' }) : view.getByTestId('sheet-backdrop'));
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

test.each(['page', 'sheet'] as const)('%s routes system back separately from its close button and gesture', async presentation => {
  const close = jest.fn(), systemBack = jest.fn();
  const view = await render(<Sheet visible title="对话" presentation={presentation} onClose={close} onSystemBack={systemBack}><Text>当前会话</Text></Sheet>);
  await perform(() => view.root?.props.onRequestClose());
  expect(systemBack).toHaveBeenCalledTimes(1);
  expect(close).not.toHaveBeenCalled();
  await fireEvent.press(presentation === 'page' ? view.getByRole('button', { name: '返回' }) : view.getByTestId('sheet-backdrop'));
  const callbacks = mockPans[presentation === 'page' ? 1 : 0];
  const move = presentation === 'page' ? gesture({ dx: 160, vx: 1 }) : gesture({ dy: 160, vy: 1 });
  await perform(() => callbacks.onPanResponderRelease?.(event(move.dx), move));
  expect(close).toHaveBeenCalledTimes(2);
  expect(systemBack).toHaveBeenCalledTimes(1);
});

test.each(['page', 'sheet'] as const)('locked %s blocks both custom system back and close actions', async presentation => {
  const close = jest.fn(), systemBack = jest.fn();
  const view = await render(<Sheet visible title="正在切换 API" presentation={presentation} dismissible={false} onClose={close} onSystemBack={systemBack}><Text>等待结果</Text></Sheet>);
  await perform(() => view.root?.props.onRequestClose());
  await fireEvent.press(presentation === 'page' ? view.getByRole('button', { name: '返回' }) : view.getByTestId('sheet-backdrop'));
  const callbacks = mockPans[presentation === 'page' ? 1 : 0];
  const move = presentation === 'page' ? gesture({ dx: 160, vx: 1 }) : gesture({ dy: 160, vy: 1 });
  await perform(() => callbacks.onPanResponderRelease?.(event(move.dx), move));
  expect(close).not.toHaveBeenCalled();
  expect(systemBack).not.toHaveBeenCalled();
});

test.each(['page', 'sheet'] as const)('%s resets drag when a nested close is consumed and the sheet stays open', async presentation => {
  const systemBack = jest.fn(), close = jest.fn();
  function NestedPage() {
    const [toolOpen, setToolOpen] = React.useState(true);
    return <Sheet visible title="工作区" presentation={presentation} onSystemBack={systemBack} onClose={() => { close(); setToolOpen(false); }}>
      <Text>{toolOpen ? '正在查看文件' : '仍在当前对话'}</Text>
    </Sheet>;
  }
  const view = await render(<NestedPage />);
  const callbacks = mockPans[presentation === 'page' ? 1 : 0];
  const move = presentation === 'page' ? gesture({ dx: 180, vx: 1 }) : gesture({ dy: 180, vy: 1 });
  await perform(() => callbacks.onPanResponderMove?.(event(move.dx), move));
  const valueSpy = jest.mocked(Animated.Value.prototype.setValue);
  expect(valueSpy).toHaveBeenLastCalledWith(180);
  const draggedValue = valueSpy.mock.contexts[valueSpy.mock.contexts.length - 1];
  jest.mocked(Animated.spring).mockClear(); valueSpy.mockClear();
  await perform(() => callbacks.onPanResponderRelease?.(event(move.dx), move));
  expect(close).toHaveBeenCalledTimes(1);
  expect(systemBack).not.toHaveBeenCalled();
  expect(view.getByText('仍在当前对话')).toBeTruthy();
  expect(view.root?.props.visible).toBe(true);
  expect(Animated.spring).toHaveBeenCalledWith(draggedValue, expect.objectContaining({ toValue: 0, useNativeDriver: true }));
  expect(valueSpy).toHaveBeenLastCalledWith(0);
  expect(valueSpy.mock.contexts[valueSpy.mock.contexts.length - 1]).toBe(draggedValue);
});
