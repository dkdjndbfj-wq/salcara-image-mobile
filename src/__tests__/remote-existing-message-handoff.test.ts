import { setHubFetch, type FetchLike } from '../remote/client';
import { bootRemote, connectStation, getPendingRemoteMessage, pairRemoteQr, parseRemoteQr, remoteDeliveryScope, resetRemoteForTests, sendToSession } from '../remote/store';
import { deliverMessage, pendingDelivery, resetDeliveryForTests, type DeliveryDraftOwner } from '../remote/delivery';
import { createComposerDraftSession } from '../remote/composer-drafts';
import { consumeAcceptedQueuedDraft, loadRemoteQueuedDrafts, saveRemoteQueuedDrafts } from '../remote/drafts';

const mockSettings = new Map<string, string>(), mockSecrets = new Map<string, string>();
let mockFailConsume = false, mockFailQueue = false, mockFailReceiptCleanup = false;
const mockWriteOrder: string[] = [];
jest.mock('../storage/database', () => ({ getSetting: async (key: string) => mockSettings.get(key) ?? null,
  setSetting: async (key: string, value: string | null) => {
    if (key === 'remote_composer_drafts_v1' && value?.includes('consumedFrom')) {
      mockWriteOrder.push('consume'); if (mockFailConsume) throw new Error('synthetic composer commit failure');
    }
    if (key === 'remote_queued_v1' && mockFailQueue) throw new Error('synthetic queue commit failure');
    if (key === 'remote_pending_delivery_v1') {
      if (value?.includes('acceptedSessionKey')) mockWriteOrder.push('accepted');
      if (value === '[]') { mockWriteOrder.push('retire'); if (mockFailReceiptCleanup) throw new Error('synthetic receipt cleanup failure'); }
    }
    if (value === null) mockSettings.delete(key); else mockSettings.set(key, value);
  } }));
jest.mock('expo-crypto', () => ({ randomUUID: () => require('node:crypto').randomUUID(), CryptoDigestAlgorithm: { SHA256: 'SHA256' },
  digestStringAsync: async (_algorithm: string, value: string) => require('node:crypto').createHash('sha256').update(value).digest('hex') }));
jest.mock('../storage/secure-keys', () => ({ getProviderKey: async () => null }));
jest.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'private',
  getItemAsync: async (key: string) => mockSecrets.get(key) ?? null, setItemAsync: async (key: string, value: string) => { mockSecrets.set(key, value); },
  deleteItemAsync: async (key: string) => { mockSecrets.delete(key); } }));
jest.mock('expo-file-system/legacy', () => ({ documentDirectory: 'file://synthetic-private/', EncodingType: { Base64: 'base64' },
  getInfoAsync: async () => ({ exists: true, isDirectory: false }), readAsStringAsync: async () => 'AQID',
  makeDirectoryAsync: async () => undefined, copyAsync: async () => undefined }));

