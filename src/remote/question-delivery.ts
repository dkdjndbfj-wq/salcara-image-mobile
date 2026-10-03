import { randomUUID } from 'expo-crypto';
import { HubError } from './client';
import { DELIVERY_RETRY_WINDOW_MS } from './offline-policy';

export class QuestionDeliveryCancelled extends Error {
  constructor() { super('问答等待已结束'); this.name = 'QuestionDeliveryCancelled'; }
}
export const questionRetryDelay = (failures: number) => Math.min(300_000, 2000 * 2 ** Math.min(failures, 8));
const transient = (error: unknown) => error instanceof HubError && (error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500
  || (error.status === 409 && (!error.code || error.code === 'computer_offline')));

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new QuestionDeliveryCancelled()); return; }
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new QuestionDeliveryCancelled()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** One frozen answer/receipt, retried only while this request is still relevant. No idle polling. */
export async function deliverQuestionAnswer(input: {
  signal: AbortSignal; active: () => boolean; canSend?: () => boolean; expiresAt?: number;
  perform: (requestId: string, retrying: boolean) => Promise<void>; recover?: () => Promise<void>;
  receipt?: { requestId: string; createdAt: number; lastObservedAt: number; attempted: boolean };
  beforeAttempt?: () => Promise<void>;
}): Promise<void> {
  const requestId = input.receipt?.requestId ?? randomUUID(), created = input.receipt?.createdAt ?? Date.now();
  const deadline = Math.min(input.expiresAt ?? Infinity, created + DELIVERY_RETRY_WINDOW_MS);
  let failures = 0, attempted = input.receipt?.attempted ?? false, observed = input.receipt?.lastObservedAt ?? created;
  const check = () => {
    if (input.signal.aborted || !input.active()) throw new QuestionDeliveryCancelled();
    const now = Date.now();
    if (now < observed) throw new HubError('时间已变化，请核对问题后重试', 200, 'question_clock_changed');
    observed = now;
    if (now >= deadline) throw new HubError('问题已过期，请刷新', 200, 'question_expired');
    return Math.max(1, deadline - now);
  };
  while (true) {
    let remaining = check();
    // Backgrounding the phone pauses dispatch without issuing presence requests.
    if (input.canSend && !input.canSend()) { await pause(Math.min(5000, remaining), input.signal); continue; }
    if (attempted && input.recover) { try { await input.recover(); } catch { /* The same receipt, never a fresh answer, is retried. */ } }
    remaining = check();
    try {
      await input.beforeAttempt?.();
      check();
      await input.perform(requestId, attempted);
      check(); return;
    } catch (error) {
      check();
      if (!transient(error)) throw error;
      attempted = true;
      await pause(Math.min(questionRetryDelay(failures++), remaining), input.signal);
    }
  }
}
