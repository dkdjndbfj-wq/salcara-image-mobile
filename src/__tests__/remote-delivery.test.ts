import { attachmentChunks, ATTACHMENT_CHUNK } from '../remote/attachment-chunks';
import { command, HubError, setHubFetch, type FetchLike } from '../remote/client';
import { bindDeliveryExecution, deliverMessage, deliveryUsesDurableProtocol, pendingDelivery, resetDeliveryForTests } from '../remote/delivery';
import { demandSyncDelay } from '../remote/useDemandSync';

const mockSettings = new Map<string, string>();
let mockUuid = 0;
let mockFailWrite = false;
jest.mock('../storage/database', () => ({ getSetting: async (key: string) => mockSettings.get(key) ?? null,
  setSetting: async (key: string, value: string | null) => { if (mockFailWrite) throw new Error('storage failed'); if (value === null) mockSettings.delete(key); else mockSettings.set(key, value); } }));
jest.mock('expo-crypto', () => ({ randomUUID: () => `0199aaa1-1234-4678-9abc-${String(++mockUuid).padStart(12, '0')}` }));
const input = { scope: 'station-a|paired-pc', deviceId: 'pc', sessionKey: 'codex:original', surface: 'desktop' as const, text: '继续原任务', idempotent: true };
beforeEach(() => { resetDeliveryForTests(); mockSettings.clear(); mockUuid = 0; mockFailWrite = false; });
afterEach(() => setHubFetch(null));

test('a first v2 response/storage failure keeps local draft ownership and the execution UUID', async () => {
  const executionId = '0199aaa1-1234-4678-9abc-999999999999';
  let original = '';
  await expect(deliverMessage({ ...input, perform: async receipt => {
    original = receipt.requestId;
    await bindDeliveryExecution(receipt.scope, receipt.deviceId, receipt.requestId, executionId);
    throw new Error('result storage failed');
  } })).rejects.toMatchObject({ retryable: true });
  resetDeliveryForTests();
  expect(await pendingDelivery(input.scope, input.deviceId, input.sessionKey)).toMatchObject({ requestId: original, executionId, text: input.text });
});

test('enabling v2 never upgrades an already attempted legacy UUID into another execution', async () => {
  let original = '';
  await expect(deliverMessage({ ...input, perform: async receipt => { original = receipt.requestId; throw new HubError('lost'); } })).rejects.toThrow();
  resetDeliveryForTests();
  await expect(deliverMessage({ ...input, durableProtocol: 2, perform: async receipt => {
    expect(receipt.requestId).toBe(original); expect(receipt.durableProtocol).toBeUndefined();
    expect(await deliveryUsesDurableProtocol(input.scope, input.deviceId, receipt.requestId)).toBe(false);
    throw new HubError('still offline');
  } })).rejects.toThrow();
});

test('new v2 intent records its protocol before attempting preparation', async () => {
  await deliverMessage({ ...input, durableProtocol: 2, perform: async receipt => {
    expect(await deliveryUsesDurableProtocol(input.scope, input.deviceId, receipt.requestId)).toBe(true);
    expect(JSON.parse(mockSettings.get('remote_pending_delivery_v1')!)[0].durableProtocol).toBe(2);
  } });
});

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

test('uncertain ownership identifies the exact durable receipt and distinguishes a new call from retry', async () => {
  const perform = jest.fn(async () => { throw new HubError('lost'); });
  let requestId = '';
  try { await deliverMessage({ ...input, requireNewReceipt: true, perform }); }
  catch (error) {
    expect(error).toMatchObject({ receiptCreatedByCall: true, requestId: expect.any(String) });
    requestId = (error as { requestId: string }).requestId;
  }
  expect(requestId).not.toBe('');
  expect(await pendingDelivery(input.scope, 'pc', input.sessionKey)).toMatchObject({ requestId });
  await expect(deliverMessage({ ...input, perform })).rejects.toMatchObject({ requestId, receiptCreatedByCall: false });
});

