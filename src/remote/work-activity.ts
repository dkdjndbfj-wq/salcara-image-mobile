import type { SessionInfo } from './client';
import type { TimelineItem } from './store';

/**
 * Only let delivery/read feedback compete with agent activity when the host has
 * no current work evidence. Prefer recent terminal turn boundaries over stale
 * status fields, while still honoring explicit work that began after them.
 */
export function hasActiveAgentWork(
  session: SessionInfo | undefined,
  items: TimelineItem[],
  pendingApprovals = 0,
  sessionSeq?: number,
): boolean {
  if (pendingApprovals > 0 || session?.status === 'waiting_approval') return true;

  const latestRootTurnIndex = items.reduce((latest, item, index) =>
    item.kind === 'turn' && !item.parentId ? index : latest, -1);
  const latestRootTurn = latestRootTurnIndex >= 0 ? items[latestRootTurnIndex] : undefined;
  if (latestRootTurn?.kind === 'turn' && latestRootTurn.status === 'started') return true;

  // A session.updated can lag behind a newer terminal event. Do not mistake
  // its old running/active ID for live work, unless it identifies a newer turn.
  const activeTurnId = session?.activeTurnId;
  const lastTerminalTurnId = session?.lastTerminalTurnId;
  const terminalTurnId = latestRootTurn?.kind === 'turn' && latestRootTurn.status !== 'started'
    ? latestRootTurn.turnId : undefined;
  if (activeTurnId && activeTurnId !== lastTerminalTurnId && activeTurnId !== terminalTurnId) return true;

  const terminalSeq = latestRootTurn?.kind === 'turn' && latestRootTurn.status !== 'started'
    ? latestRootTurn.orderSeq ?? latestRootTurn.seq : undefined;
  const sessionUpdatedAfterTerminal = terminalSeq !== undefined && sessionSeq !== undefined && sessionSeq > terminalSeq;
  if (session?.status === 'running' && (latestRootTurn?.kind !== 'turn' || latestRootTurn.status === 'started'
    // Without a comparable session cursor we cannot prove that a terminal
    // event belongs to the current status. Stay quiet rather than flashing a
    // connection spinner while the host may have already started the next turn.
    || sessionUpdatedAfterTerminal || terminalSeq === undefined || sessionSeq === undefined)) return true;

  // Child turns are independent work. Pair their start/end boundaries by
  // parent and turn identity so completed historical children do not stay live.
  const latestChildTurn = new Map<string, Extract<TimelineItem, { kind: 'turn' }>>();
  for (const item of items) {
    if (item.kind !== 'turn' || !item.parentId || !item.turnId) continue;
    latestChildTurn.set(JSON.stringify([item.parentId, item.turnId]), item);
  }
  if ([...latestChildTurn.values()].some(item => item.status === 'started')) return true;

  // Partial output and explicit in-progress compaction are direct host signals.
  // Ignore artifacts ordered before the latest root terminal boundary.
  const afterTerminal = (index: number) => latestRootTurnIndex < 0 || index > latestRootTurnIndex;
  return items.some((item, index) => afterTerminal(index) && (
    item.kind === 'tool' && item.status === 'running'
    || item.kind === 'reasoning' && !item.final
    || item.kind === 'message' && item.role === 'assistant' && !item.final
    || item.kind === 'notice' && item.noticeKind === 'context_compaction' && item.progress === true
  ));
}
