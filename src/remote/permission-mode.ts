import type { ApprovalMode, PermissionMode } from './client';

export const CLAUDE_APPROVAL_MODES = ['ask', 'auto_edits', 'auto_all'] as const;
export const isApprovalMode = (value: unknown): value is ApprovalMode => typeof value === 'string'
  && (CLAUDE_APPROVAL_MODES as readonly string[]).includes(value);

/** A negotiated Codex policy, separate from the legacy Agent approval flag. */
export const PERMISSION_MODES = ['ask', 'auto_review', 'full_access'] as const;
export const isPermissionMode = (value: unknown): value is PermissionMode => typeof value === 'string'
  && (PERMISSION_MODES as readonly string[]).includes(value);
export const PERMISSION_LABEL: Record<PermissionMode, string> = {
  ask: '请求批准', auto_review: '帮我批准', full_access: '完全访问权限',
};
