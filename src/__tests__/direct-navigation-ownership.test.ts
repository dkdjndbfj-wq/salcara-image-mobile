const mockListeners = new Map<string, Set<(event: any) => void>>();
const mockCredentials = new Map<string, string>();
const mockConnect = jest.fn(), mockSend = jest.fn(), mockClose = jest.fn();
let mockReadGate: Promise<void> | undefined;
jest.mock('../../modules/salcara-direct-transport', () => ({ connect: (...args: unknown[]) => mockConnect(...args),
  send: (...args: unknown[]) => mockSend(...args), close: () => mockClose(),
  addListener: (name: string, listener: (event: any) => void) => {
    const listeners = mockListeners.get(name) ?? new Set(); listeners.add(listener); mockListeners.set(name, listeners);
    return { remove: () => listeners.delete(listener) };
  } }));
jest.mock('expo-secure-store', () => ({ getItemAsync: async (key: string) => { await mockReadGate; return mockCredentials.get(key) ?? null; } }));
jest.mock('expo-crypto', () => ({ getRandomBytesAsync: async () => new Uint8Array(32) }));
jest.mock('../remote/phone-identity', () => ({ phoneIdentity: async () => 'b'.repeat(64) }));
import { getDirectConnectionState, reconnectDirect, resetDirectPairingForTests } from '../remote/direct-pairing';
const emit = (name: string, event: unknown) => mockListeners.get(name)?.forEach(listener => listener(event));
const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
function auth(deviceId: string) { emit('onState', { state: 'open' }); emit('onMessage', { text: JSON.stringify({ type: 'auth_ok', deviceId }) }); }
beforeEach(() => {
  resetDirectPairingForTests(); mockListeners.clear(); mockCredentials.clear(); mockReadGate = undefined;
  jest.clearAllMocks();
  for (const id of ['pc-a', 'pc-b']) mockCredentials.set(`salcara-direct-pair-v1-${id}`, JSON.stringify({ version: 1, deviceId: id,
    deviceName: 'Same name', phoneId: 'b'.repeat(64), secret: 'c'.repeat(64), fingerprint: 'd'.repeat(64),
    urls: ['wss://192.168.1.8:47832/direct/ws'], pairedAt: 1 }));
});
afterEach(() => { resetDirectPairingForTests(); });

test('a navigation already retired cannot alter the active connection or open a socket', async () => {
  await expect(reconnectDirect('pc-a', { stillWanted: () => false })).rejects.toMatchObject({ code: 'disconnected' });
  expect(getDirectConnectionState().status).toBe('idle'); expect(mockConnect).not.toHaveBeenCalled();
});

test('leaving the computer picker during secure storage lookup prevents later authentication', async () => {
  let release!: () => void, wanted = true;
  mockReadGate = new Promise(resolve => { release = resolve; });
  const pending = reconnectDirect('pc-a', { stillWanted: () => wanted });
  const failed = expect(pending).rejects.toMatchObject({ code: 'disconnected' });
  wanted = false; release(); await failed;
  expect(mockConnect).not.toHaveBeenCalled(); expect(mockSend).not.toHaveBeenCalled(); expect(getDirectConnectionState().status).toBe('closed');
});

test('a late successful authentication cannot publish a connected computer after its caller left', async () => {
  let wanted = true;
  const pending = reconnectDirect('pc-a', { stillWanted: () => wanted });
  const failed = expect(pending).rejects.toMatchObject({ code: 'disconnected' });
  await flush(); expect(mockConnect).toHaveBeenCalledTimes(1);
  wanted = false; auth('pc-a'); await failed;
  expect(getDirectConnectionState()).toMatchObject({ status: 'closed', deviceId: 'pc-a' });
  expect(mockCredentials.has('salcara-direct-pair-v1-pc-a')).toBe(true);
});

test('a new owner for the same computer does not inherit the abandoned owner flight', async () => {
  let wanted = true;
  const first = reconnectDirect('pc-a', { stillWanted: () => wanted });
  const failed = expect(first).rejects.toMatchObject({ code: 'disconnected' });
  await flush(); wanted = false;
  const second = reconnectDirect('pc-a', { stillWanted: () => true }); await flush();
  auth('pc-a'); await failed; await expect(second).resolves.toMatchObject({ status: 'connected', deviceId: 'pc-a' });
  expect(mockConnect).toHaveBeenCalledTimes(2);
});

test('abandoned pc-a callbacks cannot overwrite or close the newer pc-b connection', async () => {
  let wanted = true;
  const first = reconnectDirect('pc-a', { stillWanted: () => wanted });
  const failed = expect(first).rejects.toMatchObject({ code: 'disconnected' });
  await flush(); const staleMessages = [...(mockListeners.get('onMessage') ?? [])]; wanted = false;
  const second = reconnectDirect('pc-b', { stillWanted: () => true }); await flush(); auth('pc-b');
  await failed; await second; const closes = mockClose.mock.calls.length;
  staleMessages.forEach(listener => listener({ text: JSON.stringify({ type: 'auth_ok', deviceId: 'pc-a' }) }));
  await flush(); expect(getDirectConnectionState()).toMatchObject({ status: 'connected', deviceId: 'pc-b' });
  expect(mockClose).toHaveBeenCalledTimes(closes);
});
