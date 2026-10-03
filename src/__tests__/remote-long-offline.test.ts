import { HubError } from '../remote/client';
import { cancelPendingDelivery, deliverMessage, pendingDelivery, resetDeliveryForTests } from '../remote/delivery';
import { DELIVERY_RETRY_WINDOW_MS, deliveryRetryState } from '../remote/offline-policy';
import { liveDelay } from '../remote/useLiveSync';

const mockSettings = new Map<string, string>();
let mockUuid = 0;
jest.mock('../storage/database', () => ({ getSetting: async (key: string) => mockSettings.get(key) ?? null,
  setSetting: async (key: string, value: string | null) => { if (value === null) mockSettings.delete(key); else mockSettings.set(key, value); } }));
jest.mock('expo-crypto', () => ({ randomUUID: () => `0199aaa1-1234-4678-9abc-${String(++mockUuid).padStart(12, '0')}` }));
const input = { scope: 'station-a|credential-hash', deviceId: 'pc', sessionKey: 'codex:original', surface: 'desktop' as const, text: '继续原任务', idempotent: true };
let now: jest.SpyInstance;
beforeEach(() => { resetDeliveryForTests(); mockSettings.clear(); mockUuid = 0; now = jest.spyOn(Date, 'now').mockReturnValue(1000); });
afterEach(() => { now.mockRestore(); resetDeliveryForTests(); });

test('a week of explicit computer-offline responses preserves text and only executes once on reconnect', async () => {
  const seen: string[] = [];
  const offline = async (receipt: { requestId: string }) => { seen.push(receipt.requestId); throw new HubError('not dispatched', 409, 'computer_offline'); };
  await expect(deliverMessage({ ...input, perform: offline })).rejects.toMatchObject({ retryable: true });
  const first = await pendingDelivery(input.scope, 'pc', input.sessionKey);
  expect(first).toMatchObject({ attempted: false, text: input.text });
  expect(first?.firstAttemptAt).toBeUndefined();
  now.mockReturnValue(1000 + 7 * 24 * 60 * 60 * 1000);
  resetDeliveryForTests();
  expect(deliveryRetryState((await pendingDelivery(input.scope, 'pc', input.sessionKey))!)).toMatchObject({ kind: 'waiting-device', retryable: true });
  await expect(deliverMessage({ ...input, perform: offline })).rejects.toMatchObject({ retryable: true });
  const execute = jest.fn(async (receipt: { requestId: string }) => { seen.push(receipt.requestId); });
  await deliverMessage({ ...input, perform: execute });
  expect(execute).toHaveBeenCalledTimes(1);
  expect(new Set(seen).size).toBe(1);
  expect(await pendingDelivery(input.scope, 'pc', input.sessionKey)).toBeUndefined();
});

test('lost receipt after a long offline wait starts the confirmation window at the possible dispatch', async () => {
  await expect(deliverMessage({ ...input, perform: async () => { throw new HubError('offline', 409, 'computer_offline'); } })).rejects.toMatchObject({ retryable: true });
  const week = 1000 + 7 * 24 * 60 * 60 * 1000;
  now.mockReturnValue(week);
  await expect(deliverMessage({ ...input, perform: async () => { throw new HubError('lost acknowledgement'); } })).rejects.toMatchObject({ retryable: true });
  const record = (await pendingDelivery(input.scope, 'pc', input.sessionKey))!;
  expect(record).toMatchObject({ createdAt: 1000, attempted: true, firstAttemptAt: week });
  expect(deliveryRetryState(record, week + 22 * 60 * 60 * 1000)).toMatchObject({ retryable: true });
  expect(deliveryRetryState(record, week + DELIVERY_RETRY_WINDOW_MS)).toMatchObject({ retryable: false, reason: 'expired' });
});

test('unknown delivery across a day and restart is retained but never automatically recreated', async () => {
  await expect(deliverMessage({ ...input, perform: async () => { throw new HubError('lost'); } })).rejects.toMatchObject({ retryable: true });
  const id = (await pendingDelivery(input.scope, 'pc', input.sessionKey))!.requestId;
  now.mockReturnValue(1000 + 24 * 60 * 60 * 1000);
  resetDeliveryForTests();
  const record = (await pendingDelivery(input.scope, 'pc', input.sessionKey))!;
  expect(deliveryRetryState(record)).toMatchObject({ kind: 'needs-review', retryable: false, reason: 'expired' });
  const execute = jest.fn(async () => undefined);
  await expect(deliverMessage({ ...input, perform: execute })).rejects.toMatchObject({ retryable: false });
  expect(execute).not.toHaveBeenCalled();
  expect(await pendingDelivery(input.scope, 'pc', input.sessionKey)).toMatchObject({ requestId: id, text: input.text });
  expect(mockUuid).toBe(1);
});

test('a later explicit offline response never erases an earlier lost acknowledgement', async () => {
  await expect(deliverMessage({ ...input, perform: async () => { throw new HubError('lost'); } })).rejects.toMatchObject({ retryable: true });
  now.mockReturnValue(2000);
  await expect(deliverMessage({ ...input, perform: async () => { throw new HubError('offline', 409, 'computer_offline'); } })).rejects.toMatchObject({ retryable: true });
  expect(await pendingDelivery(input.scope, 'pc', input.sessionKey)).toMatchObject({ attempted: true, firstAttemptAt: 1000 });
  now.mockReturnValue(1000 + DELIVERY_RETRY_WINDOW_MS);
  const execute = jest.fn(async () => undefined);
  await expect(deliverMessage({ ...input, perform: execute })).rejects.toMatchObject({ retryable: false });
  expect(execute).not.toHaveBeenCalled();
});

