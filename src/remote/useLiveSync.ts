import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

/**
 * Keeps a visible thread current without a permanent stream.
 * - With Hub long-poll support: one held request at a time (the Hub answers as
 *   soon as the computer reports progress), so text streams in near real time.
 * - Without it: short reads at 2 → 4 → 8 s.
 * Repeated disconnects back off to five minutes; success or foreground resets
 * the delay. Nothing runs while idle, hidden or the app is in background.
 */
export function liveDelay(attempt: number, failures: number, longPoll: boolean): number {
  if (failures) return Math.min(300_000, 1000 * 2 ** Math.min(failures, 9));
  if (longPoll) return 0;
  return attempt < 3 ? 2000 : attempt < 8 ? 4000 : 8000;
}

export function useLiveSync(enabled: boolean, needed: boolean, longPoll: boolean, onSync: (waitSeconds: number) => Promise<void>, wakeKey: string | number = 0) {
  const callback = useRef(onSync); callback.current = onSync;
  useEffect(() => {
    if (!enabled || !needed) return;
    let stopped = false;
    let attempts = 0;
    let failures = 0;
    let busy = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (stopped || AppState.currentState !== 'active') return;
      timer = setTimeout(() => void run(), liveDelay(attempts, failures, longPoll));
    };
    const run = async () => {
      if (stopped || busy || AppState.currentState !== 'active') return;
      busy = true;
      try { await callback.current(longPoll ? 20 : 0); failures = 0; } catch { failures += 1; }
      finally { attempts += 1; busy = false; schedule(); }
    };
    const listener = AppState.addEventListener('change', (next: string) => {
      if (timer) clearTimeout(timer);
      if (next === 'active') { failures = 0; attempts = 0; void run(); }
    });
    void run();
    return () => { stopped = true; if (timer) clearTimeout(timer); listener?.remove?.(); };
  }, [enabled, needed, longPoll, wakeKey]);
}
