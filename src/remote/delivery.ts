import { randomUUID } from 'expo-crypto';

import { getSetting, setSetting } from '../storage/database';
import { HubError, type Effort } from './client';
import { isEffort } from './effort';
import { deliveryRetryState } from './offline-policy';

const SETTING = 'remote_pending_delivery_v1';
export interface PendingDelivery {
  scope: string; deviceId: string; sessionKey: string; surface: 'cli' | 'desktop';
  text: string; requestId: string; createdAt: number; attempted: boolean; safeRetry: boolean; uncertain?: boolean;
  firstAttemptAt?: number; lastObservedAt?: number; reviewReason?: 'expired' | 'clock-changed';
  /** Images already uploaded to the computer; a retry resends the same ids. */
  attachments?: string[];
  /** Frozen with this receipt: a retry must not use a newly selected model. */
  sendOptions?: { model?: string; effort?: Effort };
}
const ATTACHMENT_ID = /^att_[a-f0-9]{32}$/;
let pending: PendingDelivery[] | null = null;
let queue: Promise<unknown> = Promise.resolve();
const flights = new Map<string, Promise<void>>();
async function records(): Promise<PendingDelivery[]> {
  if (pending) return pending;
  try {
    const raw: unknown = JSON.parse(await getSetting(SETTING) ?? '[]');
    pending = Array.isArray(raw) ? raw.filter((item): item is PendingDelivery => Boolean(item && typeof item === 'object'
      && typeof item.scope === 'string' && typeof item.deviceId === 'string' && typeof item.sessionKey === 'string'
      && ['cli', 'desktop'].includes(item.surface) && typeof item.text === 'string' && item.text.length <= 100_000
      && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(item.requestId) && Number.isSafeInteger(item.createdAt) && item.createdAt >= 0
      && typeof item.attempted === 'boolean' && typeof item.safeRetry === 'boolean'
      && (item.firstAttemptAt === undefined || (Number.isSafeInteger(item.firstAttemptAt) && item.firstAttemptAt >= 0))
      && (item.lastObservedAt === undefined || (Number.isSafeInteger(item.lastObservedAt) && item.lastObservedAt >= 0))
      && (item.attachments === undefined || (Array.isArray(item.attachments) && item.attachments.length <= 4 && item.attachments.every((id: unknown) => typeof id === 'string' && ATTACHMENT_ID.test(id))))))
      .slice(0, 20).map((item) => ({ scope: item.scope, deviceId: item.deviceId, sessionKey: item.sessionKey, surface: item.surface,
        text: item.text, requestId: item.requestId, createdAt: item.createdAt, attempted: item.attempted, safeRetry: item.safeRetry,
        ...(item.sendOptions && typeof item.sendOptions === 'object' ? { sendOptions: {
          ...(typeof item.sendOptions.model === 'string' && item.sendOptions.model.length <= 200 ? { model: item.sendOptions.model } : {}),
          ...(isEffort(item.sendOptions.effort) ? { effort: item.sendOptions.effort } : {}),
        } } : {}),
        ...(item.uncertain === true ? { uncertain: true } : {}),
        ...(['expired', 'clock-changed'].includes(item.reviewReason ?? '') ? { reviewReason: item.reviewReason } : {}),
        ...(item.firstAttemptAt !== undefined ? { firstAttemptAt: item.firstAttemptAt } : {}),
        ...(item.lastObservedAt !== undefined ? { lastObservedAt: item.lastObservedAt } : {}),
        ...(item.attachments?.length ? { attachments: [...item.attachments] } : {}) })) : [];
  } catch { pending = []; }
  return pending;
}
async function edit<T>(fn: (list: PendingDelivery[]) => T): Promise<T> {
  const run = queue.then(async () => {
    const list = await records();
    const value = fn(list);
    await setSetting(SETTING, JSON.stringify(list));
    return value;
  });
  queue = run.catch(() => undefined);
  return run;
}
export async function pendingDelivery(scope: string, deviceId: string, sessionKey: string): Promise<PendingDelivery | undefined> {
  await queue;
  if (!(await records()).some((item) => item.scope === scope && item.deviceId === deviceId && item.sessionKey === sessionKey)) return undefined;
  return edit((list) => {
    const item = list.find((value) => value.scope === scope && value.deviceId === deviceId && value.sessionKey === sessionKey);
    if (!item) return undefined;
    observe(item);
    return { ...item, ...(item.sendOptions ? { sendOptions: { ...item.sendOptions } } : {}) };
  });
}

/** Observation cannot renew a retry deadline, and a blocked deadline remains blocked across restarts. */
function observe(item: PendingDelivery) {
  const now = Date.now();
  const policy = deliveryRetryState(item, now);
  if (policy.reason === 'expired' || policy.reason === 'clock-changed') item.reviewReason = policy.reason;
  if (Number.isSafeInteger(now) && now >= 0) item.lastObservedAt = Math.max(item.lastObservedAt ?? item.firstAttemptAt ?? item.createdAt, now);
  return policy;
}
/** Explicit user cancellation of phone retries only; never interrupts or undoes the computer's task. */
export async function cancelPendingDelivery(scope: string, deviceId: string, sessionKey: string): Promise<void> {
  await edit((list) => { const index = list.findIndex((item) => item.scope === scope && item.deviceId === deviceId && item.sessionKey === sessionKey); if (index >= 0) list.splice(index, 1); });
}

