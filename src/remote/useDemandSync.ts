import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

/** One request at a time, only while a visible task needs updates. No idle polling. */
export function demandSyncDelay(attempt: number, failures: number): number {
  if (failures) return Math.min(60_000, 5000 * 2 ** Math.min(failures, 4));
  return attempt < 2 ? 5000 : attempt < 6 ? 10_000 : 20_000;
}
export function useDemandSync(enabled: boolean, needed: boolean, onSync: () => Promise<void>) {
  const callback = useRef(onSync); callback.current = onSync;
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let attempts = 0;
    let failures = 0;
    let busy = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (!stopped && needed && AppState.currentState === 'active') timer = setTimeout(() => void sync(), demandSyncDelay(attempts, failures));
    };
    const sync = async () => {
      if (stopped || busy || AppState.currentState !== 'active') return;
      busy = true;
      try { await callback.current(); failures = 0; } catch { failures += 1; }
      finally { attempts += 1; busy = false; schedule(); }
    };
    const listener = AppState.addEventListener('change', (next: string) => {
      if (timer) clearTimeout(timer);
      if (next === 'active') void sync();
    });
    schedule();
    return () => { stopped = true; if (timer) clearTimeout(timer); listener?.remove?.(); };
  }, [enabled, needed]);
}
