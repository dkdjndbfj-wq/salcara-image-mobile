export const APPROVAL_PENDING_MESSAGE = '审批结果待确认，刷新原会话核对；不会重复提交';

/** HTTP 200 can carry an ambiguous native RPC outcome. Only positively known
 * rejections unlock the original choice; transport and untyped errors do not. */
export function approvalResultUncertain(error: unknown): boolean {
  if (!error || typeof error !== 'object') return true;
  const value = error as { code?: string; remoteCode?: string; status?: number };
  const code = value.remoteCode ?? value.code;
  if (['command_delivery_uncertain', 'command_receipt_missing', 'command_receipt_pending', 'request_id_conflict',
    'request_scope_changed', 'aborted', 'timeout', 'disconnected', 'protocol'].includes(code ?? '')) return true;
  if (['computer_offline', 'approval_not_sent', 'approval_rejected', 'approval_expired', 'approval_not_pending', 'approval_not_found',
    'approval_decision_unsupported', 'invalid_params'].includes(code ?? '')) return false;
  if (!value.remoteCode && (value.code === 'busy' || value.status === 400 || value.status === 401 || value.status === 403)) return false;
  return true;
}