export class DeliveryPendingError extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message); this.name = 'DeliveryPendingError'; }
}

/** Persist the same receipt before dispatch. A dropped response never becomes a brand-new command. */
export function deliverMessage(input: Pick<PendingDelivery, 'scope' | 'deviceId' | 'sessionKey' | 'surface' | 'text' | 'attachments' | 'sendOptions'> & {
  idempotent: boolean; perform: (receipt: PendingDelivery) => Promise<void>;
}): Promise<void> {
  const flightKey = JSON.stringify([input.scope, input.deviceId, input.sessionKey]);
  const existingFlight = flights.get(flightKey);
  if (existingFlight) return Promise.reject(new DeliveryPendingError('这条消息正在确认送达，请稍候', false));
  const flight = (async () => {
    let previouslyPossible = false;
    const prepared = await edit((list) => {
      let item = list.find((value) => value.scope === input.scope && value.deviceId === input.deviceId && value.sessionKey === input.sessionKey);
      if (item && (item.text !== input.text || item.surface !== input.surface)) throw new DeliveryPendingError('上一条消息尚未确认，请先重试原消息，避免重复或乱序发布任务', false);
      if (!item) {
        if (list.length >= 20) throw new DeliveryPendingError('待确认消息过多，请先处理已有消息', false);
        item = { scope: input.scope, deviceId: input.deviceId, sessionKey: input.sessionKey, surface: input.surface,
          text: input.text, requestId: randomUUID(), createdAt: Date.now(), attempted: false, safeRetry: input.idempotent,
          ...(input.attachments?.length ? { attachments: [...input.attachments] } : {}),
          ...(input.sendOptions ? { sendOptions: { ...input.sendOptions } } : {}) };
        list.push(item);
      }
      const policy = observe(item);
      if (!policy.retryable) return { blocked: policy.message };
      if (item.attempted && !input.idempotent) return { blocked: '本站已不支持安全重试，请先核对原会话；不会自动重复发送' };
      previouslyPossible = item.attempted;
      const now = Date.now();
      item.firstAttemptAt = item.firstAttemptAt ?? (item.attempted ? item.createdAt : now);
      item.lastObservedAt = now;
      item.attempted = true;
      item.safeRetry = item.safeRetry && input.idempotent;
      return { receipt: { ...item } };
    });
    if (!prepared.receipt) throw new DeliveryPendingError(prepared.blocked!, false);
    const receipt = prepared.receipt;
    try {
      await input.perform(receipt);
      await edit((list) => { const index = list.findIndex((item) => item.requestId === receipt.requestId && item.scope === receipt.scope); if (index >= 0) list.splice(index, 1); });
    } catch (error) {
      const uncertain = error instanceof HubError && ['command_delivery_uncertain', 'request_id_conflict'].includes(error.code ?? '');
      const transient = error instanceof HubError && (error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500 || (error.status === 409 && (!error.code || error.code === 'computer_offline')));
      if (uncertain || transient) {
        const retained = await edit((list) => {
          const item = list.find((value) => value.requestId === receipt.requestId && value.scope === receipt.scope);
          if (!item) return receipt;
          if (uncertain) item.uncertain = true;
          // Hub's explicit code means no receipt existed and no dispatch occurred.
          // It cannot erase an earlier lost acknowledgement or an old migrated attempt.
          if (!previouslyPossible && error instanceof HubError && error.status === 409 && error.code === 'computer_offline') {
            item.attempted = false;
            delete item.firstAttemptAt;
          }
          observe(item);
          return { ...item };
        });
        const policy = deliveryRetryState(retained);
        throw new DeliveryPendingError(policy.message, policy.retryable);
      }
      if (previouslyPossible) {
        // A new authorization/capability error cannot prove that an earlier
        // request did not already execute. Preserve its text and receipt.
        await edit((list) => {
          const item = list.find((value) => value.requestId === receipt.requestId && value.scope === receipt.scope);
          if (item) { item.uncertain = true; observe(item); }
        });
        throw new DeliveryPendingError('原消息曾等待确认，当前连接无法确认送达。文字仍在手机，请先核对原会话；不会自动重发', false);
      }
      // Definitive authorization/capability failure did not run the task. Keep its text, not a misleading pending receipt.
      await edit((list) => { const index = list.findIndex((item) => item.requestId === receipt.requestId && item.scope === receipt.scope); if (index >= 0) list.splice(index, 1); });
      throw error;
    }
  })();
  flights.set(flightKey, flight);
  void flight.finally(() => { if (flights.get(flightKey) === flight) flights.delete(flightKey); }).catch(() => undefined);
  return flight;
}

/** Test reset never erases on-device records; restart tests can exercise restoration. */
export function resetDeliveryForTests() { pending = null; queue = Promise.resolve(); flights.clear(); }
