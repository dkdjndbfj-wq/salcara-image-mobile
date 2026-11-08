import { applyEvent, EMPTY_TIMELINE, mergeHistory, type Timeline, type TimelineItem } from '../remote/store';
import type { HubEvent } from '../remote/client';

jest.mock('../storage/database', () => ({ getSetting: async () => null, setSetting: async () => undefined }));
jest.mock('../storage/secure-keys', () => ({ getProviderKey: async () => 'synthetic-key' }));

type MessageEvent = Extract<HubEvent, { type: 'message' }>;
const base = { deviceId: 'pc', sessionKey: 'codex:conversation', tool: 'codex' as const, turnId: 'turn-1' };
const message = (id: string, seq: number, props: Partial<MessageEvent> = {}): MessageEvent => ({
  ...base, type: 'message', id, seq, ts: seq * 1000, role: 'assistant', text: id, final: true, ...props,
});
const messages = (timeline: Timeline) => timeline.items.filter((item): item is Extract<TimelineItem, { kind: 'message' }> => item.kind === 'message');

test.each(['terminal-unconfirmed', 'incomplete'] as const)('a bounded final snapshot preserves distinct %s commentary before tool activity', streamState => {
  let current = applyEvent(EMPTY_TIMELINE, message('commentary', 1, { final: false, messagePhase: 'commentary', text: 'Checking the implementation.' }));
  current = applyEvent(current, { ...base, type: 'tool', id: 'read-file', seq: 2, ts: 2000, kind: 'read', title: 'Read source', status: 'done' });
  current = { ...current, items: current.items.map(item => item.kind === 'message' ? { ...item, streamState } : item) };

  const result = mergeHistory(current, undefined, [message('answer', 3, { messagePhase: 'final_answer', text: 'The implementation is ready.' })]);

  expect(result.items.map(item => item.id)).toEqual(['commentary', 'read-file', 'answer']);
  expect(messages(result)).toMatchObject([
    { id: 'commentary', text: 'Checking the implementation.', messagePhase: 'commentary', streamState },
    { id: 'answer', text: 'The implementation is ready.', messagePhase: 'final_answer', final: true },
  ]);
});

test.each([undefined, 'final_answer'] as const)('distinct message IDs survive even when their phase is the same (%s)', messagePhase => {
  const current: Timeline = { ...EMPTY_TIMELINE, items: [
    { kind: 'message', id: 'earlier-block', role: 'assistant', text: 'First body paragraph.', final: false,
      streamState: 'terminal-unconfirmed', ts: 1000, seq: 1, turnId: base.turnId, messagePhase },
  ] };
  const result = mergeHistory(current, undefined, [message('later-block', 2, { messagePhase, text: 'Second body paragraph.' })]);
  expect(messages(result).map(item => item.text)).toEqual(['First body paragraph.', 'Second body paragraph.']);
});

test('the same ID final repairs a partial while retaining its original position before tools', () => {
  const current: Timeline = { ...EMPTY_TIMELINE, items: [
    { kind: 'message', id: 'answer', role: 'assistant', text: 'First', final: false, streamState: 'incomplete',
      ts: 1000, seq: 1, orderSeq: 1, turnId: base.turnId, messagePhase: 'final_answer' },
    { kind: 'tool', id: 'verify', tool: 'command', title: 'Verify', status: 'done', ts: 2000, seq: 2, turnId: base.turnId },
  ] };
  const result = mergeHistory(current, undefined, [message('answer', 3, { text: 'First paragraph is complete.', messagePhase: 'final_answer' })]);
  expect(result.items.map(item => item.id)).toEqual(['answer', 'verify']);
  expect(messages(result)).toHaveLength(1);
  expect(messages(result)[0]).toMatchObject({ text: 'First paragraph is complete.', final: true, seq: 3, orderSeq: 1 });
  expect(messages(result)[0].streamState).toBeUndefined();
});

test.each([true, false])('a newer live final survives a stale snapshot (snapshot final=%s)', final => {
  const current = applyEvent(EMPTY_TIMELINE, message('answer', 3, { text: 'Current complete answer.', messagePhase: 'final_answer' }));
  const result = mergeHistory(current, undefined, [message('answer', 1, { text: 'Old snapshot', final, messagePhase: 'final_answer' })]);
  expect(messages(result)).toHaveLength(1);
  expect(messages(result)[0]).toMatchObject({ text: 'Current complete answer.', final: true, seq: 3, orderSeq: 1 });
  expect(messages(result)[0].streamState).toBeUndefined();
});

test('a parent final does not remove an earlier child commentary block', () => {
  const current: Timeline = { ...EMPTY_TIMELINE, items: [
    { kind: 'message', id: 'child-commentary', role: 'assistant', text: 'Child progress.', final: false,
      streamState: 'terminal-unconfirmed', ts: 1000, seq: 1, turnId: base.turnId, parentId: 'child:a', messagePhase: 'commentary' },
  ] };
  const result = mergeHistory(current, undefined, [message('parent-answer', 2, { messagePhase: 'final_answer' })]);
  expect(messages(result).map(item => item.id)).toEqual(['child-commentary', 'parent-answer']);
  expect(messages(result)[0].parentId).toBe('child:a');
  expect(messages(result)[1].parentId).toBeUndefined();
});
