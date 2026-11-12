const mockListeners = new Map<string, Set<(event: any) => void>>();
const mockStore = new Map<string, string>();
let mockBeforeWrite: (() => Promise<void>) | null = null;
const mockConnect = jest.fn((_url: string, _fingerprint: string) => {
  queueMicrotask(() => mockListeners.get('onState')?.forEach(listener => listener({ state: 'open' })));
});
const mockSend = jest.fn((text: string) => {
  const message = JSON.parse(text);
  if (message.type === 'auth') queueMicrotask(() => mockListeners.get('onMessage')?.forEach(listener => listener({
    text: JSON.stringify({ type: 'auth_ok', deviceId: 'pc-1', name: 'Test PC' }),
  })));
});
const mockClose = jest.fn();
const mockClearDrafts=jest.fn(async(_scope:string)=>{});
const mockClearQueue=jest.fn(async(_scope:string)=>{});
const mockClearPending=jest.fn(async(_scope:string)=>{});
const mockClearApiSelections=jest.fn(async(_scope:string)=>{});
const mockRetireApprovals=jest.fn(async(_scope:string)=>{});
jest.mock('../remote/drafts',()=>({clearRemoteQueuedScope:(scope:string)=>mockClearDrafts(scope)}));
jest.mock('../remote/direct-message-queue',()=>({clearDirectMessageQueueScope:(scope:string)=>mockClearQueue(scope)}));
jest.mock('../remote/direct-pending-operation',()=>({clearDirectPendingOperationScope:(scope:string)=>mockClearPending(scope)}));
jest.mock('../remote/direct-api-selection',()=>({clearDirectApiSelectionScope:(scope:string)=>mockClearApiSelections(scope)}));
jest.mock('../remote/question-outbox',()=>({retireQuestionScope:(scope:string)=>mockRetireApprovals(scope)}));

jest.mock('../../modules/salcara-direct-transport', () => ({
  connect: (...args: unknown[]) => mockConnect(...args as [string, string]),
  send: (...args: unknown[]) => mockSend(...args as [string]),
  close: () => mockClose(),
  addListener: (name: string, listener: (event: any) => void) => {
    const listeners = mockListeners.get(name) ?? new Set();
    listeners.add(listener); mockListeners.set(name, listeners);
    return { remove: () => listeners.delete(listener) };
  },
}));
jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device-only',
  getItemAsync: async (key: string) => mockStore.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { if (mockBeforeWrite) await mockBeforeWrite(); mockStore.set(key, value); },
  deleteItemAsync: async (key: string) => { mockStore.delete(key); },
}));
jest.mock('expo-crypto', () => ({ getRandomBytesAsync: async (size: number) => new Uint8Array(size).fill(9) }));
jest.mock('../remote/phone-identity', () => ({ phoneIdentity: async () => 'b'.repeat(64) }));

import {
  disconnectDirect, directDeliveryScope, directConnectionGeneration, forgetDirectPairing, listDirectPairings, pairDirectQr, parseDirectPairQr, reconnectDirect, resetDirectPairingForTests, restoreDirectPairing,
} from '../remote/direct-pairing';

const fingerprint = 'a'.repeat(64);
const qr = (overrides: Record<string, unknown> = {}) => ({
  mode: 'direct', urls: ['wss://192.168.1.8:47832/direct/ws'], token: 'c'.repeat(32), deviceId: 'pc-1',
  fingerprint, expiresAt: Date.now() + 60_000, deviceName: 'Test PC', ...overrides,
});

beforeEach(() => {
  mockClearApiSelections.mockReset().mockResolvedValue(undefined);
  mockRetireApprovals.mockReset().mockResolvedValue(undefined);
  resetDirectPairingForTests();
  mockListeners.clear(); mockStore.clear(); mockConnect.mockClear(); mockSend.mockClear(); mockClose.mockClear(); mockClearDrafts.mockReset().mockResolvedValue(undefined); mockClearQueue.mockReset().mockResolvedValue(undefined); mockBeforeWrite = null;
});

test('accepts only pinned WSS direct QR payloads with a short-lived one-time token', () => {
  expect(parseDirectPairQr(JSON.stringify(qr())).urls).toEqual(['wss://192.168.1.8:47832/direct/ws']);
  for (const invalid of [
    qr({ urls: ['ws://192.168.1.8:47832/direct/ws'] }),
    qr({ urls: ['wss://192.168.1.8:47832/direct/ws?token=secret'] }),
    qr({ urls: ['wss://relay.example.com:47832/direct/ws'] }),
    qr({ urls: ['wss://8.8.8.8:47832/direct/ws'] }),
    qr({ urls: ['wss://169.254.1.8:47832/direct/ws'] }),
    qr({ urls: ['wss://localhost:47832/direct/ws'] }),
    qr({ urls: ['wss://127.0.0.1:47832/direct/ws'] }),
    qr({ urls: ['wss://[::1]:47832/direct/ws'] }),
    qr({ fingerprint: 'f'.repeat(63) }),
    qr({ expiresAt: Date.now() - 1 }),
  ]) expect(() => parseDirectPairQr(JSON.stringify(invalid))).toThrow();
  for (const host of ['10.0.0.7', '172.31.0.7', '192.168.1.8', '100.100.0.7', '[fd00::8]']) {
    expect(parseDirectPairQr(JSON.stringify(qr({ urls: [`wss://${host}:47832/direct/ws`] }))).urls).toHaveLength(1);
  }
});

