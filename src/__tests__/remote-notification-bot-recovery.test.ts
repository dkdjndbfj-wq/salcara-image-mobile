import { generateKeyPairSync, sign } from 'node:crypto';
import type { IngressManifest } from '../remote/ingress';

const mockNative = {
  canNotify: jest.fn(() => true), pushToken: jest.fn(), startStandby: jest.fn(async () => true),
  startWatch: jest.fn(async () => true), stopWatch: jest.fn(async () => undefined), configureWatch: jest.fn(),
  watchStatus: jest.fn(), recoveredIngress: jest.fn(), consumeLaunchPayload: jest.fn(() => null),
  addListener: jest.fn(() => ({ remove: jest.fn() })),
};
const mockSnapshot = jest.fn();
const mockAdopt = jest.fn();
const mockBotAdopt = jest.fn();
let mockAppChange: ((state: string) => void) | undefined;
let mockRemoteChange: (() => void) | undefined;
let mockBindingChange: (() => void) | undefined;
let mockLoadTargets: (() => Promise<Target[]>) | undefined;
type Pin = { instanceId: string; publicKey: string };
type Target = { notificationScope: string; deviceId: string; connectionId?: string; hub: { url: string; pairToken: string; botToken: string; botPin: Pin } };
let mockTarget: Target | null;
let mockTargets: Target[];
let mockRecovery: string | null;

jest.mock('expo', () => ({ requireOptionalNativeModule: () => mockNative }));
jest.mock('react-native', () => ({ Platform: { OS: 'android' }, AppState: { currentState: 'active',
  addEventListener: (_: string, callback: typeof mockAppChange) => { mockAppChange = callback; return { remove: jest.fn() }; } } }));
jest.mock('../remote/client', () => ({ hubIngressSnapshot: (...args: unknown[]) => mockSnapshot(...args),
  adoptRecoveredHubIngress: (...args: unknown[]) => mockAdopt(...args),
  adoptRecoveredBotHubIngress: (...args: unknown[]) => mockBotAdopt(...args) }));
jest.mock('../remote/push', () => ({ onPushChange: () => () => undefined, standbyEnabled: () => true, syncPush: async () => undefined }));
jest.mock('../remote/notification-preferences', () => ({ loadNotificationPreference: async () => undefined,
  onNotificationPreferenceChange: () => () => undefined, remoteNotificationsEnabled: () => true }));
jest.mock('../remote/notification-targets', () => ({ notificationTargets: async () => mockLoadTargets ? mockLoadTargets() : mockTargets,
  publishNotificationTargets: jest.fn(), currentNoticeTarget: async () => true }));
jest.mock('../remote/connections', () => ({ onConnectionBindingsChange: (callback: typeof mockBindingChange) => { mockBindingChange = callback; return () => undefined; },
  resolveNotificationTarget: async () => null }));
jest.mock('../remote/store', () => ({ pushTarget: () => mockTarget, watchCredentials: () => mockTarget?.hub,
  onRemoteChange: (callback: typeof mockRemoteChange) => { mockRemoteChange = callback; return () => undefined; },
  getRemoteState: () => ({ sessions: {}, phase: 'ready', signingIn: null }), onRemoteEvent: () => () => undefined,
  hubSupportsWait: () => true, sessionCursor: () => 0, setRemoteFocus: jest.fn(), useSavedConnection: jest.fn() }));

const url = 'https://old.example/salcara-hub/v1';
const moved = 'https://new.example/salcara-hub/v1';
const keys = generateKeyPairSync('ed25519');
const pin = { instanceId: 'a'.repeat(32), publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64') };
function signed(revision: number, options: Partial<IngressManifest> = {}): IngressManifest {
  const now = Date.now(), canonical = revision > 1 ? moved : url;
  const value = { version: 1, hub_instance_id: pin.instanceId, identity_public_key: pin.publicKey, canonical_url: canonical,
    revision, issued_at: now - 1000, expires_at: now + 60_000, endpoints: [{ id: 'canonical', url: canonical, priority: 0 }], ...options };
  const payload = Buffer.from(JSON.stringify(value));
  return { ...value, signed_payload: payload.toString('base64'), signature: sign(null,
    Buffer.concat([Buffer.from('salcara-ingress-manifest-v1\n'), payload]), keys.privateKey).toString('base64') } as IngressManifest;
}
function target(token = 'synthetic-bot-token', botPin = pin, deviceId = 'pc-a'): Target {
  const hub = { url, pairToken: token, botToken: token, botPin: { ...botPin } };
  const notificationScope = require('../remote/notification-scope').notificationScopeFor(hub, deviceId);
  return { notificationScope, hub, deviceId, connectionId: `saved-${deviceId}` };
}
const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
function recovery(manifest: unknown, owner = mockTarget!) {
  mockRecovery = JSON.stringify({ hubUrl: owner.hub.url, navigationScope: owner.notificationScope, manifest });
}
async function background() { require('react-native').AppState.currentState = 'background'; mockAppChange?.('background'); await flush(); }
async function foreground() { require('react-native').AppState.currentState = 'active'; mockAppChange?.('active'); await flush(); }
function handoff() { return JSON.parse(mockNative.configureWatch.mock.calls.at(-1)![0]); }
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) }; }

