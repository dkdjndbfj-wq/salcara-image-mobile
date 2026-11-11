const mockAdoptIngress = jest.fn();
// This suite mocks all transport boundaries. Avoid Expo's lazy global fetch
// loader running after Jest tears the mocked native module registry down.
beforeAll(() => { Object.defineProperty(globalThis, 'fetch', { value: jest.fn(), configurable: true, writable: true }); });
const mockNative = {
  recoveredIngress: jest.fn(), configureWatch: jest.fn(),
  stopWatch: jest.fn(async () => undefined), consumeLaunchPayload: jest.fn(() => null),
  addListener: jest.fn(() => ({ remove: jest.fn() })), canNotify: jest.fn(() => true),
};
let mockTarget: { hub: { url: string; pairToken: string }; deviceId: string } | null;
const mockRemoteListeners = new Set<() => void>();
jest.mock('expo', () => ({ requireOptionalNativeModule: () => mockNative }));
jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  AppState: { currentState: 'active', addEventListener: () => ({ remove: jest.fn() }) },
}));
jest.mock('../remote/client', () => ({ adoptRecoveredHubIngress: (...args: unknown[]) => mockAdoptIngress(...args) }));
jest.mock('../remote/notification-preferences', () => ({
  remoteNotificationsEnabled: () => true, loadNotificationPreference: async () => undefined,
  onNotificationPreferenceChange: () => () => undefined,
}));
jest.mock('../remote/push', () => ({ onPushChange: () => () => undefined, pushStatus: () => 'fcm', standbyEnabled: () => false }));
jest.mock('../remote/store', () => ({
  watchCredentials: () => mockTarget?.hub, pushTarget: () => mockTarget,
  getRemoteState: () => ({ phase: 'ready', signingIn: null, sessions: {}, focus: null }),
  onRemoteChange: (listener: () => void) => { mockRemoteListeners.add(listener); return () => mockRemoteListeners.delete(listener); },
  onRemoteEvent: () => () => undefined,
}));

const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('cancelling a hand-back during pin loading retains its public cache for a later return to the exact pairing', async () => {
  const original = { hub: { url: 'https://original.example/v1', pairToken: 'original-pair' }, deviceId: 'pc-a' };
  mockTarget = original;
  const scope = require('../remote/notification-scope').notificationScopeFor(original.hub, original.deviceId);
  const manifest = { signed_payload: 'native-only-migration-hint', signature: 'signature-validated-by-router' };
  mockNative.recoveredIngress.mockReturnValueOnce(JSON.stringify({ hubUrl: original.hub.url, navigationScope: scope, manifest })).mockReturnValue(null);
  const loadingPin = deferred<void>();
  mockAdoptIngress.mockImplementationOnce(async (_url: string, _manifest: unknown, active: () => boolean) => {
    await loadingPin.promise;
    return active();
  }).mockResolvedValue(true);
  const stop = require('../remote/notifications').startRemoteNotifications(() => undefined);
  try {
    expect(mockAdoptIngress).toHaveBeenCalledTimes(1);
    // configureWatch(false) has already cleared the native recovery checkpoint.
    expect(JSON.parse(mockNative.configureWatch.mock.calls[0][0]).follow).toBe(false);
    mockTarget = { hub: { url: 'https://other.example/v1', pairToken: 'other-pair' }, deviceId: 'pc-b' };
    mockRemoteListeners.forEach(listener => listener());
    loadingPin.resolve(); await flush();
    expect(await mockAdoptIngress.mock.results[0].value).toBe(false);
    mockTarget = original;
    mockRemoteListeners.forEach(listener => listener());
    await flush();
    expect(mockAdoptIngress).toHaveBeenCalledTimes(2);
    expect(mockAdoptIngress).toHaveBeenLastCalledWith(original.hub.url, manifest, expect.any(Function));
  } finally { stop(); }
});
