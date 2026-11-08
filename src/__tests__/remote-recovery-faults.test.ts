import { setHubFetch, type DeviceStatus, type FetchLike, type HubEvent, type SessionInfo } from '../remote/client';
import { bootRemote, connectStation, getRemoteState, openSession, pairRemoteQr, parseRemoteQr, resetRemoteForTests,
  sessionCursor, syncSessionEvents, timelineKey } from '../remote/store';

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
const key = 'codex:recover';
const device: DeviceStatus = { deviceId: 'pc', name: 'Fixture', os: 'windows', tools: [], projects: [], online: true, lastSeen: 1 };
const session: SessionInfo = { sessionKey: key, tool: 'codex', client: 'Codex App', title: 'Recovery', cwd: '/fixture', updatedAt: 1, status: 'idle', controllable: true };
const message = (id: string, seq: number, extra = {}): HubEvent => ({ type: 'message', deviceId: 'pc', sessionKey: key, tool: 'codex',
  id, role: 'assistant', text: id, final: true, ts: seq, seq, ...extra });
const approval = (id: string, seq: number): HubEvent => ({ type: 'approval.request', deviceId: 'pc', sessionKey: key, tool: 'codex',
  approvalId: id, kind: 'command', title: id, ts: seq, seq });
const response = (value: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });
const writes: string[] = [];
function transport(handler: (url: URL, command?: Record<string, unknown>) => Promise<unknown> | unknown): FetchLike {
  return (async (endpoint, init) => {
    if (endpoint.endsWith('/ping')) return response({ service: 'salcara-hub', protocol: 'salcara-remote', protocolVersion: 1,
      authModes: ['device-pairing'], capabilities: ['device.identity.v1', 'pair.qr.v1', 'session.remote.v1', 'pair.revoke.v1', 'events.cursor.v1', 'commands.idempotency.v1'] });
    if (endpoint.endsWith('/app/pair/qr')) return response({ pair_token: 'a'.repeat(64), device });
    if (endpoint.endsWith('/app/devices')) return response({ devices: [device] });
    const command = endpoint.endsWith('/app/commands') ? JSON.parse(String(init.body)).command : undefined;
    if (command) writes.push(command.type);
    return response(await handler(new URL(endpoint), command));
  }) as FetchLike;
}
async function pair() {
  await bootRemote([]); await connectStation(origin);
  await pairRemoteQr(parseRemoteQr(JSON.stringify({ type: 'salcara-remote-pair', version: 1, hubUrl: `${origin}/salcara-hub/v1`,
    deviceId: 'pc', deviceName: device.name, ticket: 'b'.repeat(64), expiresAt: Date.now() + 120_000 })));
}
const items = () => getRemoteState().timelines[timelineKey('pc', key)].items;
beforeEach(() => { resetRemoteForTests(); mockSettings.clear(); mockSecrets.clear(); writes.length = 0; });
afterEach(() => { resetRemoteForTests(); setHubFetch(null); });

test('cache eviction without a notice replays every retained page before advancing to the snapshot head', async () => {
  let opens = 0;
  const reads: number[] = [];
  setHubFetch(transport((url, command) => {
    if (command) return { ok: true, result: { session, events: ++opens > 1 ? [message('snapshot-tail', 100)] : [] } };
    if (url.searchParams.get('limit') === '1') return { events: [], lastSeq: opens ? 100 : 10, nextSeq: 0 };
    const after = Number(url.searchParams.get('after')); reads.push(after);
    if (after === 10) return { events: [message('retained-first', 40)], nextSeq: 40, lastSeq: 100, hasMore: true, resetRequired: true };
    if (after === 40) return { events: [message('retained-second', 50), approval('stale-buffer-approval', 51)], nextSeq: 51, lastSeq: 100 };
    return { events: [], nextSeq: after, lastSeq: 100 };
  }));
  await pair(); await openSession('pc', key); await syncSessionEvents('pc', key);
  expect(reads).toEqual([10, 40]);
  expect(items()).toEqual(expect.arrayContaining(['retained-first', 'retained-second', 'snapshot-tail'].map(id => expect.objectContaining({ id }))));
  expect(Object.values(getRemoteState().approvals)).toEqual([]);
  expect(sessionCursor('pc', key)).toBe(51);
  expect(writes).toEqual(['session.open', 'session.open']);
});

