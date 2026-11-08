import type { Timeline } from './store';
import type { SessionInfo } from './client';

/** A Claude transcript is not proof that its original process can be resumed.
 * Owned workers and confirmed completion leases are explicitly controllable;
 * unknown/external histories stay view-only even when no work is visible.
 * Codex retains its separate native-live contract. */
export function claudeSessionAdmissionBlocked(session: SessionInfo | undefined): boolean {
  return Boolean(session?.sessionKey.startsWith('claude:') && (session.controllable === false || session.status === 'unknown'));
}

export const CONTINUE_PROMPT = '继续处理这个任务中尚未完成的工作。';
export const validTurnId = (value: unknown): value is string => typeof value === 'string'
  && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);

/** Identity comes only from a live, verified snapshot, never cached history. */
export function turnControlTarget(timeline: Timeline | undefined, action: 'stop' | 'continue'): string | undefined {
  if (!timeline?.snapshotAt || timeline.cachedAt || timeline.loading || timeline.error || !timeline.session?.controllable
    || timeline.session.controlSurface === 'desktop' || timeline.session.controlSurface === 'read-only') return undefined;
  const session = timeline.session;
  // Prefer the newest *observed* turn boundary over a stale session.updated
  // field.  A reconnect can deliver session.updated for the previous turn
  // after the current turn event; using that old activeTurnId would let a
  // late stop request interrupt the wrong generation.  Ambiguous boundaries
  // fail closed and force a fresh snapshot instead of guessing.
  const turns = timeline.items.filter((item): item is Extract<Timeline['items'][number], { kind: 'turn' }> => item.kind === 'turn' && !item.parentId && validTurnId(item.turnId));
  const lastStarted = [...turns].reverse().find(item => item.status === 'started');
  const lastTerminal = [...turns].reverse().find(item => item.status !== 'started');
  if (action === 'stop') {
    if (session.status !== 'running' && session.status !== 'waiting_approval') return undefined;
    if (lastStarted && (!lastTerminal || (lastStarted.orderSeq ?? lastStarted.seq ?? lastStarted.ts) > (lastTerminal.orderSeq ?? lastTerminal.seq ?? lastTerminal.ts))) {
      return lastStarted.turnId;
    }
    // No turn boundary was observed in this snapshot.  The Bridge may still
    // expose an active ID in session.updated, but only use it in that case;
    // never choose an ID that conflicts with a newer terminal boundary.
    if (lastStarted) return undefined;
    if (lastTerminal && lastTerminal.turnId === session.activeTurnId) return undefined;
    return validTurnId(session.activeTurnId) ? session.activeTurnId : undefined;
  }
  if (session.status !== 'idle' && session.status !== 'failed' || session.activeTurnId) return undefined;
  if (lastStarted && (!lastTerminal || (lastStarted.orderSeq ?? lastStarted.seq ?? lastStarted.ts) > (lastTerminal.orderSeq ?? lastTerminal.seq ?? lastTerminal.ts))) return undefined;
  if (lastTerminal) return lastTerminal.turnId;
  return validTurnId(session.lastTerminalTurnId) ? session.lastTerminalTurnId : undefined;
}
