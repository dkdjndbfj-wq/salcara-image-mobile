import { openStream, parseHubEvent, sessionEventsPage, setHubFetch, type FetchLike, type HubEvent } from '../remote/client';
import { applyEvent, EMPTY_TIMELINE } from '../remote/store';

const hub = { url: 'https://fixture.example/salcara-hub/v1', deviceId: 'pc', pairToken: 'paired' };
const base = { deviceId: 'pc', sessionKey: 'codex:wire', tool: 'codex', ts: 2, seq: 2, id: 'wire-item' };
// Model the JSON serialized by protocol.Event, which omits zero text/final.
const wire = (type: 'message' | 'reasoning', fields: Record<string, unknown> = {}) =>
  JSON.parse(JSON.stringify({ ...base, type, ...(type === 'message' ? { role: 'assistant' } : {}), ...fields })) as Record<string, unknown>;
const page = (events: Record<string, unknown>[]) => {
  setHubFetch((async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ events, nextSeq: 3, lastSeq: 3 }) })) as FetchLike);
  return sessionEventsPage(hub, 'pc', base.sessionKey, 0);
};

afterEach(() => setHubFetch(null));

test.each(['message', 'reasoning'] as const)('Hub event recovery accepts a streaming %s without final and feeds the shared reducer', async type => {
  const event = wire(type, { text: 'Partial reply' });
  const recovered = await page([event]);
  expect(recovered.events).toEqual([{ ...event, final: false }]);
  expect(applyEvent(EMPTY_TIMELINE, recovered.events[0]).items[0]).toMatchObject({ kind: type, text: 'Partial reply', final: false });
});

test.each(['message', 'reasoning'] as const)('Hub normalizes an empty %s start without mutating the caller envelope', async type => {
  const event = Object.freeze(wire(type));
  const normalized = parseHubEvent(event);
  expect(normalized).toEqual({ ...event, text: '', final: false });
  expect(normalized).not.toBe(event);
  expect(Object.hasOwn(event, 'text')).toBe(false);
  expect(Object.hasOwn(event, 'final')).toBe(false);
  expect((await page([event])).events).toEqual([normalized]);
});

test('Hub preserves an image-only final message when empty text is omitted', async () => {
  const attachment = { id: `att_${'a'.repeat(32)}`, mime: 'image/png', size: 100, sha256: 'b'.repeat(64), width: 400, height: 300 };
  const event = wire('message', { final: true, attachments: [attachment] });
  const recovered = await page([event]);
  expect(recovered.events).toEqual([{ ...event, text: '' }]);
  expect(applyEvent(EMPTY_TIMELINE, recovered.events[0]).items[0]).toMatchObject({ kind: 'message', text: '', final: true, attachments: [attachment] });
});

test.each(['message', 'reasoning'] as const)('a %s completion updates the recovered partial item once', async type => {
  const recovered = await page([wire(type, { text: 'Partial' }), wire(type, { seq: 3, ts: 3, text: 'Complete', final: true })]);
  const timeline = recovered.events.reduce(applyEvent, EMPTY_TIMELINE);
  expect(timeline.items).toHaveLength(1);
  expect(timeline.items[0]).toMatchObject({ kind: type, id: base.id, text: 'Complete', final: true });
  expect(recovered.nextSeq).toBe(3);
});

test.each([{ text: null }, { text: 42 }, { text: [] }, { final: null }, { final: 'false' }, { final: 0 }])(
  'Hub rejects explicit invalid values %j instead of defaulting them', async malformed => {
    for (const type of ['message', 'reasoning'] as const) {
      const event = wire(type, { text: 'Reply', final: true, ...malformed });
      expect(() => parseHubEvent(event)).toThrow(/无效/);
      await expect(page([event])).rejects.toThrow(/无效/);
    }
  },
);

test('Hub SSE delivers omitted fields and resumes after them without replaying the rejected cursor', async () => {
  const events = [wire('message', { text: 'Streaming' }), wire('reasoning', { id: 'reasoning', seq: 3, ts: 3 })];
  const urls: string[] = [];
  setHubFetch((async (url: string) => {
    urls.push(url);
    if (urls.length > 1) return { ok: false, status: 401, text: async () => '{}' };
    let sent = false;
    return { ok: true, status: 200, headers: { get: () => 'text/event-stream' }, body: { getReader: () => ({
      read: async () => {
        if (sent) return { done: true };
        sent = true;
        return { done: false, value: new TextEncoder().encode(events.map(event => `event: event\ndata: ${JSON.stringify(event)}\n\n`).join('')) };
      }, cancel: () => undefined,
    }) } };
  }) as FetchLike);
  const received: HubEvent[] = [];
  let closed!: () => void;
  const completion = new Promise<void>(resolve => { closed = resolve; });
  const stream = openStream({ hub, onEvent: event => received.push(event), onDevice: () => undefined,
    onState: state => { if (state === 'closed') closed(); }, wait: async () => undefined });
  try {
    await completion;
    expect(received).toEqual([{ ...events[0], final: false }, { ...events[1], text: '', final: false }]);
    expect(stream.lastSeq()).toBe(3);
    expect(urls[1]).toContain('after=3');
    expect(received.reduce(applyEvent, EMPTY_TIMELINE).items).toHaveLength(2);
  } finally { stream.close(); }
});
