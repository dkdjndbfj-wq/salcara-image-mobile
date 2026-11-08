import { parseSessionWorkflowResult, parseSessionWorkflows, validWorkflowInput, type WorkflowInput } from '../remote/session-workflows';
import { agentSupports } from '../remote/projection';
import { applyEvent } from '../remote/store';

const sessionKey = 'codex:s', operationId = '11111111-2222-4333-8444-555555555555';
const goal = { threadId: 's', objective: '完成审查', status: 'active', tokenBudget: null, tokensUsed: 100, timeUsedSeconds: 12, createdAt: 1, updatedAt: 2 };
const catalog = { sessionKey, revision: 'r1', canReview: true, goalSupported: true, goalActions: ['set'] };
test('workflow support must be explicit, never inferred from builtin names', () => {
  expect(agentSupports(undefined, 'codex', 'sessionWorkflows')).toBe(false);
  expect(agentSupports({ available: true, capabilities: { sessionWorkflows: true } } as any, 'codex', 'sessionWorkflows')).toBe(true);
});
test.each(['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'])('keeps native %s goals and optional budgets', status => {
  expect(parseSessionWorkflows({ ...catalog, goal: { ...goal, status }, goalActions: ['set', 'clear'] }, sessionKey)?.goal).toMatchObject({ status, tokensUsed: 100, tokenBudget: null });
});
test.each([
  { sessionKey: 'codex:other' }, { revision: '' }, { goalActions: ['resume'] }, { goalActions: ['set', 'set'] },
  { goal: { ...goal, threadId: 'other' } }, { goal: { ...goal, tokensUsed: -1 } }, { goal: { ...goal, tokenBudget: 0 } },
  { goalSupported: false, goal }, { goal: { ...goal, status: 'running' } }, { goal: { ...goal, tokensUsed: Number.MAX_SAFE_INTEGER + 1 } },
])('rejects malformed or foreign native catalogs %#', patch => { expect(parseSessionWorkflows({ ...catalog, ...patch }, sessionKey)).toBeUndefined(); });
test('no mutation is possible from an unsupported native catalog', () => {
  expect(parseSessionWorkflows({ ...catalog, revision: '', canReview: false, goalSupported: false, goalActions: [], unavailableReason: '当前版本不支持' }, sessionKey)).toBeTruthy();
});
test.each<WorkflowInput>([
  { kind: 'review', target: { type: 'uncommittedChanges' } }, { kind: 'review', target: { type: 'baseBranch', branch: 'main' } },
  { kind: 'review', target: { type: 'commit', sha: 'a12ef34' } }, { kind: 'review', target: { type: 'custom', instructions: '核对来源\n检查并发' } },
  { kind: 'goal.set', objective: '完成任务' }, { kind: 'goal.set', objective: '完成任务', tokenBudget: 10000 }, { kind: 'goal.pause' },
])('accepts explicit user input %#', value => { expect(validWorkflowInput(value)).toBe(true); });
test.each<WorkflowInput>([
  { kind: 'goal.set', objective: 'hidden\u202eorigin' }, { kind: 'goal.set', objective: '完成', tokenBudget: -1 },
  { kind: 'goal.set', objective: '完成', tokenBudget: NaN }, { kind: 'review', target: { type: 'baseBranch', branch: '--inject' } },
  { kind: 'review', target: { type: 'commit', sha: 'HEAD' } }, { kind: 'review', target: { type: 'custom', instructions: '' } },
])('rejects invalid user input %#', value => { expect(validWorkflowInput(value)).toBe(false); });
test('review acknowledgment is requested, never completed or a goal event', () => {
  const input: WorkflowInput = { kind: 'review', target: { type: 'uncommittedChanges' } }, value = { sessionKey, operationId, kind: 'review', state: 'requested', turnId: 'turn-1' };
  expect(parseSessionWorkflowResult(value, sessionKey, input, operationId)?.state).toBe('requested');
  for (const patch of [{ state: 'completed' }, { turnId: '' }, { goal }, { operationId: 'other' }, { sessionKey: 'codex:other' }]) expect(parseSessionWorkflowResult({ ...value, ...patch }, sessionKey, input, operationId)).toBeUndefined();
});
test('goal receipts must confirm the exact mutation, not merely an existing goal', () => {
  const value = { sessionKey, operationId, kind: 'goal.pause', state: 'completed', goal };
  expect(parseSessionWorkflowResult(value, sessionKey, { kind: 'goal.pause' }, operationId)).toBeUndefined();
  expect(parseSessionWorkflowResult({ ...value, goal: { ...goal, status: 'paused' } }, sessionKey, { kind: 'goal.pause' }, operationId)?.goal?.status).toBe('paused');
  expect(parseSessionWorkflowResult({ ...value, kind: 'goal.set' }, sessionKey, { kind: 'goal.set', objective: goal.objective, tokenBudget: 100 }, operationId)).toBeUndefined();
  expect(parseSessionWorkflowResult({ ...value, kind: 'goal.clear' }, sessionKey, { kind: 'goal.clear' }, operationId)).toBeUndefined();
});
test('workflow notifications only invalidate read state and cannot overwrite goal or completed turns', () => {
  const timeline: any = { items: [{ kind: 'turn', status: 'completed', turnId: 'turn-1' }], session: { status: 'idle' }, workflowSignal: 9 };
  const event: any = { type: 'workflows.changed', deviceId: 'pc', sessionKey, tool: 'codex', ts: 10, seq: 10, goal };
  const next = applyEvent(timeline, event);
  expect(next).toEqual({ ...timeline, workflowSignal: 10 });
  expect(applyEvent(next, { ...event, seq: 8 })).toBe(next);
});
