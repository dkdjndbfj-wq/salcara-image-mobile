import { applyEvent, EMPTY_TIMELINE, mergeHistory, type Timeline } from '../remote/store';
import type { HubEvent } from '../remote/client';
import { runningSince, turnStats } from '../remote/thread-stats';
import { turnControlTarget } from '../remote/turn-control';

jest.mock('../storage/database', () => ({ getSetting: async () => null, setSetting: async () => undefined }));
jest.mock('../storage/secure-keys', () => ({ getProviderKey: async () => 'synthetic-key' }));

const base = { deviceId: 'pc', sessionKey: 'claude:parent', tool: 'claude' as const };
const turn = (seq: number, status: 'started' | 'completed' | 'failed' | 'interrupted', parentId?: string, turnId?: string): Extract<HubEvent, { type: 'turn' }> =>
  ({ ...base, type: 'turn', seq, ts: seq * 1000, status, parentId, turnId });
const verified = (): Timeline => ({ ...EMPTY_TIMELINE, snapshotAt: 1, session: {
  sessionKey: base.sessionKey, tool: 'claude', client: 'cli', title: 'Synthetic', cwd: 'C:/fixture', updatedAt: 1,
  status: 'running', controllable: true, activeTurnId: 'root', controlSurface: 'cli',
} });

test('children sharing a turn ID retain distinct boundaries and cannot replace their parent', () => {
  let timeline = applyEvent(verified(), turn(1, 'started', undefined, 'root'));
  timeline = applyEvent(timeline, turn(2, 'interrupted', 'child:a', 'root'));
  timeline = applyEvent(timeline, turn(3, 'completed', 'child:b', 'root'));
  expect(timeline.items).toHaveLength(3);
  expect(new Set(timeline.items.map(item => item.id)).size).toBe(3);
  expect(timeline.items[1]).toMatchObject({ parentId: 'child:a', status: 'interrupted' });
  expect(turnControlTarget(timeline, 'stop')).toBe('root');
  expect(runningSince(timeline.items)).toBe(1000);
  timeline = applyEvent(timeline, turn(4, 'completed', undefined, 'root'));
  timeline = applyEvent(timeline, turn(5, 'started', 'child:a', 'new-child-turn'));
  timeline.session = { ...timeline.session!, status: 'idle', activeTurnId: undefined, lastTerminalTurnId: 'root' };
  expect(turnControlTarget(timeline, 'continue')).toBe('root');
  expect(runningSince(timeline.items)).toBeUndefined();
});

test('legacy anonymous interruption de-duplication does not cross parent boundaries', () => {
  let timeline = applyEvent(EMPTY_TIMELINE, turn(1, 'interrupted'));
  timeline = applyEvent(timeline, turn(2, 'interrupted', 'child:a'));
  timeline = applyEvent(timeline, turn(3, 'interrupted', 'child:b'));
  timeline = applyEvent(timeline, turn(4, 'interrupted', 'child:b'));
  expect(timeline.items).toHaveLength(3);
  expect(timeline.items.map(item => item.kind === 'turn' ? item.parentId : null)).toEqual([undefined, 'child:a', 'child:b']);
});

test('fresh child history repairs a cache that lost parent scope only at the same Hub cursor', () => {
  const lostScope: Timeline = { ...EMPTY_TIMELINE, items: [
    { kind: 'turn', id: 'turn:interrupted:7', status: 'interrupted', ts: 7000, seq: 7 },
    { kind: 'turn', id: 'turn:interrupted:6', status: 'interrupted', ts: 7000, seq: 6 },
  ] };
  const child = turn(7, 'interrupted', 'child:a');
  for (const result of [applyEvent(lostScope, child), mergeHistory(lostScope, undefined, [child])]) {
    expect(result.items).toHaveLength(2);
    expect(result.items.filter(item => item.kind === 'turn' && !item.parentId)).toMatchObject([lostScope.items[1]]);
    expect(result.items.find(item => item.seq === 7)).toMatchObject({ parentId: 'child:a' });
  }
});

test('cached coalesced child boundaries upgrade without claiming the parent boundary ID', () => {
  const cache: Timeline = { ...EMPTY_TIMELINE, items: [
    { kind: 'turn', id: 'turn:shared', turnId: 'shared', status: 'completed', ts: 3000, seq: 3, orderSeq: 1, parentId: 'child:a' },
  ] };
  const result = mergeHistory(cache, undefined, [turn(1, 'started', undefined, 'shared'), turn(2, 'interrupted', undefined, 'shared')]);
  expect(result.items).toHaveLength(3);
  expect(result.items[2]).toMatchObject({ parentId: 'child:a', seq: 3, orderSeq: 3, status: 'completed' });
  expect(new Set(result.items.map(item => item.id)).size).toBe(3);
});

test('child interruptions and completions cannot reset or overwrite parent reply statistics', () => {
  let timeline = applyEvent(EMPTY_TIMELINE, turn(1, 'started', undefined, 'root'));
  timeline = applyEvent(timeline, { ...base, type: 'message', seq: 2, ts: 2000, id: 'answer', role: 'assistant', text: 'Result', final: true });
  timeline = applyEvent(timeline, turn(3, 'interrupted', 'child:a'));
  timeline = applyEvent(timeline, { ...turn(4, 'completed', 'child:b'), usage: { outputTokens: 999 } });
  timeline = applyEvent(timeline, { ...turn(5, 'completed', undefined, 'root'), usage: { outputTokens: 12 } });
  expect(turnStats(timeline.items).get('answer')).toEqual({ durationMs: 4000, tokens: 12 });
});