const origin = 'https://message-handoff.invalid', hubUrl = `${origin}/salcara-hub/v1`;
const device = { deviceId: 'pc', name: 'Fixture', os: 'windows', online: true, lastSeen: 1, tools: [], projects: [] };
const sessionKey = 'codex:existing';
const ok = (value: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });
let writes: Array<{ requestId: string; command: Record<string, unknown> }>;
let handleSend: () => Promise<void>;
beforeEach(async () => {
  resetRemoteForTests(); mockSettings.clear(); mockSecrets.clear(); mockWriteOrder.length = 0;
  mockFailConsume = false; mockFailQueue = false; mockFailReceiptCleanup = false; writes = []; handleSend = async () => undefined;
  setHubFetch((async (url, init) => {
    if (url.endsWith('/ping')) return ok({ service: 'salcara-hub', protocol: 'salcara-remote', protocolVersion: 1, authModes: ['device-pairing'],
      capabilities: ['device.identity.v1', 'pair.qr.v1', 'session.remote.v1', 'pair.revoke.v1', 'commands.idempotency.v1'] });
    if (url.endsWith('/app/pair/qr')) return ok({ pair_token: 'a'.repeat(64), device });
    if (url.endsWith('/app/devices')) return ok({ devices: [device] });
    if (url.endsWith('/app/commands')) {
      const body = JSON.parse(String(init.body));
      if (body.command.type === 'session.send') { writes.push(body); await handleSend(); }
      return ok({ ok: true, result: {} });
    }
    throw new Error('unexpected fixture endpoint');
  }) as FetchLike);
  await bootRemote([]); await connectStation(origin);
  await pairRemoteQr(parseRemoteQr(JSON.stringify({ type: 'salcara-remote-pair', version: 1, hubUrl, deviceId: 'pc', deviceName: 'Fixture', ticket: 'b'.repeat(64), expiresAt: Date.now() + 120_000 })));
});
afterEach(() => { resetRemoteForTests(); setHubFetch(null); });
async function prepare(text = 'original task') {
  const scope = remoteDeliveryScope(), key = `${scope}|pc|${sessionKey}`;
  const composer = createComposerDraftSession(key, scope); await composer.restore();
  const draft = await composer.save({ text, images: [] });
  const draftOwner: DeliveryDraftOwner = { kind: 'composer', key, revision: draft.revision, identity: draft.identity! };
  return { scope, key, composer, draft, draftOwner };
}
const send = (draftOwner: DeliveryDraftOwner, text = 'original task') => sendToSession('pc', sessionKey, text, { draftOwner });

test('acceptance is durable before consuming the original draft and retiring its UUID', async () => {
  const prepared = await prepare();
  await send(prepared.draftOwner);
  expect(mockWriteOrder.indexOf('accepted')).toBeLessThan(mockWriteOrder.indexOf('consume'));
  expect(mockWriteOrder.indexOf('consume')).toBeLessThan(mockWriteOrder.indexOf('retire'));
  expect(await getPendingRemoteMessage('pc', sessionKey)).toBeUndefined();
  expect(await createComposerDraftSession(prepared.key, prepared.scope).restore()).toMatchObject({ text: '', imageCount: 0 });
  expect(writes).toHaveLength(1); expect(writes[0].command).not.toHaveProperty('draftOwner');
});

test('restart after accepted draft cleanup failure reconciles locally with no second command', async () => {
  const prepared = await prepare(); mockFailConsume = true;
  await expect(send(prepared.draftOwner)).rejects.toMatchObject({ name: 'DeliveryPendingError', receiptCreatedByCall: true });
  const receipt = await getPendingRemoteMessage('pc', sessionKey);
  expect(receipt).toMatchObject({ acceptedSessionKey: sessionKey, draftOwner: prepared.draftOwner });
  prepared.composer.dispose(); resetDeliveryForTests(); mockFailConsume = false;
  setHubFetch(async () => { throw new Error('recovery must not touch the network'); });
  expect(await getPendingRemoteMessage('pc', sessionKey, { settleAccepted: true })).toBeUndefined();
  expect(await createComposerDraftSession(prepared.key, prepared.scope).restore()).toMatchObject({ text: '', images: [] });
  expect(writes).toHaveLength(1);
});

test('new edits during failed cleanup survive acceptance reconciliation', async () => {
  const prepared = await prepare(); mockFailConsume = true;
  await expect(send(prepared.draftOwner)).rejects.toThrow();
  await prepared.composer.save({ text: 'a different new task', images: [] });
  mockFailConsume = false;
  expect(await getPendingRemoteMessage('pc', sessionKey, { settleAccepted: true })).toBeUndefined();
  expect(await createComposerDraftSession(prepared.key, prepared.scope).restore()).toMatchObject({ text: 'a different new task' });
  expect(writes).toHaveLength(1);
});

