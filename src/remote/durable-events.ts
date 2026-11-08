import { getSetting, setSetting } from '../storage/database';
import { HubError, parseHubEvent, type HubEvent, type SessionEventsPage } from './client';

const KEY = 'remote.durable.events.v1';
const RETAIN_MS = 7 * 86400_000;
const MAX_SESSION_BYTES = 2 * 1024 * 1024;
const MAX_BYTES = 32 * 1024 * 1024;
type Row = { scope: string; deviceId: string; sessionKey: string; epoch: string; through: number; savedAt: number; events: unknown[] };
let tail: Promise<unknown> = Promise.resolve();
const retired = new Set<string>();
async function read(): Promise<Row[]> {
  const encoded = await getSetting(KEY);
  if (encoded === null) return [];
  try {
    const rows = JSON.parse(encoded) as Row[];
    if (!Array.isArray(rows) || rows.length > 128 || !rows.every(row => row && typeof row.scope === 'string' && typeof row.deviceId === 'string'
      && typeof row.sessionKey === 'string' && typeof row.epoch === 'string' && Number.isSafeInteger(row.through) && row.through >= 0
      && Number.isSafeInteger(row.savedAt) && Array.isArray(row.events))) throw new Error();
    return rows;
  } catch { throw new HubError('手机事件恢复记录无法读取，尚未确认服务器副本', 507, 'local_recovery_unavailable'); }
}
const same = (row: Row, scope: string, deviceId: string, sessionKey: string) => row.scope === scope && row.deviceId === deviceId && row.sessionKey === sessionKey;
export async function loadDurableEvents(scope: string, deviceId: string, sessionKey: string): Promise<{ epoch: string; through: number; events: HubEvent[] } | undefined> {
  await tail;
  if (retired.has(scope)) return;
  const row = (await read()).find(row => same(row, scope, deviceId, sessionKey));
  if (!row || row.savedAt + RETAIN_MS <= Date.now()) return;
  return { epoch: row.epoch, through: row.through, events: row.events.map(parseHubEvent).filter((event): event is HubEvent => Boolean(event)
    && event!.deviceId === deviceId && event!.sessionKey === sessionKey && !event!.type.startsWith('approval.')) };
}
// Messages/reasoning are cumulative replacements, so the newest full record
// supersedes fragments for the exact identity. Unknown future events remain
// verbatim; we cannot ACK content the installed client silently discarded.
function compact(events: unknown[]): unknown[] {
  const result: Record<string, unknown>[] = [], identities = new Map<string, number>();
  for (const value of events) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无效事件记录');
    const event = value as Record<string, unknown>;
    const key = ['message', 'reasoning', 'notice'].includes(String(event.type)) && typeof event.id === 'string'
      ? JSON.stringify([event.type, event.id, event.parentId, event.role, event.clientId]) : undefined;
    const previous = key === undefined ? undefined : identities.get(key);
    if (previous !== undefined) { result[previous] = { ...result[previous], ...event }; }
    else { if (key) identities.set(key, result.length); result.push(event); }
  }
  return result.sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0));
}
/** The returned cursor may be ACKed only after this promise resolves. Writes
 * and cleanup share a queue; a failed write never publishes a new cursor. */
export function commitDurableEvents(scope: string, deviceId: string, sessionKey: string, page: SessionEventsPage): Promise<void> {
  const frozen = JSON.parse(JSON.stringify(page)) as SessionEventsPage;
  const run = tail.then(async () => {
    if (retired.has(scope)) throw new Error('原配对已解除');
    if (!frozen.storageEpoch || !frozen.durableEvents) throw new Error('服务器未提供持久事件身份');
    const now = Date.now();
    const list = (await read()).filter(row => row.savedAt + RETAIN_MS > now);
    const previous = list.find(row => same(row, scope, deviceId, sessionKey));
    const currentEpoch = previous?.epoch === frozen.storageEpoch;
    const retained = previous?.events.map(value => currentEpoch ? value : { ...(value as object), seq: undefined }) ?? [];
    const incoming = frozen.durableEvents.filter(value => !currentEpoch || (value as Record<string, unknown>).seq === undefined || Number((value as Record<string, unknown>).seq) > previous!.through);
    const row: Row = { scope, deviceId, sessionKey, epoch: frozen.storageEpoch,
      through: currentEpoch ? Math.max(previous!.through, frozen.nextSeq) : frozen.nextSeq, savedAt: now, events: compact([...retained, ...incoming]) };
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
    if (bytes(row) > MAX_SESSION_BYTES) throw new HubError('此会话超过手机恢复空间，服务器副本尚未确认，可从电脑补读', 507, 'recovery_capacity');
    const next = [...list.filter(row => !same(row, scope, deviceId, sessionKey)), row];
    if (next.length > 128 || bytes(next) > MAX_BYTES) throw new HubError('手机恢复空间已满，服务器副本尚未确认', 507, 'recovery_capacity');
    await setSetting(KEY, JSON.stringify(next));
  });
  tail = run.catch(() => undefined); return run;
}
export function clearDurableEventScope(scope: string): Promise<void> {
  retired.add(scope);
  const run = tail.then(async () => { const list = (await read()).filter(row => row.scope !== scope); await setSetting(KEY, list.length ? JSON.stringify(list) : null); });
  tail = run.catch(() => undefined); return run;
}

export function pruneDurableEvents(): Promise<void> {
  const run = tail.then(async () => {
    const list = await read(), next = list.filter(row => row.savedAt + RETAIN_MS > Date.now());
    if (next.length !== list.length) await setSetting(KEY, next.length ? JSON.stringify(next) : null);
  });
  tail = run.catch(() => undefined); return run;
}
