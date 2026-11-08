import { HubError } from '../remote/client';
import { deliverMessage, pendingDelivery, resetDeliveryForTests, retireDeliveryScope, type PendingDelivery } from '../remote/delivery';

const key = 'remote_pending_delivery_v1';
const retirementKey = 'remote_retired_delivery_scopes_v1';
const oldScope = 'station|credential:revoked';
const otherScope = 'station|credential:still-paired';
const mockSettings = new Map<string, string>();
let mockUuid = 100;
let mockFailReadKey: string | undefined;
let mockFailWriteKey: string | undefined;
const mockRead = jest.fn(async (name: string): Promise<string | null> => {
  if (name === mockFailReadKey) throw new Error('private SQLite read error');
  return mockSettings.get(name) ?? null;
});
const mockWrite = jest.fn(async (name: string, value: string) => {
  if (name === mockFailWriteKey) throw new Error('private SQLite write error');
  mockSettings.set(name, value);
});
jest.mock('../storage/database', () => ({ getSetting: (name: string) => mockRead(name), setSetting: (name: string, value: string) => mockWrite(name, value) }));
jest.mock('expo-crypto', () => ({ randomUUID: () => `0199aaa1-1234-4678-9abc-${String(++mockUuid).padStart(12, '0')}` }));

const input = { scope: oldScope, deviceId: 'pc', sessionKey: 'codex:original', surface: 'cli' as const, text: 'private old task', idempotent: true };
function receipt(index = 1, scope = oldScope): PendingDelivery {
  return { scope, deviceId: input.deviceId, sessionKey: `codex:${index}`, surface: input.surface, text: input.text,
    requestId: `0199aaa1-1234-4678-9abc-${String(index).padStart(12, '0')}`,
    createdAt: Date.now(), attempted: true, safeRetry: true };
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
}
beforeEach(() => {
  resetDeliveryForTests(); mockSettings.clear(); mockUuid = 100; mockFailReadKey = undefined; mockFailWriteKey = undefined;
  mockRead.mockImplementation(async name => {
    if (name === mockFailReadKey) throw new Error('private SQLite read error');
    return mockSettings.get(name) ?? null;
  });
  mockRead.mockClear(); mockWrite.mockClear();
});

test('retiring twenty receipts releases capacity without clearing another pairing', async () => {
  const old = Array.from({ length: 20 }, (_, index) => receipt(index + 1));
  mockSettings.set(key, JSON.stringify(old));
  const perform = jest.fn(async () => { throw new HubError('lost acknowledgement'); });
  await expect(deliverMessage({ ...input, scope: otherScope, requireNewReceipt: true, perform })).rejects.toMatchObject({ retryable: false });
  expect(perform).not.toHaveBeenCalled();
  await retireDeliveryScope(oldScope);
  expect(JSON.parse(mockSettings.get(key)!)).toEqual([]);
  expect(JSON.parse(mockSettings.get(retirementKey)!)).toEqual([oldScope]);
  expect([...mockSettings.values()].join()).not.toContain(input.text);
  await expect(deliverMessage({ ...input, scope: otherScope, requireNewReceipt: true, perform })).rejects.toMatchObject({ retryable: true });
  expect(perform).toHaveBeenCalledTimes(1);
  expect(await pendingDelivery(otherScope, input.deviceId, input.sessionKey)).toMatchObject({ scope: otherScope, text: input.text });
});

test('exact retirement preserves an unknown receipt, image digest and frozen API on another scope', async () => {
  const attachmentId = `att_${'a'.repeat(32)}`;
  const other: PendingDelivery = { ...receipt(2, otherScope), uncertain: true, attachments: [attachmentId], attachmentsUploaded: false,
    attachmentSources: [{ id: attachmentId, uri: 'file://private/original.png', mime: 'image/png', width: 2, height: 2, digest: 'b'.repeat(64) }],
    sendOptions: { accountId: 'api_original', model: 'model-original', effort: 'high' } };
  mockSettings.set(key, JSON.stringify([receipt(), other]));
  await retireDeliveryScope(oldScope);
  expect(JSON.parse(mockSettings.get(key)!)).toEqual([other]);
  expect(await pendingDelivery(oldScope, input.deviceId, 'codex:1')).toBeUndefined();
  expect(await pendingDelivery(otherScope, other.deviceId, other.sessionKey)).toMatchObject(other);
});

