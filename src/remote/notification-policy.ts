import type { HubEvent } from './client';

export type TaskNoticeKind = 'completed' | 'failed' | 'reply' | 'approval' | 'question';
export type ForegroundTaskNotice = { text: string; icon: 'checkCircle' | 'alert' | 'chat' | 'code' };

/** Events worth interrupting the user for outside the currently open thread. */
export function taskNoticeKind(event: HubEvent, now = Date.now()): TaskNoticeKind | null {
  if (event.type === 'approval.request' && (event.expiresAt === undefined || event.expiresAt > now)) return event.kind === 'question' ? 'question' : 'approval';
  if (event.type === 'turn' && !event.parentId && event.status === 'completed') return 'completed';
  if (event.type === 'turn' && !event.parentId && event.status === 'failed') return 'failed';
  if (event.type === 'message' && event.role === 'assistant' && event.final
    && !event.parentId && event.messagePhase !== 'commentary') return 'reply';
  return null;
}

/** Progress stays quiet; terminal results and requests requiring the user do not. */
export function foregroundTaskNotice(event: HubEvent, sessionTitle: string, isVisibleThread: boolean, agentName: string): ForegroundTaskNotice | null {
  if (isVisibleThread) return null;
  const name = sessionTitle.trim() || '远程任务';
  switch (taskNoticeKind(event)) {
    case 'completed': return { text: `${agentName} 已完成 · ${name}`, icon: 'checkCircle' };
    case 'failed': return { text: `${agentName} 失败 · ${name}`, icon: 'alert' };
    case 'reply': return { text: `${agentName} 有新回复 · ${name}`, icon: 'chat' };
    case 'approval': return { text: `${agentName} 需要批准 · ${name}`, icon: 'code' };
    case 'question': return { text: `${agentName} 需要你回答 · ${name}`, icon: 'chat' };
    default: return null;
  }
}

export interface TaskNotificationDecision {
  id: string;
  scope: string;
  kind: TaskNoticeKind;
  urgent: boolean;
  upgrade: boolean;
  stale: boolean;
  expiresAt?: number;
}
type NoticeRecord = { scope: string; at: number; kind: TaskNoticeKind | 'resolved' };
type LegacyTurn = { scope: string; at: number; ref: string; started: boolean; marker?: string; kinds: Set<TaskNoticeKind> };

/** In-memory presentation policy, never a routing/authorization decision. */
export function createTaskNotificationPolicy(options: { maxEntries?: number; retentionMs?: number; legacyWindowMs?: number } = {}) {
  const limit = Math.max(1, Math.floor(options.maxEntries ?? 1000));
  const retention = Math.max(1, options.retentionMs ?? 24 * 60 * 60_000);
  const legacyWindow = options.legacyWindowMs ?? 60_000;
  const records = new Map<string, NoticeRecord>();
  const events = new Map<string, { scope: string; at: number }>();
  const legacy = new Map<string, LegacyTurn>();
  const prune = <T extends { at: number }>(map: Map<string, T>, now: number) => {
    for (const [key, row] of map) if (now - row.at > retention) map.delete(key);
    while (map.size > limit) map.delete(map.keys().next().value!);
  };
  const remember = <T>(map: Map<string, T>, key: string, row: T) => {
    map.delete(key); map.set(key, row);
    while (map.size > limit) map.delete(map.keys().next().value!);
  };
  return {
    observe(event: HubEvent, scope: string, now = Date.now()): TaskNotificationDecision | null {
      if (!scope) return null;
      prune(records, now); prune(events, now); prune(legacy, now);
      const session = JSON.stringify([scope, event.deviceId, event.sessionKey]);
      const marker = String(event.seq ?? event.ts);
      if (event.type === 'turn' && event.status === 'started' && !event.parentId) {
        const startKey = `start:${session}:${marker}`;
        if (events.has(startKey)) return null;
        remember(events, startKey, { scope, at: now });
        const previous = legacy.get(session);
        // A replay of the same start cannot reopen a result that was already shown.
        if (previous?.marker !== marker) remember(legacy, session, { scope, at: now, ref: `legacy:${marker}`, started: true, marker, kinds: new Set<TaskNoticeKind>() });
        return null;
      }
      const approvalId = event.type === 'approval.request' || event.type === 'approval.resolved'
        ? `${scope}:approval:${event.deviceId}:${event.sessionKey}:${event.approvalId}` : null;
      if (event.type === 'approval.resolved' && approvalId) {
        remember(records, approvalId, { scope, at: now, kind: 'resolved' });
        return null;
      }
      const kind = taskNoticeKind(event, now);
      if (!kind) return null;
      const eventId = JSON.stringify([session, event.type, event.turnId, approvalId, 'id' in event ? event.id : marker, kind]);
      if (events.has(eventId)) return null;
      remember(events, eventId, { scope, at: now });
      let ref = event.turnId;
      if (!approvalId && !ref) {
        let current = legacy.get(session);
        // Without a start marker only complementary reply/result events may be
        // combined. A fresh result of the same kind must not swallow a new task.
        if (!current || !current.started && (now - current.at > legacyWindow || current.kinds.has(kind))) {
          const identity = event.seq ?? ('id' in event ? event.id : marker);
          current = { scope, at: now, ref: `legacy:${identity}`, started: false, kinds: new Set() };
        }
        current.kinds.add(kind); current.at = now; current.started = false;
        remember(legacy, session, current);
        ref = current.ref;
      }
      const id = approvalId ?? `${scope}:task:${event.deviceId}:${event.sessionKey}:${ref}`;
      const previous = records.get(id);
      if (previous?.kind === 'resolved' || previous?.kind === 'failed') return null;
      // A failure upgrades an already delivered ordinary result. Everything
      // else for the same task/request is a duplicate, not a new alert.
      if (previous && kind !== 'failed') return null;
      remember(records, id, { scope, at: now, kind });
      return { id, scope, kind, urgent: kind === 'failed' || kind === 'approval' || kind === 'question',
        upgrade: Boolean(previous), stale: now - event.ts > 10 * 60_000,
        ...(event.type === 'approval.request' && event.expiresAt ? { expiresAt: event.expiresAt } : {}) };
    },
    clearScope(scope: string) {
      for (const map of [records, events, legacy]) for (const [key, row] of map) if (row.scope === scope) map.delete(key);
    },
    clear() { records.clear(); events.clear(); legacy.clear(); },
  };
}
