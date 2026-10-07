import { HubError, setHubFetch, type DeviceStatus, type FetchLike, type HubEvent, type SessionInfo } from '../remote/client';
import { applyEvent, applyRecoveredEvent, bootRemote, connectStation, EMPTY_TIMELINE, getRemoteState, mergeHistory, openSession, pairRemoteQr,
  parseRemoteQr, resetRemoteForTests, syncSessionEvents, timelineKey, loadEarlierHistory, loadSessions, loadMoreSessions, preloadRecentSessionMessages } from '../remote/store';

const mockSettings = new Map<string, string>();
const mockSecrets = new Map<string, string>();
jest.mock('../storage/database', () => ({ getSetting: async (key: string) => mockSettings.get(key) ?? null,
  setSetting: async (key: string, value: string | null) => { if (value === null) mockSettings.delete(key); else mockSettings.set(key, value); } }));
jest.mock('../storage/secure-keys', () => ({ getProviderKey: async () => null }));
jest.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'this-device-only',
  getItemAsync: async (key: string) => mockSecrets.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { mockSecrets.set(key, value); },
  deleteItemAsync: async (key: string) => { mockSecrets.delete(key); } }));
const origin = 'https://station.example';
const hubUrl = `${origin}/salcara-hub/v1`;
const key = 'codex:original';
const device: DeviceStatus = { deviceId: 'pc', name: 'Fixture', os: 'windows', tools: [], projects: [], online: true, lastSeen: 1 };
const session: SessionInfo = { sessionKey: key, tool: 'codex', client: 'Codex App', title: 'Original', cwd: '/fixture', updatedAt: 1, status: 'idle', controllable: true };
const event = (id: string, ts: number, extra: Record<string, unknown> = {}): HubEvent => ({ type: 'message', deviceId: 'pc', sessionKey: key,
  tool: 'codex', id, role: 'assistant', text: id, final: true, ts, ...extra } as HubEvent);
const response = (value: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });
const capabilities = ['device.identity.v1', 'pair.qr.v1', 'session.remote.v1', 'pair.revoke.v1', 'events.cursor.v1', 'commands.idempotency.v1'];
const commands: string[] = [];
function transport(handler: (url: URL, command?: Record<string, unknown>) => Promise<unknown> | unknown): FetchLike {
  return (async (endpoint, init) => {
    if (endpoint.endsWith('/ping')) return response({ service: 'salcara-hub', protocol: 'salcara-remote', protocolVersion: 1,
      authModes: ['device-pairing'], capabilities });
    if (endpoint.endsWith('/app/pair/qr')) return response({ pair_token: 'a'.repeat(64), device });
    if (endpoint.endsWith('/app/devices')) return response({ devices: [device] });
    const command = endpoint.endsWith('/app/commands') ? JSON.parse(String(init.body)).command : undefined;
    if (command) commands.push(command.type);
    return response(await handler(new URL(endpoint), command));
  }) as FetchLike;
}
async function pair() {
  await bootRemote([]); await connectStation(origin);
  await pairRemoteQr(parseRemoteQr(JSON.stringify({ type: 'salcara-remote-pair', version: 1, hubUrl, deviceId: 'pc', deviceName: device.name,
    ticket: 'b'.repeat(64), expiresAt: Date.now() + 120_000 })));
}
beforeEach(() => { resetRemoteForTests(); mockSettings.clear(); mockSecrets.clear(); commands.length = 0; device.online = true; });
afterEach(() => { resetRemoteForTests(); setHubFetch(null); device.online = true; });

test('initial open and live sync share the in-flight snapshot without losing history', async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  setHubFetch(transport(async (_url, command) => {
    if (command?.type === 'session.open') { await gate; return { ok: true, result: { session, events: [event('shared', 10)], lastSeq: 0 } }; }
    return { events: [], nextSeq: 0, lastSeq: 0 };
  }));
  await pair(); const opened = openSession('pc', key);
  await Promise.resolve(); await Promise.resolve();
  const synced = syncSessionEvents('pc', key);
  release?.(); await Promise.all([opened, synced]);
  expect(commands.filter(type => type === 'session.open')).toHaveLength(1);
  expect(getRemoteState().timelines[timelineKey('pc', key)].items).toEqual(expect.arrayContaining([expect.objectContaining({ text: 'shared' })]));
});