test('persists a recoverable device-only credential before one-time auth and connects without Hub APIs', async () => {
  const result = await pairDirectQr(parseDirectPairQr(JSON.stringify(qr())));
  expect(result.status).toBe('connected');
  expect(mockConnect).toHaveBeenCalledWith('wss://192.168.1.8:47832/direct/ws', fingerprint);
  expect(mockSend).toHaveBeenCalledTimes(1);
  const [authFrame] = mockSend.mock.calls[0];
  expect(JSON.parse(authFrame)).toEqual({ type: 'auth', token: 'c'.repeat(32), phoneId: 'b'.repeat(64), phoneHash: expect.any(String) });
  const persisted = JSON.parse(mockStore.get('salcara-direct-pair-v1-pc-1')!);
  expect(persisted.version).toBe(1);
  expect(persisted.secret).toHaveLength(64);
  expect(JSON.parse(mockStore.get('salcara-direct-pair-index-v1')!)).toEqual(['pc-1']);
});

test('explicit disconnect keeps peer identity available for reconnect and unpair controls', async () => {
  await pairDirectQr(parseDirectPairQr(JSON.stringify(qr())));
  disconnectDirect();
  const { getDirectConnectionState } = require('../remote/direct-pairing') as typeof import('../remote/direct-pairing');
  expect(getDirectConnectionState()).toMatchObject({ status: 'closed', deviceId: 'pc-1', deviceName: 'Test PC' });
  await reconnectDirect('pc-1');
  expect(getDirectConnectionState()).toMatchObject({ status: 'connected', deviceId: 'pc-1' });
  expect(mockConnect).toHaveBeenCalledTimes(2);
});

test('device management lists every valid direct peer without exposing secrets or opening sockets',async()=>{
  await pairDirectQr(parseDirectPairQr(JSON.stringify(qr())));
  const original=JSON.parse(mockStore.get('salcara-direct-pair-v1-pc-1')!);
  mockStore.set('salcara-direct-pair-v1-pc-2',JSON.stringify({...original,deviceId:'pc-2',deviceName:'Second PC'}));
  mockStore.set('salcara-direct-pair-v1-invalid','{bad');
  mockStore.set('salcara-direct-pair-index-v1',JSON.stringify(['pc-1','pc-2','invalid']));
  mockConnect.mockClear();mockSend.mockClear();
  const peers=await listDirectPairings();
  expect(peers.map(item=>item.deviceId)).toEqual(['pc-1','pc-2']);
  expect(peers[1]).toEqual({deviceId:'pc-2',deviceName:'Second PC',endpoint:original.urls[0],pairedAt:original.pairedAt,pairingScope:expect.stringMatching(/^direct:/)});
  expect(JSON.stringify(peers)).not.toContain(original.secret);expect(peers[0]).not.toHaveProperty('phoneId');
  expect(mockConnect).not.toHaveBeenCalled();expect(mockSend).not.toHaveBeenCalled();
});

test('cold start restores the last paired device reference without connecting automatically', async () => {
  await pairDirectQr(parseDirectPairQr(JSON.stringify(qr())));
  resetDirectPairingForTests();
  mockListeners.clear();
  mockConnect.mockClear(); mockSend.mockClear(); mockClose.mockClear();
  await restoreDirectPairing();
  const { getDirectConnectionState } = require('../remote/direct-pairing') as typeof import('../remote/direct-pairing');
  expect(getDirectConnectionState()).toMatchObject({ status: 'closed', deviceId: 'pc-1', deviceName: 'Test PC' });
  expect(mockConnect).not.toHaveBeenCalled();
  await reconnectDirect('pc-1');
  expect(getDirectConnectionState()).toMatchObject({ status: 'connected', deviceId: 'pc-1' });
});

