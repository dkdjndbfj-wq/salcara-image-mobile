import { abortError } from './api/network';

/** Native operations may ignore AbortSignal. Stop waiting without trusting their cooperation. */
export function awaitUpdateOperation<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(abortError()));
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) { onAbort(); return; }
    try {
      // Attach both handlers even if operation synchronously aborts. A native
      // promise that rejects much later must never become an unhandled rejection.
      Promise.resolve(operation()).then(
        (value) => signal.aborted ? onAbort() : finish(() => resolve(value)),
        (error) => signal.aborted ? onAbort() : finish(() => reject(error)),
      );
    } catch (error) {
      if (signal.aborted) onAbort();
      else finish(() => reject(error));
    }
  });
}