test('scoped directory reads more than 100 chats, keeps other Agents and deduplicates overlap', async () => {
  const writes: Record<string, unknown>[] = [];
  setHubFetch(transport((_url, command) => {
    if (!command) return {};
    writes.push(command);
    if (!command.tool) return { ok: true, result: { sessions: [{ ...session, sessionKey: 'claude:other', tool: 'claude', client: 'Claude Code' }] } };
    const offset = command.cursor ? 99 : 0, count = command.cursor ? 72 : 100;
    return { ok: true, result: { sessions: Array.from({ length: count }, (_, i) => ({ ...session, sessionKey: `codex:${i + offset}`, updatedAt: 1000 - i - offset })), nextCursor: command.cursor ? '' : 'next-page' } };
  }));
  await pair(); await loadSessions('pc'); await loadSessions('pc', 'codex'); await loadMoreSessions('pc', 'codex');
  expect(getRemoteState().sessions.pc.list).toHaveLength(172);
  expect(getRemoteState().sessions.pc.pages?.codex?.nextCursor).toBeUndefined();
  expect(writes[2]).toMatchObject({ type: 'sessions.list', tool: 'codex', cursor: 'next-page', limit: 10 });
});

test('earlier history preserves current content and approvals without starting or sending anything', async () => {
  setHubFetch(transport((_url, command) => command ? { ok: true, result: { session,
    events: command.cursor ? [event('oldest', 1), event('overlap', 10, { text: 'old version' }),
      { type: 'approval.request', sessionKey: key, tool: 'codex', deviceId: 'pc', ts: 2, approvalId: 'stale', kind: 'command', title: 'old request' }]
      : [event('overlap', 10, { text: 'current version' }), { type: 'approval.request', sessionKey: key, tool: 'codex', deviceId: 'pc', ts: 12, approvalId: 'current', kind: 'question', title: 'current request' }],
    nextCursor: command.cursor ? '' : 'older-page' } } : { events: [], lastSeq: 0, nextSeq: 0 }));
  await pair(); await openSession('pc', key); await loadEarlierHistory('pc', key);
  const timeline = getRemoteState().timelines[timelineKey('pc', key)];
  expect(timeline.items.find(item => item.id === 'overlap')).toMatchObject({ text: 'current version' });
  expect(timeline.items.map(item => item.id)).toEqual(['oldest', 'overlap', 'current']);
  expect(getRemoteState().approvals.current).toBeTruthy(); expect(getRemoteState().approvals.stale).toBeUndefined();
  expect(commands).toEqual(['session.open', 'session.open']); expect(timeline.nextCursor).toBeUndefined();
});

test('first snapshot asks for two real messages and older pages ask for ten without changing transport', async () => {
  const writes: Record<string, unknown>[] = [];
  setHubFetch(transport((_url, command) => {
    if (!command) return { events: [], nextSeq: 0, lastSeq: 0 };
    writes.push(command);
    return { ok: true, result: { session, events: [event(command.cursor ? 'older' : 'current', command.cursor ? 1 : 10)], nextCursor: command.cursor ? '' : 'older' } };
  }));
  await pair(); await openSession('pc', key); await loadEarlierHistory('pc', key);
  expect(writes).toEqual([
    { type: 'session.open', sessionKey: key, limit: 400, messageLimit: 2 },
    { type: 'session.open', sessionKey: key, limit: 400, messageLimit: 10, cursor: 'older' },
  ]);
});

