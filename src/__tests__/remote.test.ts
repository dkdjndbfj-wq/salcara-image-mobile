import { confirmPair, devices, hubUrlFor, openStream, parseBotBindingPackage, sessionEventsPage, setHubFetch, type FetchLike, type HubEvent } from '../remote/client';
import { applyEvent, applyRecoveredEvent, EMPTY_TIMELINE, mergeHistory, type Timeline } from '../remote/store';
import { buildBlocks } from '../remote/blocks';
import { turnStats } from '../remote/thread-stats';

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

test('Bot binding parser rejects unknown fields and non-HTTPS Hub URLs', () => {
  const binding = { type: 'salcara-hub-bot-binding', version: 1, hubUrl: 'https://relay.test/salcara-hub', groupId: 'group-1', invite: 'a'.repeat(64), signature: 'b'.repeat(64) };
  expect(parseBotBindingPackage(JSON.stringify(binding))).toEqual(binding);
  expect(() => parseBotBindingPackage(JSON.stringify({ ...binding, extra: true }))).toThrow('Bot 绑定包字段无效');
  expect(() => parseBotBindingPackage(JSON.stringify({ ...binding, hubUrl: 'http://relay.test/salcara-hub' }))).toThrow('Bot 绑定包字段无效');
});

test('event page cursor never regresses behind a returned event', async () => {
  setHubFetch((async () => ({ ok: true, status: 200, text: async () => JSON.stringify({
    events: [{ seq: 12, deviceId: 'd1', sessionKey: 'codex:t1', tool: 'codex', ts: 12, type: 'notice', level: 'info', text: 'new' }],
    // A legacy relay could report a stale zero cursor with a non-empty page.
    nextSeq: 0, lastSeq: 12,
  }) })) as FetchLike);
  const page = await sessionEventsPage({ url: 'https://relay.test', pairToken: 'token', deviceId: 'd1' }, 'd1', 'codex:t1', 10);
  expect(page.nextSeq).toBe(12);
  expect(page.events).toHaveLength(1);
});

test('event page rejects an invalid optional sequence instead of advancing past it', async () => {
  setHubFetch((async () => ({ ok: true, status: 200, text: async () => JSON.stringify({
    events: [{ seq: -1, deviceId: 'd1', sessionKey: 'codex:t1', tool: 'codex', ts: 12, type: 'notice', level: 'info', text: 'bad' }],
    nextSeq: 100,
  }) })) as FetchLike);
  await expect(sessionEventsPage({ url: 'https://relay.test', pairToken: 'token', deviceId: 'd1' }, 'd1', 'codex:t1', 0)).rejects.toThrow('无效的事件游标');
});

test('event pages ignore unknown event kinds and accept additive fields without losing their cursor', async () => {
  setHubFetch((async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ events: [
    { seq: 11, deviceId: 'd1', sessionKey: 'codex:t1', tool: 'codex', ts: 11, type: 'notice', level: 'info', text: 'ready', serverTrace: { id: 'new-field' } },
    { seq: 12, deviceId: 'd1', sessionKey: 'codex:t1', tool: 'codex', ts: 12, type: 'progress.v2', newPayload: { revision: 2 } },
  ], nextSeq: 12, lastSeq: 12 }) })) as FetchLike);
  const page = await sessionEventsPage({ url: 'https://relay.test', pairToken: 'token', deviceId: 'd1' }, 'd1', 'codex:t1', 10);
  expect(page.events).toHaveLength(1);
  expect(page.events[0]).toMatchObject({ type: 'notice', serverTrace: { id: 'new-field' } });
  expect(page.nextSeq).toBe(12);
});

