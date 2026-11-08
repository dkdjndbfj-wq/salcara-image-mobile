import { HubError, setHubFetch, type DeviceStatus, type FetchLike, type HubEvent, type SessionInfo } from '../remote/client';
import { applyEvent, applyRecoveredEvent, bootRemote, connectStation, EMPTY_TIMELINE, getRemoteState, mergeHistory, openSession, pairRemoteQr,
  parseRemoteQr, resetRemoteForTests, syncSessionEvents, sessionCursor, timelineKey, approvalStateKey, loadEarlierHistory, loadSessions, loadMoreSessions, preloadRecentSessionMessages } from '../remote/store';
import { attachMaterializedUri, remoteDeliveryScope } from '../remote/store';

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
  expect(getRemoteState().approvals[approvalStateKey('pc', key, 'current')]).toBeTruthy(); expect(getRemoteState().approvals[approvalStateKey('pc', key, 'stale')]).toBeUndefined();
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
  expect(getRemoteState().approvals[approvalStateKey('pc', key, 'concurrent-question')]).toBeTruthy();
  expect(getRemoteState().timelines[timelineKey('pc', key)].items).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'concurrent-question', state: 'pending' })]));
});

test.each(['head','earlier'] as const)('a concurrent revert discards a boundary-free late %s page and reads the fresh head once',async kind=>{
  let opens=0,release!:(value:unknown)=>void,entered!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;});
  const original=event('reverted-user',3,{role:'user',turnId:'reverted-turn'});
  const terminal:HubEvent={type:'turn',deviceId:'pc',sessionKey:key,tool:'codex',ts:6,turnId:'reverted-turn',status:'completed'};
  const reverted:HubEvent={type:'session.reverted',deviceId:'pc',sessionKey:key,tool:'codex',ts:30,seq:1,id:'reverted-user',turnId:'reverted-turn',operationId:'revert-op'};
  const newer=event('new-user',31,{role:'user',turnId:'new-turn',seq:2});
  setHubFetch(transport((url,command)=>{
    if(command){
      opens++;
      if(opens===1)return {ok:true,result:{session,events:[original,terminal],nextCursor:'old-cursor'}};
      if(opens===2){entered();return new Promise(resolve=>{release=resolve;});}
      expect(command.cursor).toBeUndefined();
      return {ok:true,result:{session,events:[newer,event('fresh-answer',32,{turnId:'new-turn'})],nextCursor:'fresh-cursor'}};
    }
    if(url.searchParams.get('limit')==='1')return {events:[],lastSeq:0,nextSeq:0};
    return {events:[reverted,newer],lastSeq:2,nextSeq:2,hasMore:false};
  }));
  await pair();await openSession('pc',key);
  const reading=kind==='head'?openSession('pc',key):loadEarlierHistory('pc',key);
  await started;await syncSessionEvents('pc',key);
  release({ok:true,result:{session,events:[event('unattributed-stale-answer',5)],nextCursor:'stale-cursor'}});
  await reading;
  const current=getRemoteState().timelines[timelineKey('pc',key)];
  expect(opens).toBe(3);expect(current.items.map(item=>item.id)).not.toContain('unattributed-stale-answer');
  expect(current.items.map(item=>item.id)).toEqual(expect.arrayContaining(['new-user','fresh-answer']));
  expect(current.nextCursor).toBe('fresh-cursor');expect(current.historyExpanded).toBe(false);
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

test('parallel sync requests for one conversation share its cursor in order while different sessions remain isolated', async () => {
  let releaseFirst!: (value: unknown) => void;
  let enteredFirst!: () => void;
  const firstEntered = new Promise<void>(resolve => { enteredFirst = resolve; });
  const after: string[] = [];
  setHubFetch(transport((url, command) => {
    if (command) return { ok: true, result: { session, events: [] } };
    if (url.searchParams.get('limit') === '1') return { events: [], nextSeq: 0, lastSeq: 10 };
    const cursor = url.searchParams.get('after')!; after.push(cursor);
    if (cursor === '10') { enteredFirst(); return new Promise(resolve => { releaseFirst = resolve; }); }
    return { events: [event(`progress-${cursor}`, Number(cursor) + 1, { seq: Number(cursor) + 1 })], nextSeq: Number(cursor) + 1, lastSeq: Number(cursor) + 1 };
  }));
  await pair(); await openSession('pc', key);
  const first = syncSessionEvents('pc', key);
  await firstEntered;
  const second = syncSessionEvents('pc', key);
  releaseFirst({ events: [event('progress-10', 11, { seq: 11 })], nextSeq: 11, lastSeq: 11 });
  await Promise.all([first, second]);
  expect(after).toEqual(['10', '11']);
  expect(sessionCursor('pc', key)).toBe(12);
  expect(getRemoteState().timelines[timelineKey('pc', key)].items.map(item => item.id)).toEqual(['progress-10', 'progress-11']);
});