test('first-page message preloads publish independently, stay bounded to ten and never block a selected thread', async () => {
  const writes: Record<string, unknown>[] = [], releases: Array<() => void> = [];
  let active = 0, peak = 0;
  const rows = Array.from({ length: 15 }, (_, index) => ({ ...session, sessionKey: `codex:preview-${index}`, title: `preview-${index}` }));
  setHubFetch(transport(async (_url, command) => {
    if (!command) return { events: [], nextSeq: 0, lastSeq: 0 };
    writes.push(command); active += 1; peak = Math.max(peak, active);
    await new Promise<void>(resolve => { releases.push(resolve); }); active -= 1;
    const row = rows.find(item => item.sessionKey === command.sessionKey)!;
    return { ok: true, result: { session: row, events: [{ ...event('answer', 1), sessionKey: row.sessionKey }] } };
  }));
  await pair();
  const read = preloadRecentSessionMessages('pc', rows);
  const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
  for (let i = 0; i < 25 && writes.length < 2; i++) await tick();
  expect(writes).toHaveLength(2);
  expect(getRemoteState().timelines[timelineKey('pc', rows[0].sessionKey)].loading).toBe(false);
  releases.shift()!();
  for (let i = 0; i < 25 && !getRemoteState().timelines[timelineKey('pc', rows[0].sessionKey)].snapshotAt; i++) await tick();
  expect(getRemoteState().timelines[timelineKey('pc', rows[0].sessionKey)].items).toHaveLength(1);
  for (let i = 0; i < 25 && writes.length < 10; i++) { while (releases.length) releases.shift()!(); await tick(); }
  for (let i = 0; i < 10; i++) { while (releases.length) releases.shift()!(); await tick(); }
  await read;
  expect(writes).toHaveLength(10); expect(peak).toBeLessThanOrEqual(2);
  expect(writes.every(command => command.messageLimit === 2)).toBe(true);
  await preloadRecentSessionMessages('pc', rows);
  expect(writes).toHaveLength(10); // the recently confirmed snapshots are reused
});

test('cancelling preloads releases the current requests and never drains the rest of the directory', async () => {
  const writes: Record<string, unknown>[] = [];
  const rows = Array.from({ length: 12 }, (_, index) => ({ ...session, sessionKey: `codex:cancel-${index}` }));
  setHubFetch(transport(async (_url, command) => {
    if (!command) return { events: [], nextSeq: 0, lastSeq: 0 };
    writes.push(command); return new Promise(() => undefined); // transport intentionally ignores abort
  }));
  await pair(); const controller = new AbortController();
  const read = preloadRecentSessionMessages('pc', rows, controller.signal);
  for (let i = 0; i < 25 && writes.length < 2; i++) await new Promise<void>(resolve => setTimeout(resolve, 0));
  controller.abort(); await read;
  expect(writes).toHaveLength(2);
  expect(Object.values(getRemoteState().timelines).every(timeline => !timeline.loading)).toBe(true);
});

test('a failed opportunistic preview cannot flip the whole computer into an offline-refresh loop', async () => {
  setHubFetch(transport(() => ({ events: [], nextSeq: 0, lastSeq: 0 })));
  await pair();
  expect(getRemoteState().connection).toBe('open');
  setHubFetch((async endpoint => endpoint.includes('/app/events?') ? response({ events: [], nextSeq: 0, lastSeq: 0 })
    : { ok: false, status: 403, text: async () => JSON.stringify({ error: 'fixture rejection' }) }) as FetchLike);
  await preloadRecentSessionMessages('pc', [session]);
  expect(getRemoteState().connection).toBe('open');
  expect(getRemoteState().devices.find(item => item.deviceId === 'pc')?.online).toBe(true);
});

test('a failed earlier page retains the cursor, current content and a retry affordance', async () => {
  setHubFetch(transport((_url, command) => command ? command.cursor ? { ok: false, error: 'fixture page unavailable' }
    : { ok: true, result: { session, events: [event('current', 10)], nextCursor: 'older' } } : { events: [], lastSeq: 0, nextSeq: 0 }));
  await pair(); await openSession('pc', key); await expect(loadEarlierHistory('pc', key)).rejects.toThrow('fixture page unavailable');
  expect(getRemoteState().timelines[timelineKey('pc', key)]).toMatchObject({ nextCursor: 'older', loadingEarlier: false, earlierError: 'fixture page unavailable' });
  expect(getRemoteState().timelines[timelineKey('pc', key)].items.map(item => item.id)).toEqual(['current']);
});

