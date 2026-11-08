import { deliverMessage, pendingDelivery, resetDeliveryForTests } from '../remote/delivery';
import { HubError } from '../remote/client';

const key = 'remote_pending_delivery_v1';
const mockSettings = new Map<string, string>();
let mockFailRead = false;
let mockUuid = 0;
const mockRead = jest.fn(async (name: string): Promise<string | null> => {
  if (mockFailRead) throw new Error('private SQLite error must not be exposed');
  return mockSettings.get(name) ?? null;
});
const mockWrite = jest.fn(async (name: string, value: string) => { mockSettings.set(name, value); });
jest.mock('../storage/database', () => ({ getSetting: (name: string) => mockRead(name), setSetting: (name: string, value: string) => mockWrite(name, value) }));
jest.mock('expo-crypto', () => ({ randomUUID: () => `0199aaa1-1234-4678-9abc-${String(++mockUuid).padStart(12, '0')}` }));

const input = { scope: 'station|credential:fixture', deviceId: 'pc', sessionKey: 'codex:original', surface: 'cli' as const, text: 'task', idempotent: true };
const receipt = { scope: input.scope, deviceId: input.deviceId, sessionKey: input.sessionKey, surface: input.surface, text: input.text,
  requestId: '0199aaa1-1234-4678-9abc-000000000001', createdAt: 1000, attempted: true, safeRetry: true };
beforeEach(() => {
  resetDeliveryForTests(); mockSettings.clear(); mockUuid = 0; mockFailRead = false; mockWrite.mockClear(); mockRead.mockClear();
});

test('transient SQLite read failure never invents an empty owner or overwrites the old receipt', async () => {
  mockSettings.set(key, JSON.stringify([receipt])); mockFailRead = true;
  const perform = jest.fn(async () => undefined);
  await expect(deliverMessage({ ...input, requireNewReceipt: true, perform })).rejects.toThrow('手机待确认记录暂时无法读取');
  expect(perform).not.toHaveBeenCalled(); expect(mockWrite).not.toHaveBeenCalled();
  expect(mockSettings.get(key)).toBe(JSON.stringify([receipt]));
  mockFailRead = false;
  expect(await pendingDelivery(input.scope, 'pc', input.sessionKey)).toMatchObject({ requestId: receipt.requestId });
});

test.each([
  '{"private":', '{}', 'null',
  JSON.stringify([{ ...receipt, requestId: 'bad' }]),
  JSON.stringify([receipt, { ...receipt, requestId: '0199aaa1-1234-4678-9abc-000000000002' }]),
  JSON.stringify([receipt, { ...receipt, deviceId: 'other-pc', sessionKey: 'codex:other' }]),
  JSON.stringify([receipt, { ...receipt, sessionKey: 'codex:other', sendOptions: { effort: 'unrecognized' } }]),
  JSON.stringify([receipt, { ...receipt, sessionKey: 'codex:other', safeRetry: 'yes' }]),
])('invalid, partial or ambiguous receipt storage is never silently filtered: %s', async encoded => {
  mockSettings.set(key, encoded);
  const perform = jest.fn(async () => undefined);
  await expect(deliverMessage({ ...input, requireNewReceipt: true, perform })).rejects.toThrow('手机待确认记录暂时无法读取');
  expect(perform).not.toHaveBeenCalled(); expect(mockWrite).not.toHaveBeenCalled(); expect(mockSettings.get(key)).toBe(encoded);
});

test('an over-limit receipt list is not truncated to make room for a new task', async () => {
  const encoded = JSON.stringify(Array.from({ length: 21 }, (_, index) => ({ ...receipt, sessionKey: `codex:${index}` })));
  mockSettings.set(key, encoded);
  await expect(deliverMessage({ ...input, requireNewReceipt: true, perform: jest.fn() })).rejects.toThrow('手机待确认记录暂时无法读取');
  expect(mockWrite).not.toHaveBeenCalled(); expect(mockSettings.get(key)).toBe(encoded);
});