test('different conversations may finish out of order without crossing same-id messages or cursors', async () => {
  const otherKey = 'codex:parallel';
  const waiters = new Map<string, (value: unknown) => void>();
  let entered = 0;
  let releaseBoth!: () => void;
  const bothEntered = new Promise<void>(resolve => { releaseBoth = resolve; });
  setHubFetch(transport((url, command) => {
    if (command) {
      const sessionKey = String(command.sessionKey);
      return { ok: true, result: { session: { ...session, sessionKey, title: sessionKey }, events: [] } };
    }
    const sessionKey = url.searchParams.get('sessionKey')!;
    if (url.searchParams.get('limit') === '1') return { events: [], nextSeq: 0, lastSeq: 10 };
    entered += 1;
    if (entered === 2) releaseBoth();
    return new Promise(resolve => { waiters.set(sessionKey, resolve); });
  }));
  await pair();
  await Promise.all([openSession('pc', key), openSession('pc', otherKey)]);
  const first = syncSessionEvents('pc', key);
  const second = syncSessionEvents('pc', otherKey);
  await bothEntered;
  const page = (sessionKey: string, text: string) => ({ events: [{ type: 'message', deviceId: 'pc', sessionKey, tool: 'codex',
    id: 'same-message-id', role: 'assistant', text, final: true, ts: 11, seq: 11 }], nextSeq: 11, lastSeq: 11 });
  waiters.get(otherKey)?.(page(otherKey, 'parallel response'));
  await second;
  waiters.get(key)?.(page(key, 'original response'));
  await first;
  expect(sessionCursor('pc', key)).toBe(11);
  expect(sessionCursor('pc', otherKey)).toBe(11);
  expect(getRemoteState().timelines[timelineKey('pc', key)].items).toEqual([expect.objectContaining({ id: 'same-message-id', text: 'original response' })]);
  expect(getRemoteState().timelines[timelineKey('pc', otherKey)].items).toEqual([expect.objectContaining({ id: 'same-message-id', text: 'parallel response' })]);
});