test('delivery scope survives reconnect and restore but changes when this computer is bound again', async () => {
  await pairDirectQr(parseDirectPairQr(JSON.stringify(qr())));
  const initial=directDeliveryScope(),generation=directConnectionGeneration();
  expect(initial).toMatch(/^direct:/);
  disconnectDirect();expect(directDeliveryScope()).toBe(initial);
  await reconnectDirect('pc-1');
  expect(directDeliveryScope()).toBe(initial);expect(directConnectionGeneration()).not.toBe(generation);
  resetDirectPairingForTests();mockListeners.clear();
  await restoreDirectPairing();expect(directDeliveryScope()).toBe(initial);
  await forgetDirectPairing('pc-1');expect(directDeliveryScope()).toBe('');
  await new Promise(resolve=>setTimeout(resolve,2));
  await pairDirectQr(parseDirectPairQr(JSON.stringify(qr())));
  expect(directDeliveryScope()).not.toBe(initial);
});

test('concurrent reconnect taps share one native connection attempt', async () => {
  await pairDirectQr(parseDirectPairQr(JSON.stringify(qr())));
  disconnectDirect();
  mockConnect.mockClear();
  const first = reconnectDirect('pc-1');
  const second = reconnectDirect('pc-1');
  await Promise.all([first, second]);
  expect(mockConnect).toHaveBeenCalledTimes(1);
});

test('forgetting the active pairing clears the visible peer state and index', async () => {
  await pairDirectQr(parseDirectPairQr(JSON.stringify(qr())));
  const scope=directDeliveryScope();
  const { forgetDirectPairing, getDirectConnectionState } = require('../remote/direct-pairing') as typeof import('../remote/direct-pairing');
  await forgetDirectPairing('pc-1');
  expect(getDirectConnectionState()).toEqual({ status: 'idle' });
  expect(mockStore.has('salcara-direct-pair-v1-pc-1')).toBe(false);
  expect(mockStore.has('salcara-direct-pair-index-v1')).toBe(false);
  expect(mockClearDrafts).toHaveBeenCalledWith(scope);
  expect(mockClearQueue).toHaveBeenCalledWith(scope);
  expect(mockClearPending).toHaveBeenCalledWith(scope);
  expect(mockClearApiSelections).toHaveBeenCalledWith(scope);
  expect(mockRetireApprovals).toHaveBeenCalledWith(scope);
});

test('draft cleanup failure after permanent unbind does not restore the deleted credential',async()=>{
  await pairDirectQr(parseDirectPairQr(JSON.stringify(qr())));disconnectDirect();await reconnectDirect('pc-1');expect(mockClearDrafts).not.toHaveBeenCalled();
  mockClearDrafts.mockRejectedValueOnce(new Error('storage failure'));
  await expect(forgetDirectPairing('pc-1')).rejects.toThrow('电脑已解除绑定');expect(mockStore.has('salcara-direct-pair-v1-pc-1')).toBe(false);expect(directDeliveryScope()).toBe('');
  expect(mockClearQueue).toHaveBeenCalledTimes(1);
});

test('queue cleanup failure still clears drafts without restoring pairing',async()=>{
  await pairDirectQr(parseDirectPairQr(JSON.stringify(qr())));
  mockClearQueue.mockRejectedValueOnce(new Error('queue storage failure'));
  await expect(forgetDirectPairing('pc-1')).rejects.toThrow('电脑已解除绑定');
  expect(mockClearDrafts).toHaveBeenCalledTimes(1);expect(mockStore.has('salcara-direct-pair-v1-pc-1')).toBe(false);
});

test('an explicit pairing rejection removes the provisional binding', async () => {
  mockSend.mockImplementationOnce(() => {
    queueMicrotask(() => mockListeners.get('onMessage')?.forEach(listener => listener({ text: JSON.stringify({ type: 'error', error: 'invalid ticket' }) })));
  });
  await expect(pairDirectQr(parseDirectPairQr(JSON.stringify(qr())))).rejects.toMatchObject({ code: 'pairing_rejected' });
  expect(mockStore.has('salcara-direct-pair-v1-pc-1')).toBe(false);
});

test('disconnect racing a delayed secure write restores the prior credential and cancels auth', async () => {
  const key = 'salcara-direct-pair-v1-pc-1';
  const prior = JSON.stringify({ version: 1, deviceId: 'pc-1', phoneId: 'd'.repeat(64), secret: 'e'.repeat(64),
    fingerprint, urls: ['wss://192.168.1.8:47832/direct/ws'], pairedAt: Date.now() });
  mockStore.set(key, prior);
  let finishWrite!: () => void;
  let delayFirstWrite = true;
  mockBeforeWrite = () => delayFirstWrite ? new Promise<void>(resolve => { delayFirstWrite = false; finishWrite = resolve; }) : Promise.resolve();
  const pairing = pairDirectQr(parseDirectPairQr(JSON.stringify(qr())));
  await new Promise(resolve => setTimeout(resolve, 25));
  expect(finishWrite).toBeDefined();
  disconnectDirect();
  finishWrite();
  await expect(pairing).rejects.toMatchObject({ code: 'disconnected' });
  expect(mockStore.get(key)).toBe(prior);
  expect(mockConnect).not.toHaveBeenCalled();
});