test('a retirement queued before a submission blocks both prepare and perform', async () => {
  const prepare = jest.fn(async () => undefined), perform = jest.fn(async () => undefined);
  const retirement = retireDeliveryScope(oldScope);
  const submission = deliverMessage({ ...input, requireNewReceipt: true, attachments: [`att_${'c'.repeat(32)}`], prepare, perform });
  await retirement;
  await expect(submission).rejects.toMatchObject({ name: 'DeliveryPendingError', retryable: false });
  expect(prepare).not.toHaveBeenCalled(); expect(perform).not.toHaveBeenCalled();
  expect(await pendingDelivery(oldScope, input.deviceId, input.sessionKey)).toBeUndefined();
});

test.each(['success', 'transient', 'uncertain', 'definitive'] as const)('a late in-flight command result cannot resurrect a retired receipt: %s', async result => {
  const entered = deferred<void>(), completion = deferred<void>();
  let requestId = '';
  const flight = deliverMessage({ ...input, perform: async value => { requestId = value.requestId; entered.resolve(); await completion.promise; } });
  const outcome = flight.catch(error => error);
  await entered.promise;
  await retireDeliveryScope(oldScope);
  if (result === 'success') completion.resolve();
  else completion.reject(result === 'transient' ? new HubError('lost') : result === 'uncertain'
    ? new HubError('uncertain', 409, 'command_delivery_uncertain') : new HubError('denied', 403, 'forbidden'));
  expect(await outcome).toMatchObject({ name: 'DeliveryPendingError', retryable: false, requestId });
  expect(await pendingDelivery(oldScope, input.deviceId, input.sessionKey)).toBeUndefined();
  expect(JSON.parse(mockSettings.get(key)!)).toEqual([]);
});

test.each(['success', 'failure'] as const)('a late image prepare never enters perform after retirement: %s', async result => {
  const entered = deferred<void>(), upload = deferred<void>();
  const perform = jest.fn(async () => undefined);
  const flight = deliverMessage({ ...input, attachments: [`att_${'d'.repeat(32)}`],
    prepare: async () => { entered.resolve(); await upload.promise; }, perform });
  const outcome = flight.catch(error => error);
  await entered.promise;
  await retireDeliveryScope(oldScope);
  if (result === 'success') upload.resolve(); else upload.reject(new Error('upload failed after revocation'));
  expect(await outcome).toMatchObject({ name: 'DeliveryPendingError', retryable: false });
  expect(perform).not.toHaveBeenCalled();
  expect(await pendingDelivery(oldScope, input.deviceId, input.sessionKey)).toBeUndefined();
  expect(JSON.parse(mockSettings.get(key)!)).toEqual([]);
});

test('a committed fence survives failed receipt deletion, rejects retries after restart and allows cleanup retry', async () => {
  const old = receipt();
  mockSettings.set(key, JSON.stringify([old])); mockFailWriteKey = key;
  await expect(retireDeliveryScope(oldScope)).rejects.toThrow('write error');
  expect(JSON.parse(mockSettings.get(retirementKey)!)).toEqual([oldScope]);
  expect(JSON.parse(mockSettings.get(key)!)).toEqual([old]);
  resetDeliveryForTests(); mockFailWriteKey = undefined;
  const perform = jest.fn(async () => undefined);
  await expect(deliverMessage({ ...input, sessionKey: old.sessionKey, expectedRequestId: old.requestId, perform }))
    .rejects.toMatchObject({ name: 'DeliveryPendingError', retryable: false });
  await expect(deliverMessage({ ...input, requireNewReceipt: true, perform })).rejects.toMatchObject({ name: 'DeliveryPendingError', retryable: false });
  expect(perform).not.toHaveBeenCalled();
  expect(JSON.parse(mockSettings.get(key)!)).toEqual([old]);
  await retireDeliveryScope(oldScope);
  expect(JSON.parse(mockSettings.get(key)!)).toEqual([]);
  await deliverMessage({ ...input, scope: otherScope, requireNewReceipt: true, perform });
  expect(perform).toHaveBeenCalledTimes(1);
  resetDeliveryForTests();
  await expect(deliverMessage({ ...input, requireNewReceipt: true, perform })).rejects.toMatchObject({ retryable: false });
  expect(perform).toHaveBeenCalledTimes(1);
});

