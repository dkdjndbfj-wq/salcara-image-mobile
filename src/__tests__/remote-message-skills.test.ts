import { applyEvent, EMPTY_TIMELINE, mergeHistory, type Timeline, type TimelineItem } from '../remote/store';
import type { HubEvent } from '../remote/client';
import { messageSkills } from '../remote/conversation-metadata';

jest.mock('../storage/database', () => ({ getSetting: async () => null, setSetting: async () => undefined }));
jest.mock('../storage/secure-keys', () => ({ getProviderKey: async () => null }));

type Message = Extract<TimelineItem, { kind: 'message' }>;
type MessageEvent = Extract<HubEvent, { type: 'message' }>;
const skills = [{ name: 'review', path: 'C:/codex/skills/review/SKILL.md' }];
const otherSkills = [{ name: 'review', path: 'C:/claude/skills/review/SKILL.md' }];
const event = (extra: Partial<MessageEvent> = {}): MessageEvent => ({ type: 'message', deviceId: 'pc', sessionKey: 'codex:thread', tool: 'codex',
  id: 'confirmed', role: 'user', text: 'same text', final: true, ts: 2, ...extra });
const local = (extra: Partial<Message> = {}): Message => ({ kind: 'message', id: 'local:one', role: 'user', text: 'same text', final: true,
  local: true, ts: 1, clientId: 'receipt-one', skills, ...extra });
const messages = (timeline: Timeline) => timeline.items.filter((item): item is Message => item.kind === 'message');

test('explicit historical skills are copied as references without changing the original body', () => {
  const references = skills.map(skill => ({ ...skill }));
  const result = applyEvent(EMPTY_TIMELINE, event({ text: 'literal $other stays intact', skills: references }));
  references[0].path = 'mutated';
  expect(messages(result)[0]).toMatchObject({ text: 'literal $other stays intact', skills });
  expect(messages(applyEvent(EMPTY_TIMELINE, event({ text: '$review' })))[0].skills).toBeUndefined();
});

test.each([{}, [{ name: 'review', secret: 'hidden' }], [{ name: 'bad\nname' }], [...skills, ...skills]])('malformed message skills are discarded: %j', value => {
  expect(messageSkills(value)).toBeUndefined();
  expect(messages(applyEvent(EMPTY_TIMELINE, event({ skills: value as MessageEvent['skills'] })))[0].skills ?? []).toEqual([]);
});

test.each(['live', 'history'] as const)('%s echo transfers only the exact receipt among same-text submissions', kind => {
  const first = local(), second = local({ id: 'local:two', clientId: 'receipt-two', skills: otherSkills });
  const current: Timeline = { items: [first, second], loading: false };
  const echo = event({ clientId: 'receipt-two' });
  const result = kind === 'live' ? applyEvent(current, echo) : mergeHistory(current, undefined, [echo]);
  expect(messages(result).find(item => !item.local)?.skills).toEqual(otherSkills);
  expect(messages(result).find(item => item.local)).toEqual(first);
});

test.each(['live', 'history'] as const)('%s legacy equal-text matching never transfers selected skills', kind => {
  const current: Timeline = { items: [local()], loading: false };
  const result = kind === 'live' ? applyEvent(current, event()) : mergeHistory(current, undefined, [event()]);
  expect(messages(result)).toHaveLength(1);
  expect(messages(result)[0].skills).toBeUndefined();
});

test.each([{ parentId: 'child' }, { messageOrigin: { kind: 'delegation' as const } }, { role: 'assistant' as const }])('child/delegation/assistant cannot inherit the phone selection: %j', extra => {
  const current: Timeline = { items: [local()], loading: false };
  for (const result of [applyEvent(current, event({ clientId: 'receipt-one', ...extra })), mergeHistory(current, undefined, [event({ clientId: 'receipt-one', ...extra })])]) {
    expect(messages(result).find(item => !item.local)?.skills).toBeUndefined();
    expect(messages(result).find(item => item.local)?.skills).toEqual(skills);
  }
});

test('same-message replay and old history preserve references while another message ID cannot borrow them', () => {
  const current = applyEvent(EMPTY_TIMELINE, event({ skills, clientId: 'receipt-one' }));
  expect(messages(applyEvent(current, event({ ts: 3 })))[0].skills).toEqual(skills);
  const restored = mergeHistory(current, undefined, [event({ ts: 3 }), event({ id: 'different', ts: 4 })]);
  expect(messages(restored).find(item => item.id === 'confirmed')?.skills).toEqual(skills);
  expect(messages(restored).find(item => item.id === 'different')?.skills).toBeUndefined();
});

test('an explicit empty reference list clears old metadata and assistant records never retain it', () => {
  const current = applyEvent(EMPTY_TIMELINE, event({ skills }));
  expect(messages(applyEvent(current, event({ ts: 3, skills: [] })))[0].skills).toEqual([]);
  expect(messages(applyEvent(current, event({ ts: 3, role: 'assistant', skills })))[0].skills).toBeUndefined();
});

test('conflicting message receipt or parent identity does not inherit old skill references', () => {
  const current = applyEvent(EMPTY_TIMELINE, event({ skills, clientId: 'receipt-one' }));
  for (const extra of [{ clientId: 'receipt-two' }, { parentId: 'child' }]) {
    expect(messages(applyEvent(current, event({ ts: 3, ...extra })))[0].skills).toBeUndefined();
  }
});

test('a separately routed session cannot obtain references through a repeated ID, receipt or body', () => {
  const original = applyEvent({ items: [local()], loading: false }, event({ clientId: 'receipt-one' }));
  const other = applyEvent(EMPTY_TIMELINE, event({ sessionKey: 'claude:thread', tool: 'claude', clientId: 'receipt-one' }));
  expect(messages(original)[0].skills).toEqual(skills);
  expect(messages(other)[0].skills).toBeUndefined();
});

test('a malformed local child cannot lend skill metadata to an ordinary root echo', () => {
  const current: Timeline = { items: [local({ parentId: 'child' })], loading: false };
  for (const result of [applyEvent(current, event({ clientId: 'receipt-one' })), mergeHistory(current, undefined, [event({ clientId: 'receipt-one' })])]) {
    expect(messages(result).find(item => !item.local)?.skills).toBeUndefined();
  }
});
