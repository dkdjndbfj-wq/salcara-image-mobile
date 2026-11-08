import { createHash } from 'node:crypto';
import { AppState } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { setHubFetch, type FetchLike } from '../remote/client';
import { bootRemote, connectStation, getPendingNewSession, loadAgentProfiles, pairRemoteQr, parseRemoteQr,
  remoteDeliveryScope, resetRemoteForTests, retryNewSession, startSession } from '../remote/store';
import { acknowledgeNewSession, newSessionReceiptKey } from '../remote/store';
import { deliverMessage, pendingDelivery, resetDeliveryForTests, retireDeliveryScope } from '../remote/delivery';
import { decodeNewTask, encodeNewTask, type NewTaskSnapshot } from '../remote/new-task';

// Independent fixture: synthetic storage, bytes and network only. Nothing
// reads real credentials/files, starts an Agent or calls a paid model.
const RECEIPTS = 'remote_pending_delivery_v1';
const mockSettings = new Map<string, string>(), mockSecrets = new Map<string, string>();
let mockSequence = 0, mockFailAcceptedOutcome = false;
let mockReadGate: { key: string; entered: () => void; wait: Promise<void> } | undefined;
const mockStorageWrites: Array<{ key: string; value: string | null }> = [];
jest.mock('expo-crypto', () => ({ randomUUID: () => `0199aaa1-1234-4678-9abc-${String(++mockSequence).padStart(12, '0')}` }));
jest.mock('../storage/database', () => ({
  getSetting: async (key: string) => {
    if (mockReadGate?.key === key) {
      const gate = mockReadGate; mockReadGate = undefined; gate.entered(); await gate.wait;
    }
    return mockSettings.get(key) ?? null;
  },
  setSetting: async (key: string, value: string | null) => {
    mockStorageWrites.push({ key, value });
    if (key === 'remote_pending_delivery_v1' && mockFailAcceptedOutcome && value?.includes('acceptedSessionKey')) {
      mockFailAcceptedOutcome = false; throw new Error('synthetic accepted outcome commit failure');
    }
    if (value === null) mockSettings.delete(key); else mockSettings.set(key, value);
  },
}));
jest.mock('../storage/secure-keys', () => ({ getProviderKey: async () => null }));
jest.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'private',
  getItemAsync: async (key: string) => mockSecrets.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { mockSecrets.set(key, value); },
  deleteItemAsync: async (key: string) => { mockSecrets.delete(key); },
}));
jest.mock('expo-file-system/legacy', () => ({ documentDirectory: 'file://private/', EncodingType: { Base64: 'base64' },
  getInfoAsync: jest.fn(), readAsStringAsync: jest.fn(), makeDirectoryAsync: jest.fn(), copyAsync: jest.fn(),
}));

