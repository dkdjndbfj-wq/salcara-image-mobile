import { confirmPair, devices, hubUrlFor, openStream, setHubFetch, type FetchLike, type HubEvent } from '../remote/client';
import { applyEvent, EMPTY_TIMELINE, mergeHistory, type Timeline } from '../remote/store';

jest.mock('../storage/database', () => ({ getSetting: async () => null, setSetting: async () => undefined }));
jest.mock('../storage/secure-keys', () => ({ getProviderKey: async () => 'sk-test' }));

const encoder = new TextEncoder();

function streamResponse(chunks: string[], status = 200) {
  let index = 0;
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? (status === 200 ? 'text/event-stream' : 'application/json') : null) },
    text: async () => chunks.join(''),
    body: { getReader: () => ({ read: async () => (index < chunks.length ? { done: false, value: encoder.encode(chunks[index++]) } : { done: true }), cancel: () => undefined }) },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
async function until(check: () => boolean, tries = 200) {
  for (let i = 0; i < tries && !check(); i += 1) await flush();
  if (!check()) throw new Error('timed out');
}

const event = (seq: number, extra: Record<string, unknown>) => JSON.stringify({ seq, deviceId: 'd1', sessionKey: 'codex:t1', tool: 'codex', ts: 1000 + seq, ...extra });

afterEach(() => setHubFetch(null));

test('derives the hub address from the relay origin', () => {
  expect(hubUrlFor('https://api.relay.top/v1')).toBe('https://api.relay.top/salcara-hub/v1');
  expect(hubUrlFor('http://10.0.0.2:3000/openai/v1/')).toBe('http://10.0.0.2:3000/salcara-hub/v1');
  expect(hubUrlFor('not a url')).toBe(null);
});

test('pairing requires a one-time code and later requests carry the pair token', async () => {
  const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
  setHubFetch((async (url: string, init: Record<string, unknown>) => {
    calls.push({ url, init });
    const payload = url.endsWith('/app/pair/confirm')
      ? { pair_token: 'a'.repeat(64), device: { deviceId: 'pc-1', name: 'PC' } }
      : { devices: [{ deviceId: 'pc-1', name: 'PC' }] };
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  }) as FetchLike);
  const hub = { url: 'https://r.top/salcara-hub/v1', key: 'sk-test' };
  const pair = await confirmPair(hub, ' abcd2345 ');
  expect(pair.token).toBe('a'.repeat(64));
  expect(JSON.parse(String(calls[0].init.body))).toEqual({ code: 'ABCD2345' });
  expect(calls[0].init.headers).not.toHaveProperty('X-Salcara-Pair-Token');
  expect(await devices({ ...hub, pairToken: pair.token })).toHaveLength(1);
  expect(calls[1].init.headers).toMatchObject({ Authorization: 'Bearer sk-test', 'X-Salcara-Pair-Token': pair.token });
});

test('stream parses events split across chunks, skips pings and resumes after the last seq with backoff', async () => {
  const urls: string[] = [];
  const responses = [
    streamResponse([
      ': ping\n\nevent: ev', `ent\ndata: ${event(1, { type: 'message', id: 'm1', role: 'assistant', text: '你好', final: false })}\n`,
      `\nevent: device\ndata: {"deviceId":"d1","name":"PC","online":true}\n\n`,
      `event: event\ndata: ${event(2, { type: 'message', id: 'm1', role: 'assistant', text: '你好呀', final: true })}\n\n`,
    ]),
    streamResponse([], 502),
    streamResponse([
      // Replay overlap: seq 2 again must be dropped.
      `event: event\ndata: ${event(2, { type: 'message', id: 'm1', role: 'assistant', text: 'dup', final: true })}\n\n`,
      `event: event\ndata: ${event(3, { type: 'turn', status: 'completed' })}\n\n`,
    ]),
  ];
  setHubFetch((async (url: string) => { urls.push(url); return responses.shift() ?? streamResponse([], 401); }) as unknown as FetchLike);
  const events: HubEvent[] = [];
  const devices: unknown[] = [];
  const waits: number[] = [];
  const states: string[] = [];
  const handle = openStream({
    hub: { url: 'https://r.top/salcara-hub/v1', key: 'k' }, after: 0,
    onEvent: (item) => events.push(item), onDevice: (item) => devices.push(item), onState: (state) => states.push(state),
    wait: async (ms) => { waits.push(ms); },
  });
  await until(() => states[states.length - 1] === 'closed');
  expect(events.map((item) => item.seq)).toEqual([1, 2, 3]);
  expect((events[1] as { text: string }).text).toBe('你好呀');
  expect(devices.length).toBe(1);
  expect(urls).toEqual([
    'https://r.top/salcara-hub/v1/app/stream?after=0',
    'https://r.top/salcara-hub/v1/app/stream?after=2',
    'https://r.top/salcara-hub/v1/app/stream?after=2',
    'https://r.top/salcara-hub/v1/app/stream?after=3',
  ]);
  // open → reset to 1 s; failure doubles; next success resets again.
  expect(waits).toEqual([1000, 2000, 1000]);
  expect(handle.lastSeq()).toBe(3);
});

