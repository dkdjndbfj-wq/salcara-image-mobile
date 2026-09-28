import type { Animated } from 'react-native';

/** setValue only when the level moved noticeably: native level events arrive dozens of times a second. */
export function levelSetter(value: Animated.Value): (next: number) => void {
  let last = -1;
  return (next) => {
    if (Math.abs(next - last) < 0.02 && !(next === 0 && last !== 0)) return;
    last = next;
    value.setValue(next);
  };
}