test('cancelling an earlier page releases its spinner and retains the cursor for retry', async () => {
  let release!: (value: unknown) => void; let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let pages = 0;
  setHubFetch(transport((_url, command) => {
    if (!command) return { events: [], lastSeq: 0, nextSeq: 0 };
    if (!command.cursor) return { ok: true, result: { session, events: [event('recent', 10)], nextCursor: 'older' } };
    if (++pages === 1) { entered(); return new Promise(resolve => { release = resolve; }); }
    return { ok: true, result: { session, events: [event('old', 1)] } };
  }));
  await pair(); await openSession('pc', key);
  const controller = new AbortController();
  const reading = loadEarlierHistory('pc', key, controller.signal); await started;
  controller.abort();
  release({ ok: true, result: { session, events: [event('cancelled', 1)] } }); await reading;
  expect(getRemoteState().timelines[timelineKey('pc', key)]).toMatchObject({ nextCursor: 'older', loadingEarlier: false });
  expect(getRemoteState().timelines[timelineKey('pc', key)].earlierError).toBeUndefined();
  await loadEarlierHistory('pc', key);
  expect(pages).toBe(2);
  expect(getRemoteState().timelines[timelineKey('pc', key)].items.map(item => item.id)).toEqual(['old', 'recent']);
});

test('a cancelled stale page cannot clear the spinner owned by a newer history read', async () => {
  const releases: Array<(value: unknown) => void> = [];
  setHubFetch(transport((_url, command) => {
    if (!command) return { events: [], lastSeq: 0, nextSeq: 0 };
    if (!command.cursor) return { ok: true, result: { session, events: [event('recent', 10)], nextCursor: 'older' } };
    return new Promise(resolve => { releases.push(resolve); });
  }));
  await pair(); await openSession('pc', key);
  const controller = new AbortController();
  const stale = loadEarlierHistory('pc', key, controller.signal);
  await Promise.resolve(); await Promise.resolve();
  await openSession('pc', key);
  const current = loadEarlierHistory('pc', key);
  await Promise.resolve(); await Promise.resolve();
  expect(releases).toHaveLength(2);
  controller.abort(); releases[0]({ ok: true, result: { session, events: [] } }); await stale;
  expect(getRemoteState().timelines[timelineKey('pc', key)].loadingEarlier).toBe(true);
  releases[1]({ ok: true, result: { session, events: [event('old', 1)] } }); await current;
  expect(getRemoteState().timelines[timelineKey('pc', key)].loadingEarlier).toBe(false);
});

test('automatic directory head refresh preserves older pages and their continuation cursor', async () => {
  let head = 0;
  setHubFetch(transport((_url, command) => {
    if (!command) return {};
    if (command.cursor) return { ok: true, result: { sessions: [{ ...session, sessionKey: 'codex:older' }], nextCursor: 'third-page' } };
    return { ok: true, result: { sessions: [{ ...session, status: ++head > 1 ? 'running' : 'idle' }], nextCursor: 'second-page' } };
  }));
  await pair(); await loadSessions('pc', 'codex'); await loadMoreSessions('pc', 'codex');
  await loadSessions('pc', 'codex', { preservePages: true });
  const entry = getRemoteState().sessions.pc;
  expect(entry.list).toHaveLength(2); expect(entry.list.find(item => item.sessionKey === key)?.status).toBe('running');
  expect(entry.pages?.codex?.nextCursor).toBe('third-page');
  await loadSessions('pc', 'codex'); expect(getRemoteState().sessions.pc.list).toHaveLength(1);
});