test('a distinct same-text submission cannot reuse or mutate an older image/API receipt even if retry would succeed', async () => {
  const oldAttachments = [`att_${'e'.repeat(32)}`];
  const oldSource = { id: oldAttachments[0], uri: 'file://old.png', mime: 'image/png' as const, width: 1, height: 1 };
  await expect(deliverMessage({ ...input, attachments: oldAttachments, attachmentSources: [oldSource],
    sendOptions: { accountId: 'api_old', model: 'old-model' }, perform: async () => { throw new HubError('lost'); } })).rejects.toMatchObject({ receiptCreatedByCall: true });
  const before = await pendingDelivery(input.scope, 'pc', input.sessionKey);
  const perform = jest.fn(async () => undefined), prepare = jest.fn(async () => undefined);
  await expect(deliverMessage({ ...input, requireNewReceipt: true, attachments: [`att_${'f'.repeat(32)}`],
    attachmentSources: [{ ...oldSource, id: `att_${'f'.repeat(32)}`, uri: 'file://new.png' }],
    sendOptions: { accountId: 'api_new', model: 'new-model' }, perform, prepare })).rejects.toMatchObject({ retryable: false, requestId: undefined });
  expect(perform).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
  expect(await pendingDelivery(input.scope, 'pc', input.sessionKey)).toMatchObject({ requestId: before?.requestId,
    attachmentSources: [oldSource], attachments: oldAttachments, sendOptions: { accountId: 'api_old', model: 'old-model' } });
});

test('a concurrent flight cannot claim ownership of another submission receipt', async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const first = deliverMessage({ ...input, requireNewReceipt: true, perform: async () => held });
  const perform = jest.fn(async () => undefined);
  await expect(deliverMessage({ ...input, requireNewReceipt: true, perform })).rejects.toMatchObject({ retryable: false, requestId: undefined });
  expect(perform).not.toHaveBeenCalled();
  release(); await first;
});

test('different conversations dispatch concurrently with independent receipts even when acknowledgements arrive out of order', async () => {
  const firstSession = 'codex:first-parallel';
  const secondSession = 'codex:second-parallel';
  let releaseFirst!: () => void, releaseSecond!: () => void, enteredBoth!: () => void;
  const firstHeld = new Promise<void>(resolve => { releaseFirst = resolve; });
  const secondHeld = new Promise<void>(resolve => { releaseSecond = resolve; });
  const bothEntered = new Promise<void>(resolve => { enteredBoth = resolve; });
  const accepted: Array<{ sessionKey: string; text: string; requestId: string }> = [];
  const makeInput = (sessionKey: string, text: string, held: Promise<void>) => ({
    ...input, sessionKey, text, requireNewReceipt: true,
    perform: async (receipt: { sessionKey: string; text: string; requestId: string }) => {
      accepted.push({ sessionKey: receipt.sessionKey, text: receipt.text, requestId: receipt.requestId });
      if (accepted.length === 2) enteredBoth();
      await held;
    },
  });

  const first = deliverMessage(makeInput(firstSession, 'first prompt', firstHeld));
  const second = deliverMessage(makeInput(secondSession, 'second prompt', secondHeld));
  await bothEntered;
  expect(accepted).toHaveLength(2);
  expect(accepted).toEqual(expect.arrayContaining([
    expect.objectContaining({ sessionKey: firstSession, text: 'first prompt' }),
    expect.objectContaining({ sessionKey: secondSession, text: 'second prompt' }),
  ]));
  expect(new Set(accepted.map(item => item.requestId)).size).toBe(2);

  releaseSecond(); await second;
  expect(await pendingDelivery(input.scope, 'pc', firstSession)).toMatchObject({ text: 'first prompt', requestId: accepted.find(item => item.sessionKey === firstSession)?.requestId });
  expect(await pendingDelivery(input.scope, 'pc', secondSession)).toBeUndefined();
  releaseFirst(); await first;
  expect(await pendingDelivery(input.scope, 'pc', firstSession)).toBeUndefined();
});

test('a newer receipt field is preserved and blocks unsafe dispatch with a compatibility message', async () => {
  await expect(deliverMessage({ ...input, perform: async () => { throw new HubError('offline'); } })).rejects.toMatchObject({ retryable: true });
  const encoded = mockSettings.get('remote_pending_delivery_v1')!;
  const futureReceipt = JSON.parse(encoded);
  futureReceipt[0].deliveryPolicyRevision = 2;
  const futureEncoded = JSON.stringify(futureReceipt);
  mockSettings.set('remote_pending_delivery_v1', futureEncoded);
  resetDeliveryForTests();
  const perform = jest.fn(async () => undefined);
  await expect(deliverMessage({ ...input, perform })).rejects.toThrow('当前版本不支持的字段');
  expect(perform).not.toHaveBeenCalled();
  expect(mockSettings.get('remote_pending_delivery_v1')).toBe(futureEncoded);
});

