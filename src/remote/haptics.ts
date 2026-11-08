import { AppState, Platform, Vibration } from 'react-native';
import * as Haptics from 'expo-haptics';

/**
 * Native selection feedback respects the device's haptics settings. Android
 * uses View.performHapticFeedback, not sub-10ms pulses many motors cannot feel.
 * An older Android binary without the module keeps a bounded vibration fallback;
 * never use React Native's ~400ms iOS vibration as a selection fallback.
 */
const EFFORT_PATTERNS: Record<string, number[]> = {
  '': [0, 18], none: [0, 18], minimal: [0, 18], low: [0, 20],
  medium: [0, 24], high: [0, 28], xhigh: [0, 22, 45, 22],
  max: [0, 24, 40, 28], ultra: [0, 26, 35, 30],
};

let enabled = true;
let lastTick: number | undefined;
let feedbackRevision = 0;
const available = () => enabled && (Platform.OS === 'android' || Platform.OS === 'ios')
  && AppState.currentState !== 'background' && AppState.currentState !== 'inactive';

function feedback(android: Haptics.AndroidHaptics, ios: () => Promise<void>, fallback: number[]) {
  if (!available()) return;
  const revision = ++feedbackRevision;
  try {
    const result = Platform.OS === 'android' ? Haptics.performAndroidHapticsAsync(android) : ios();
    void Promise.resolve(result).catch(() => {
      // Do not replay stale pulses after a newer selection or backgrounding.
      if (revision !== feedbackRevision || !available() || Platform.OS !== 'android') return;
      try { Vibration.cancel(); Vibration.vibrate(fallback); } catch { /* decorative only */ }
    });
  } catch { /* an unavailable haptics host must never block selection */ }
}

/** One reported effort step, including None, Minimal and following the default. */
export function hapticEffort(level?: string) {
  const pattern = EFFORT_PATTERNS[level ?? ''];
  if (!pattern) return;
  const style = level === 'high' || level === 'xhigh' ? Haptics.ImpactFeedbackStyle.Medium
    : level === 'max' || level === 'ultra' ? Haptics.ImpactFeedbackStyle.Heavy : Haptics.ImpactFeedbackStyle.Light;
  feedback(Haptics.AndroidHaptics.Segment_Tick, () => Haptics.impactAsync(style), pattern);
}

/** A model passing the centre of the arc: a crisp single tick, rate-limited while swiping. */
export function hapticModelTick() {
  const now = Date.now();
  if (!available() || lastTick !== undefined && now >= lastTick && now - lastTick < 45) return;
  lastTick = now;
  feedback(Haptics.AndroidHaptics.Segment_Tick, () => Haptics.selectionAsync(), [0, 18]);
}

/** A model (with its effort) committed: a soft double knock, distinct from effort steps. */
export function hapticModelCommit() {
  feedback(Haptics.AndroidHaptics.Confirm, () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium), [0, 22, 55, 28]);
}

/** Tests and a future settings switch can turn haptics off. */
export function setRemoteHaptics(value: boolean) { enabled = value; lastTick = undefined; feedbackRevision += 1; }
