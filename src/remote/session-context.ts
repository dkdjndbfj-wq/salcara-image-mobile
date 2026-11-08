/** Native observations are independent of cumulative billable token usage. */
export interface ContextSnapshot {
  usedTokens: number; windowTokens?: number; source: 'codex_token_usage' | 'claude_context_usage';
  basis: 'last_request' | 'runtime_estimate'; windowKind?: 'model' | 'effective'; measuredAt: number;
  estimated?: boolean; model?: string;
}
export interface ContextCompaction {
  operationId?: string; state: 'requested' | 'running' | 'completed' | 'failed' | 'unconfirmed';
  blocking: boolean; startedAt: number; updatedAt: number; error?: string;
}
export interface SessionContext {
  sessionKey: string; revision: string; snapshot?: ContextSnapshot; compaction?: ContextCompaction;
  canCompact: boolean; unavailableReason?: string;
}

const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const shortText = (value: unknown, max = 256): value is string => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function parseSessionContext(value: unknown, sessionKey: string): SessionContext | undefined {
  const raw = record(value);
  if (!raw || raw.sessionKey !== sessionKey || !shortText(raw.revision) || /[\s\p{Cf}]/u.test(raw.revision) || typeof raw.canCompact !== 'boolean'
    || raw.canCompact && !raw.revision || raw.unavailableReason !== undefined && !shortText(raw.unavailableReason)) return;
  const result: SessionContext = { sessionKey, revision: raw.revision, canCompact: raw.canCompact,
    ...(raw.unavailableReason ? { unavailableReason: raw.unavailableReason as string } : {}) };
  if (raw.snapshot !== undefined && raw.snapshot !== null) {
    const snapshot = record(raw.snapshot);
    if (!snapshot || !count(snapshot.usedTokens) || !count(snapshot.measuredAt) || snapshot.measuredAt === 0
      || snapshot.windowTokens !== undefined && snapshot.windowTokens !== null && (!count(snapshot.windowTokens) || snapshot.windowTokens === 0)
      || snapshot.model !== undefined && !shortText(snapshot.model)
      || snapshot.estimated !== undefined && typeof snapshot.estimated !== 'boolean') return;
    const codex = sessionKey.startsWith('codex:') && snapshot.source === 'codex_token_usage' && snapshot.basis === 'last_request' && (snapshot.windowKind === undefined || snapshot.windowKind === 'model');
    const claude = sessionKey.startsWith('claude:') && snapshot.source === 'claude_context_usage' && snapshot.basis === 'runtime_estimate' && snapshot.estimated === true && (snapshot.windowKind === undefined || snapshot.windowKind === 'effective');
    if (!codex && !claude) return;
    result.snapshot = { usedTokens: snapshot.usedTokens, measuredAt: snapshot.measuredAt,
      source: snapshot.source as ContextSnapshot['source'], basis: snapshot.basis as ContextSnapshot['basis'],
      ...(count(snapshot.windowTokens) ? { windowTokens: snapshot.windowTokens } : {}),
      ...(snapshot.windowKind ? { windowKind: snapshot.windowKind as ContextSnapshot['windowKind'] } : {}),
      ...(snapshot.estimated === true ? { estimated: true } : {}), ...(snapshot.model ? { model: snapshot.model as string } : {}) };
  }
  if (raw.compaction !== undefined && raw.compaction !== null) {
    const operation = record(raw.compaction);
    if (!operation || !['requested', 'running', 'completed', 'failed', 'unconfirmed'].includes(operation.state as string)
      || typeof operation.blocking !== 'boolean' || !count(operation.startedAt) || !count(operation.updatedAt) || operation.updatedAt < operation.startedAt
      || operation.operationId !== undefined && (!shortText(operation.operationId) || !uuid.test(operation.operationId))
      || operation.error !== undefined && (typeof operation.error !== 'string' || operation.error.length > 4096)) return;
    result.compaction = { state: operation.state as ContextCompaction['state'], blocking: operation.blocking, startedAt: operation.startedAt, updatedAt: operation.updatedAt,
      ...(operation.operationId ? { operationId: operation.operationId as string } : {}), ...(operation.error ? { error: operation.error as string } : {}) };
    if (contextCompactionBusy(result)) result.canCompact = false;
  }
  return result;
}

export function contextCompactionBusy(value?: SessionContext): boolean {
  return value?.compaction?.blocking === true;
}
export function contextUsageLabel(value?: SessionContext): string {
  const snapshot = value?.snapshot;
  if (!snapshot) return '上下文 —';
  const prefix = snapshot.estimated ? '上下文 ≈ ' : '最近上下文 ';
  if (snapshot.windowTokens) return `${prefix}${Math.round(snapshot.usedTokens / snapshot.windowTokens * 100)}%`;
  return `${prefix}${snapshot.usedTokens.toLocaleString()} tokens`;
}
export function contextStateLabel(value?: SessionContext): string {
  switch (value?.compaction?.state) {
    case 'requested': return '等待压缩';
    case 'running': return '压缩中';
    case 'completed': return '已压缩';
    case 'failed': return '压缩失败';
    case 'unconfirmed': return '压缩结果未确认';
    default: return '';
  }
}