const station = 'https://independent-new-task.example', hubUrl = `${station}/salcara-hub/v1`;
const device = { deviceId: 'pc', name: 'Synthetic', os: 'windows', online: true, lastSeen: 1, tools: [], projects: [] };
const originalImage = { uri: 'file://private/image-a', base64: 'AQID', mime: 'image/jpeg' as const, width: 1, height: 1 };
const digest = (payload: string) => createHash('sha256').update(payload).digest('hex');
const input = () => ({ tool: 'codex' as const, cwd: 'C:/original', prompt: 'original synthetic task', approval: 'ask' as const,
  accountId: 'api_aabbccdd', model: 'fixture-model', effort: 'low' as const,
  composerDraft: { key: `${remoteDeliveryScope()}|pc|new:codex`, revision: 1 }, images: [{ ...originalImage }],
});
type CommandWrite = { requestId: string; command: Record<string, unknown> };
let writes: CommandWrite[], handle: (write: CommandWrite) => unknown | Promise<unknown>;
const ok = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
function transport() {
  setHubFetch((async (url, init) => {
    if (url.endsWith('/ping')) return ok({ service: 'salcara-hub', protocol: 'salcara-remote', protocolVersion: 1,
      authModes: ['device-pairing'], capabilities: ['device.identity.v1', 'pair.qr.v1', 'session.remote.v1', 'pair.revoke.v1', 'commands.idempotency.v1'] });
    if (url.endsWith('/app/pair/qr')) return ok({ pair_token: 'a'.repeat(64), device });
    if (url.endsWith('/app/devices')) return ok({ devices: [device] });
    if (url.endsWith('/app/commands')) {
      const body = JSON.parse(String(init.body)) as CommandWrite;
      if (body.command.type === 'agents.status') return ok({ ok: true, result: { agents: [
        { id: 'codex', available: true, api: { configured: true, accountId: 'api_aabbccdd', source: 'computer' } },
        { id: 'claude', available: true, api: { configured: true, accountId: 'api_11223344', source: 'computer' } },
      ] } });
      writes.push(body); return ok(await handle(body));
    }
    throw new Error('unexpected synthetic endpoint');
  }) as FetchLike);
}
async function pair() {
  await bootRemote([]); await connectStation(station);
  await pairRemoteQr(parseRemoteQr(JSON.stringify({ type: 'salcara-remote-pair', version: 1, hubUrl,
    deviceId: 'pc', deviceName: 'Synthetic', ticket: 'b'.repeat(64), expiresAt: Date.now() + 120_000 })));
  await loadAgentProfiles('pc');
}
beforeEach(() => {
  resetRemoteForTests(); mockSettings.clear(); mockSecrets.clear(); mockSequence = 0; mockReadGate = undefined;
  mockFailAcceptedOutcome = false; mockStorageWrites.length = 0; writes = [];
  handle = write => ({ ok: true, result: write.command.type === 'session.start' ? { sessionKey: 'codex:created' } : {} });
  (AppState as unknown as { currentState: string }).currentState = 'active';
  (FileSystem.getInfoAsync as jest.Mock).mockReset().mockResolvedValue({ exists: true, isDirectory: false });
  (FileSystem.readAsStringAsync as jest.Mock).mockReset().mockResolvedValue(originalImage.base64);
  (FileSystem.makeDirectoryAsync as jest.Mock).mockReset().mockResolvedValue(undefined);
  (FileSystem.copyAsync as jest.Mock).mockReset().mockResolvedValue(undefined);
  transport();
});
afterEach(() => {
  resetRemoteForTests(); setHubFetch(null); mockReadGate = undefined;
  (AppState as unknown as { currentState: string }).currentState = 'active';
});

test('start freezes all input and image objects before its first storage await', async () => {
  await pair(); resetDeliveryForTests(); const original = input();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  mockReadGate = { key: RECEIPTS, entered: enter, wait: new Promise<void>(resolve => { release = resolve; }) };
  const submitted = startSession('pc', original);
  await entered;
  original.prompt = 'a different task'; original.cwd = 'C:/different'; original.accountId = 'api_cafefeed';
  original.model = 'different-model'; original.composerDraft.key = 'foreign-draft'; original.composerDraft.revision = 99;
  original.images[0].base64 = 'BAUG'; original.images[0].width = 7;
  release();
  await expect(submitted).resolves.toBe('codex:created');
  const start = writes.find(write => write.command.type === 'session.start')!;
  expect(start.command).toMatchObject({ cwd: 'C:/original', prompt: 'original synthetic task', accountId: 'api_aabbccdd', model: 'fixture-model', effort: 'low', approval: 'ask' });
  expect(writes.find(write => write.command.type === 'attachment.put')?.command.data).toBe('AQID');
  const committed = mockStorageWrites.filter(write => write.key === RECEIPTS && write.value !== '[]')
    .map(write => JSON.parse(write.value!)[0]).filter(Boolean)[0];
  expect(decodeNewTask(committed.text)).toMatchObject({ composerDraft: { key: `${remoteDeliveryScope()}|pc|new:codex`, revision: 1 },
    images: [{ mime: 'image/jpeg', width: 1, height: 1, digest: digest('AQID') }] });
});

