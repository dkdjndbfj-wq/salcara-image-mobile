const mockListeners = new Map<string, Set<(event: any) => void>>(), mockStore = new Map<string, string>();
let mockWriteGate: (() => Promise<void>) | undefined;
const mockClose = jest.fn();
jest.mock('../../modules/salcara-direct-transport', () => ({
  connect: () => queueMicrotask(() => mockListeners.get('onState')?.forEach(listener => listener({ state: 'open' }))),
  send: () => queueMicrotask(() => mockListeners.get('onMessage')?.forEach(listener => listener({ text: JSON.stringify({ type: 'auth_ok', deviceId: 'pc-a' }) }))),
  close: () => mockClose(), addListener: (name: string, listener: (event: any) => void) => {
    const listeners = mockListeners.get(name) ?? new Set(); listeners.add(listener); mockListeners.set(name, listeners);
    return { remove: () => listeners.delete(listener) };
  } }));
jest.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'fixture',
  getItemAsync: async (key: string) => mockStore.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { await mockWriteGate?.(); mockStore.set(key, value); },
  deleteItemAsync: async (key: string) => { mockStore.delete(key); } }));
jest.mock('expo-crypto', () => ({ getRandomBytesAsync: async () => new Uint8Array(32).fill(8) }));
jest.mock('../remote/phone-identity', () => ({ phoneIdentity: async () => 'b'.repeat(64) }));
jest.mock('../remote/drafts', () => ({ clearRemoteQueuedScope: async () => {} }));
jest.mock('../remote/direct-message-queue', () => ({ clearDirectMessageQueueScope: async () => {} }));
jest.mock('../remote/direct-pending-operation', () => ({ clearDirectPendingOperationScope: async () => {} }));
jest.mock('../remote/direct-api-selection', () => ({ clearDirectApiSelectionScope: async () => {} }));
jest.mock('../remote/agent-preferences', () => ({ clearPreferredAgent: async () => {} }));
import { disconnectDirect, forgetDirectPairing, getDirectConnectionState, listDirectPairings, pairDirectQr,
  reconnectDirect, resetDirectPairingForTests } from '../remote/direct-pairing';
const key = 'salcara-direct-pair-v1-pc-a', index = 'salcara-direct-pair-index-v1';
const record = { version: 1, deviceId: 'pc-a', deviceName: 'Computer', phoneId: 'b'.repeat(64), secret: 'c'.repeat(64),
  fingerprint: 'd'.repeat(64), urls: ['wss://192.168.1.8:47832/direct/ws'], pairedAt: 1 };
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
beforeEach(() => {
  resetDirectPairingForTests(); mockListeners.clear(); mockStore.clear(); mockClose.mockClear(); mockWriteGate = undefined;
  mockStore.set(key, JSON.stringify(record)); mockStore.set(index, JSON.stringify(['pc-a']));
});
afterEach(() => { resetDirectPairingForTests(); });

test('stale unpair identity does not disconnect or delete a new credential with identical public metadata', async () => {
  const [expected] = await listDirectPairings();
  mockStore.set(key, JSON.stringify({ ...record, secret: 'f'.repeat(64) }));
  await reconnectDirect('pc-a'); const closes = mockClose.mock.calls.length;
  await expect(forgetDirectPairing('pc-a', expected)).rejects.toThrow('绑定已改变');
  expect(JSON.parse(mockStore.get(key)!).secret).toBe('f'.repeat(64));
  expect(getDirectConnectionState().status).toBe('connected'); expect(mockClose).toHaveBeenCalledTimes(closes);
});

test('the storage queue CAS protects a same-ID replacement committed after the confirmation snapshot', async () => {
  const [expected] = await listDirectPairings();
  let release!: () => void, writes = 0; const gate = new Promise<void>(resolve => { release = resolve; });
  mockWriteGate = () => { writes++; return gate; };
  const pairing = pairDirectQr({ mode: 'direct', deviceId: 'pc-a', urls: record.urls, fingerprint: 'e'.repeat(64), token: 'a'.repeat(32), expiresAt: Date.now() + 60_000 });
  await flush(); expect(writes).toBeGreaterThan(0);
  const removal = forgetDirectPairing('pc-a', expected), rejected = expect(removal).rejects.toThrow('绑定已改变');
  release(); await pairing; await rejected;
  expect(JSON.parse(mockStore.get(key)!).fingerprint).toBe('e'.repeat(64));
  expect(getDirectConnectionState()).toMatchObject({ status: 'connected', deviceId: 'pc-a' });
});

test('the expected snapshot is frozen before queueing, and endpoint changes also require a new confirmation', async () => {
  const [expected] = await listDirectPairings();
  mockStore.set(key, JSON.stringify({ ...record, urls: ['wss://192.168.1.9:47832/direct/ws'] }));
  const removal = forgetDirectPairing('pc-a', expected);
  expected.endpoint = 'wss://192.168.1.9:47832/direct/ws';
  await expect(removal).rejects.toThrow('绑定已改变'); expect(mockStore.has(key)).toBe(true);
});

test('the unchanged binding remains removable after an ordinary disconnect and reconnect', async () => {
  const [expected] = await listDirectPairings(); await reconnectDirect('pc-a'); disconnectDirect(); await reconnectDirect('pc-a');
  await forgetDirectPairing('pc-a', expected);
  expect(mockStore.has(key)).toBe(false); expect(mockStore.has(index)).toBe(false); expect(getDirectConnectionState().status).toBe('idle');
});
