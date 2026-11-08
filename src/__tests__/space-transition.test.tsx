import React from 'react';
import { Animated, Text } from 'react-native';
import { render } from '@testing-library/react-native';

jest.mock('../components/MotionPressable', () => ({ useReducedMotion: () => false }));

import { SpaceTransition } from '../companion/SpaceTransition';

function animation() {
  return { start: jest.fn(), stop: jest.fn(), reset: jest.fn() } as unknown as Animated.CompositeAnimation;
}

test('switching spaces cancels the whole previous animation group', async () => {
  const running: Animated.CompositeAnimation[] = [];
  const make = () => { const value = animation(); running.push(value); return value; };
  const timing = jest.spyOn(Animated, 'timing').mockImplementation(make);
  const spring = jest.spyOn(Animated, 'spring').mockImplementation(make);
  const delay = jest.spyOn(Animated, 'delay').mockImplementation(make);
  const sequence = jest.spyOn(Animated, 'sequence').mockImplementation(make);

  const screen = (space: 'assistant' | 'companion' | 'remote') => <SpaceTransition space={space}>{shown => <Text>{shown}</Text>}</SpaceTransition>;
  const view = await render(screen('assistant'));
  await view.rerender(screen('remote'));
  // The sequence owns its delay and spring; the parent group owns the burst,
  // sequence, and bloom. React Native stops sequence children with the group.
  const firstGroup = [running[0], running[3], running[4]];
  expect(firstGroup.every(Boolean)).toBe(true);
  await view.rerender(screen('companion'));
  expect(firstGroup.map(item => (item.stop as jest.Mock).mock.calls.length)).toEqual([1, 1, 1]);

  timing.mockRestore(); spring.mockRestore(); delay.mockRestore(); sequence.mockRestore();
});
