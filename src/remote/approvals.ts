import type { ApprovalOptions, Decision } from './client';

/** Missing legacy descriptors are once-only. Unknown/malformed contracts are
 * not interpreted as the three Codex buttons, even for a known Agent name. */
export function normalizeApprovalOptions(raw: unknown): ApprovalOptions | undefined {
  if (raw === undefined) return undefined;
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  if (value.version !== 1 || !Array.isArray(value.decisions) || value.decisions.length > 16) return { version: 0, decisions: [] };
  const decisions = value.decisions;
  return { version: 1, decisions: (['allow', 'allow_session', 'deny'] as const).filter(item => decisions.includes(item)),
    ...(value.denyEffect === 'cancel_turn' ? { denyEffect: 'cancel_turn' as const } : {}) };
}

export function approvalDecisions(approval: { approvalOptions?: ApprovalOptions; approval?: string; approvalTransport?: string }): Decision[] {
  const options = normalizeApprovalOptions(approval.approvalOptions);
  const decisions: Decision[] = options ? options.decisions : ['allow', 'deny'];
  return approval.approval === 'question' || approval.approvalTransport === 'codex-hook-v1' ? decisions.filter(value => value !== 'allow_session') : decisions;
}