test('a failed initial storage commit never publishes a phantom receipt or dispatches a task', async () => {
  mockFailWrite = true;
  const perform = jest.fn(async () => undefined);
  await expect(deliverMessage({ ...input, requireNewReceipt: true, perform })).rejects.toThrow('storage failed');
  mockFailWrite = false;
  expect(perform).not.toHaveBeenCalled();
  expect(await pendingDelivery(input.scope, 'pc', input.sessionKey)).toBeUndefined();
  await deliverMessage({ ...input, requireNewReceipt: true, perform });
  expect(perform).toHaveBeenCalledTimes(1);
});

test('failure to clear an accepted receipt keeps its durable ID and never pretends the task was rejected', async () => {
  let requestId = '';
  await expect(deliverMessage({ ...input, requireNewReceipt: true, perform: async receipt => {
    requestId = receipt.requestId; mockFailWrite = true;
  } })).rejects.toMatchObject({ retryable: false, requestId: expect.any(String), receiptCreatedByCall: true });
  mockFailWrite = false;
  expect(await pendingDelivery(input.scope, 'pc', input.sessionKey)).toMatchObject({ requestId, attempted: true });
  resetDeliveryForTests();
  expect(await pendingDelivery(input.scope, 'pc', input.sessionKey)).toMatchObject({ requestId });
  const newTask = jest.fn(async () => undefined);
  await expect(deliverMessage({ ...input, requireNewReceipt: true, perform: newTask })).rejects.toMatchObject({ retryable: false, requestId: undefined });
  expect(newTask).not.toHaveBeenCalled();
  await deliverMessage({ ...input, perform: async receipt => { expect(receipt.requestId).toBe(requestId); } });
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

test('an HTTP 200 uncertain execution reply retains the first attempt across restart and blocks duplicate dispatch', async () => {
  const fetch = jest.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({
    ok: false, code: 'command_delivery_uncertain', error: '电脑可能已执行，请先核对原会话',
  }) }));
  setHubFetch(fetch as FetchLike);
  let requestId = '';
  const perform = jest.fn(async (receipt: { requestId: string }) => {
    requestId = receipt.requestId;
    await command({ url: 'https://station.test/salcara-hub/v1', pairToken: 'fixture' }, 'pc',
      { type: 'session.send', sessionKey: input.sessionKey, text: input.text, controlSurface: 'cli' }, receipt.requestId);
  });
  await expect(deliverMessage({ ...input, requireNewReceipt: true, perform })).rejects.toMatchObject({ retryable: false });
  expect(await pendingDelivery(input.scope, 'pc', input.sessionKey)).toMatchObject({ requestId, attempted: true, uncertain: true, text: input.text });
  resetDeliveryForTests();
  expect(await pendingDelivery(input.scope, 'pc', input.sessionKey)).toMatchObject({ requestId, uncertain: true });
  await expect(deliverMessage({ ...input, perform })).rejects.toMatchObject({ retryable: false });
  await expect(deliverMessage({ ...input, requireNewReceipt: true, perform })).rejects.toMatchObject({ retryable: false });
  expect(perform).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledTimes(1);
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

test('image transaction persists before prepare and never dispatches before upload confirmation', async () => {
  const attachments = [`att_${'c'.repeat(32)}`];
  const prepare = jest.fn(async () => undefined);
  await expect(deliverMessage({ ...input, attachments, prepare, perform: async () => { throw new HubError('offline'); } })).rejects.toMatchObject({ retryable: true });
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(await pendingDelivery(input.scope, 'pc', input.sessionKey)).toMatchObject({ attachments, attachmentsUploaded: true });

  resetDeliveryForTests();
  const blocked = [`att_${'d'.repeat(32)}`];
  const blockedInput = { ...input, scope: 'station-c|paired-pc', text: '另一条带图消息', attachments: blocked };
  await expect(deliverMessage({ ...blockedInput, prepare: async () => { throw new Error('upload interrupted'); }, perform: jest.fn() })).rejects.toMatchObject({ retryable: false });
  expect(await pendingDelivery(blockedInput.scope, 'pc', input.sessionKey)).toMatchObject({ attachments: blocked, attachmentsUploaded: false });
});

test('images are split into Hub-sized chunks that keep base64 boundaries', () => {
  const chunks = attachmentChunks('A'.repeat(ATTACHMENT_CHUNK * 2 + 8));
  expect(chunks.map((chunk) => chunk.length)).toEqual([ATTACHMENT_CHUNK, ATTACHMENT_CHUNK, 8]);
  expect(ATTACHMENT_CHUNK % 4).toBe(0);
});
