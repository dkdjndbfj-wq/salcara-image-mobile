import { isDirectEvent, mergeDirectHistoryPage, normalizeDirectEvent, parseDirectHistoryPage } from '../remote/direct-history';
import { applyEvent, EMPTY_TIMELINE } from '../remote/store';

const session = { sessionKey: 'codex:wire', tool: 'codex', client: 'Codex CLI', title: 'Wire events', cwd: 'C:/project', updatedAt: 1, status: 'running', controllable: true, controlSurface: 'cli' };
const base = { deviceId: 'pc', sessionKey: session.sessionKey, tool: 'codex', ts: 2, seq: 2, id: 'wire-text' };
// protocol.Event uses json omitempty for both text and final. Fixtures model
// the serialized envelope rather than a TypeScript event with explicit defaults.
const wire = (type: 'message' | 'reasoning', fields: Record<string, unknown>) => JSON.parse(JSON.stringify({ ...base, type, ...(type === 'message' ? { role: 'assistant' } : {}), ...fields })) as Record<string, unknown>;

test.each(['message', 'reasoning'] as const)('normalizes omitted final on a real %s streaming envelope through live and history paths', type => {
  const event = wire(type, { text: 'Partial response' });
  expect(Object.hasOwn(event, 'final')).toBe(false);
  expect(isDirectEvent(event, 'pc', session.sessionKey)).toBe(true);
  if (!isDirectEvent(event, 'pc', session.sessionKey)) throw new Error('Direct dropped a streaming event');
  const normalized = { ...event, final: false };
  expect(normalizeDirectEvent(event, 'pc')).toEqual(normalized);
  const page = parseDirectHistoryPage({ session, events: [event] }, 'pc', session);
  expect(page.events).toEqual([normalized]);
  const expected = { kind: type, id: base.id, text: 'Partial response', final: false };
  expect(applyEvent(EMPTY_TIMELINE, normalizeDirectEvent(event, 'pc')).items[0]).toMatchObject(expected);
  expect(mergeDirectHistoryPage(EMPTY_TIMELINE, page, []).items[0]).toMatchObject(expected);
});

test.each(['message', 'reasoning'] as const)('accepts omitted empty text and false final on a %s item start', type => {
  const event = wire(type, {});
  expect(Object.hasOwn(event, 'text')).toBe(false);
  expect(Object.hasOwn(event, 'final')).toBe(false);
  const page = parseDirectHistoryPage({ session, events: [event] }, 'pc', session);
  expect(page.events).toEqual([{ ...event, text: '', final: false }]);
  if (!isDirectEvent(event, 'pc', session.sessionKey)) throw new Error('Direct dropped an item start');
  expect(normalizeDirectEvent(event, 'pc')).toEqual(page.events[0]);
});

test('preserves a pure-image message when the Bridge omits its empty text', () => {
  const attachment = { id: `att_${'a'.repeat(32)}`, mime: 'image/png', size: 100, sha256: 'b'.repeat(64), width: 400, height: 300 };
  const event = wire('message', { final: true, attachments: [attachment] });
  expect(Object.hasOwn(event, 'text')).toBe(false);
  const page = parseDirectHistoryPage({ session, events: [event] }, 'pc', session);
  expect(page.events).toEqual([{ ...event, text: '' }]);
  if (!isDirectEvent(event, 'pc', session.sessionKey)) throw new Error('Direct dropped an image-only message');
  const expected = { kind: 'message', id: base.id, role: 'assistant', text: '', final: true, attachments: [attachment] };
  expect(applyEvent(EMPTY_TIMELINE, normalizeDirectEvent(event, 'pc')).items[0]).toMatchObject(expected);
  expect(mergeDirectHistoryPage(EMPTY_TIMELINE, page, []).items[0]).toMatchObject(expected);
});

test.each(['message', 'reasoning'] as const)('merges a %s completion received while loading a partial wire snapshot', type => {
  const partial = wire(type, { text: 'Partial' });
  const complete = wire(type, { ts: 3, seq: 3, text: 'Complete response', final: true });
  const page = parseDirectHistoryPage({ session, events: [partial] }, 'pc', session);
  if (!isDirectEvent(complete, 'pc', session.sessionKey)) throw new Error('Direct dropped completion');
  const normalized = normalizeDirectEvent(complete, 'pc');
  const buffered = mergeDirectHistoryPage(EMPTY_TIMELINE, page, [normalized]);
  const live = applyEvent(mergeDirectHistoryPage(EMPTY_TIMELINE, page, []), normalized);
  expect(buffered.items).toHaveLength(1);
  expect(buffered.items[0]).toMatchObject({ kind: type, id: base.id, text: 'Complete response', final: true });
  expect(live.items).toEqual(buffered.items);
});

test.each([
  { text: null }, { text: 42 }, { text: [] },
  { final: null }, { final: 'false' }, { final: 0 },
])('rejects explicitly malformed text fields %j instead of applying omitted-field defaults', malformed => {
  for (const type of ['message', 'reasoning'] as const) {
    const event = wire(type, { text: 'Message', final: true, ...malformed });
    expect(isDirectEvent(event, 'pc', session.sessionKey)).toBe(false);
    expect(parseDirectHistoryPage({ session, events: [event] }, 'pc', session).events).toEqual([]);
  }
});
