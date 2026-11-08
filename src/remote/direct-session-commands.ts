import { randomUUID } from 'expo-crypto';
import type { Command } from './client';
import { directActionUncertain } from './direct-turn-actions';
import { parseNativeSessionActionResult, parseNativeSessionActions } from './session-actions';
import { parseSessionWorkflowResult, parseSessionWorkflows } from './session-workflows';
import type { SessionCommandTransport } from './session-commands';

// Keep uncertain revisions across composer/popover remounts. The Bridge owns
// durable receipts; a fresh read must advance before this client can resubmit.
type State = { flight?: object; uncertain: Set<string> };
const states = new Map<string, State>();
const stateFor = (scope: string) => {
  let state = states.get(scope);
  if (!state) {
    if (states.size >= 512) for (const [key, candidate] of states) { if (!candidate.flight && !candidate.uncertain.size) { states.delete(key); break; } }
    if (states.size >= 512) throw new Error('请先核对已有的会话操作');
    state = { uncertain: new Set() }; states.set(scope, state);
  }
  return state;
};
const uncertainError = (error: unknown) => {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  return directActionUncertain(error) || code !== 'remote' && code !== 'busy';
};

/** Reuses the existing Direct protocol, never the currently selected Hub. */
export function createDirectSessionCommands({ scope, sessionKey, isCurrent, guard, need, send, base }: {
  scope: string; sessionKey: string; isCurrent: () => boolean; guard: () => void;
  need: (capability: 'sessionActions' | 'sessionWorkflows') => void;
  send: (command: Command, timeoutMs?: number) => Promise<unknown>;
  base: { tool: string; sessionKey: string; controlSurface: 'cli'; accountId?: string };
}): SessionCommandTransport {
  const check = (capability: 'sessionActions' | 'sessionWorkflows') => { guard(); if (!isCurrent()) throw new Error('当前控制方式不支持会话操作'); need(capability); };
  const read = async <T,>(capability: 'sessionActions' | 'sessionWorkflows', type: 'session.actions' | 'session.workflows', parse: (raw: unknown, key: string) => T | undefined, signal?: AbortSignal) => {
    check(capability); if (signal?.aborted) throw new Error('读取已取消');
    const raw = await send({ ...base, type });
    check(capability); if (signal?.aborted) throw new Error('读取已取消');
    const value = parse(raw, sessionKey); if (!value) throw new Error('电脑返回的会话状态无效');
    return value;
  };
  const mutate = async <T extends { state: string },>(kind: 'actions' | 'review', revision: string, execute: () => Promise<T>) => {
    const state = stateFor(scope), key = `${kind}:${revision}`;
    if (state.flight || state.uncertain.has(key)) throw new Error('上次操作尚未确认，请刷新状态');
    const token = {}; state.flight = token;
    try {
      const result = await execute();
      if (result.state === 'unconfirmed') state.uncertain.add(key);
      else state.uncertain.delete(key);
      return result;
    } catch (error) { if (uncertainError(error)) state.uncertain.add(key); throw error; }
    finally {
      if (state.flight === token) state.flight = undefined;
    }
  };
  return {
    scope: () => scope, isCurrent,
    readActions: async signal => {
      const value = await read('sessionActions', 'session.actions', parseNativeSessionActions, signal);
      if (stateFor(scope).uncertain.has(`actions:${value.revision}`)) { value.actions = []; value.unavailableReason = '上次操作结果未确认'; }
      return { scope, value };
    },
    applyAction: async (reading, action) => {
      check('sessionActions');
      if (reading.scope !== scope || reading.value.sessionKey !== sessionKey || !reading.value.revision || !reading.value.actions.includes(action)) throw new Error('请刷新并确认会话操作');
      return mutate('actions', reading.value.revision, async () => {
        const operationId = randomUUID();
        const raw = await send({ ...base, type: 'session.action', action, expectedRevision: reading.value.revision, operationId }, 110000);
        check('sessionActions');
        const result = parseNativeSessionActionResult(raw, sessionKey, action, operationId);
        if (!result) throw new Error('会话操作结果未确认');
        return result;
      });
    },
    readWorkflows: async signal => {
      const value = await read('sessionWorkflows', 'session.workflows', parseSessionWorkflows, signal);
      if (stateFor(scope).uncertain.has(`review:${value.revision}`)) { value.canReview = false; value.unavailableReason = '上次审查结果未确认'; }
      return { scope, value };
    },
    applyReview: async reading => {
      check('sessionWorkflows');
      if (reading.scope !== scope || reading.value.sessionKey !== sessionKey || !reading.value.revision || !reading.value.canReview) throw new Error('请刷新并确认审查状态');
      return mutate('review', reading.value.revision, async () => {
        const operationId = randomUUID(), input = { kind: 'review' as const, target: { type: 'uncommittedChanges' as const } };
        const raw = await send({ ...base, type: 'session.workflow', ...input, expectedRevision: reading.value.revision, operationId }, 110000);
        check('sessionWorkflows');
        const result = parseSessionWorkflowResult(raw, sessionKey, input, operationId);
        if (!result) throw new Error('审查结果未确认');
        return result;
      });
    },
  };
}