test('a foreground CLI page supersedes background refresh without losing its frontier or raising loading', async () => {
  let release!: (value: unknown) => void, entered!: () => void, head = 0;
  const started = new Promise<void>(resolve => { entered = resolve; });
  setHubFetch(transport((_url, command) => {
    if (!command) return {};
    if (command.cursor) return { ok: true, result: { sessions: [{ ...session, sessionKey: 'codex:older' }], nextCursor: 'third-page' } };
    return ++head === 1 ? { ok: true, result: { sessions: [session], nextCursor: 'second-page' } }
      : (entered(), new Promise(resolve => { release = resolve; }));
  }));
  await pair(); await loadSessions('pc', 'codex');
  const refresh = loadSessions('pc', 'codex', { preservePages: true }); await started;
  expect(getRemoteState().sessions.pc).toMatchObject({ loading: false, pages: { codex: { loading: false, nextCursor: 'second-page' } } });
  await loadMoreSessions('pc', 'codex');
  release({ ok: true, result: { sessions: [{ ...session, title: 'stale background' }], nextCursor: 'second-page' } }); await refresh;
  expect(getRemoteState().sessions.pc.pages?.codex?.nextCursor).toBe('third-page');
  expect(getRemoteState().sessions.pc.list.map(item => item.title)).toEqual(['Original', 'Original']);
});

test('a failed snapshot refresh invalidates but cannot strand an older-page loading indicator', async () => {
  let opens = 0, release!: (value: unknown) => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  setHubFetch(transport((_url, command) => {
    if (!command) return { events: [], lastSeq: 0, nextSeq: 0 };
    if (command.cursor) { entered(); return new Promise(resolve => { release = resolve; }); }
    return ++opens === 1 ? { ok: true, result: { session, events: [event('recent', 100)], nextCursor: 'older-page' } }
      : { ok: false, error: 'refresh fixture failed' };
  }));
  await pair(); await openSession('pc', key); const older = loadEarlierHistory('pc', key); await started;
  await expect(openSession('pc', key)).rejects.toThrow('refresh fixture failed');
  release({ ok: true, result: { session, events: [event('outdated-old-page', 1)] } }); await older;
  const timeline = getRemoteState().timelines[timelineKey('pc', key)];
  expect(timeline.loadingEarlier).toBe(false); expect(timeline.nextCursor).toBe('older-page');
  expect(timeline.items.map(item => item.id)).toEqual(['recent']);
});

test('a live question during snapshot read survives an older snapshot and keeps its ID', async () => {
  let opens = 0;
  let release!: (value: unknown) => void; let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  setHubFetch(transport((url, command) => {
    if (command) { if (++opens === 1) return { ok: true, result: { session, events: [] } }; entered(); return new Promise(resolve => { release = resolve; }); }
    if (url.searchParams.get('limit') === '1') return { events: [], lastSeq: 0, nextSeq: 0 };
    return { events: [{ type: 'approval.request', deviceId: 'pc', sessionKey: key, tool: 'codex', ts: 1, seq: 1,
      approvalId: 'concurrent-question', kind: 'question', title: 'new during read' }], nextSeq: 1, lastSeq: 1 };
  }));
  await pair(); await openSession('pc', key); const reading = openSession('pc', key); await started;
  await syncSessionEvents('pc', key);
  release({ ok: true, result: { session, events: [] } }); await reading;
  expect(getRemoteState().approvals['concurrent-question']).toBeTruthy();
  expect(getRemoteState().timelines[timelineKey('pc', key)].items).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'concurrent-question', state: 'pending' })]));
});

test('snapshot reads the event baseline first, so progress arriving during the read is not skipped', async () => {
  const order: string[] = [];
  setHubFetch(transport((url, command) => {
    if (command) { order.push('snapshot'); return { ok: true, result: { session, events: [event('before', 10)] } }; }
    if (url.searchParams.get('limit') === '1') { order.push('baseline'); return { events: [], nextSeq: 0, lastSeq: 10 }; }
    order.push(`events:${url.searchParams.get('after')}`);
    return { events: [event('during-snapshot', 11, { seq: 11 })], nextSeq: 11, lastSeq: 11, hasMore: false };
  }));
  await pair();
  await openSession('pc', key);
  await syncSessionEvents('pc', key);
  expect(order).toEqual(['baseline', 'snapshot', 'events:10']);
  expect(getRemoteState().timelines[timelineKey('pc', key)].items.map((item) => item.id)).toEqual(['before', 'during-snapshot']);
  expect(commands).toEqual(['session.open']);
});