test('a page made only of a future event status advances past it and receives the following page', async () => {
  let reads = 0;
  const after: string[] = [];
  setHubFetch(transport((url, command) => {
    if (command) return { ok: true, result: { session, events: [] } };
    if (url.searchParams.get('limit') === '1') return { events: [], nextSeq: 0, lastSeq: 10 };
    reads += 1;
    after.push(url.searchParams.get('after')!);
    if (reads === 1) return { events: [{ type: 'tool', deviceId: 'pc', sessionKey: key, tool: 'codex', id: 'future-tool', kind: 'command',
      title: 'Queued build', status: 'queued', ts: 11, seq: 11 }], nextSeq: 11, lastSeq: 12, hasMore: true };
    return { events: [{ type: 'message', deviceId: 'pc', sessionKey: key, tool: 'codex', id: 'after-future', role: 'assistant',
      text: 'received', final: true, ts: 12, seq: 12 }], nextSeq: 12, lastSeq: 12 };
  }));
  await pair(); await openSession('pc', key); await syncSessionEvents('pc', key);
  expect(after).toEqual(['10', '11']);
  expect(sessionCursor('pc', key)).toBe(12);
  expect(getRemoteState().timelines[timelineKey('pc', key)].items.map(item => item.id)).toEqual(['after-future']);
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
  expect(getRemoteState().approvals[approvalStateKey('pc', key, 'old-approval')]).toBeDefined();
  await syncSessionEvents('pc', key);
  expect(opens).toBe(2);
  expect(commands).toEqual(['session.open', 'session.open']);
  expect(getRemoteState().approvals[approvalStateKey('pc', key, 'old-approval')]).toBeUndefined();
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

test.each(['app_read_capacity', undefined])('event read capacity (%s) preserves connectivity and resumes the exact cursor', async code => {
  let saturated = true;
  const cursors: string[] = [], waits: string[] = [];
  const fallback = transport((url, command) => command
    ? { ok: true, result: { session, events: [event('snapshot', 10)] } }
    : { events: [], nextSeq: 0, lastSeq: 10 });
  setHubFetch(async (endpoint, init) => {
    if (endpoint.endsWith('/ping')) return response({ service: 'salcara-hub', protocol: 'salcara-remote', protocolVersion: 1,
      authModes: ['device-pairing'], capabilities: [...capabilities, 'events.wait.v1'] });
    const url = new URL(endpoint);
    if (url.pathname.endsWith('/app/events') && url.searchParams.get('limit') !== '1') {
      cursors.push(url.searchParams.get('after')!); waits.push(url.searchParams.get('wait')!);
      if (saturated) return { ok: false, status: 429, text: async () => JSON.stringify({ error: 'read capacity fixture', ...(code ? { code } : {}) }) };
      return response({ events: [event('later-progress', 11, { seq: 11 })], nextSeq: 11, lastSeq: 11 });
    }
    return fallback(endpoint, init);
  });
  await pair(); await openSession('pc', key);
  const before = getRemoteState().timelines[timelineKey('pc', key)].items;
  await expect(syncSessionEvents('pc', key, 20)).rejects.toMatchObject({ status: 429, ...(code ? { code } : {}) });
  expect(getRemoteState().connection).toBe('open'); expect(getRemoteState().connectionError).toBeUndefined();
  expect(getRemoteState().devices[0].online).toBe(true);
  expect(getRemoteState().timelines[timelineKey('pc', key)].items).toEqual(before);
  expect(commands).toEqual(['session.open']);
  saturated = false; await syncSessionEvents('pc', key, 20);
  expect(cursors).toEqual(['10', '10']); expect(waits).toEqual(['20', '20']);
  expect(getRemoteState().timelines[timelineKey('pc', key)].items.map(item => item.id)).toEqual(['snapshot', 'later-progress']);
  expect(getRemoteState().connection).toBe('open'); expect(commands).toEqual(['session.open']);
});

test.each([0, 401, 403, 503])('event read status %s remains an error and a later capacity rejection cannot claim recovery', async status => {
  let failure = new HubError('unavailable fixture', status);
  setHubFetch(transport((url, command) => {
    if (command) return { ok: true, result: { session, events: [event('snapshot', 10)] } };
    if (url.searchParams.get('limit') === '1') return { events: [], nextSeq: 0, lastSeq: 10 };
    throw failure;
  }));
  await pair(); await openSession('pc', key);
  await expect(syncSessionEvents('pc', key)).rejects.toBe(failure);
  expect(getRemoteState().connection).toBe('error'); expect(getRemoteState().connectionError).toBe('unavailable fixture');
  failure = new HubError('read capacity fixture', 429, 'app_read_capacity');
  await expect(syncSessionEvents('pc', key)).rejects.toBe(failure);
  expect(getRemoteState().connection).toBe('error'); expect(getRemoteState().connectionError).toBe('unavailable fixture');
  expect(commands).toEqual(['session.open']);
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
  expect(Object.values(getRemoteState().approvals).map(item => item.approvalId)).toEqual(['current-registry-approval']);
  await syncSessionEvents('pc', key);
  expect(reads).toEqual(['10', '14', '16']);
  expect(Object.values(getRemoteState().approvals).map(item => item.approvalId).sort()).toEqual(['current-registry-approval', 'new-live-approval']);
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

test('a terminal turn with only a streamed prefix silently rereads and completes the message', async () => {
  let opens = 0;
  const partial = event('assistant-message', 10, { text: '一起', final: false, turnId: 'turn-1' });
  const complete = event('assistant-message', 12, { text: '一起去玩', final: true, turnId: 'turn-1' });
  setHubFetch(transport((url, command) => {
    if (command?.type === 'session.open') {
      opens += 1;
      return { ok: true, result: { session, events: [opens === 1 ? partial : complete] } };
    }
    if (url.searchParams.get('limit') === '1') return { events: [], nextSeq: 0, lastSeq: opens ? 11 : 10 };
    return { events: [{ type: 'turn', deviceId: 'pc', sessionKey: key, tool: 'codex', ts: 11, seq: 11, status: 'completed', turnId: 'turn-1' }], nextSeq: 11, lastSeq: 11 };
  }));
  await pair(); await openSession('pc', key); await syncSessionEvents('pc', key);
  expect(opens).toBe(2);
  expect(getRemoteState().timelines[timelineKey('pc', key)].items).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'assistant-message', text: '一起去玩', final: true }),
  ]));
  expect(getRemoteState().timelines[timelineKey('pc', key)].items.some(item => item.kind === 'message' && item.streamState)).toBe(false);
  expect(commands).toEqual(['session.open', 'session.open']);
});