test('backoff grows to 30 s and close() stops reconnecting', async () => {
  let calls = 0;
  setHubFetch((async () => { calls += 1; throw new Error('offline'); }) as unknown as FetchLike);
  const waits: number[] = [];
  const states: string[] = [];
  let handle: { close: () => void } | null = null;
  handle = openStream({
    hub: { url: 'https://r.top/salcara-hub/v1', key: 'k' }, onEvent: () => undefined, onDevice: () => undefined, onState: (state) => states.push(state),
    wait: async (ms) => { waits.push(ms); if (waits.length === 7) handle?.close(); },
  });
  await until(() => states[states.length - 1] === 'closed');
  expect(waits).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  expect(calls).toBe(7);
});

test('timeline merges streamed items by id and tracks approvals', () => {
  const base = { deviceId: 'd1', sessionKey: 'codex:t1', tool: 'codex' as const };
  let timeline: Timeline = { ...EMPTY_TIMELINE, items: [{ kind: 'message', id: 'local:1', role: 'user', text: '跑测试', final: true, ts: 1, local: true }] };
  timeline = applyEvent(timeline, { ...base, ts: 2, type: 'message', id: 'u1', role: 'user', text: '跑测试', final: true });
  timeline = applyEvent(timeline, { ...base, ts: 3, type: 'tool', id: 't1', kind: 'command', title: '运行 npm test', status: 'running' });
  timeline = applyEvent(timeline, { ...base, ts: 4, type: 'approval.request', approvalId: 'a1', kind: 'command', title: '运行 npm test' });
  timeline = applyEvent(timeline, { ...base, ts: 5, type: 'tool', id: 't1', kind: 'command', title: '运行 npm test', status: 'done', output: 'ok', exitCode: 0 });
  timeline = applyEvent(timeline, { ...base, ts: 6, type: 'approval.resolved', approvalId: 'a1', decision: 'allow', by: 'phone' });
  // A late replay of the request must not reopen it.
  timeline = applyEvent(timeline, { ...base, ts: 4, type: 'approval.request', approvalId: 'a1', kind: 'command', title: '运行 npm test' });
  timeline = applyEvent(timeline, { ...base, ts: 7, type: 'turn', status: 'completed', usage: { inputTokens: 10, outputTokens: 2 } });
  timeline = applyEvent(timeline, { ...base, ts: 8, type: 'turn', status: 'completed' });
  expect(timeline.items.map((item) => `${item.kind}:${item.id}`)).toEqual(['message:u1', 'tool:t1', 'approval:a1', 'turn:turn:completed:7']);
  expect(timeline.items[1]).toMatchObject({ status: 'done', output: 'ok' });
  expect(timeline.items[2]).toMatchObject({ state: 'allow', by: 'phone' });
});

test('session history keeps newer live items and resolved approvals', () => {
  const base = { deviceId: 'd1', sessionKey: 'claude:s', tool: 'claude' as const };
  let live = applyEvent(EMPTY_TIMELINE, { ...base, ts: 50, type: 'approval.request', approvalId: 'a1', kind: 'file_change', title: '修改 a.ts' });
  live = applyEvent(live, { ...base, ts: 60, type: 'approval.resolved', approvalId: 'a1', decision: 'deny', by: 'desktop' });
  live = applyEvent(live, { ...base, ts: 70, type: 'message', id: 'm9', role: 'assistant', text: '好的', final: false });
  const merged = mergeHistory(live, undefined, [
    { ...base, ts: 10, type: 'message', id: 'm1', role: 'user', text: '改一下', final: true },
    { ...base, ts: 50, type: 'approval.request', approvalId: 'a1', kind: 'file_change', title: '修改 a.ts' },
  ]);
  expect(merged.items.map((item) => item.id)).toEqual(['m1', 'a1', 'm9']);
  expect(merged.items[1]).toMatchObject({ state: 'deny' });
});