test.each(['bridge-marker', 'server-cursor-gap'])('%s only reloads the original session and removes stale actionable approvals', async (kind) => {
  let opens = 0;
  const gap = { type: 'notice', deviceId: 'pc', sessionKey: key, tool: 'codex', ts: 501, seq: 501,
    level: 'warn', text: '[salcara:history-gap:v1] buffered progress trimmed' };
  setHubFetch(transport((url, command) => {
    if (command) {
      opens += 1;
      return { ok: true, result: { session, events: opens === 1 ? [event('already-loaded-old', 10), { type: 'approval.request', deviceId: 'pc', sessionKey: key,
        tool: 'codex', ts: 11, approvalId: 'old-approval', kind: 'command', title: 'Old approval' }] : [event('current-from-computer', 600)] } };
    }
    if (url.searchParams.get('limit') === '1') return { events: [], nextSeq: 0, lastSeq: opens ? 600 : 10 };
    return { events: kind === 'bridge-marker' ? [gap] : [], nextSeq: 501, lastSeq: 600, resetRequired: kind === 'server-cursor-gap' };
  }));
  await pair(); await openSession('pc', key);
  expect(getRemoteState().approvals).toHaveProperty('old-approval');
  await syncSessionEvents('pc', key);
  expect(opens).toBe(2);
  expect(commands).toEqual(['session.open', 'session.open']);
  expect(getRemoteState().approvals).not.toHaveProperty('old-approval');
  const timeline = getRemoteState().timelines[timelineKey('pc', key)];
  expect(timeline.items.map((item) => item.id)).toEqual(expect.arrayContaining(['already-loaded-old', 'current-from-computer']));
  expect(timeline.items.some((item) => item.kind === 'approval' && item.state === 'pending')).toBe(false);
  expect(JSON.stringify(timeline)).not.toContain('[salcara:history-gap:v1]');
});

test('a gap marker for another device or thread cannot reload this conversation', async () => {
  setHubFetch(transport((url, command) => command ? { ok: true, result: { session, events: [] } }
    : url.searchParams.get('limit') === '1' ? { events: [], nextSeq: 0, lastSeq: 10 }
      : { events: [{ type: 'notice', deviceId: 'another-pc', sessionKey: key, tool: 'codex', ts: 20, seq: 20,
        level: 'warn', text: '[salcara:history-gap:v1]' }], nextSeq: 20, lastSeq: 20 }));
  await pair(); await openSession('pc', key); await syncSessionEvents('pc', key);
  expect(commands).toEqual(['session.open']);
  expect(getRemoteState().timelines[timelineKey('pc', key)].items).toHaveLength(0);
});

test('an old overlapping snapshot cannot replace the newer read or its cursor', async () => {
  let opens = 0; let heads = 0;
  let release: ((value: unknown) => void) | undefined;
  let entered: (() => void) | undefined;
  const firstEntered = new Promise<void>((resolve) => { entered = resolve; });
  const after: string[] = [];
  setHubFetch(transport((url, command) => {
    if (command) {
      opens += 1;
      if (opens === 1) { entered?.(); return new Promise((resolve) => { release = resolve; }); }
      return { ok: true, result: { session, events: [event('new-snapshot', 20)] } };
    }
    if (url.searchParams.get('limit') === '1') return { events: [], nextSeq: 0, lastSeq: ++heads * 10 };
    after.push(url.searchParams.get('after')!);
    return { events: [], nextSeq: 20, lastSeq: 20 };
  }));
  await pair();
  const oldRead = openSession('pc', key);
  await firstEntered;
  await openSession('pc', key);
  release?.({ ok: true, result: { session, events: [event('stale-snapshot', 10)] } });
  await oldRead;
  await syncSessionEvents('pc', key);
  expect(getRemoteState().timelines[timelineKey('pc', key)].items.map((item) => item.id)).toEqual(['new-snapshot']);
  expect(after).toEqual(['20']);
});

