import React, { useState } from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { Animated, Easing, StyleSheet, TextInput, View } from 'react-native';
import { QuestionDock } from '../remote/QuestionDock';
import { captureDissolveTexture, ComposerDissolve, COMPOSER_DISSOLVE_MS, DISSOLVE_FRAGMENTS, DISSOLVE_TILES } from '../remote/ComposerDissolve';

let mockReducedMotion = false;
const mockCapture = jest.fn(async (_ref: unknown, _options: unknown): Promise<string> => 'synthetic-memory-texture');
jest.mock('react-native-view-shot', () => ({ captureRef: (...args: [unknown, unknown]) => mockCapture(...args) }));
jest.mock('../components/ui', () => {
  const React = require('react'); const { Pressable, Text } = require('react-native');
  return {
    useReducedMotion: () => mockReducedMotion,
    PrimaryButton: ({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) =>
      React.createElement(Pressable, { accessibilityRole: 'button', accessibilityLabel: label, accessibilityState: { disabled }, disabled, onPress }, React.createElement(Text, null, label)),
  };
});
const first = { id: 'first', title: '需要选择', questions: [{ id: 'q', question: '选方案', required: true, options: [{ label: 'A' }, { label: 'B' }] }] };
const second = { id: 'second', title: '另一个问题', questions: [{ id: 'q', question: '填名称', required: true }] };
type Request = React.ComponentProps<typeof QuestionDock>['question'];
function Host({ question, busy = false }: { question: Request; busy?: boolean }) {
  const [draft, setDraft] = useState('未发送的草稿');
  return <QuestionDock question={question} busy={busy} onAnswer={jest.fn()} onCancel={jest.fn()}>
    <TextInput accessibilityLabel="原输入框" value={draft} onChangeText={setDraft} />
  </QuestionDock>;
}
beforeEach(() => {
  jest.useFakeTimers(); mockReducedMotion = false;
  mockCapture.mockReset().mockResolvedValue('synthetic-memory-texture');
  const timing: typeof Animated.timing = (value, config) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => { if (timer !== undefined) clearTimeout(timer); };
    return {
      start: (callback) => { timer = setTimeout(() => {
        if (value instanceof Animated.Value && typeof config.toValue === 'number') value.setValue(config.toValue);
        callback?.({ finished: true });
      }, config.duration ?? 0); },
      stop, reset: stop,
    };
  };
  jest.spyOn(Animated, 'timing').mockImplementation(timing);
});
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });
const advance = async (ms: number) => { await act(async () => { jest.advanceTimersByTime(ms); }); };

test('the composer disintegrates in place before the separate question window appears', async () => {
  const view = await render(<Host question={null} />);
  await fireEvent.changeText(view.getByLabelText('原输入框'), '保留这个任务');
  await view.rerender(<Host question={first} />);
  const surface = view.getByTestId('remote-composer-surface', { includeHiddenElements: true });
  expect(surface.props.pointerEvents).toBe('none');
  expect(surface.props.importantForAccessibility).toBe('no-hide-descendants');
  expect(view.getByTestId('remote-question-dialog').props.role).toBe('dialog');
  expect(StyleSheet.flatten(surface.props.style).transform).toBeUndefined();
  expect(StyleSheet.flatten(surface.props.style).width).toBeUndefined();
  expect(view.getByTestId('remote-composer-dissolve', { includeHiddenElements: true })).toBeTruthy();
  expect(Animated.timing).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ toValue: 0, duration: COMPOSER_DISSOLVE_MS, useNativeDriver: true }));
  await advance(COMPOSER_DISSOLVE_MS);
  expect(view.queryByTestId('remote-composer-surface')).toBeNull();
  expect(Animated.timing).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ toValue: 1, duration: 160, useNativeDriver: true }));
  await advance(160);
  await view.rerender(<Host question={null} />);
  expect(view.getByLabelText('提交回答').props.accessibilityState.disabled).toBe(true);
  expect(view.getByTestId('remote-question-dissolve', { includeHiddenElements: true })).toBeTruthy();
  expect(view.queryByTestId('remote-composer-surface')).toBeNull();
  await advance(COMPOSER_DISSOLVE_MS);
  expect(view.queryByTestId('remote-question-dialog')).toBeNull();
  expect(view.getByLabelText('原输入框', { includeHiddenElements: true }).props.value).toBe('保留这个任务');
  expect(view.getByTestId('remote-composer-surface', { includeHiddenElements: true }).props.pointerEvents).toBe('none');
  const reverse = jest.mocked(Animated.timing).mock.calls.find(([_, config]) => config.toValue === 1 && config.duration === COMPOSER_DISSOLVE_MS);
  expect(reverse?.[1].easing?.(0.25)).toBeCloseTo(Easing.bezier(0.4, 0, 0.2, 1)(0.25));
  await advance(COMPOSER_DISSOLVE_MS);
  expect(view.getByTestId('remote-composer-surface').props.pointerEvents).toBe('auto');
  expect(view.queryByTestId('remote-composer-dissolve', { includeHiddenElements: true })).toBeNull();
});

