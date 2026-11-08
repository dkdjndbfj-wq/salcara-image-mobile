import { applyEvent, EMPTY_TIMELINE, mergeHistory, type Timeline, type TimelineItem } from '../remote/store';
import type { HubEvent } from '../remote/client';
import type { ContextReference } from '../remote/context-references';
jest.mock('../storage/database', () => ({ getSetting: async () => null, setSetting: async () => undefined }));
jest.mock('../storage/secure-keys', () => ({ getProviderKey: async () => null }));
type Message = Extract<TimelineItem, { kind: 'message' }>;
type MessageEvent = Extract<HubEvent, { type: 'message' }>;
const ref: ContextReference = { kind: 'file', sessionKey: 'codex:thread', label: 'a.ts', path: 'a.ts', text: 'selected code', startLine: 12, endLine: 12, capturedAt: 1 };
const event = (extra: Partial<MessageEvent> = {}): MessageEvent => ({ type: 'message', deviceId: 'pc', sessionKey: 'codex:thread', tool: 'codex', id: 'confirmed', role: 'user', text: 'same', final: true, ts: 2, ...extra });
const local = (extra: Partial<Message> = {}): Message => ({ kind: 'message', id: 'local:one', role: 'user', text: 'same', final: true, local: true, ts: 1, clientId: 'receipt-one', contextReferences: [ref], skills: [{ name: 'review' }], ...extra });
const messages = (timeline: Timeline) => timeline.items.filter((item): item is Message => item.kind === 'message');

test.each(['live', 'history'] as const)('%s keeps references and skills together only with exact receipt identity', mode => {
  const current: Timeline = { items: [local(), local({ id: 'two', clientId: 'receipt-two', contextReferences: [{ ...ref, text: 'other' }] })], loading: false };
  const echo = event({ clientId: 'receipt-two' });
  const result = mode === 'live' ? applyEvent(current, echo) : mergeHistory(current, undefined, [echo]);
  expect(messages(result).find(x => !x.local)).toMatchObject({ contextReferences: [{ ...ref, text: 'other' }], skills: [{ name: 'review' }] });
  expect(messages(result).find(x => x.local)?.clientId).toBe('receipt-one');
});

test.each(['live', 'history'] as const)('%s equal-body legacy echo cannot acquire reference identity', mode => {
  const current: Timeline = { items: [local()], loading: false };
  const result = mode === 'live' ? applyEvent(current, event()) : mergeHistory(current, undefined, [event()]);
  expect(messages(result)[0].contextReferences).toBeUndefined();
});

test('historical snapshots preserve exact refs and explicit empty clears them', () => {
  const current = applyEvent(EMPTY_TIMELINE, event({ contextReferences: [ref], clientId: 'r' }));
  expect(messages(mergeHistory(current, undefined, [event()]))[0].contextReferences).toEqual([ref]);
  expect(messages(applyEvent(current, event({ contextReferences: [] })))[0].contextReferences).toEqual([]);
  expect(messages(applyEvent(current, event({ clientId: 'different' })))[0].contextReferences).toBeUndefined();
  expect(messages(applyEvent(EMPTY_TIMELINE, event({ text: '@a.ts' })))[0].contextReferences).toBeUndefined();
});

test.each([{ role: 'assistant' as const }, { parentId: 'child' }, { messageOrigin: { kind: 'delegation' as const } }])('root receipt never lends refs to unrelated context %j', extra => {
  const result = applyEvent({ items: [local()], loading: false }, event({ clientId: 'receipt-one', ...extra }));
  expect(messages(result).find(x => !x.local)?.contextReferences).toBeUndefined();
});