test('a rejected fence commit never publishes retirement or deletes the durable receipt', async () => {
  const old = receipt(); mockSettings.set(key, JSON.stringify([old])); mockFailWriteKey = retirementKey;
  await expect(retireDeliveryScope(oldScope)).rejects.toThrow('write error');
  expect(mockSettings.has(retirementKey)).toBe(false); expect(JSON.parse(mockSettings.get(key)!)).toEqual([old]);
  mockFailWriteKey = undefined;
  expect(await pendingDelivery(oldScope, old.deviceId, old.sessionKey)).toMatchObject(old);
  await retireDeliveryScope(oldScope);
  expect(await pendingDelivery(oldScope, old.deviceId, old.sessionKey)).toBeUndefined();
});

test.each([key, retirementKey])('a fresh disk read failure cannot retire or overwrite cached ownership: %s', async failedKey => {
  const old = receipt(); mockSettings.set(key, JSON.stringify([old]));
  await pendingDelivery(oldScope, old.deviceId, old.sessionKey);
  const durableBefore = new Map(mockSettings);
  mockWrite.mockClear(); mockFailReadKey = failedKey;
  await expect(retireDeliveryScope(oldScope)).rejects.toThrow('手机待确认记录暂时无法读取');
  expect(mockWrite).not.toHaveBeenCalled(); expect(mockSettings).toEqual(durableBefore);
});

test.each([key, retirementKey])('warm caches cannot wash malformed retirement storage: %s', async damagedKey => {
  const old = receipt(); mockSettings.set(key, JSON.stringify([old]));
  await pendingDelivery(oldScope, old.deviceId, old.sessionKey);
  mockSettings.set(damagedKey, '{"partial":');
  const durableBefore = new Map(mockSettings); mockWrite.mockClear();
  await expect(retireDeliveryScope(oldScope)).rejects.toThrow('手机待确认记录暂时无法读取');
  expect(mockWrite).not.toHaveBeenCalled(); expect(mockSettings).toEqual(durableBefore);
});

test('retirement uses fresh receipt storage and preserves a pairing absent from the warm cache', async () => {
  const old = receipt(), other = receipt(2, otherScope);
  mockSettings.set(key, JSON.stringify([old])); await pendingDelivery(oldScope, old.deviceId, old.sessionKey);
  mockSettings.set(key, JSON.stringify([old, other]));
  await retireDeliveryScope(oldScope);
  expect(JSON.parse(mockSettings.get(key)!)).toEqual([other]);
});

test.each([key, retirementKey])('a slow older disk snapshot cannot restore receipts or erase a committed fence: %s', async delayedKey => {
  const old = receipt(); mockSettings.set(key, JSON.stringify([old]));
  const entered = deferred<void>(), read = deferred<string | null>();
  const snapshot = mockSettings.get(delayedKey) ?? null;
  let delayed = false;
  mockRead.mockImplementation(async name => {
    if (!delayed && name === delayedKey) { delayed = true; entered.resolve(); return read.promise; }
    return mockSettings.get(name) ?? null;
  });
  const staleLookup = pendingDelivery(oldScope, old.deviceId, old.sessionKey);
  await entered.promise;
  await retireDeliveryScope(oldScope);
  read.resolve(snapshot); await staleLookup;
  expect(await pendingDelivery(oldScope, old.deviceId, old.sessionKey)).toBeUndefined();
  const perform = jest.fn(async () => undefined);
  await expect(deliverMessage({ ...input, requireNewReceipt: true, perform })).rejects.toMatchObject({ retryable: false });
  expect(perform).not.toHaveBeenCalled(); expect(JSON.parse(mockSettings.get(key)!)).toEqual([]);
});