test('a pruned draft revision reused for a later edit cannot be consumed by the old UUID', async () => {
  const prepared = await prepare(); mockFailConsume = true;
  await expect(send(prepared.draftOwner)).rejects.toThrow(); mockFailConsume = false;
  await prepared.composer.consume(prepared.draft.revision); await prepared.composer.pruneEmpty();
  const newer = await prepared.composer.save({ text: 'original task', images: [] });
  expect(newer.revision).toBe(prepared.draft.revision); expect(newer.identity).not.toBe(prepared.draft.identity);
  expect(await getPendingRemoteMessage('pc', sessionKey, { settleAccepted: true })).toBeUndefined();
  expect(await createComposerDraftSession(prepared.key, prepared.scope).restore()).toMatchObject({ identity: newer.identity, text: 'original task' });
});

test('changing pages during send leaves a tombstone that fences stale composer saves', async () => {
  const prepared = await prepare(); let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  handleSend = () => { entered(); return new Promise<void>(resolve => { release = resolve; }); };
  const sending = send(prepared.draftOwner); await started; prepared.composer.dispose();
  const reopened = createComposerDraftSession(prepared.key, prepared.scope); const old = await reopened.restore();
  release(); await sending;
  await expect(reopened.save(old!)).rejects.toThrow('草稿已在其他窗口改变');
  await reopened.save({ text: 'new edit after returning', images: [] });
  expect(await createComposerDraftSession(prepared.key, prepared.scope).restore()).toMatchObject({ text: 'new edit after returning' });
});

test('failed receipt deletion after draft consumption remains recoverable without a second send', async () => {
  const prepared = await prepare(); mockFailReceiptCleanup = true;
  await expect(send(prepared.draftOwner)).rejects.toThrow();
  expect(await pendingDelivery(prepared.scope, 'pc', sessionKey)).toMatchObject({ acceptedSessionKey: sessionKey });
  mockFailReceiptCleanup = false; resetDeliveryForTests();
  expect(await getPendingRemoteMessage('pc', sessionKey, { settleAccepted: true })).toBeUndefined(); expect(writes).toHaveLength(1);
});

test('accepted queue recovery removes only its original row and preserves the next turn gate', async () => {
  const scope = remoteDeliveryScope(), key = `${scope}|pc|${sessionKey}`;
  const queued = (id: string, text: string) => ({ id, scope, text, images: [], state: 'waiting' as const, apiIdentity: 'fixture', sendOptions: { surface: 'cli' as const } });
  await saveRemoteQueuedDrafts(key, [queued('original', 'original task'), queued('next', 'next task')]);
  mockFailQueue = true;
  await expect(send({ kind: 'queue', key, id: 'original', afterTurn: 'turn-before-send' })).rejects.toThrow();
  expect(await getPendingRemoteMessage('pc', sessionKey)).toMatchObject({ acceptedSessionKey: sessionKey });
  mockFailQueue = false; resetDeliveryForTests();
  expect(await getPendingRemoteMessage('pc', sessionKey, { settleAccepted: true })).toBeUndefined();
  expect(await loadRemoteQueuedDrafts(key)).toEqual([expect.objectContaining({ id: 'next', text: 'next task', afterTurn: 'turn-before-send' })]);
  expect(writes).toHaveLength(1);
});

test('a lost acknowledgement retries the same UUID then reconciles the original draft', async () => {
  const prepared = await prepare(); let lost = true;
  handleSend = async () => { if (lost) throw new Error('synthetic network loss'); };
  await expect(send(prepared.draftOwner)).rejects.toThrow();
  const receipt = await getPendingRemoteMessage('pc', sessionKey); expect(receipt?.acceptedSessionKey).toBeUndefined();
  lost = false;
  await sendToSession('pc', sessionKey, 'original task', { retryRequestId: receipt!.requestId });
  expect(writes.map(item => item.requestId)).toEqual([receipt!.requestId, receipt!.requestId]);
  expect(await createComposerDraftSession(prepared.key, prepared.scope).restore()).toMatchObject({ text: '' });
});

