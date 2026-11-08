import type { SessionInfo } from '../remote/client';
import type { TimelineItem } from '../remote/store';
import { hasActiveAgentWork } from '../remote/work-activity';

const idleSession: SessionInfo = {
  sessionKey: 'codex:work-state', tool: 'codex', client: 'Codex', title: 'work state', cwd: 'C:/fixture', updatedAt: 1,
  status: 'idle', controllable: true,
};

test.each([
  ['host running status', { ...idleSession, status: 'running' as const }, [], 0],
  ['active turn ID', { ...idleSession, activeTurnId: 'turn-live' }, [], 0],
  ['started turn event', idleSession, [{ kind: 'turn', id: 'turn-live', turnId: 'turn-live', status: 'started', ts: 1 } as TimelineItem], 0],
  ['partial assistant response', idleSession, [{ kind: 'message', id: 'partial', role: 'assistant', text: 'thinking', final: false, ts: 1 } as TimelineItem], 0],
  ['partial reasoning response', idleSession, [{ kind: 'reasoning', id: 'partial', text: 'thinking', final: false, ts: 1 } as TimelineItem], 0],
  ['running tool', idleSession, [{ kind: 'tool', id: 'tool-live', tool: 'command', title: 'command', status: 'running', ts: 1 } as TimelineItem], 0],
  ['active context compaction', idleSession, [{ kind: 'notice', id: 'compact', level: 'info', text: 'Compacting', noticeKind: 'context_compaction', progress: true, ts: 1 } as TimelineItem], 0],
  ['pending approval', idleSession, [], 1],
] as const)('treats %s as active host work', (_name, session, items, approvals) => {
  expect(hasActiveAgentWork(session, [...items], approvals)).toBe(true);
});

test('a terminal turn suppresses stale running fields and old partial output', () => {
  const items: TimelineItem[] = [
    { kind: 'reasoning', id: 'old-partial', text: 'old reasoning', final: false, seq: 3, ts: 3 },
    { kind: 'turn', id: 'turn-finished', turnId: 'turn-old', status: 'completed', seq: 8, ts: 8 },
  ];
  expect(hasActiveAgentWork({ ...idleSession, status: 'running', activeTurnId: 'turn-old', lastTerminalTurnId: 'turn-old' }, items, 0, 7)).toBe(false);
  expect(hasActiveAgentWork({ ...idleSession, status: 'running', activeTurnId: 'turn-new', lastTerminalTurnId: 'turn-old' }, items, 0, 7)).toBe(true);
  expect(hasActiveAgentWork({ ...idleSession, status: 'running', activeTurnId: 'turn-old', lastTerminalTurnId: 'turn-old' }, items, 0, 9)).toBe(true);
});

test('a finished child turn does not keep the parent active', () => {
  const items: TimelineItem[] = [
    { kind: 'turn', id: 'child-done', turnId: 'child', parentId: 'subagent-1', status: 'completed', ts: 3 },
  ];
  expect(hasActiveAgentWork(idleSession, items)).toBe(false);
});

test('a live child turn remains active when the parent is otherwise idle', () => {
  const items: TimelineItem[] = [
    { kind: 'turn', id: 'child-live', turnId: 'child', parentId: 'subagent-1', status: 'started', ts: 3 },
  ];
  expect(hasActiveAgentWork(idleSession, items)).toBe(true);
});