test('a failed recovery snapshot preserves its cursor and content so retry can consume the same unread page', async () => {
  let opens = 0;
  const reads: number[] = [];
  setHubFetch(transport((url, command) => {
    if (command) return ++opens === 2 ? { ok: false, error: 'computer disconnected during recovery' }
      : { ok: true, result: { session, events: [message(opens === 1 ? 'already-visible' : 'snapshot-tail', opens === 1 ? 10 : 100)] } };
    if (url.searchParams.get('limit') === '1') return { events: [], lastSeq: opens ? 100 : 10, nextSeq: 0 };
    const after = Number(url.searchParams.get('after')); reads.push(after);
    return { events: [message('retained', 40)], nextSeq: 40, lastSeq: 100, resetRequired: true };
  }));
  await pair(); await openSession('pc', key);
  await expect(syncSessionEvents('pc', key)).rejects.toThrow('computer disconnected');
  expect(sessionCursor('pc', key)).toBe(10);
  expect(items()).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'already-visible' })]));
  await syncSessionEvents('pc', key);
  expect(reads).toEqual([10, 10]);
  expect(sessionCursor('pc', key)).toBe(40);
  expect(items()).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'retained' })]));
});

test('explicit sequence reset after relay data loss recovers retained progress and accepts new approvals', async () => {
  let opens = 0;
  const reads: number[] = [];
  setHubFetch(transport((url, command) => {
    if (command) return { ok: true, result: { session, events: ++opens === 1
      ? [message('answer', 1000, { text: 'prefix', final: false })] : [message('answer', 3, { text: 'complete' })] } };
    if (url.searchParams.get('limit') === '1') return { events: [], nextSeq: 0, lastSeq: opens ? 3 : 1000 };
    const after = Number(url.searchParams.get('after')); reads.push(after);
    if (after === 1000) return { events: [message('retained-after-reset', 1)], nextSeq: 1, lastSeq: 3, resetRequired: true, hasMore: true };
    if (after === 0) return { events: [message('retained-after-reset', 1), approval('old-buffer-only', 2)], nextSeq: 2, lastSeq: 3, hasMore: true };
    if (after === 2) return { events: [message('answer', 3, { text: 'complete' })], nextSeq: 3, lastSeq: 3 };
    if (after === 3) return { events: [approval('new-live-approval', 4)], nextSeq: 4, lastSeq: 4 };
    return { events: [], nextSeq: after, lastSeq: 4 };
  }));
  await pair(); await openSession('pc', key); await syncSessionEvents('pc', key);
  expect(reads).toEqual([1000, 0, 2]);
  expect(sessionCursor('pc', key)).toBe(3);
  expect(items().find(item => item.id === 'answer')).toMatchObject({ text: 'complete', final: true });
  expect(items()).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'retained-after-reset' })]));
  await syncSessionEvents('pc', key);
  expect(Object.values(getRemoteState().approvals).map(item => item.approvalId)).toEqual(['new-live-approval']);
  expect(writes).toEqual(['session.open', 'session.open']);
});

test('empty reset cache releases an obsolete cursor and resumes with the first subsequent event', async () => {
  let opens = 0, published = false;
  setHubFetch(transport((url, command) => {
    if (command) { opens += 1; return { ok: true, result: { session, events: [message('saved-on-computer', 1)] } }; }
    const after = Number(url.searchParams.get('after'));
    if (url.searchParams.get('limit') === '1') return { events: [], nextSeq: 0, lastSeq: opens ? 0 : 1000 };
    return { events: published ? [message('new-message', 1)] : [], nextSeq: published ? 1 : 0, lastSeq: published ? 1 : 0, resetRequired: after > 1 };
  }));
  await pair(); await openSession('pc', key); await syncSessionEvents('pc', key);
  expect(sessionCursor('pc', key)).toBe(0);
  published = true; await syncSessionEvents('pc', key);
  expect(sessionCursor('pc', key)).toBe(1);
  expect(items()).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'new-message' })]));
  expect(writes).toEqual(['session.open', 'session.open']);
});