test.each([
  ['tool status', { type: 'tool', id: 'tool-1', kind: 'command', title: 'Run', status: 'queued' }],
  ['turn status', { type: 'turn', status: 'paused' }],
  ['notice level', { type: 'notice', level: 'debug', text: 'new level' }],
  ['approval kind', { type: 'approval.request', approvalId: 'approval-1', kind: 'workspace_lock', title: 'New permission' }],
  ['approval decision', { type: 'approval.resolved', approvalId: 'approval-1', decision: 'deferred', by: 'phone' }],
  ['message role', { type: 'message', id: 'message-1', role: 'system', text: 'new role', final: true }],
] as const)('event pages skip an unsupported %s value and keep replay moving', async (_label, unsupported) => {
  const withEnvelope = (seq: number, event: Record<string, unknown>) => ({ seq, deviceId: 'd1', sessionKey: 'codex:t1', tool: 'codex', ts: seq, ...event });
  setHubFetch((async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ events: [
    withEnvelope(11, unsupported),
    withEnvelope(12, { type: 'notice', level: 'info', text: 'still receiving events' }),
  ], nextSeq: 12, lastSeq: 12 }) })) as FetchLike);
  const page = await sessionEventsPage({ url: 'https://relay.test', pairToken: 'token', deviceId: 'd1' }, 'd1', 'codex:t1', 10);
  expect(page.events).toHaveLength(1);
  expect(page.events[0]).toMatchObject({ type: 'notice', seq: 12, text: 'still receiving events' });
  expect(page.nextSeq).toBe(12);
});

test('an additive message phase is retained as metadata instead of stalling the page', async () => {
  setHubFetch((async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ events: [
    { seq: 11, deviceId: 'd1', sessionKey: 'codex:t1', tool: 'codex', ts: 11, type: 'message', id: 'm1', role: 'assistant', text: 'summary', final: true, messagePhase: 'summary' },
  ], nextSeq: 11, lastSeq: 11 }) })) as FetchLike);
  const page = await sessionEventsPage({ url: 'https://relay.test', pairToken: 'token', deviceId: 'd1' }, 'd1', 'codex:t1', 10);
  expect(page.events[0]).toMatchObject({ type: 'message', messagePhase: 'summary' });
  expect(page.nextSeq).toBe(11);
});

test('malformed known events reject the page before its cursor can advance', async () => {
  setHubFetch((async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ events: [
    { seq: 11, deviceId: 'd1', sessionKey: 'codex:t1', tool: 'codex', ts: 11, type: 'notice', level: 'warn' },
  ], nextSeq: 100, lastSeq: 100 }) })) as FetchLike);
  await expect(sessionEventsPage({ url: 'https://relay.test', pairToken: 'token', deviceId: 'd1' }, 'd1', 'codex:t1', 10)).rejects.toThrow('无效的提示事件');
});

test('a missing event array cannot advance a cursor from an incomplete response', async () => {
  setHubFetch((async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ nextSeq: 100, lastSeq: 100 }) })) as FetchLike);
  const page = await sessionEventsPage({ url: 'https://relay.test', pairToken: 'token', deviceId: 'd1' }, 'd1', 'codex:t1', 10);
  expect(page.events).toEqual([]);
  expect(page.nextSeq).toBe(10);
});

test('feature change snapshots accept new additive metadata', async () => {
  setHubFetch((async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ events: [], nextSeq: 0, lastSeq: 0,
    featureChanges: [{ type: 'features.changed', deviceId: 'd1', tool: 'codex', seq: 1 }] }) })) as FetchLike);
  const page = await sessionEventsPage({ url: 'https://relay.test', pairToken: 'token', deviceId: 'd1' }, 'd1', 'codex:t1');
  expect(page.featureChanges).toEqual([expect.objectContaining({ deviceId: 'd1', seq: 1 })]);
});