test('a pending incremental request cannot rewind a manually refreshed snapshot or cursor', async () => {
  let heads = 0;
  let release: ((value: unknown) => void) | undefined;
  let entered: (() => void) | undefined;
  const incrementEntered = new Promise<void>((resolve) => { entered = resolve; });
  const cursors: string[] = [];
  let increments = 0;
  setHubFetch(transport((url, command) => {
    if (command) return { ok: true, result: { session, events: [event(`snapshot-${heads}`, heads * 10)] } };
    if (url.searchParams.get('limit') === '1') return { events: [], nextSeq: 0, lastSeq: ++heads * 10 };
    cursors.push(url.searchParams.get('after')!);
    if (++increments === 1) { entered?.(); return new Promise((resolve) => { release = resolve; }); }
    return { events: [], nextSeq: 20, lastSeq: 20 };
  }));
  await pair(); await openSession('pc', key);
  const oldIncrement = syncSessionEvents('pc', key);
  await incrementEntered;
  await openSession('pc', key);
  release?.({ events: [event('stale-progress', 11, { seq: 11 })], nextSeq: 11, lastSeq: 11 });
  await oldIncrement;
  await syncSessionEvents('pc', key);
  expect(cursors).toEqual(['10', '20']);
  expect(getRemoteState().timelines[timelineKey('pc', key)].items.map((item) => item.id)).toEqual(['snapshot-1', 'snapshot-2']);
});

test('merging a recent history slice preserves older loaded messages but not stale pending permissions', () => {
  let current = applyEvent(EMPTY_TIMELINE, event('old-visible-message', 1));
  current = applyEvent(current, { type: 'approval.request', deviceId: 'pc', sessionKey: key, tool: 'codex', ts: 2,
    approvalId: 'old', kind: 'command', title: 'Old permission' });
  const merged = mergeHistory(current, session, [event('recent-message', 1000)]);
  expect(merged.items.map((item) => item.id)).toEqual(['old-visible-message', 'recent-message']);
});

test('a known-offline computer fails a read-only recovery and returns online after recovery without presence heartbeats', async () => {
  device.online = false;
  let available = false;
  setHubFetch(transport((url, command) => {
    if (command) {
      if (!available) throw new HubError('computer offline fixture', 409, 'computer_offline');
      return { ok: true, result: { session, events: [event('recovered', 10)] } };
    }
    return { events: [], nextSeq: 10, lastSeq: 10 };
  }));
  await pair();
  await expect(syncSessionEvents('pc', key)).rejects.toMatchObject({ code: 'computer_offline' });
  available = true;
  await syncSessionEvents('pc', key);
  expect(getRemoteState().devices[0].online).toBe(true);
  expect(getRemoteState().timelines[timelineKey('pc', key)].items[0]).toMatchObject({ text: 'recovered' });
  expect(commands).toEqual(['session.open', 'session.open']);
});

