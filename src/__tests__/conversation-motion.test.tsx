import React from 'react';
import { Animated, Text } from 'react-native';
import { act, render } from '@testing-library/react-native';
import { WorkbenchReveal } from '../remote/ConversationMotion';

let mockReduced = false;
jest.mock('../components/MotionPressable', () => ({ useReducedMotion: () => mockReduced }));
let callbacks: Array<((result: { finished: boolean }) => void) | undefined>;
let stop: jest.Mock, timing: jest.SpyInstance;
beforeEach(() => {
  mockReduced = false;callbacks = [];stop = jest.fn();
  timing = jest.spyOn(Animated, 'timing').mockImplementation(() => ({
    start: callback => { callbacks.push(callback); }, stop, reset: jest.fn(),
  }));
});
afterEach(() => jest.restoreAllMocks());

test('live content changes do not replay the entrance while explicit mode changes do', async () => {
  const view = await render(<WorkbenchReveal transitionKey="preview"><Text>first chunk</Text></WorkbenchReveal>);
  expect(timing).toHaveBeenCalledTimes(1);
  expect(timing).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ duration: 150, useNativeDriver: true, isInteraction: false }));
  await view.rerender(<WorkbenchReveal transitionKey="preview"><Text>second chunk</Text></WorkbenchReveal>);
  expect(timing).toHaveBeenCalledTimes(1);
  await view.rerender(<WorkbenchReveal transitionKey="edit"><Text>editing</Text></WorkbenchReveal>);
  expect(timing).toHaveBeenCalledTimes(2);expect(stop).toHaveBeenCalled();
});

test('collapsing disables interaction and accessibility immediately, then removes the local content', async () => {
  const view = await render(<WorkbenchReveal testID="reveal"><Text>details</Text></WorkbenchReveal>);
  await view.rerender(<WorkbenchReveal testID="reveal" visible={false}><Text>details</Text></WorkbenchReveal>);
  expect(timing).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ duration: 100, toValue: 0 }));
  const hidden = view.getByTestId('reveal', { includeHiddenElements: true });
  expect(hidden.props.pointerEvents).toBe('none');expect(hidden.props.importantForAccessibility).toBe('no-hide-descendants');
  expect(view.queryByText('details')).toBeNull();
  await act(async () => { callbacks[1]?.({ finished: true }); });
  expect(view.queryByTestId('reveal', { includeHiddenElements: true })).toBeNull();
});

test('a late closing animation cannot hide content reopened by a newer interaction', async () => {
  const view = await render(<WorkbenchReveal testID="reveal"><Text>details</Text></WorkbenchReveal>);
  await view.rerender(<WorkbenchReveal testID="reveal" visible={false}><Text>details</Text></WorkbenchReveal>);
  const closing = callbacks[1];
  await view.rerender(<WorkbenchReveal testID="reveal"><Text>details</Text></WorkbenchReveal>);
  await act(async () => { closing?.({ finished: true }); });
  expect(view.getByText('details')).toBeTruthy();expect(view.getByTestId('reveal').props.pointerEvents).toBe('auto');
});

test('reduced motion switches immediately without scheduling animations', async () => {
  mockReduced = true;
  const view = await render(<WorkbenchReveal testID="reveal"><Text>details</Text></WorkbenchReveal>);
  expect(view.getByText('details')).toBeTruthy();expect(timing).not.toHaveBeenCalled();
  await view.rerender(<WorkbenchReveal testID="reveal" visible={false}><Text>details</Text></WorkbenchReveal>);
  expect(view.queryByTestId('reveal', { includeHiddenElements: true })).toBeNull();expect(timing).not.toHaveBeenCalled();
  await view.rerender(<WorkbenchReveal testID="reveal"><Text>details</Text></WorkbenchReveal>);
  expect(view.getByText('details')).toBeTruthy();expect(timing).not.toHaveBeenCalled();
});
