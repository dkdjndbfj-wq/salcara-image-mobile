/** Receive-only compatibility for events already stored by older Hermes Bridges.
 * This never supplies a decision or actor, and cannot cross Agent/session IDs. */
export function hermesEventScope(value: Record<string, unknown>): boolean {
  return value.tool === 'hermes' && typeof value.sessionKey === 'string'
    && /^hermes:[A-Za-z0-9_-]+$/.test(value.sessionKey);
}

export function hermesSettlement(value: Record<string, unknown>): boolean {
  return hermesEventScope(value) && value.type === 'approval.resolved'
    && typeof value.approvalId === 'string' && value.approvalId.startsWith(`${value.sessionKey}:`)
    && value.approvalId.length > String(value.sessionKey).length + 1 && value.approvalId.length <= 512
    && !/[\u0000-\u001f\u007f]/.test(value.approvalId);
}

export function normalizeHermesEvent<T>(value: T): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const event = value as Record<string, unknown>;
  if (!hermesEventScope(event)) return value;
  if (hermesSettlement(event)) return { ...event,
    ...(!Object.hasOwn(event, 'decision') || event.decision === '' ? { decision: 'unknown' } : {}),
    ...(!Object.hasOwn(event, 'by') || event.by === '' ? { by: 'unknown' } : {}) } as T;
  if (event.type === 'tool' && event.status === 'completed') return { ...event, status: 'done' } as T;
  if (event.type === 'notice') {
    if (event.level === 'warning') return { ...event, level: 'warn' } as T;
    if (!Object.hasOwn(event, 'level') || event.level === '') return { ...event, level: 'info' } as T;
  }
  return value;
}