test('a recovery page preserves final replies and tools, consumes only nextSeq, and trusts only current registry approvals', async () => {
  let opens = 0;
  const reads: string[] = [];
  const approval = (id: string, seq?: number): HubEvent => ({ type: 'approval.request', deviceId: 'pc', sessionKey: key, tool: 'codex', ts: 30,
    approvalId: id, kind: 'command', title: id, ...(seq === undefined ? {} : { seq }) });
  setHubFetch(transport((url, command) => {
    if (command) {
      opens += 1;
      return { ok: true, result: { session, events: opens === 1 ? [] : [event('snapshot-final', 30), approval('current-registry-approval')] } };
    }
    if (url.searchParams.get('limit') === '1') return { events: [], nextSeq: 0, lastSeq: opens ? 100 : 10 };
    const after = url.searchParams.get('after')!; reads.push(after);
    if (after === '10') return { events: [
      { type: 'notice', deviceId: 'pc', sessionKey: key, tool: 'codex', ts: 11, seq: 11, level: 'warn', text: '[salcara:history-gap:v1]' },
      { type: 'tool', deviceId: 'pc', sessionKey: key, tool: 'codex', ts: 12, seq: 12, id: 'finished-tool', kind: 'command', title: 'Fixture tool', status: 'done', output: 'PASS' },
      event('page-final', 13, { seq: 13 }), approval('expired-buffer-only', 14),
    ], nextSeq: 14, lastSeq: 100, hasMore: true };
    if (after === '14') return { events: [event('second-page-final', 15, { seq: 15 }), approval('expired-on-next-page', 16)], nextSeq: 16, lastSeq: 100, hasMore: false };
    if (after === '16') return { events: [approval('expired-on-next-sync', 17), approval('new-live-approval', 101)], nextSeq: 101, lastSeq: 101, hasMore: false };
    throw new Error(`cursor skipped unread page: ${after}`);
  }));
  await pair(); await openSession('pc', key); await syncSessionEvents('pc', key);
  expect(reads).toEqual(['10', '14']);
  const items = getRemoteState().timelines[timelineKey('pc', key)].items;
  expect(items).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'finished-tool', output: 'PASS', status: 'done' }),
    expect.objectContaining({ id: 'page-final', text: 'page-final', final: true }),
    expect.objectContaining({ id: 'second-page-final', text: 'second-page-final', final: true }),
  ]));
  expect(Object.keys(getRemoteState().approvals)).toEqual(['current-registry-approval']);
  await syncSessionEvents('pc', key);
  expect(reads).toEqual(['10', '14', '16']);
  expect(Object.keys(getRemoteState().approvals).sort()).toEqual(['current-registry-approval', 'new-live-approval']);
  expect(commands).toEqual(['session.open', 'session.open']);
});

test('a final authoritative snapshot is not downgraded by earlier partial progress replay', () => {
  let timeline = applyEvent(EMPTY_TIMELINE, event('answer', 1));
  timeline = applyRecoveredEvent(timeline, event('answer', 2, { text: 'partial', final: false }));
  expect(timeline.items[0]).toMatchObject({ text: 'answer', final: true });
  timeline = applyEvent(timeline, { type: 'tool', deviceId: 'pc', sessionKey: key, tool: 'codex', ts: 3, id: 'tool', kind: 'command', title: 'Done', status: 'done', output: 'PASS' });
  timeline = applyRecoveredEvent(timeline, { type: 'tool', deviceId: 'pc', sessionKey: key, tool: 'codex', ts: 4, id: 'tool', kind: 'command', title: 'Old running event', status: 'running' });
  expect(timeline.items[1]).toMatchObject({ status: 'done', output: 'PASS' });
});

test('first baseline may skip buffered approvals because the fresh computer registry returns current requests', async () => {
  setHubFetch(transport((url, command) => command ? { ok: true, result: { session, events: [{ type: 'approval.request', deviceId: 'pc', sessionKey: key,
    tool: 'codex', ts: 10, approvalId: 'current', kind: 'command', title: 'Still waiting locally' }] } }
    : { events: [{ type: 'approval.request', deviceId: 'pc', sessionKey: key, tool: 'codex', ts: 9, seq: 9,
      approvalId: 'expired', kind: 'command', title: 'Stale Hub buffer' }], nextSeq: 10, lastSeq: 10 }));
  await pair(); await openSession('pc', key);
  expect(Object.keys(getRemoteState().approvals)).toEqual(['current']);
  expect(commands).toEqual(['session.open']);
});

test('a fresh snapshot replaces the optimistic bubble instead of showing the message twice', () => {
  const sent = { ...EMPTY_TIMELINE, items: [{ kind: 'message' as const, id: 'local:1', role: 'user' as const, text: '修一下', final: true, ts: 5, local: true }] };
  const next = mergeHistory(sent, session, [event('u1', 1, { role: 'user', text: '修一下' }), event('a1', 1)]);
  expect(next.items.map((item) => item.id)).toEqual(['u1', 'a1']);
});
