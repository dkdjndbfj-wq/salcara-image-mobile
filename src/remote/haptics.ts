import { Platform, Vibration } from 'react-native';

/**
 * Short, distinct taps for the programming model / effort controls.
 * Android only: React Native's iOS Vibration ignores durations and always
 * buzzes ~400 ms, which is the opposite of "短促". (iOS needs expo-haptics.)
 * Patterns are [wait, buzz, wait, buzz…] in ms; every buzz stays ≤ 22 ms.
 */
const EFFORT_PATTERNS: Record<string, number[]> = {
  low: [0, 8],
  medium: [0, 14],
  high: [0, 12, 50, 12],
  xhigh: [0, 12, 38, 12, 38, 18],
  max: [0, 14, 30, 14, 30, 14, 30, 20],
  ultra: [0, 16, 24, 16, 24, 16, 24, 16, 24, 22],
};

let enabled = Platform.OS === 'android';
let lastTick = 0;

function buzz(pattern: number[]) {
  if (!enabled) return;
  try { Vibration.cancel(); Vibration.vibrate(pattern); } catch { /* haptics are decorative */ }
}

/** One step of thinking effort; higher levels get more, slightly stronger pulses. */
export function hapticEffort(level?: string) {
  if (level && EFFORT_PATTERNS[level]) buzz(EFFORT_PATTERNS[level]);
}

/** A model passing the centre of the arc: a crisp single tick, rate-limited while swiping. */
export function hapticModelTick() {
  const now = Date.now();
  if (now - lastTick < 45) return;
  lastTick = now; buzz([0, 6]);
}

/** A model (with its effort) committed: a soft double knock, distinct from effort steps. */
export function hapticModelCommit() { buzz([0, 9, 70, 16]); }

/** Tests and a future settings switch can turn haptics off. */
export function setRemoteHaptics(value: boolean) { enabled = value && Platform.OS === 'android'; }