beforeAll(() => { Object.defineProperty(globalThis, 'fetch', { value: jest.fn(), configurable: true, writable: true }); });
beforeEach(() => {
  jest.resetModules(); jest.clearAllMocks();
  mockTarget = target(); mockTargets = [mockTarget]; mockRecovery = null; mockLoadTargets = undefined;
  mockAppChange = undefined; mockRemoteChange = undefined; mockBindingChange = undefined;
  mockSnapshot.mockReset().mockReturnValue(signed(1)); mockAdopt.mockReset().mockResolvedValue(true); mockBotAdopt.mockReset().mockResolvedValue(true);
  mockNative.watchStatus.mockReturnValue({ running: true, standby: true });
  mockNative.recoveredIngress.mockImplementation(() => mockRecovery);
  mockNative.configureWatch.mockImplementation((raw: string) => { if (!JSON.parse(raw).follow) mockRecovery = null; });
  require('react-native').AppState.currentState = 'active';
});

test('native-only moved Bot locator survives foreground checkpoint deletion and the next background handoff', async () => {
  const manifest = signed(2); recovery({ signed_payload: manifest.signed_payload, signature: manifest.signature });
  const stop = require('../remote/notifications').startRemoteNotifications(jest.fn());
  try {
    await flush(); expect(mockRecovery).toBeNull();
    await background();
    expect(handoff().connections[0]).toMatchObject({ hubUrl: url, botPin: pin, ingressManifest: manifest });
    expect(mockBotAdopt).toHaveBeenCalledWith(url, manifest, pin, expect.any(Function));
    expect(mockAdopt).not.toHaveBeenCalled();
    await foreground(); await background();
    expect(handoff().connections[0].ingressManifest).toMatchObject(manifest);
  } finally { stop(); }
});

test('an empty global cache uses the explicit-pin client import and still preserves the next handoff', async () => {
  mockSnapshot.mockReturnValue(undefined); const manifest = signed(2); recovery(manifest);
  const stop = require('../remote/notifications').startRemoteNotifications(jest.fn());
  try { await flush(); expect(mockBotAdopt).toHaveBeenCalledWith(url, manifest, pin, expect.any(Function));
    await background(); expect(handoff().connections[0].ingressManifest).toMatchObject(manifest); }
  finally { stop(); }
});

test('a foreign global pin is never overwritten while the original Bot retains its scoped native locator', async () => {
  mockSnapshot.mockReturnValue(signed(9, { hub_instance_id: 'b'.repeat(32) })); const manifest = signed(2); recovery(manifest);
  const stop = require('../remote/notifications').startRemoteNotifications(jest.fn());
  try { await flush(); expect(mockBotAdopt).not.toHaveBeenCalled(); expect(mockAdopt).not.toHaveBeenCalled();
    await background(); expect(handoff().connections[0]).toMatchObject({ botPin: pin, ingressManifest: manifest }); }
  finally { stop(); }
});

test.each(['foreign-pin', 'unsigned', 'forged-signature', 'foreign-scope'] as const)('a %s hand-back never becomes Bot authority', async variant => {
  const manifest = signed(3, variant === 'foreign-pin' ? { hub_instance_id: 'b'.repeat(32) } : {});
  if (variant === 'unsigned') { delete manifest.signature; delete manifest.signed_payload; }
  if (variant === 'forged-signature') manifest.signature = Buffer.alloc(64).toString('base64');
  recovery(manifest, variant === 'foreign-scope' ? target('another-token') : mockTarget!);
  const stop = require('../remote/notifications').startRemoteNotifications(jest.fn());
  try { await flush(); expect(mockBotAdopt).not.toHaveBeenCalled(); await background(); expect(handoff().connections[0].ingressManifest.revision).toBe(1); }
  finally { stop(); }
});

test.each(['lower-revision', 'shorter-equal-revision'] as const)('scoped Bot recovery refuses a %s rollback', async variant => {
  const newest = signed(5); recovery(newest);
  const stop = require('../remote/notifications').startRemoteNotifications(jest.fn());
  try {
    await flush(); await background();
    recovery(variant === 'lower-revision' ? signed(4) : signed(5, { expires_at: newest.expires_at - 1000 }));
    await foreground(); await background();
    expect(handoff().connections[0].ingressManifest).toMatchObject(newest);
  } finally { stop(); }
});

test('a newer matching global revision takes precedence over a stale native hand-back', async () => {
  const newest = signed(7); mockSnapshot.mockReturnValue(newest); recovery(signed(2));
  const stop = require('../remote/notifications').startRemoteNotifications(jest.fn());
  try { await flush(); await background(); expect(handoff().connections[0].ingressManifest).toMatchObject(newest); }
  finally { stop(); }
});

