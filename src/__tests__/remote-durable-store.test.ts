import { HubError, setHubFetch, type DeviceStatus, type FetchLike, type HubEvent, type SessionInfo } from '../remote/client';
import { applyEvent, applyRecoveredEvent, bootRemote, connectStation, EMPTY_TIMELINE, getRemoteState, mergeHistory, openSession, pairRemoteQr,
  parseRemoteQr, resetRemoteForTests, syncSessionEvents, sessionCursor, timelineKey, approvalStateKey, loadEarlierHistory, loadSessions, loadMoreSessions, preloadRecentSessionMessages } from '../remote/store';
import { attachMaterializedUri, remoteDeliveryScope } from '../remote/store';
import { sendToSession, materializeAttachmentThumbnail } from '../remote/store';
import { pendingDelivery } from '../remote/delivery';
import * as attachmentCache from '../remote/attachment-cache';

let mockFailWrite = false;
let mockUUID = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `0199aaa1-1234-4678-9abc-${String(++mockUUID).padStart(12, '0')}` }));
const mockSettings = new Map<string, string>();
const mockSecrets = new Map<string, string>();
jest.mock('../storage/database', () => ({ getSetting: async (key: string) => mockSettings.get(key) ?? null,
  setSetting: async (key: string, value: string | null) => { if (mockFailWrite && key === 'remote.durable.events.v1') throw new Error('disk full'); if (value === null) mockSettings.delete(key); else mockSettings.set(key, value); } }));
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
const capabilities = ['device.identity.v1', 'pair.qr.v1', 'session.remote.v1', 'pair.revoke.v1', 'events.cursor.v1', 'commands.idempotency.v1', 'events.durable.v1', 'commands.durable.v2', 'storage.blobs.v1'];
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
beforeEach(() => { resetRemoteForTests(); mockSettings.clear(); mockSecrets.clear(); commands.length = 0; device.online = true; mockFailWrite = false; mockUUID = 0; });
afterEach(() => { resetRemoteForTests(); setHubFetch(null); device.online = true; });

test('offline computer events are committed before ACK, then restore after phone restart', async () => {
  device.online = false; let acknowledgements = 0;
  setHubFetch(transport((url, command) => {
    if (command) throw new Error('must not contact offline computer');
    if (url.pathname.endsWith('/events/ack')) {
      acknowledgements++;
      expect(mockSettings.get('remote.durable.events.v1')).toContain('saved while offline');
      return { ok: true, through: 4, storageEpoch: 'one' };
    }
    return { events: [event('reply', 4, { seq: 4, text: 'saved while offline' })], nextSeq: 4, lastSeq: 4, storageEpoch: 'one' };
  }));
  await pair(); await syncSessionEvents('pc', key);
  expect(acknowledgements).toBe(1);
  expect(sessionCursor('pc', key)).toBe(4);
  expect(getRemoteState().timelines[timelineKey('pc', key)].items).toEqual(expect.arrayContaining([expect.objectContaining({ text: 'saved while offline' })]));
  resetRemoteForTests(); await bootRemote([]); await syncSessionEvents('pc', key);
  expect(getRemoteState().timelines[timelineKey('pc', key)].items).toEqual(expect.arrayContaining([expect.objectContaining({ text: 'saved while offline' })]));
});

test('failed phone disk write neither ACKs events nor advances its retry cursor', async () => {
  device.online = false; let acknowledged = false;
  setHubFetch(transport(url => {
    if (url.pathname.endsWith('/events/ack')) { acknowledged = true; return {}; }
    return { events: [event('reply', 4, { seq: 4 })], nextSeq: 4, lastSeq: 4, storageEpoch: 'one' };
  }));
  await pair(); mockFailWrite = true;
  await expect(syncSessionEvents('pc', key)).rejects.toThrow('disk full');
  expect(acknowledged).toBe(false); expect(sessionCursor('pc', key)).toBe(0);
  mockFailWrite = false; await syncSessionEvents('pc', key);
  expect(acknowledged).toBe(true); expect(sessionCursor('pc', key)).toBe(4);
});

test('storage epoch change replays from zero without discarding existing phone content', async () => {
  device.online = false; let epoch = 'one'; const after: number[] = [];
  setHubFetch(transport(url => {
    if (url.pathname.endsWith('/events/ack')) return { ok: true };
    const cursor = Number(url.searchParams.get('after')); after.push(cursor);
    return epoch === 'one' ? { events: [event('old', 9, { seq: 9 })], nextSeq: 9, lastSeq: 9, storageEpoch: epoch }
      : { events: cursor ? [] : [event('new', 10, { seq: 1 })], nextSeq: 1, lastSeq: 1, resetRequired: cursor > 0, storageEpoch: epoch };
  }));
  await pair(); await syncSessionEvents('pc', key);
  epoch = 'two'; await syncSessionEvents('pc', key);
  expect(after).toEqual([0, 9, 0]); expect(commands).toEqual([]);
  expect(sessionCursor('pc', key)).toBe(1);
  expect(getRemoteState().timelines[timelineKey('pc', key)].items.map(item => item.id)).toEqual(expect.arrayContaining(['old', 'new']));
});

