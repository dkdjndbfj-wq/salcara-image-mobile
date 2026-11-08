import type { AgentProfile, SessionInfo, SessionStatus, WorkspaceMode } from './client';
import { agentSessions, sessionWorkspaceMode } from './projection';

export interface DirectorySessionActivity { status: SessionStatus; includesChildren: boolean }
const surface = (row: SessionInfo) => `${row.controlSurface ?? 'cli'}:${row.sessionScope ?? ''}`;

/** `sessions` must come from one selected computer's directory. A child only
 * contributes when every native parent link is present in the same Agent,
 * workspace mode and execution surface. Missing links and cycles prove nothing. */
export function directorySessionActivities(sessions: SessionInfo[], agent: Pick<AgentProfile, 'id' | 'tool'>, mode: WorkspaceMode,
  options: { pending?: ReadonlySet<string>; statusFor?: (row: SessionInfo) => SessionStatus } = {}): Map<string, DirectorySessionActivity> {
  const rows = agentSessions(sessions, agent).filter(row => sessionWorkspaceMode(row) === mode);
  const byKey = new Map<string, SessionInfo | undefined>();
  for (const row of rows) byKey.set(row.sessionKey, byKey.has(row.sessionKey) ? undefined : row);
  const roots = new Map<string, string | undefined>();
  const rootOf = (row: SessionInfo): string | undefined => {
    const chain: string[] = [], seen = new Set<string>();
    let current: SessionInfo | undefined = row, root: string | undefined;
    while (current && surface(current) === surface(row)) {
      if (seen.has(current.sessionKey) || byKey.get(current.sessionKey) !== current) break;
      if (roots.has(current.sessionKey)) { root = roots.get(current.sessionKey); break; }
      seen.add(current.sessionKey); chain.push(current.sessionKey);
      if (!current.parentSessionKey) { root = current.sessionKey; break; }
      current = byKey.get(current.parentSessionKey);
    }
    for (const key of chain) roots.set(key, root);
    return root;
  };
  const statusOf = (row: SessionInfo): SessionStatus => options.pending?.has(row.sessionKey) ? 'waiting_approval' : options.statusFor?.(row) ?? row.status;
  const result = new Map<string, DirectorySessionActivity>();
  for (const row of rows) if (!row.parentSessionKey && byKey.get(row.sessionKey) === row) result.set(row.sessionKey, { status: statusOf(row), includesChildren: false });
  for (const row of rows) {
    if (!row.parentSessionKey) continue;
    const status = statusOf(row);
    if (status !== 'running' && status !== 'waiting_approval') continue;
    const root = rootOf(row), previous = root ? result.get(root) : undefined;
    if (!root || !previous) continue;
    result.set(root, { status: previous.status === 'waiting_approval' || status === 'waiting_approval' ? 'waiting_approval' : 'running', includesChildren: true });
  }
  return result;
}