test('a generic 409 is not evidence that the computer never received the message', async () => {
  await expect(deliverMessage({ ...input, perform: async () => { throw new HubError('generic conflict', 409); } })).rejects.toMatchObject({ retryable: true });
  expect(await pendingDelivery(input.scope, 'pc', input.sessionKey)).toMatchObject({ attempted: true, firstAttemptAt: 1000 });
});

test('rolling the phone clock backward cannot extend the confirmation window or dispatch', async () => {
  await expect(deliverMessage({ ...input, perform: async () => { throw new HubError('lost'); } })).rejects.toMatchObject({ retryable: true });
  now.mockReturnValue(4000);
  await expect(deliverMessage({ ...input, perform: async () => { throw new HubError('lost'); } })).rejects.toMatchObject({ retryable: true });
  resetDeliveryForTests();
  now.mockReturnValue(2000);
  expect(deliveryRetryState((await pendingDelivery(input.scope, 'pc', input.sessionKey))!)).toMatchObject({ retryable: false, reason: 'clock-changed' });
  const execute = jest.fn(async () => undefined);
  await expect(deliverMessage({ ...input, perform: execute })).rejects.toMatchObject({ retryable: false });
  expect(execute).not.toHaveBeenCalled();
});

test('observed expiry is persisted: a later clock rollback and restart cannot resurrect the receipt', async () => {
  await expect(deliverMessage({ ...input, perform: async () => { throw new HubError('lost'); } })).rejects.toMatchObject({ retryable: true });
  now.mockReturnValue(1000 + 24 * 60 * 60 * 1000);
  expect(await pendingDelivery(input.scope, 'pc', input.sessionKey)).toMatchObject({ reviewReason: 'expired' });
  resetDeliveryForTests();
  now.mockReturnValue(2000);
  const execute = jest.fn(async () => undefined);
  await expect(deliverMessage({ ...input, perform: execute })).rejects.toMatchObject({ retryable: false });
  expect(execute).not.toHaveBeenCalled();
  resetDeliveryForTests();
  now.mockReturnValue(1000 + 24 * 60 * 60 * 1000);
  expect(deliveryRetryState((await pendingDelivery(input.scope, 'pc', input.sessionKey))!).retryable).toBe(false);
});

test('expiry discovered during an attempted retry is durable even without opening the pending-message page', async () => {
  await expect(deliverMessage({ ...input, perform: async () => { throw new HubError('lost'); } })).rejects.toMatchObject({ retryable: true });
  now.mockReturnValue(1000 + 24 * 60 * 60 * 1000);
  const execute = jest.fn(async () => undefined);
  await expect(deliverMessage({ ...input, perform: execute })).rejects.toMatchObject({ retryable: false });
  resetDeliveryForTests();
  now.mockReturnValue(2000);
  await expect(deliverMessage({ ...input, perform: execute })).rejects.toMatchObject({ retryable: false });
  expect(execute).not.toHaveBeenCalled();
});

test('a later authorization failure cannot discard an earlier possible execution', async () => {
  await expect(deliverMessage({ ...input, perform: async () => { throw new HubError('lost'); } })).rejects.toMatchObject({ retryable: true });
  await expect(deliverMessage({ ...input, perform: async () => { throw new HubError('revoked', 403); } })).rejects.toMatchObject({ retryable: false });
  expect(await pendingDelivery(input.scope, 'pc', input.sessionKey)).toMatchObject({ text: input.text, attempted: true, uncertain: true });
});

test('legacy attempted records are conservatively timed from their creation, not migrated to fresh receipts', async () => {
  mockSettings.set('remote_pending_delivery_v1', JSON.stringify([{ ...input, requestId: '0199aaa1-1234-4678-9abc-000000000001', createdAt: 1000, attempted: true, safeRetry: true }]));
  now.mockReturnValue(1000 + DELIVERY_RETRY_WINDOW_MS);
  expect(deliveryRetryState((await pendingDelivery(input.scope, 'pc', input.sessionKey))!)).toMatchObject({ retryable: false, reason: 'expired' });
  const execute = jest.fn(async () => undefined);
  await expect(deliverMessage({ ...input, perform: execute })).rejects.toMatchObject({ retryable: false });
  expect(execute).not.toHaveBeenCalled();
});

test('old expiry cannot block another station, device or credential namespace', async () => {
  await expect(deliverMessage({ ...input, perform: async () => { throw new HubError('lost'); } })).rejects.toMatchObject({ retryable: true });
  now.mockReturnValue(1000 + 7 * 24 * 60 * 60 * 1000);
  const execute = jest.fn(async () => undefined);
  await deliverMessage({ ...input, scope: 'station-b|credential-hash', perform: execute });
  await deliverMessage({ ...input, deviceId: 'another-pc', perform: execute });
  await deliverMessage({ ...input, scope: 'station-a|new-credential-hash', perform: execute });
  expect(execute).toHaveBeenCalledTimes(3);
  expect(await pendingDelivery(input.scope, 'pc', input.sessionKey)).toMatchObject({ text: input.text });
});

test('cancel only removes the phone retry record and does not invoke a computer command', async () => {
  await expect(deliverMessage({ ...input, perform: async () => { throw new HubError('lost'); } })).rejects.toMatchObject({ retryable: true });
  await cancelPendingDelivery(input.scope, 'pc', input.sessionKey);
  expect(await pendingDelivery(input.scope, 'pc', input.sessionKey)).toBeUndefined();
});

test('repeated synchronization failures exponentially back off to five minutes and success resets it', () => {
  expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 100].map((failures) => liveDelay(0, failures, true)))
    .toEqual([2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 300000, 300000]);
  expect(liveDelay(100, 0, true)).toBe(0);
  expect(liveDelay(0, 0, false)).toBe(2000);
  expect(liveDelay(100, 0, false)).toBe(8000);
});