test('derives the first hub candidate from a public HTTPS relay address', () => {
  expect(hubUrlFor('https://api.relay.top/v1')).toBe('https://api.relay.top/salcara-hub/v1');
  expect(hubUrlFor('https://api.relay.top/openai/v1/')).toBe('https://api.relay.top/openai/salcara-hub/v1');
  expect(hubUrlFor('http://10.0.0.2:3000/openai/v1/')).toBe(null);
  expect(hubUrlFor('https://10.0.0.2:3000/openai/v1/')).toBe(null);
  expect(hubUrlFor('http://api.relay.top/v1')).toBe(null);
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
      `\nevent: device\ndata: {"deviceId":"d1","name":"PC","os":"windows","tools":[],"projects":[],"online":true,"lastSeen":1}\n\n`,
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

test('a malformed known stream event cannot poison the reconnect cursor', async () => {
  const urls: string[] = [];
  const responses = [
    streamResponse([`event: event\ndata: ${event(9, { type: 'notice', level: 'warn' })}\n\n`]),
    streamResponse([`event: event\ndata: ${event(1, { type: 'notice', level: 'info', text: 'recovered' })}\n\n`]),
    streamResponse([], 401),
  ];
  setHubFetch((async (url: string) => { urls.push(url); return responses.shift() ?? streamResponse([], 401); }) as unknown as FetchLike);
  const events: HubEvent[] = [];
  const states: string[] = [];
  const handle = openStream({ hub: { url: 'https://r.top/salcara-hub/v1', key: 'k' }, onEvent: item => events.push(item),
    onDevice: () => undefined, onState: state => states.push(state), wait: async () => undefined });
  await until(() => states[states.length - 1] === 'closed');
  expect(urls).toEqual([
    'https://r.top/salcara-hub/v1/app/stream?after=0',
    'https://r.top/salcara-hub/v1/app/stream?after=0',
    'https://r.top/salcara-hub/v1/app/stream?after=1',
  ]);
  expect(events.map(item => item.seq)).toEqual([1]);
  expect(handle.lastSeq()).toBe(1);
});

test('a future tool status is skipped while the live stream advances to later events', async () => {
  const urls: string[] = [];
  const responses = [
    streamResponse([
      `event: event\ndata: ${event(7, { type: 'tool', id: 't1', kind: 'command', title: 'Build', status: 'queued' })}\n\n`,
      `event: event\ndata: ${event(8, { type: 'notice', level: 'info', text: 'still live' })}\n\n`,
    ]),
    streamResponse([], 401),
  ];
  setHubFetch((async (url: string) => { urls.push(url); return responses.shift() ?? streamResponse([], 401); }) as unknown as FetchLike);
  const events: HubEvent[] = [];
  const states: string[] = [];
  const handle = openStream({ hub: { url: 'https://r.top/salcara-hub/v1', key: 'k' }, onEvent: item => events.push(item),
    onDevice: () => undefined, onState: state => states.push(state), wait: async () => undefined });
  await until(() => states[states.length - 1] === 'closed');
  expect(events.map(item => item.seq)).toEqual([8]);
  expect(handle.lastSeq()).toBe(8);
  expect(urls).toEqual(['https://r.top/salcara-hub/v1/app/stream?after=0', 'https://r.top/salcara-hub/v1/app/stream?after=8']);
});

test('a malformed event from another device cannot interrupt the bound stream', async () => {
  const urls: string[] = [];
  const responses = [
    streamResponse([
      'event: event\ndata: {"deviceId":"other-pc","type":"message","seq":99}\n\n',
      `event: event\ndata: ${event(1, { type: 'notice', level: 'info', text: 'local event' })}\n\n`,
    ]),
    streamResponse([], 401),
  ];
  setHubFetch((async (url: string) => { urls.push(url); return responses.shift() ?? streamResponse([], 401); }) as unknown as FetchLike);
  const events: HubEvent[] = [];
  const states: string[] = [];
  const handle = openStream({ hub: { url: 'https://r.top/salcara-hub/v1', key: 'k', deviceId: 'd1' }, onEvent: item => events.push(item),
    onDevice: () => undefined, onState: state => states.push(state), wait: async () => undefined });
  await until(() => states[states.length - 1] === 'closed');
  expect(events.map(item => item.seq)).toEqual([1]);
  expect(handle.lastSeq()).toBe(1);
  expect(urls).toEqual(['https://r.top/salcara-hub/v1/app/stream?after=0&deviceId=d1', 'https://r.top/salcara-hub/v1/app/stream?after=1&deviceId=d1']);
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
  expect(timeline.items[1]).toMatchObject({ status: 'done', output: 'ok', startedAt: 3, durationMs: 2 });
  timeline = applyEvent(timeline, { ...base, ts: 9, type: 'tool', id: 't1', kind: 'command', title: '运行 npm test', status: 'done' });
  expect(timeline.items.find((item) => item.kind === 'tool' && item.id === 't1')).toMatchObject({ status: 'done', output: 'ok', startedAt: 3, durationMs: 2 });
  expect(timeline.items.find((item) => item.kind === 'approval' && item.id === 'a1')).toMatchObject({ state: 'allow', by: 'phone' });
  expect(timeline.items.map((item) => `${item.kind}:${item.id}`)).toEqual(['message:u1', 'tool:t1', 'approval:a1', 'turn:turn:completed:7']);
});

test('timeline orders out-of-order pages and never regresses terminal records', () => {
  const base = { deviceId: 'd1', sessionKey: 'codex:t1', tool: 'codex' as const };
  let timeline: Timeline = EMPTY_TIMELINE;
  timeline = applyEvent(timeline, { ...base, seq: 12, ts: 12, type: 'message', id: 'late', role: 'assistant', text: '第二条', final: true });
  timeline = applyEvent(timeline, { ...base, seq: 11, ts: 11, type: 'message', id: 'early', role: 'assistant', text: '第一条', final: true });
  timeline = applyEvent(timeline, { ...base, seq: 14, ts: 14, type: 'message', id: 'stream', role: 'assistant', text: '完整回答', final: true });
  timeline = applyEvent(timeline, { ...base, seq: 13, ts: 13, type: 'message', id: 'stream', role: 'assistant', text: '不完整', final: false });
  timeline = applyEvent(timeline, { ...base, seq: 16, ts: 16, type: 'tool', id: 'tool', kind: 'command', title: '完成', status: 'done', output: 'PASS' });
  timeline = applyEvent(timeline, { ...base, seq: 15, ts: 15, type: 'tool', id: 'tool', kind: 'command', title: '旧状态', status: 'running' });
  expect(timeline.items.map(item => item.id)).toEqual(['early', 'late', 'stream', 'tool']);
  expect(timeline.items.find(item => item.id === 'stream')).toMatchObject({ text: '完整回答', final: true });
  expect(timeline.items.find(item => item.id === 'tool')).toMatchObject({ status: 'done', output: 'PASS' });
});

test('stable turn IDs keep start and terminal at their actual conversation positions', () => {
  const base = { deviceId: 'd1', sessionKey: 'codex:t1', tool: 'codex' as const, turnId: 'turn-1' };
  let timeline = applyEvent(EMPTY_TIMELINE, { ...base, seq: 20, ts: 20, type: 'turn', status: 'started' });
  timeline = applyEvent(timeline, { ...base, seq: 21, ts: 21, type: 'message', id: 'prompt', role: 'user', text: '检查', final: true });
  timeline = applyEvent(timeline, { ...base, seq: 22, ts: 22, type: 'message', id: 'answer', role: 'assistant', text: '完成', final: true, messagePhase: 'final_answer' });
  timeline = applyEvent(timeline, { ...base, seq: 23, ts: 23, type: 'turn', status: 'completed', durationMs: 3, usage: { outputTokens: 50 } });
  expect(timeline.items.map(item => item.id)).toEqual(['turn:turn-1:started', 'prompt', 'answer', 'turn:turn-1:terminal']);
  expect(buildBlocks(timeline.items, false).map(block => block.type)).toEqual(['user', 'assistant']);
  expect(turnStats(timeline.items).get('answer')).toEqual({ durationMs: 3, tokens: 50 });
  timeline = applyEvent(timeline, { ...base, seq: 24, ts: 24, type: 'turn', status: 'completed' });
  expect(timeline.items).toHaveLength(4);
});

test('stable failed turn stays after its prompt and upgrades old coalesced cache records', () => {
  const base = { deviceId: 'd1', sessionKey: 'codex:t1', tool: 'codex' as const, turnId: 'turn-1' };
  const old: Timeline = { ...EMPTY_TIMELINE, items: [
    { kind: 'turn', id: 'turn:turn-1', turnId: 'turn-1', status: 'failed', seq: 23, orderSeq: 20, ts: 23 },
    { kind: 'message', id: 'prompt', role: 'user', text: '检查', final: true, seq: 21, ts: 21 },
  ] };
  const result = mergeHistory(old, undefined, [{ ...base, seq: 23, ts: 23, type: 'turn', status: 'failed', errorCode: 'model_capacity' }]);
  expect(result.items.map(item => item.id)).toEqual(['prompt', 'turn:turn-1:terminal']);
  expect(buildBlocks(result.items, false).map(block => block.type)).toEqual(['user', 'turn']);
});

test('native notice IDs deduplicate hook start, completion and replay', () => {
  const base = { deviceId: 'd1', sessionKey: 'codex:t1', tool: 'codex' as const, type: 'notice' as const, level: 'info' as const, id: 'hook', text: '钩子提示：初始' };
  let timeline = applyEvent(EMPTY_TIMELINE, { ...base, seq: 1, ts: 1 });
  timeline = applyEvent(timeline, { ...base, seq: 2, ts: 2, text: '钩子提示：完成' });
  timeline = applyEvent(timeline, { ...base, seq: 1, ts: 1 });
  expect(timeline.items).toHaveLength(1);
  expect(timeline.items[0]).toMatchObject({ text: '钩子提示：完成', orderSeq: 1, seq: 2 });
});

test('context compaction lifecycle updates one visible native notice in place', () => {
  const base = { deviceId: 'd1', sessionKey: 'codex:t1', tool: 'codex' as const, type: 'notice' as const, level: 'info' as const,
    id: 'context-compaction:t1:item1', noticeKind: 'context_compaction' as const };
  let timeline = applyEvent(EMPTY_TIMELINE, { ...base, seq: 1, ts: 1, progress: true, text: '正在压缩上下文' });
  timeline = applyEvent(timeline, { ...base, seq: 2, ts: 2, progress: false, text: '上下文已压缩' });
  expect(timeline.items).toHaveLength(1);
  expect(timeline.items[0]).toMatchObject({ text: '上下文已压缩', progress: false, noticeKind: 'context_compaction', orderSeq: 1, seq: 2 });
  expect(buildBlocks(timeline.items, false).map(block => block.type)).toEqual(['notice']);
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

test('streaming updates keep the original position instead of sorting by the latest seq', () => {
  const base = { deviceId: 'd1', sessionKey: 'codex:t1', tool: 'codex' as const };
  let timeline = applyEvent(EMPTY_TIMELINE, { ...base, seq: 1, ts: 1, type: 'message', id: 'answer', role: 'assistant', text: '开始', final: false });
  timeline = applyEvent(timeline, { ...base, seq: 2, ts: 2, type: 'tool', id: 'read', kind: 'read', title: '读取文件', status: 'done' });
  timeline = applyEvent(timeline, { ...base, seq: 3, ts: 3, type: 'message', id: 'answer', role: 'assistant', text: '完整回答', final: true });
  expect(timeline.items.map(item => item.id)).toEqual(['answer', 'read']);
  expect(timeline.items[0]).toMatchObject({ seq: 3, orderSeq: 1, text: '完整回答' });
});

test('a newer history snapshot updates text without moving an existing streamed item past later tools', () => {
  const base = { deviceId: 'd1', sessionKey: 'codex:t1', tool: 'codex' as const };
  let live = applyEvent(EMPTY_TIMELINE, { ...base, seq: 1, ts: 1, type: 'message', id: 'answer', role: 'assistant', text: '开始', final: false });
  live = applyEvent(live, { ...base, seq: 2, ts: 2, type: 'tool', id: 'read', kind: 'read', title: '读取文件', status: 'done' });
  const merged = mergeHistory(live, undefined, [{ ...base, seq: 3, ts: 3, type: 'message', id: 'answer', role: 'assistant', text: '完整回答', final: true }]);
  expect(merged.items.map(item => item.id)).toEqual(['answer', 'read']);
  expect(merged.items[0]).toMatchObject({ seq: 3, orderSeq: 1, text: '完整回答', final: true });
});

test.each([applyEvent, applyRecoveredEvent])('an older replay can restore insertion order but never downgrade the latest text (%#)', apply => {
  const base = { deviceId: 'd1', sessionKey: 'codex:t1', tool: 'codex' as const };
  let timeline = applyEvent(EMPTY_TIMELINE, { ...base, seq: 3, ts: 3, type: 'message', id: 'answer', role: 'assistant', text: '完整回答', final: true });
  timeline = applyEvent(timeline, { ...base, seq: 2, ts: 2, type: 'tool', id: 'read', kind: 'read', title: '读取文件', status: 'done' });
  timeline = apply(timeline, { ...base, seq: 1, ts: 1, type: 'message', id: 'answer', role: 'assistant', text: '开始', final: false });
  expect(timeline.items.map(item => item.id)).toEqual(['answer', 'read']);
  expect(timeline.items[0]).toMatchObject({ seq: 3, orderSeq: 1, text: '完整回答', final: true });
});

test('message attachment refs survive the computer echo and keep the local thumbnail', () => {
  const base = { deviceId: 'pc', sessionKey: 'codex:thread', tool: 'codex' as const, ts: 1 };
  let timeline: Timeline = { ...EMPTY_TIMELINE, items: [{ kind: 'message', id: 'local:1', role: 'user', text: '看这张图', final: true, ts: 1, local: true,
    attachments: [{ id: 'att_0123456789abcdef0123456789abcdef', mime: 'image/jpeg', size: 4, uri: 'file:///cache/a.jpg' }], images: ['file:///cache/a.jpg'] }] };
  timeline = applyEvent(timeline, { ...base, type: 'message', id: 'u1', role: 'user', text: '看这张图', final: true,
    attachments: [{ id: 'att_0123456789abcdef0123456789abcdef', mime: 'image/jpeg', size: 4 }] });
  expect(timeline.items).toHaveLength(1);
  expect(timeline.items[0]).toMatchObject({ id: 'u1', attachments: [{ id: 'att_0123456789abcdef0123456789abcdef', uri: 'file:///cache/a.jpg' }], images: ['file:///cache/a.jpg'] });
});

test('tool attachment refs survive history/live merges without becoming message images', () => {
  const base = { deviceId: 'pc', sessionKey: 'codex:thread', tool: 'codex' as const, ts: 1 };
  const ref = { id: 'att_abcdefabcdefabcdefabcdefabcdefab', mime: 'image/png' as const, size: 8 };
  let timeline = applyEvent(EMPTY_TIMELINE, { ...base, seq: 4, type: 'tool', id: 'image-view', kind: 'read', title: '查看图片', status: 'done', attachments: [ref] });
  timeline = applyEvent(timeline, { ...base, seq: 5, type: 'tool', id: 'image-view', kind: 'read', title: '查看图片', status: 'done' });
  expect(timeline.items[0]).toMatchObject({ kind: 'tool', attachments: [ref] });
  expect(timeline.items[0]).not.toHaveProperty('images');
});

test('a duplicate terminal output cannot erase image refs or child handles', () => {
  const base = { deviceId: 'pc', sessionKey: 'codex:thread', tool: 'codex' as const, ts: 1 };
  const ref = { id: 'att_abcdefabcdefabcdefabcdefabcdefab', mime: 'image/png' as const, size: 8 };
  let timeline = applyEvent(EMPTY_TIMELINE, { ...base, seq: 4, type: 'tool', id: 'image-output', kind: 'image_generation', title: '生成图片', status: 'done', output: '已保存', attachments: [ref], childSessionKeys: ['codex:child'] });
  timeline = applyEvent(timeline, { ...base, seq: 5, type: 'tool', id: 'image-output', kind: 'image_generation', title: '生成图片', status: 'done' });
  expect(timeline.items[0]).toMatchObject({ output: '已保存', attachments: [ref], childSessionKeys: ['codex:child'] });
});

test('an authoritative empty completed plan clears the proposed streaming draft', () => {
  const base = { deviceId: 'pc', sessionKey: 'codex:thread', tool: 'codex' as const, ts: 1 };
  let timeline = applyEvent(EMPTY_TIMELINE, { ...base, seq: 1, type: 'tool', id: 'plan', kind: 'plan', title: '计划', status: 'running', output: '尚未确认的草稿' });
  timeline = applyEvent(timeline, { ...base, seq: 2, type: 'tool', id: 'plan', kind: 'plan', title: '计划', status: 'done', outputFinal: true });
  expect(timeline.items[0]).toMatchObject({ output: '', outputFinal: true, status: 'done' });
  timeline = applyEvent(timeline, { ...base, seq: 3, type: 'tool', id: 'plan', kind: 'plan', title: '计划', status: 'done' });
  expect(timeline.items[0]).toMatchObject({ output: '', outputFinal: true });
});