test('queued questions replace only the popup without flashing the composer or keeping old answers', async () => {
  const view = await render(<Host question={first} />);
  await advance(COMPOSER_DISSOLVE_MS); await advance(160);
  await fireEvent.press(view.getByRole('radio', { name: 'A' }));
  await view.rerender(<Host question={second} />);
  expect(view.queryByTestId('remote-composer-surface')).toBeNull();
  expect(view.queryByRole('radio', { name: 'A' })).toBeNull();
  expect(view.getByLabelText('填名称：回答').props.value).toBe('');
  await advance(500);
  expect(view.queryByTestId('remote-composer-surface')).toBeNull();
  expect(view.getAllByTestId('remote-question-dialog')).toHaveLength(1);
});

test('a new question arriving during exit cancels the stale restoration animation', async () => {
  const view = await render(<Host question={first} />);
  await advance(COMPOSER_DISSOLVE_MS); await advance(160);
  await view.rerender(<Host question={null} />);
  await advance(50);
  await view.rerender(<Host question={second} />);
  await advance(500);
  expect(view.queryByTestId('remote-composer-surface')).toBeNull();
  expect(view.getByLabelText('填名称：回答')).toBeTruthy();
  expect(view.queryByRole('radio', { name: 'A' })).toBeNull();
});

test('resolution during entry cannot leave a hidden composer or a stale question window', async () => {
  const view = await render(<Host question={null} />);
  await view.rerender(<Host question={first} />);
  await advance(40);
  await view.rerender(<Host question={null} />);
  await advance(COMPOSER_DISSOLVE_MS);
  expect(view.queryByTestId('remote-question-dialog')).toBeNull();
  expect(view.getByTestId('remote-composer-surface').props.pointerEvents).toBe('auto');
  expect(view.getByLabelText('原输入框').props.value).toBe('未发送的草稿');
});

test('reduced motion replaces the input surface immediately and still preserves its draft', async () => {
  mockReducedMotion = true;
  const view = await render(<Host question={null} />);
  await fireEvent.changeText(view.getByLabelText('原输入框'), '不用动画的草稿');
  await view.rerender(<Host question={first} />);
  expect(view.queryByTestId('remote-composer-surface')).toBeNull();
  expect(view.getByTestId('remote-question-dialog')).toBeTruthy();
  await view.rerender(<Host question={null} />);
  expect(view.getByLabelText('原输入框').props.value).toBe('不用动画的草稿');
  expect(Animated.timing).not.toHaveBeenCalled();
});

test('status or expiry updates to the same request preserve the answer and use measured popup height', async () => {
  const view = await render(<Host question={first} />);
  await advance(COMPOSER_DISSOLVE_MS); await advance(160);
  await fireEvent.press(view.getByRole('radio', { name: 'B' }));
  await fireEvent(view.getByTestId('remote-question-dialog'), 'layout', { nativeEvent: { layout: { height: 220 } } });
  expect(Animated.timing).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ toValue: 236, useNativeDriver: false }));
  await view.rerender(<Host question={{ ...first, expiresAt: Date.now() + 30_000 }} busy />);
  expect(view.getByRole('radio', { name: 'B' }).props.accessibilityState.checked).toBe(true);
  expect(view.getByLabelText('提交回答').props.accessibilityState.disabled).toBe(true);
  expect(view.queryByTestId('remote-composer-surface')).toBeNull();
  await view.rerender(<Host question={first} />);
  expect(view.getByRole('radio', { name: 'B' }).props.accessibilityState.checked).toBe(true);
});