test('Claude Code stream block IDs let a transcript repair replace the same partial bubble', async () => {
  const claudeKey = 'claude:worker';
  const claudeSession: SessionInfo = { ...session, sessionKey: claudeKey, tool: 'claude', client: 'Claude Code' };
  let opens = 0;
  const claudeMessage = (text: string, final: boolean, ts: number): HubEvent => ({ type: 'message', deviceId: 'pc', sessionKey: claudeKey,
    tool: 'claude', id: 'msg_X:1', role: 'assistant', text, final, ts, seq: ts, turnId: 'claude-turn' } as HubEvent);
  setHubFetch(transport((url, command) => {
    if (command?.type === 'session.open') {
      opens += 1;
      return { ok: true, result: { session: claudeSession, events: [claudeMessage(opens === 1 ? '一起' : '一起去玩', opens > 1, opens === 1 ? 10 : 12)] } };
    }
    if (url.searchParams.get('limit') === '1') return { events: [], nextSeq: 0, lastSeq: 10 };
    return { events: [{ type: 'turn', deviceId: 'pc', sessionKey: claudeKey, tool: 'claude', ts: 11, seq: 11, status: 'completed', turnId: 'claude-turn' }], nextSeq: 11, lastSeq: 11 };
  }));
  await pair(); await openSession('pc', claudeKey); await syncSessionEvents('pc', claudeKey);
  const items = getRemoteState().timelines[timelineKey('pc', claudeKey)].items;
  expect(opens).toBe(2);
  expect(items.filter(item => item.kind === 'message' && item.role === 'assistant')).toHaveLength(1);
  expect(items).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'msg_X:1', text: '一起去玩', final: true })]));
});

test('an unrecoverable terminal prefix stays quiet for a minute and requires another successful read before warning', async () => {
  let now = 1_000;
  const dateNow = jest.spyOn(Date, 'now').mockImplementation(() => now);
  let opens = 0;
  const partial = event('assistant-message', 10, { text: '一起', final: false, turnId: 'turn-stuck' });
  setHubFetch(transport((url, command) => {
    if (command?.type === 'session.open') {
      opens += 1;
      return { ok: true, result: { session, events: [partial] } };
    }
    if (url.searchParams.get('limit') === '1') return { events: [], nextSeq: 0, lastSeq: 10 };
    return { events: [{ type: 'turn', deviceId: 'pc', sessionKey: key, tool: 'codex', ts: 11, seq: 11, status: 'completed', turnId: 'turn-stuck' }], nextSeq: 11, lastSeq: 11 };
  }));
  try {
    await pair(); await openSession('pc', key); await syncSessionEvents('pc', key);
    expect(opens).toBe(2); // initial snapshot plus first quiet repair
    expect(getRemoteState().timelines[timelineKey('pc', key)].items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'assistant-message', text: '一起', final: false, streamState: 'terminal-unconfirmed' }),
    ]));

    now += 1_000;
    await syncSessionEvents('pc', key);
    expect(opens).toBe(3);
    now += 5_000;
    await syncSessionEvents('pc', key);
    expect(opens).toBe(4);
    expect(getRemoteState().timelines[timelineKey('pc', key)].items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'assistant-message', text: '一起', final: false, streamState: 'terminal-unconfirmed' }),
    ]));
    now += 15_000;
    await syncSessionEvents('pc', key);
    expect(getRemoteState().timelines[timelineKey('pc', key)].items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'assistant-message', final: false, streamState: 'terminal-unconfirmed' }),
    ]));
    now = 61_000;
    await syncSessionEvents('pc', key);
    expect(getRemoteState().timelines[timelineKey('pc', key)].items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'assistant-message', text: '一起', final: false, streamState: 'incomplete' }),
    ]));
    expect(commands).toEqual(Array(6).fill('session.open'));
  } finally {
    dateNow.mockRestore();
  }
});