test('a draft from another conversation cannot be consumed or dispatched', async () => {
  const prepared = await prepare();
  await expect(send({ ...prepared.draftOwner, key: `${prepared.scope}|pc|codex:other` })).rejects.toThrow('草稿归属无效');
  expect(writes).toHaveLength(0); expect(await prepared.composer.restore()).toMatchObject({ text: 'original task' });
});

test('an already queued retry cannot redispatch once the durable receipt becomes accepted', async () => {
  const prepared = await prepare(); mockFailConsume = true;
  await expect(send(prepared.draftOwner)).rejects.toThrow();
  const receipt = (await getPendingRemoteMessage('pc', sessionKey))!;
  const perform = jest.fn();
  await deliverMessage({ scope: prepared.scope, deviceId: 'pc', sessionKey, surface: 'cli', text: 'original task', idempotent: true,
    expectedRequestId: receipt.requestId, perform });
  expect(perform).not.toHaveBeenCalled(); expect(writes).toHaveLength(1);
  // Expired network retries do not constrain purely local acceptance cleanup.
  const persisted = JSON.parse(mockSettings.get('remote_pending_delivery_v1')!);
  persisted[0].firstAttemptAt = 1; persisted[0].reviewReason = 'expired';
  mockSettings.set('remote_pending_delivery_v1', JSON.stringify(persisted)); resetDeliveryForTests(); mockFailConsume = false;
  setHubFetch(async () => { throw new Error('no network during accepted recovery'); });
  expect(await getPendingRemoteMessage('pc', sessionKey, { settleAccepted: true })).toBeUndefined();
});

test.each(['unmount', 'stop'] as const)('late %s queue snapshot cannot resurrect an accepted row or lose its next-turn gate', async callback => {
  const scope = remoteDeliveryScope(), key = `${scope}|pc|${sessionKey}`;
  const queued = (id: string, text: string) => ({ id, scope, text, images: [], state: 'waiting' as const, apiIdentity: 'fixture', sendOptions: { surface: 'cli' as const } });
  const stale = await saveRemoteQueuedDrafts(key, [queued(`accepted-${callback}`, 'original task'), queued(`next-${callback}`, 'next task')]);
  await send({ kind: 'queue', key, id: `accepted-${callback}`, afterTurn: 'original-turn' });
  expect(await getPendingRemoteMessage('pc', sessionKey)).toBeUndefined();
  const saved = await saveRemoteQueuedDrafts(key, stale.map(row => ({ ...row, state: callback === 'stop' ? 'blocked' as const : 'attempting' as const })));
  expect(saved).toEqual([expect.objectContaining({ id: `next-${callback}`, afterTurn: 'original-turn' })]);
  expect(await loadRemoteQueuedDrafts(key)).toEqual([expect.objectContaining({ id: `next-${callback}`, afterTurn: 'original-turn' })]);
  expect(writes).toHaveLength(1);
});

test.each([false, true])('an accepted row already absent from disk is still fenced against old callbacks (other rows=%s)', async keepOther => {
  const scope = remoteDeliveryScope(), key = `${scope}|pc|${sessionKey}`, id = `already-removed-${keepOther}`;
  const row = { id, scope, text: 'original task', images: [], state: 'waiting' as const, apiIdentity: 'fixture', sendOptions: { surface: 'cli' as const } };
  const stale = await saveRemoteQueuedDrafts(key, [row]);
  await saveRemoteQueuedDrafts(key, keepOther ? [{ ...row, id: `other-${keepOther}`, text: 'other' }] : []);
  await consumeAcceptedQueuedDraft(key, scope, id, 'old-turn');
  const saved = await saveRemoteQueuedDrafts(key, stale);
  expect(saved.some(item => item.id === id)).toBe(false);
  if (keepOther) expect(saved).toEqual([expect.objectContaining({ id: `other-${keepOther}`, text: 'other' })]);
  expect((await loadRemoteQueuedDrafts(key)).some(item => item.id === id)).toBe(false);
});