test.each(['token', 'pin', 'target', 'removed', 'cleanup'] as const)('in-flight Bot import cancels on %s ownership change', async variant => {
  const pending = deferred<boolean>(); mockBotAdopt.mockReturnValue(pending.promise); recovery(signed(2));
  const notifications = require('../remote/notifications'); const stop = notifications.startRemoteNotifications(jest.fn());
  let stopped = false;
  try {
    await flush(); expect(mockBotAdopt).toHaveBeenCalled();
    const active = mockBotAdopt.mock.calls[0][3]; expect(active()).toBe(true);
    if (variant === 'cleanup') { stop(); stopped = true; }
    else if (variant === 'removed') { mockTargets = []; mockTarget = null; mockBindingChange?.(); }
    else { mockTarget = target(variant === 'token' ? 'new-token' : 'synthetic-bot-token',
      variant === 'pin' ? { ...pin, instanceId: 'b'.repeat(32) } : pin, variant === 'target' ? 'pc-b' : 'pc-a');
      mockTargets = [mockTarget]; mockRemoteChange?.(); }
    expect(active()).toBe(false); pending.resolve(true); await flush();
    if (!stopped) { await background(); expect(handoff().connections ?? []).not.toEqual(expect.arrayContaining([expect.objectContaining({ ingressManifest: expect.objectContaining({ revision: 2 }) })])); }
  } finally { if (!stopped) stop(); }
});

test('a delayed target refresh from a removed binding cannot restore its Bot locator', async () => {
  const pending = deferred<Target[]>(), original = mockTarget!;
  mockLoadTargets = () => pending.promise; recovery(signed(2));
  const stop = require('../remote/notifications').startRemoteNotifications(jest.fn());
  try {
    mockTarget = null; mockTargets = []; mockLoadTargets = async () => []; mockBindingChange?.();
    pending.resolve([original]); await flush(); await background();
    expect(handoff().follow).toBe(false); expect(mockBotAdopt.mock.calls.every(call => call[3]() === false)).toBe(true);
  } finally { stop(); }
});

test('removing a saved binding cancels import even while the visible store still contains the old target', async () => {
  const pending = deferred<boolean>(); mockBotAdopt.mockReturnValue(pending.promise); recovery(signed(2));
  const stop = require('../remote/notifications').startRemoteNotifications(jest.fn());
  try {
    await flush(); const active = mockBotAdopt.mock.calls[0][3]; expect(active()).toBe(true);
    mockTargets = []; mockBindingChange?.(); expect(active()).toBe(false);
    pending.resolve(true); await flush(); await background();
    expect(handoff().follow).toBe(false); expect(mockBotAdopt).toHaveBeenCalledTimes(1);
  } finally { stop(); }
});

test('a global pin change during async import cancels the old Bot owner', async () => {
  const pending = deferred<boolean>(); mockBotAdopt.mockReturnValue(pending.promise); recovery(signed(2));
  const stop = require('../remote/notifications').startRemoteNotifications(jest.fn());
  try {
    await flush(); const active = mockBotAdopt.mock.calls[0][3]; expect(active()).toBe(true);
    mockSnapshot.mockReturnValue(signed(7, { hub_instance_id: 'b'.repeat(32) })); expect(active()).toBe(false);
    pending.resolve(false); await flush(); await background();
    expect(handoff().connections[0]).toMatchObject({ botPin: pin, ingressManifest: { revision: 2 } });
  } finally { stop(); }
});

test('the legacy client fallback imports only an existing matching global identity', async () => {
  require('../remote/client').adoptRecoveredBotHubIngress = undefined;
  const manifest = signed(2); recovery(manifest);
  const stop = require('../remote/notifications').startRemoteNotifications(jest.fn());
  try { await flush(); expect(mockBotAdopt).not.toHaveBeenCalled(); expect(mockAdopt).toHaveBeenCalledWith(url, manifest, expect.any(Function));
    await background(); expect(handoff().connections[0].ingressManifest).toMatchObject(manifest); }
  finally { stop(); }
});

test('an older client with no global pin retains the scoped hint without attempting TOFU', async () => {
  require('../remote/client').adoptRecoveredBotHubIngress = undefined; mockSnapshot.mockReturnValue(undefined);
  const manifest = signed(2); recovery(manifest);
  const stop = require('../remote/notifications').startRemoteNotifications(jest.fn());
  try { await flush(); expect(mockBotAdopt).not.toHaveBeenCalled(); expect(mockAdopt).not.toHaveBeenCalled();
    await background(); expect(handoff().connections[0].ingressManifest).toMatchObject(manifest); }
  finally { stop(); }
});

test('native hand-back for an inactive saved Bot is preserved without importing under the visible target', async () => {
  const original = mockTarget!, other = target('other-token', pin, 'pc-b'), manifest = signed(2);
  mockTarget = other; mockTargets = [original, other]; recovery(manifest, original);
  const stop = require('../remote/notifications').startRemoteNotifications(jest.fn());
  try { await flush(); expect(mockBotAdopt).not.toHaveBeenCalled(); await background();
    expect(handoff().connections.find((row: { navigationScope: string }) => row.navigationScope === original.notificationScope).ingressManifest).toMatchObject(manifest);
    expect(handoff().connections.find((row: { navigationScope: string }) => row.navigationScope === other.notificationScope).ingressManifest.revision).toBe(1); }
  finally { stop(); }
});
