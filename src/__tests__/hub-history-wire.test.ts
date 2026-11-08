import type { HubEvent } from '../remote/client';
import { applyEvent, EMPTY_TIMELINE, mergeHistory, type Timeline } from '../remote/store';

const attachment = { id: `att_${'a'.repeat(32)}`, mime: 'image/png', size: 100, sha256: 'b'.repeat(64) };
const wire = (type: 'message' | 'reasoning', fields: Record<string, unknown> = {}) =>
  JSON.parse(JSON.stringify({ type, sessionKey: 'codex:wire', tool: 'codex', ts: 2, id: 'remote', ...(type === 'message' ? { role: 'assistant' } : {}), ...fields })) as HubEvent;
const optimistic: Timeline = { ...EMPTY_TIMELINE, items: [{ kind: 'message', role: 'user', id: 'local', text: '', final: true, ts: 1,
  local: true, attachments: [{ ...attachment, uri: 'data:image/png;base64,AA==' }], images: ['data:image/png;base64,AA=='] }] };

test.each(['message', 'reasoning'] as const)('initial and older Hub history normalize omitted %s text/final without needing deviceId', type => {
  const raw = Object.freeze(wire(type));
  expect(Object.hasOwn(raw, 'deviceId')).toBe(false);
  const initial = mergeHistory(EMPTY_TIMELINE, undefined, [raw]);
  const older = applyEvent(EMPTY_TIMELINE, raw);
  expect(initial.items[0]).toMatchObject({ kind: type, id: 'remote', text: '', final: false });
  expect(older.items).toEqual(initial.items);
  expect(Object.hasOwn(raw, 'text')).toBe(false);
  expect(Object.hasOwn(raw, 'final')).toBe(false);
});

test('an image-only raw history echo replaces only the matching optimistic image prompt', () => {
  const echo = wire('message', { role: 'user', final: true, attachments: [attachment] });
  const live = applyEvent(optimistic, echo);
  const initial = mergeHistory(optimistic, undefined, [echo]);
  for (const result of [live, initial]) {
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ kind: 'message', id: 'remote', role: 'user', text: '', final: true });
  }
  expect(live.items[0]).toMatchObject({ attachments: [{ ...attachment, uri: 'data:image/png;base64,AA==' }], images: ['data:image/png;base64,AA=='] });
  const different = applyEvent(optimistic, wire('message', { role: 'user', final: true, attachments: [{ ...attachment, id: `att_${'c'.repeat(32)}` }] }));
  expect(different.items).toHaveLength(2);
});

test.each([{ text: null }, { text: 42 }, { final: null }, { final: 'false' }, { final: 0 }])(
  'raw history skips invalid values %j without consuming an optimistic prompt', malformed => {
    for (const type of ['message', 'reasoning'] as const) {
      const event = wire(type, { role: 'user', attachments: [attachment], ...malformed });
      expect(applyEvent(optimistic, event)).toBe(optimistic);
      expect(mergeHistory(optimistic, undefined, [event]).items).toEqual(optimistic.items);
    }
  },
);