test('a small keyboard-reduced input area shrinks the body without resetting the selected answer', async () => {
  mockReducedMotion = true;
  const dock = (availableHeight: number) => <QuestionDock question={first} busy={false} availableHeight={availableHeight} onAnswer={jest.fn()} onCancel={jest.fn()}><TextInput /></QuestionDock>;
  const view = await render(dock(700));
  await fireEvent.press(view.getByRole('radio', { name: 'B' }));
  await view.rerender(dock(250));
  expect(view.getByTestId('remote-question-body').props.style.maxHeight).toBeLessThanOrEqual(60);
  expect(view.getByRole('radio', { name: 'B' }).props.accessibilityState.checked).toBe(true);
  expect(view.getAllByTestId('remote-question-dialog')).toHaveLength(1);
});

test('the actual surface breaks into tiles from the right, drifting up-left as fine muted dust', async () => {
  const view = await render(<ComposerDissolve progress={new Animated.Value(0.55)} texture={{ uri: 'data:image/png;base64,fixture', width: 280, height: 100 }} />);
  const style = (id: string) => StyleSheet.flatten(view.getByTestId(id, { includeHiddenElements: true }).props.style);
  // Left column still intact, right column already gone.
  expect(style('remote-composer-sample-0').opacity).toBe(1);
  expect(style('remote-composer-sample-0').transform[0].translateX).toBe(0);
  expect(style('remote-composer-sample-11').opacity).toBe(0);
  expect(style('remote-composer-sample-11').transform[0].translateX).toBeLessThan(0);
  expect(DISSOLVE_TILES.every((tile) => tile.dx < 0 && tile.dx >= -38 && tile.start + tile.span <= 1)).toBe(true);
  expect(DISSOLVE_FRAGMENTS).toHaveLength(36);
  expect(DISSOLVE_FRAGMENTS.every((particle) => particle.size <= 2.6 && particle.distance <= 42 && particle.peak <= 0.7)).toBe(true);
  const dust = style('remote-composer-particle-0');
  expect(dust.borderRadius).toBe(dust.width / 2);
});

test('the dissolve is silent, inert and removed after restoration, including reduced motion', async () => {
  mockReducedMotion = true;
  const view = await render(<Host question={first} />);
  expect(view.queryByTestId('remote-composer-dissolve', { includeHiddenElements: true })).toBeNull();
  await view.rerender(<Host question={null} />);
  expect(view.queryByTestId('remote-composer-dissolve', { includeHiddenElements: true })).toBeNull();
  expect(view.getByLabelText('原输入框').props.value).toBe('未发送的草稿');
  expect(mockCapture).not.toHaveBeenCalled();
});

test('native texture is base64 memory only and exactly the measured local surface', async () => {
  const ref = { current: {} as View };
  const texture = await captureDissolveTexture(ref, { width: 280, height: 120 });
  expect(mockCapture).toHaveBeenCalledWith(ref, { format: 'png', result: 'base64', width: 280, height: 120 });
  expect(texture).toEqual({ uri: 'data:image/png;base64,synthetic-memory-texture', width: 280, height: 120 });
  expect(jest.getTimerCount()).toBe(0);
});

test('a slow or unavailable native texture never holds the input transition indefinitely', async () => {
  mockCapture.mockImplementationOnce(() => new Promise<string>(() => undefined));
  const pendingTexture = captureDissolveTexture({ current: {} as View }, { width: 280, height: 120 });
  await advance(100); expect(await pendingTexture).toBeUndefined();
  mockCapture.mockRejectedValueOnce(new Error('capture unavailable'));
  expect(await captureDissolveTexture({ current: {} as View }, { width: 280, height: 120 })).toBeUndefined();
  expect(await captureDissolveTexture({ current: null }, { width: 0, height: 0 })).toBeUndefined();
});