test('expired earlier events do not block offline access to the retained suffix', async () => {
  device.online = false;
  setHubFetch(transport((url, command) => {
    if (command) throw new Error('offline computer must not be required');
    if (url.pathname.endsWith('/events/ack')) return { ok: true };
    return { events: [event('retained', 10, { seq: 10 })], nextSeq: 10, lastSeq: 10, storageEpoch: 'one', resetRequired: true };
  }));
  await pair(); await syncSessionEvents('pc', key);
  expect(getRemoteState().timelines[timelineKey('pc', key)].items).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'retained' }), expect.objectContaining({ kind: 'notice', text: expect.stringContaining('保留期') }),
  ]));
  expect(mockSettings.get('remote.durable.events.v1')).toContain('保留期');
  expect(sessionCursor('pc', key)).toBe(10);
});

test('actual send path keeps draft intent distinct from its execution and recovers a lost reply', async () => {
  const operationId = '0199aaa1-1234-4678-9abc-999999999991';
  const issued = { operationId, ticket: 'signed', dispatchNotAfter: Date.now() + 600_000, storageEpoch: 'one' };
  let prepares = 0, sends = 0;
  const fallback = transport(() => ({ events: [], nextSeq: 0, lastSeq: 0, storageEpoch: 'one' }));
  setHubFetch(async (endpoint, init) => {
    if (endpoint.endsWith('/app/commands/prepare')) { prepares++; return response({ ...issued, state: 'prepared' }); }
    if (endpoint.includes('/app/operations?')) return response({ ...issued, ok: true, state: sends ? 'completed' : 'prepared', ...(sends ? { result: { accepted: true } } : {}) });
    if (endpoint.endsWith('/app/operations/ack')) return response({ ok: true });
    if (endpoint.endsWith('/app/commands')) {
      const envelope = JSON.parse(String(init.body));
      expect(envelope).toMatchObject({ requestId: operationId, executionTicket: 'signed', command: { type: 'session.send', operationId } });
      sends++; throw new Error('lost execution response');
    }
    return fallback(endpoint, init);
  });
  await pair();
  await expect(sendToSession('pc', key, 'send once')).rejects.toMatchObject({ retryable: true });
  const receipt = await pendingDelivery(remoteDeliveryScope(), 'pc', key);
  expect(receipt).toMatchObject({ durableProtocol: 2, executionId: operationId }); expect(receipt!.requestId).not.toBe(operationId);
  expect(getRemoteState().timelines[timelineKey('pc', key)].items).toEqual(expect.arrayContaining([expect.objectContaining({ clientId: operationId })]));
  await sendToSession('pc', key, 'send once', { retryRequestId: receipt!.requestId });
  expect([prepares, sends]).toEqual([1, 1]);
  expect(await pendingDelivery(remoteDeliveryScope(), 'pc', key)).toBeUndefined();
});

test('thumbnail transport uses the existing session authorization and keeps the original reference intact', async () => {
  const ref = { id: `att_${'e'.repeat(32)}`, mime: 'image/png', size: 800_000, width: 1600, height: 1200 };
  const requested: Record<string, unknown>[] = [];
  setHubFetch(transport((_url, command) => {
    if (command) { requested.push(command); return { ok: true, result: { id: ref.id, mime: 'image/jpeg', size: 4, offset: 0, nextOffset: 4, complete: true, data: '/9j/AA==' } }; }
    return {};
  }));
  const cached = jest.spyOn(attachmentCache, 'cachedAttachment').mockImplementationOnce(async (scope, derived, fetchPage, signal) => {
    expect(scope).toContain('\u0000thumbnail'); expect(derived.id).not.toBe(ref.id); expect(derived.mime).toBe('image/jpeg');
    expect(await fetchPage(0, signal ?? new AbortController().signal)).toMatchObject({ id: derived.id, mime: 'image/jpeg', size: 4 });
    return 'file://cache/thumbnail.jpg';
  });
  try {
    await pair();
    expect(await materializeAttachmentThumbnail('pc', ref, undefined, key)).toBe('file://cache/thumbnail.jpg');
    expect(requested).toEqual([{ type: 'attachment.read', id: ref.id, sessionKey: key, variant: 'thumbnail', offset: 0, length: 90000 }]);
    expect(ref).toEqual({ id: `att_${'e'.repeat(32)}`, mime: 'image/png', size: 800_000, width: 1600, height: 1200 });
  } finally { cached.mockRestore(); }
});