test.each(['digest', 'mime', 'width', 'height'] as const)('retry requires restored image %s to match canonical snapshot, not just its own source record', async mismatch => {
  await pair(); handle = () => { throw new Error('synthetic upload interruption'); };
  await expect(startSession('pc', input())).rejects.toMatchObject({ name: 'DeliveryPendingError' });
  const rows = JSON.parse(mockSettings.get(RECEIPTS)!);
  const source = rows[0].attachmentSources[0];
  if (mismatch === 'digest') { source.digest = digest('BAUG'); source.uri = 'file://private/image-b'; (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue('BAUG'); }
  else if (mismatch === 'mime') source.mime = 'image/png';
  else source[mismatch] = 2;
  const changed = JSON.stringify(rows); mockSettings.set(RECEIPTS, changed); resetDeliveryForTests();
  writes = []; mockStorageWrites.length = 0;
  handle = write => ({ ok: true, result: write.command.type === 'session.start' ? { sessionKey: 'codex:created' } : {} });
  await expect(retryNewSession('pc', 'codex', false, rows[0].requestId)).rejects.toBeTruthy();
  expect(writes).toEqual([]);
  // A read/observation may update its clock, but it may not substitute a new
  // source payload or rewrite the frozen start to match the changed source.
  const preserved = JSON.parse(mockSettings.get(RECEIPTS)!)[0];
  expect(preserved.text).toBe(rows[0].text); expect(preserved.attachmentSources).toEqual(rows[0].attachmentSources);
});

test.each(['outer', 'options', 'source'] as const)('unknown %s receipt metadata remains unreadable and untouched instead of being normalised away', async nesting => {
  await pair(); handle = () => { throw new Error('synthetic interrupted operation'); };
  await expect(startSession('pc', input())).rejects.toMatchObject({ name: 'DeliveryPendingError' });
  const rows = JSON.parse(mockSettings.get(RECEIPTS)!);
  if (nesting === 'outer') rows[0].futureGuard = { prohibitReplay: true };
  else if (nesting === 'options') rows[0].sendOptions = { model: 'fixture-model', futureMode: 'never-redispatch' };
  else rows[0].attachmentSources[0].futurePolicy = 'do-not-read';
  const changed = JSON.stringify(rows); mockSettings.set(RECEIPTS, changed); resetDeliveryForTests();
  writes = []; mockStorageWrites.length = 0;
  await expect(getPendingNewSession('pc', 'codex')).rejects.toThrow('无法读取');
  await expect(retryNewSession('pc', 'codex', false, rows[0].requestId)).rejects.toThrow('无法读取');
  expect(mockSettings.get(RECEIPTS)).toBe(changed); expect(mockStorageWrites).toEqual([]); expect(writes).toEqual([]);
});

test.each(['prompt', 'escaped-prompt', 'image-mime', 'composer-revision'] as const)('canonical start rejects duplicate JSON field %s', async field => {
  await pair(); const { images: _images, ...base } = input();
  const snapshot: NewTaskSnapshot = { version: 1, ...base, images: [{ mime: 'image/jpeg', width: 1, height: 1, digest: digest('AQID') }] };
  let encoded = encodeNewTask(snapshot);
  if (field === 'prompt') encoded = encoded.replace('"prompt":"original synthetic task"', '"prompt":"untrusted first value","prompt":"original synthetic task"');
  else if (field === 'escaped-prompt') encoded = encoded.replace('"prompt":"original synthetic task"', '"p\\u0072ompt":"untrusted first value","prompt":"original synthetic task"');
  else if (field === 'image-mime') encoded = encoded.replace('"mime":"image/jpeg"', '"mime":"image/png","mime":"image/jpeg"');
  else encoded = encoded.replace('"revision":1', '"revision":99,"revision":1');
  expect(() => decodeNewTask(encoded)).toThrow();
});

test('accepted result commit failure retains the original UUID for safe receipt recovery', async () => {
  await pair(); const submitted = input(); submitted.images = []; mockFailAcceptedOutcome = true;
  expect(await startSession('pc', submitted)).toBe('codex:created');
  const pending = await getPendingNewSession('pc', 'codex');
  expect(pending?.acceptedSessionKey).toBeUndefined(); expect(pending?.requestId).toBe(writes[0].requestId);
  const original = writes[0]; resetDeliveryForTests();
  expect(await retryNewSession('pc', 'codex', false, pending!.requestId)).toBe('codex:created');
  expect(writes).toEqual([original, original]);
  expect(await getPendingNewSession('pc', 'codex')).toMatchObject({ requestId: original.requestId, acceptedSessionKey: 'codex:created' });
  await acknowledgeNewSession('pc', 'codex', false, 'codex:created', remoteDeliveryScope());
  expect(await getPendingNewSession('pc', 'codex')).toBeUndefined();
  expect(writes).toEqual([original, original]);
});

test('accepted task acknowledgement validates exact scope, device, tool and result without dispatching again', async () => {
  await pair(); const scope = remoteDeliveryScope(), submitted = input(); submitted.images = [];
  expect(await startSession('pc', submitted)).toBe('codex:created');
  const receipt = await getPendingNewSession('pc', 'codex');
  expect(receipt).toMatchObject({ acceptedSessionKey: 'codex:created' });
  const originalWrites = writes.slice(), originalRecord = mockSettings.get(RECEIPTS);
  await expect(acknowledgeNewSession('pc', 'codex', false, 'codex:created', `${scope}-different`)).rejects.toBeTruthy();
  await expect(acknowledgeNewSession('other-device', 'codex', false, 'codex:created', scope)).rejects.toBeTruthy();
  await expect(acknowledgeNewSession('pc', 'claude', false, 'codex:created', scope)).rejects.toBeTruthy();
  await expect(acknowledgeNewSession('pc', 'codex', false, 'codex:different', scope)).rejects.toBeTruthy();
  // Read-only ownership checks may advance the observation clock; no ACK may
  // delete the task or change its frozen submission/accepted outcome.
  const withoutObservation = (raw: string | undefined) => JSON.parse(raw!).map(({ lastObservedAt: _clock, ...record }: Record<string, unknown>) => record);
  expect(withoutObservation(mockSettings.get(RECEIPTS))).toEqual(withoutObservation(originalRecord)); expect(writes).toEqual(originalWrites);
  await acknowledgeNewSession('pc', 'codex', false, 'codex:created', scope);
  expect(await getPendingNewSession('pc', 'codex')).toBeUndefined(); expect(writes).toEqual(originalWrites);
});

test('an accepted old-owner task cannot be acknowledged through the current different pairing', async () => {
  await pair(); const originalScope = remoteDeliveryScope(), submitted = input(); submitted.images = [];
  expect(await startSession('pc', submitted)).toBe('codex:created');
  const originalWrites = writes.slice();
  await connectStation('https://other-synthetic-station.example');
  await expect(acknowledgeNewSession('pc', 'codex', false, 'codex:created', originalScope)).rejects.toBeTruthy();
  expect(await pendingDelivery(originalScope, 'pc', newSessionReceiptKey('codex'))).toMatchObject({ acceptedSessionKey: 'codex:created' });
  expect(writes).toEqual(originalWrites);
});

test('valid registered extension IDs retain accepted results using the same namespace rules as their registry', async () => {
  await pair(); const scope = remoteDeliveryScope(), tool = 'Hermes.v2', sessionKey = newSessionReceiptKey(tool);
  const text = encodeNewTask({ ...input(), version: 1, tool, images: [] });
  await deliverMessage({ scope, deviceId: 'pc', sessionKey, surface: 'cli', text, idempotent: true, requireNewReceipt: true,
    perform: async () => ({ sessionKey: `${tool}:accepted-synthetic`, retain: true }) });
  expect(await pendingDelivery(scope, 'pc', sessionKey)).toMatchObject({ acceptedSessionKey: `${tool}:accepted-synthetic` });
  resetDeliveryForTests();
  expect(await pendingDelivery(scope, 'pc', sessionKey)).toMatchObject({ acceptedSessionKey: `${tool}:accepted-synthetic` });
  expect(writes).toEqual([]);
});

test('a virtual outbox sentinel returned by the server cannot masquerade as an accepted real task', async () => {
  await pair(); const submitted = input(); submitted.images = [];
  handle = () => ({ ok: true, result: { sessionKey: newSessionReceiptKey('codex') } });
  await expect(startSession('pc', submitted)).rejects.toMatchObject({ name: 'DeliveryPendingError' });
  const pending = await getPendingNewSession('pc', 'codex');
  expect(pending).toMatchObject({ requestId: writes[0].requestId, text: submitted.prompt });
  expect(pending?.acceptedSessionKey).toBeUndefined();
  expect(writes).toHaveLength(1);
});

test('generic delivery cannot persist an accepted result in another Agent namespace and poison the receipt table', async () => {
  await pair(); const scope = remoteDeliveryScope(), sessionKey = newSessionReceiptKey('codex');
  const text = encodeNewTask({ ...input(), version: 1, images: [] });
  await expect(deliverMessage({ scope, deviceId: 'pc', sessionKey, surface: 'cli', text, idempotent: true, requireNewReceipt: true,
    perform: async () => ({ sessionKey: 'claude:foreign-accepted', retain: true }) })).rejects.toMatchObject({ name: 'DeliveryPendingError' });
  const receipt = await pendingDelivery(scope, 'pc', sessionKey);
  expect(receipt).toMatchObject({ text, attempted: true });
  expect(receipt?.acceptedSessionKey).toBeUndefined();
  resetDeliveryForTests();
  expect(await pendingDelivery(scope, 'pc', sessionKey)).toMatchObject({ requestId: receipt!.requestId, text });
  expect(writes).toEqual([]);
});

test('an accepted result for an old UI owner remains recoverable in its original durable outbox', async () => {
  await pair(); const originalScope = remoteDeliveryScope(), submitted = input(); submitted.images = [];
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  handle = async () => {
    enter(); await new Promise<void>(resolve => { release = resolve; });
    return { ok: true, result: { sessionKey: 'codex:accepted-before-switch' } };
  };
  const outcome = startSession('pc', submitted).catch(error => error);
  await entered; await connectStation('https://other-synthetic-station.example'); release();
  expect(await outcome).toMatchObject({ code: 'request_scope_changed' });
  expect(await pendingDelivery(originalScope, 'pc', newSessionReceiptKey('codex'))).toMatchObject({
    scope: originalScope, requestId: writes[0].requestId, acceptedSessionKey: 'codex:accepted-before-switch',
  });
  expect(writes).toHaveLength(1);
});

test('a late accepted response cannot be reported as current success after exact pairing retirement', async () => {
  await pair(); const originalScope = remoteDeliveryScope(), submitted = input(); submitted.images = [];
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  handle = async () => {
    enter(); await new Promise<void>(resolve => { release = resolve; });
    return { ok: true, result: { sessionKey: 'codex:accepted-before-revocation' } };
  };
  const outcome = startSession('pc', submitted).catch(error => error);
  await entered; await retireDeliveryScope(originalScope); release();
  expect(await outcome).toMatchObject({ name: 'DeliveryPendingError', retryable: false });
  expect(await pendingDelivery(originalScope, 'pc', newSessionReceiptKey('codex'))).toBeUndefined();
  expect(mockSettings.get(RECEIPTS)).toBe('[]'); expect(writes).toHaveLength(1);
});
