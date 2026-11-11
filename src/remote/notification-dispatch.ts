/** A short batching window, not a rate limit: urgent news is never discarded. */
export interface NotificationDispatchItem<T> {
  id: string;
  scope: string;
  urgent: boolean;
  value: T;
  expiresAt?: number;
  isCurrent?: () => boolean;
}

export function createNotificationDispatcher<T>(
  deliver: (items: readonly NotificationDispatchItem<T>[]) => void,
  options: { normalDelayMs?: number; urgentDelayMs?: number; protectUrgentMs?: number } = {},
) {
  const normalDelay = options.normalDelayMs ?? 1000;
  const urgentDelay = options.urgentDelayMs ?? 100;
  const protectUrgent = options.protectUrgentMs ?? 4000;
  const normal = new Map<string, NotificationDispatchItem<T>>();
  const urgent = new Map<string, NotificationDispatchItem<T>>();
  const recentUrgent = new Map<string, NotificationDispatchItem<T>>();
  let normalTimer: ReturnType<typeof setTimeout> | undefined;
  let urgentTimer: ReturnType<typeof setTimeout> | undefined;
  let protectedUntil = 0;
  let disposed = false;
  const keyOf = (scope: string, id: string) => JSON.stringify([scope, id]);
  const valid = (item: NotificationDispatchItem<T>) => {
    if (item.expiresAt !== undefined && item.expiresAt <= Date.now()) return false;
    try { return item.isCurrent?.() !== false; } catch { return false; }
  };
  const drain = (pending: Map<string, NotificationDispatchItem<T>>) => {
    const items = [...pending.values()].filter(valid);
    pending.clear();
    return items;
  };
  const scheduleNormal = () => {
    if (disposed || normalTimer !== undefined || !normal.size) return;
    normalTimer = setTimeout(() => {
      normalTimer = undefined;
      if (disposed) return;
      if (Date.now() < protectedUntil) { scheduleNormal(); return; }
      recentUrgent.clear();
      const items = drain(normal);
      if (items.length) deliver(items);
    }, Math.max(normalDelay, protectedUntil - Date.now()));
  };
  const scheduleUrgent = () => {
    if (disposed || urgentTimer !== undefined || !urgent.size) return;
    urgentTimer = setTimeout(() => {
      urgentTimer = undefined;
      if (disposed) return;
      const items = drain(urgent);
      if (!items.length) return;
      if (Date.now() >= protectedUntil) recentUrgent.clear();
      for (const item of items) recentUrgent.set(keyOf(item.scope, item.id), item);
      for (const [key, item] of recentUrgent) if (!valid(item)) recentUrgent.delete(key);
      protectedUntil = Date.now() + protectUrgent;
      if (normalTimer !== undefined) { clearTimeout(normalTimer); normalTimer = undefined; }
      deliver([...recentUrgent.values()]);
      scheduleNormal();
    }, urgentDelay);
  };
  return {
    enqueue(item: NotificationDispatchItem<T>) {
      if (disposed) return;
      const key = keyOf(item.scope, item.id);
      if (item.urgent) {
        normal.delete(key);
        urgent.set(key, item);
        scheduleUrgent();
      } else if (!urgent.has(key)) {
        normal.set(key, item);
        scheduleNormal();
      }
    },
    cancel(scope: string, id: string) {
      const key = keyOf(scope, id);
      normal.delete(key); urgent.delete(key); recentUrgent.delete(key);
    },
    cancelScope(scope: string) {
      for (const [key, item] of normal) if (item.scope === scope) normal.delete(key);
      for (const [key, item] of urgent) if (item.scope === scope) urgent.delete(key);
      for (const [key, item] of recentUrgent) if (item.scope === scope) recentUrgent.delete(key);
    },
    dispose() {
      disposed = true;
      if (normalTimer !== undefined) clearTimeout(normalTimer);
      if (urgentTimer !== undefined) clearTimeout(urgentTimer);
      normalTimer = undefined; urgentTimer = undefined;
      normal.clear(); urgent.clear(); recentUrgent.clear();
    },
  };
}
