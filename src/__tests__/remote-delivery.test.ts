import { attachmentChunks, ATTACHMENT_CHUNK } from '../remote/attachment-chunks';
import { command, HubError, setHubFetch, type FetchLike } from '../remote/client';
import { deliverMessage, pendingDelivery, resetDeliveryForTests } from '../remote/delivery';
import { demandSyncDelay } from '../remote/useDemandSync';

const mockSettings = new Map<string, string>();
let mockUuid = 0;
jest.mock('../storage/database', () => ({ getSetting: async (key: string) => mockSettings.get(key) ?? null,
  setSetting: async (key: string, value: string | null) => { if (value === null) mockSettings.delete(key); else mockSettings.set(key, value); } }));
jest.mock('expo-crypto', () => ({ randomUUID: () => `0199aaa1-1234-4678-9abc-${String(++mockUuid).padStart(12, '0')}` }));
const input = { scope: 'station-a|paired-pc', deviceId: 'pc', sessionKey: 'codex:original', surface: 'desktop' as const, text: '继续原任务', idempotent: true };
beforeEach(() => { resetDeliveryForTests(); mockSettings.clear(); mockUuid = 0; });
afterEach(() => setHubFetch(null));

test.each(['{"ok":true,"result":', '{}', '[]'])('a partial or absent acknowledgement preserves the receipt: %s', async (body) => {
  setHubFetch((async () => ({ ok: true, status: 200, text: async () => body })) as FetchLike);
  await expect(deliverMessage({ ...input, perform: async (receipt) => { await command({ url: 'https://station.test/salcara-hub/v1', pairToken: 'fixture' }, 'pc',
    { type: 'session.send', sessionKey: input.sessionKey, text: input.text, controlSurface: 'cli' }, receipt.requestId); } })).rejects.toMatchObject({ retryable: true });
  expect(await pendingDelivery(input.scope, 'pc', input.sessionKey)).toMatchObject({ text: input.text, attempted: true });
});

test('lost acknowledgement restores the same receipt after restart, never a new task ID', async () => {
  let firstId = '';
  await expect(deliverMessage({ ...input, perform: async (receipt) => { firstId = receipt.requestId; throw new HubError('offline'); } })).rejects.toMatchObject({ retryable: true });
  resetDeliveryForTests();
  expect(await pendingDelivery(input.scope, 'pc', input.sessionKey)).toMatchObject({ requestId: firstId, text: input.text });
  await deliverMessage({ ...input, perform: async (receipt) => { expect(receipt.requestId).toBe(firstId); } });
  expect(await pendingDelivery(input.scope, 'pc', input.sessionKey)).toBeUndefined();
});

test('uncertain server restart or incompatible older Hub never automatically repeats a mutation', async () => {
  const perform = jest.fn(async () => { throw new HubError('uncertain', 409, 'command_delivery_uncertain'); });
  await expect(deliverMessage({ ...input, perform })).rejects.toMatchObject({ retryable: false });
  await expect(deliverMessage({ ...input, perform })).rejects.toMatchObject({ retryable: false });
  expect(perform).toHaveBeenCalledTimes(1);
  await expect(deliverMessage({ ...input, scope: 'older', idempotent: false, perform: async () => { throw new HubError('lost'); } })).rejects.toMatchObject({ retryable: false });
  const oldRetry = jest.fn(async () => undefined);
  await expect(deliverMessage({ ...input, scope: 'older', idempotent: false, perform: oldRetry })).rejects.toMatchObject({ retryable: false });
  expect(oldRetry).not.toHaveBeenCalled();
});

test('pending messages remain ordered and station-scoped without persisting credentials', async () => {
  await expect(deliverMessage({ ...input, perform: async () => { throw new HubError('offline', 409, 'computer_offline'); } })).rejects.toMatchObject({ retryable: true });
  const perform = jest.fn(async () => undefined);
  await expect(deliverMessage({ ...input, text: 'changed task', perform })).rejects.toMatchObject({ retryable: false });
  expect(perform).not.toHaveBeenCalled();
  await deliverMessage({ ...input, scope: 'station-b|paired-pc', perform });
  expect(await pendingDelivery(input.scope, 'pc', input.sessionKey)).toBeDefined();
  expect([...mockSettings.values()].join()).not.toMatch(/pairToken|Authorization|Bearer/);
});

test('an expired receipt cannot be silently recreated after the server retention window', async () => {
  const now = jest.spyOn(Date, 'now').mockReturnValue(1000);
  try {
    await expect(deliverMessage({ ...input, perform: async () => { throw new HubError('lost'); } })).rejects.toMatchObject({ retryable: true });
    now.mockReturnValue(1000 + 24 * 60 * 60 * 1000);
    const perform = jest.fn(async () => undefined);
    await expect(deliverMessage({ ...input, perform })).rejects.toMatchObject({ retryable: false });
    expect(perform).not.toHaveBeenCalled();
  } finally { now.mockRestore(); }
});

test('short-request synchronization backs off without a permanent subscription', () => {
  expect([0, 1, 2, 6].map((attempt) => demandSyncDelay(attempt, 0))).toEqual([5000, 5000, 10000, 20000]);
  expect([1, 2, 4, 20].map((failures) => demandSyncDelay(0, failures))).toEqual([10000, 20000, 60000, 60000]);
});

test('a retried message with images resends the same uploaded image ids', async () => {
  const attachments = [`att_${'a'.repeat(32)}`, `att_${'b'.repeat(32)}`];
  await expect(deliverMessage({ ...input, attachments, perform: async () => { throw new HubError('offline'); } })).rejects.toMatchObject({ retryable: true });
  resetDeliveryForTests();
  expect(await pendingDelivery(input.scope, 'pc', input.sessionKey)).toMatchObject({ attachments });
  await deliverMessage({ ...input, perform: async (receipt) => { expect(receipt.attachments).toEqual(attachments); } });
});

test('images are split into Hub-sized chunks that keep base64 boundaries', () => {
  const chunks = attachmentChunks('A'.repeat(ATTACHMENT_CHUNK * 2 + 8));
  expect(chunks.map((chunk) => chunk.length)).toEqual([ATTACHMENT_CHUNK, ATTACHMENT_CHUNK, 8]);
  expect(ATTACHMENT_CHUNK % 4).toBe(0);
});
