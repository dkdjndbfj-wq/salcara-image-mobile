export type GoalAction = 'set' | 'pause' | 'resume' | 'clear';
export type WorkflowKind = 'review' | `goal.${GoalAction}`;
export type GoalStatus = 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete';
export interface SessionGoal {
  threadId: string; objective: string; status: GoalStatus; tokenBudget: number | null; tokensUsed: number;
  timeUsedSeconds: number; createdAt: number; updatedAt: number;
}
export interface SessionWorkflows {
  sessionKey: string; revision: string; canReview: boolean; goalSupported: boolean; goal?: SessionGoal; goalActions: GoalAction[]; unavailableReason?: string;
}
export interface SessionWorkflowsReading { scope: string; value: SessionWorkflows }
export type ReviewTarget = { type: 'uncommittedChanges' } | { type: 'baseBranch'; branch: string } | { type: 'commit'; sha: string } | { type: 'custom'; instructions: string };
export type WorkflowInput = { kind: 'review'; target: ReviewTarget } | { kind: 'goal.set'; objective: string; tokenBudget?: number }
  | { kind: 'goal.pause' | 'goal.resume' | 'goal.clear' };
export interface SessionWorkflowResult { sessionKey: string; operationId: string; kind: WorkflowKind; state: 'requested' | 'completed' | 'unconfirmed'; turnId?: string; goal?: SessionGoal; error?: string }
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const number = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown, max: number, multiline = false): value is string => typeof value === 'string' && [...value].length <= max
  && !/[\p{Cc}\p{Cf}]/u.test(multiline ? value.replace(/[\n\t]/g, '') : value);
const revision = (value: unknown): value is string => text(value, 256) && Boolean(value) && !/\s/u.test(value);
const goalActions: GoalAction[] = ['set', 'pause', 'resume', 'clear'];
export const goalStatusLabels: Record<GoalStatus, string> = { active: '进行中', paused: '已暂停', blocked: '受阻', usageLimited: '用量受限', budgetLimited: '达到上限', complete: '已完成' };
export function validWorkflowText(value: string, max = 4000): boolean { return text(value, max, true) && Boolean(value) && value === value.trim(); }
export function validWorkflowInput(value: WorkflowInput): boolean {
  if (value.kind === 'review') {
    const target = value.target;
    if (!target) return false;
    switch (target.type) {
      case 'uncommittedChanges': return true;
      case 'baseBranch': return text(target.branch, 256) && Boolean(target.branch) && target.branch === target.branch.trim() && !target.branch.startsWith('-');
      case 'commit': return /^[a-f0-9]{7,64}$/i.test(target.sha);
      case 'custom': return validWorkflowText(target.instructions);
      default: return false;
    }
  }
  if (value.kind === 'goal.set') return validWorkflowText(value.objective) && (value.tokenBudget === undefined || number(value.tokenBudget) && value.tokenBudget > 0);
  return ['goal.pause', 'goal.resume', 'goal.clear'].includes(value.kind);
}
function parseGoal(raw: unknown, sessionKey: string): SessionGoal | undefined {
  const goal = record(raw), id = sessionKey.slice(sessionKey.indexOf(':') + 1);
  if (!goal || goal.threadId !== id || !text(goal.objective, 64000, true) || !goal.objective.trim() || !Object.hasOwn(goalStatusLabels, String(goal.status))
    || goal.tokenBudget !== null && (!number(goal.tokenBudget) || goal.tokenBudget <= 0)
    || !number(goal.tokensUsed) || !number(goal.timeUsedSeconds) || !number(goal.createdAt) || !number(goal.updatedAt)) return;
  return { threadId: id, objective: goal.objective, status: goal.status as GoalStatus, tokenBudget: goal.tokenBudget as number | null,
    tokensUsed: goal.tokensUsed, timeUsedSeconds: goal.timeUsedSeconds, createdAt: goal.createdAt, updatedAt: goal.updatedAt };
}
export function parseSessionWorkflows(value: unknown, sessionKey: string): SessionWorkflows | undefined {
  const raw = record(value);
  if (!raw || !sessionKey.startsWith('codex:') || raw.sessionKey !== sessionKey || !text(raw.revision, 256) || typeof raw.canReview !== 'boolean' || typeof raw.goalSupported !== 'boolean'
    || !Array.isArray(raw.goalActions) || raw.goalActions.length > 4 || new Set(raw.goalActions).size !== raw.goalActions.length || raw.goalActions.some(action => !goalActions.includes(action as GoalAction))
    || (raw.canReview || raw.goalActions.length > 0) && !revision(raw.revision) || raw.unavailableReason !== undefined && !text(raw.unavailableReason, 4096)) return;
  const goal = raw.goal == null ? undefined : parseGoal(raw.goal, sessionKey);
  if (raw.goal != null && !goal || !raw.goalSupported && (goal || raw.goalActions.length) || !goal && raw.goalActions.some(action => action !== 'set')) return;
  return { sessionKey, revision: raw.revision, canReview: raw.canReview, goalSupported: raw.goalSupported,
    goalActions: raw.goalActions as GoalAction[], ...(goal ? { goal } : {}), ...(raw.unavailableReason ? { unavailableReason: raw.unavailableReason as string } : {}) };
}
export function parseSessionWorkflowResult(value: unknown, sessionKey: string, input: WorkflowInput, operationId: string): SessionWorkflowResult | undefined {
  const raw = record(value);
  if (!raw || raw.sessionKey !== sessionKey || raw.kind !== input.kind || raw.operationId !== operationId || !['requested', 'completed', 'unconfirmed'].includes(raw.state as string)
    || raw.error !== undefined && !text(raw.error, 4096)) return;
  const goal = raw.goal == null ? undefined : parseGoal(raw.goal, sessionKey);
  if (raw.goal != null && !goal) return;
  if (raw.state === 'unconfirmed') { if (raw.turnId) return; }
  else if (input.kind === 'review') { if (raw.state !== 'requested' || !revision(raw.turnId) || goal) return; }
  else {
    if (raw.state !== 'completed' || raw.turnId) return;
    if (input.kind === 'goal.clear' ? Boolean(goal) : !goal) return;
    if (input.kind === 'goal.pause' && goal?.status !== 'paused' || input.kind === 'goal.resume' && goal?.status !== 'active') return;
    if (input.kind === 'goal.set' && (goal?.objective !== input.objective || input.tokenBudget !== undefined && goal.tokenBudget !== input.tokenBudget)) return;
  }
  return { sessionKey, kind: input.kind, operationId, state: raw.state as SessionWorkflowResult['state'],
    ...(raw.turnId ? { turnId: raw.turnId as string } : {}), ...(goal ? { goal } : {}), ...(raw.error ? { error: raw.error as string } : {}) };
}
