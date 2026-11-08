import React from 'react';
import { Animated, View } from 'react-native';
import { act, render } from '@testing-library/react-native';
import { useSessionMenuMotion } from '../remote/useSessionMenuMotion';

type Flight = { config: Animated.TimingAnimationConfig; finish: (finished?: boolean) => void; stop: jest.Mock };
let flights: Flight[], motion: ReturnType<typeof useSessionMenuMotion>;
function Harness({ visible = true, scope = 'device-a:session-a', reduced = false }: { visible?: boolean; scope?: string; reduced?: boolean }) {
  motion = useSessionMenuMotion(visible, scope, reduced);
  return <View testID="menu-motion" accessibilityState={{ disabled: motion.closing }} style={motion.style}/>;
}
beforeEach(() => {
  flights = [];
  jest.spyOn(Animated, 'timing').mockImplementation((_value, config) => {
    let complete: ((result: { finished: boolean }) => void) | undefined;
    const flight = { config, finish: (finished = true) => complete?.({ finished }), stop: jest.fn() };
    flights.push(flight);
    return { start: callback => { complete = callback; }, stop: flight.stop, reset: jest.fn() } as Animated.CompositeAnimation;
  });
});
afterEach(() => jest.restoreAllMocks());

test('a quick close cancels entry, locks immediately and completes the short exit exactly once', async () => {
  const closed = jest.fn(), view = await render(<Harness/>);
  expect(flights[0].config).toMatchObject({ toValue: 1, duration: 150 });
  await act(async () => { expect(motion.close(closed)).toBe(true); expect(motion.close(closed)).toBe(false); });
  expect(flights[0].stop).toHaveBeenCalled(); expect(motion.closing).toBe(true); expect(closed).not.toHaveBeenCalled();
  expect(flights[1].config).toMatchObject({ toValue: 0, duration: 110 });
  await act(async () => { flights[0].finish(); flights[1].finish(); flights[1].finish(); });
  expect(closed).toHaveBeenCalledTimes(1); expect(motion.closing).toBe(true);
  await view.unmount();
});

test('closing then quickly reopening cancels the obsolete completion and unlocks the new opening', async () => {
  const closed = jest.fn(), view = await render(<Harness/>);
  await act(async () => { motion.close(closed); }); const exit = flights.at(-1)!;
  await view.rerender(<Harness visible={false}/>); await view.rerender(<Harness/>);
  await act(async () => exit.finish());
  expect(exit.stop).toHaveBeenCalled(); expect(closed).not.toHaveBeenCalled(); expect(motion.closing).toBe(false);
  expect(flights.at(-1)!.config).toMatchObject({ toValue: 1, duration: 150 });
  await view.unmount();
});

test('switching devices and returning does not revive an old exit or close callback', async () => {
  const closed = jest.fn(), view = await render(<Harness/>), oldClose = motion.close;
  await act(async () => { motion.close(closed); }); const exit = flights.at(-1)!;
  await view.rerender(<Harness scope="device-b:session-b"/>); await view.rerender(<Harness/>);
  await act(async () => { exit.finish(); expect(oldClose(closed)).toBe(false); });
  expect(closed).not.toHaveBeenCalled(); expect(motion.closing).toBe(false);
  await view.unmount();
});

test('reduced motion has no translation, scaling or animation delay', async () => {
  const closed = jest.fn(), view = await render(<Harness reduced/>);
  expect(flights).toHaveLength(0); expect(motion.style.transform).toEqual([]);
  await act(async () => { motion.close(closed); });
  expect(closed).toHaveBeenCalledTimes(1); expect(flights).toHaveLength(0); expect(motion.closing).toBe(true);
  await view.unmount();
});

test('enabling reduced motion mid-exit completes once and cancels the old animation', async () => {
  const closed = jest.fn(), view = await render(<Harness/>);
  await act(async () => { motion.close(closed); }); const exit = flights.at(-1)!;
  await view.rerender(<Harness reduced/>);
  expect(exit.stop).toHaveBeenCalled(); expect(closed).toHaveBeenCalledTimes(1);
  await act(async () => exit.finish()); expect(closed).toHaveBeenCalledTimes(1);
  await view.unmount();
});

test('unmount cancels a pending exit and never dispatches its action', async () => {
  const closed = jest.fn(), view = await render(<Harness/>);
  await act(async () => { motion.close(closed); }); const exit = flights.at(-1)!;
  await view.unmount(); await act(async () => exit.finish());
  expect(exit.stop).toHaveBeenCalled(); expect(closed).not.toHaveBeenCalled();
});