test('first baseline may skip buffered approvals because the fresh computer registry returns current requests', async () => {
  setHubFetch(transport((url, command) => command ? { ok: true, result: { session, events: [{ type: 'approval.request', deviceId: 'pc', sessionKey: key,
    tool: 'codex', ts: 10, approvalId: 'current', kind: 'command', title: 'Still waiting locally' }] } }
    : { events: [{ type: 'approval.request', deviceId: 'pc', sessionKey: key, tool: 'codex', ts: 9, seq: 9,
      approvalId: 'expired', kind: 'command', title: 'Stale Hub buffer' }], nextSeq: 10, lastSeq: 10 }));
  await pair(); await openSession('pc', key);
  expect(Object.values(getRemoteState().approvals).map(item => item.approvalId)).toEqual(['current']);
  expect(commands).toEqual(['session.open']);
});

test('a fresh snapshot replaces the optimistic bubble instead of showing the message twice', () => {
  const sent = { ...EMPTY_TIMELINE, items: [{ kind: 'message' as const, id: 'local:1', role: 'user' as const, text: '修一下', final: true, ts: 5, local: true }] };
  const next = mergeHistory(sent, session, [event('u1', 1, { role: 'user', text: '修一下' }), event('a1', 1)]);
  expect(next.items.map((item) => item.id)).toEqual(['u1', 'a1']);
});

test.each(['message', 'tool'])('a %s metadata update cannot keep a local URI verified for older content', kind => {
  const ref = { id: `att_${'a'.repeat(32)}`, mime: 'image/png', size: 24, sha256: 'b'.repeat(64) };
  const seed = kind === 'message' ? event('image-row', 1, { attachments: [ref] })
    : { type: 'tool', deviceId: 'pc', sessionKey: key, tool: 'codex', ts: 1, id: 'image-row', kind: 'image_generation', title: 'Image', status: 'done', attachments: [ref] } as HubEvent;
  let timeline = applyEvent(EMPTY_TIMELINE, seed);
  timeline = { ...timeline, items: timeline.items.map(item => item.kind === 'message' || item.kind === 'tool'
    ? { ...item, attachments: [{ ...ref, uri: 'file:///fixture/old.png' }], ...(item.kind === 'message' ? { images: ['file:///fixture/old.png'] } : {}) } : item) };
  const repeated = applyEvent(timeline, { ...seed, ts: 2 } as HubEvent);
  expect(repeated.items[0]).toMatchObject({ attachments: [{ ...ref, uri: 'file:///fixture/old.png' }] });
  const changed = applyEvent(timeline, { ...seed, ts: 3, attachments: [{ ...ref, sha256: 'c'.repeat(64) }] } as HubEvent);
  expect(changed.items[0]).toMatchObject({ attachments: [{ ...ref, sha256: 'c'.repeat(64) }] });
  expect(JSON.stringify(changed.items)).not.toContain('old.png');
});

test('materialization results require exact content metadata and pairing, including optional-field upgrades', async () => {
  const current = { id: `att_${'a'.repeat(32)}`, mime: 'image/png', size: 24, sha256: 'b'.repeat(64) };
  setHubFetch(transport((_url, command) => command ? { ok: true, result: { session, events: [event('image', 10, { attachments: [current] })], lastSeq: 0 } }
    : { events: [], nextSeq: 0, lastSeq: 0 }));
  await pair(); await openSession('pc', key);
  const owner = remoteDeliveryScope();
  const read = () => getRemoteState().timelines[timelineKey('pc', key)].items[0];
  expect(attachMaterializedUri('pc', key, { id: current.id, mime: current.mime }, 'file:///fixture/late-unverified.png', owner)).toBe(false);
  expect(attachMaterializedUri('pc', key, { ...current, sha256: 'c'.repeat(64) }, 'file:///fixture/wrong-digest.png', owner)).toBe(false);
  expect(attachMaterializedUri('pc', key, current, 'file:///fixture/other-pairing.png', `${owner}-other`)).toBe(false);
  expect(attachMaterializedUri('pc', key, current, 'https://private.example/credential', owner)).toBe(false);
  expect(read()).toMatchObject({ attachments: [current] });
  expect(attachMaterializedUri('pc', key, current, 'file:///fixture/current.png', owner)).toBe(true);
  expect(attachMaterializedUri('pc', key, { id: current.id, mime: current.mime }, 'file:///fixture/late.png', owner)).toBe(false);
  expect(read()).toMatchObject({ attachments: [{ ...current, uri: 'file:///fixture/current.png' }], images: ['file:///fixture/current.png'] });
});
