import { awaitUpdateOperation } from './update-async';

/** A UI step must settle even if the native bridge ignores cancellation. */
export async function runUpdateStep<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  parentSignal: AbortSignal,
  milliseconds: number,
  timeoutMessage: string,
): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (parentSignal.aborted) controller.abort();
  else parentSignal.addEventListener('abort', cancel, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, milliseconds);
  try {
    return await awaitUpdateOperation(() => operation(controller.signal), controller.signal);
  } catch (error) {
    if (timedOut && !parentSignal.aborted) throw new Error(timeoutMessage);
    throw error;
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener('abort', cancel);
  }
}