test('persisted Claude approval survives restart but cannot be smuggled onto Codex or native desktop', async () => {
  mockSettings.set(key, JSON.stringify([{ ...receipt, sessionKey: 'claude:original', sendOptions: { approval: 'auto_all' } }]));
  expect(await pendingDelivery(input.scope, 'pc', 'claude:original')).toMatchObject({ sendOptions: { approval: 'auto_all' } });
  for (const invalid of [{ sessionKey: 'codex:original', surface: 'cli', approval: 'auto_all' },
    { sessionKey: 'claude:original', surface: 'desktop', approval: 'ask' }, { sessionKey: 'claude:original', surface: 'cli', approval: 'full_access' }]) {
    resetDeliveryForTests();
    mockSettings.set(key, JSON.stringify([{ ...receipt, sessionKey: invalid.sessionKey, surface: invalid.surface, sendOptions: { approval: invalid.approval } }]));
    await expect(pendingDelivery(input.scope, 'pc', invalid.sessionKey)).rejects.toThrow();
  }
});

test.each([false, true])('legacy and digest-bearing image receipts are retained, not recreated (digest=%s)', async hasDigest => {
  const attachmentId = `att_${'a'.repeat(32)}`;
  mockSettings.set(key, JSON.stringify([{ ...receipt, attachments: [attachmentId], attachmentsUploaded: false,
    attachmentSources: [{ id: attachmentId, uri: 'file://original.png', mime: 'image/png', width: 2, height: 2,
      ...(hasDigest ? { digest: 'b'.repeat(64) } : {}) }], sendOptions: { accountId: 'api_original', model: 'model-original', effort: 'low' } }]));
  const restored = await pendingDelivery(input.scope, 'pc', input.sessionKey);
  expect(restored).toMatchObject({ requestId: receipt.requestId, attachmentsUploaded: false, sendOptions: { accountId: 'api_original', model: 'model-original', effort: 'low' },
    attachmentSources: [{ id: attachmentId, ...(hasDigest ? { digest: 'b'.repeat(64) } : {}) }] });
});

test('malformed digest or mismatched attachment ownership fails closed without dropping the receipt', async () => {
  const attachmentId = `att_${'a'.repeat(32)}`;
  for (const source of [
    { id: attachmentId, digest: 'not-sha256' },
    { id: `att_${'b'.repeat(32)}`, digest: 'c'.repeat(64) },
  ]) {
    resetDeliveryForTests();
    const encoded = JSON.stringify([{ ...receipt, attachments: [attachmentId], attachmentSources: [{ ...source, uri: 'file://original.png', mime: 'image/png', width: 2, height: 2 }] }]);
    mockSettings.set(key, encoded);
    await expect(pendingDelivery(input.scope, 'pc', input.sessionKey)).rejects.toThrow('手机待确认记录暂时无法读取');
    expect(mockWrite).not.toHaveBeenCalled(); expect(mockSettings.get(key)).toBe(encoded);
  }
});

test('a late empty disk lookup cannot overwrite a newly committed pending receipt', async () => {
  let release!: (value: string | null) => void;
  const slow = new Promise<string | null>(resolve => { release = resolve; });
  mockRead.mockImplementationOnce(async () => slow);
  const oldLookup = pendingDelivery(input.scope, 'pc', input.sessionKey);
  await Promise.resolve();
  await expect(deliverMessage({ ...input, requireNewReceipt: true, perform: async () => { throw new HubError('lost'); } })).rejects.toMatchObject({ requestId: expect.any(String) });
  const durable = JSON.parse(mockSettings.get(key)!)[0];
  release(null); await oldLookup;
  expect(await pendingDelivery(input.scope, 'pc', input.sessionKey)).toMatchObject({ requestId: durable.requestId });
});

test('a persisted Continue receipt cannot downgrade to an ordinary send on retry', async () => {
  const perform = jest.fn(async (value: any) => undefined);
  await deliverMessage({ ...input, sendOptions: { control: 'continue', expectedTurnId: 'turn-terminal', model: 'gpt-fixture' }, perform });
  expect(perform).toHaveBeenCalledWith(expect.objectContaining({
    sendOptions: { control: 'continue', expectedTurnId: 'turn-terminal', model: 'gpt-fixture' },
  }));
});
