import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Networking is mocked below; do not initialize Expo's lazy native fetch
// getter while resetModules/teardown is dismantling the native registry.
beforeAll(() => { Object.defineProperty(globalThis, 'fetch', { value: jest.fn(), configurable: true, writable: true }); });

const mockNative = {
  setNotificationsEnabled: jest.fn(), pushToken: jest.fn(), addListener: jest.fn((_event: string, _listener: (...args: any[]) => void) => ({ remove: jest.fn() })),
  canNotify: jest.fn(() => true), requestPermission: jest.fn(async () => undefined), stopWatch: jest.fn(async () => undefined), startWatch: jest.fn(), startStandby: jest.fn(),
  configureWatch: jest.fn(), consumeLaunchPayload: jest.fn(() => null), watchStatus: jest.fn(),
  recoveredIngress: jest.fn(),
  setNotificationTargets: jest.fn(),
  notify: jest.fn(async (_id: string, _title: string, _body: string, _payload: string) => undefined),
};
const mockGetSetting = jest.fn();
const mockSetSetting = jest.fn();
const mockRegister = jest.fn();
const mockAdoptIngress = jest.fn();
const mockSetFocus = jest.fn();
const mockUseSaved = jest.fn();
let mockSavedTargets: import('../remote/connections').NotificationTarget[] = [];
let mockRemoteState: { phase: string; signingIn: string | null; sessions: Record<string, unknown>; focus?: { deviceId: string; sessionKey: string } | { home: true } | null };
const mockRemoteListeners = new Set<() => void>();
let mockTarget: { hub: { url: string; pairToken: string; botToken?: string; botPin?: { instanceId: string; publicKey: string } }; deviceId: string } | null;
let mockSupports = true;
let mockRemoteChange: (() => void) | undefined;
let mockAppChange: ((state: string) => void) | undefined;
let mockRemoteEvent: ((event: import('../remote/client').HubEvent) => void) | undefined;
jest.mock('expo', () => ({ requireOptionalNativeModule: () => mockNative }));
jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  AppState: { currentState: 'active', addEventListener: (_: string, callback: (state: string) => void) => {
    mockAppChange = callback; return { remove: jest.fn() };
  } },
}));
jest.mock('../storage/database', () => ({ getSetting: (...args: unknown[]) => mockGetSetting(...args), setSetting: (...args: unknown[]) => mockSetSetting(...args) }));
jest.mock('../remote/client', () => ({ registerPushToken: (...args: unknown[]) => mockRegister(...args), adoptRecoveredHubIngress: (...args: unknown[]) => mockAdoptIngress(...args) }));
jest.mock('../remote/connections', () => ({
  onConnectionBindingsChange: () => () => undefined,
  loadNotificationTargets: async () => mockSavedTargets,
  resolveNotificationTarget: async (scope: string, device: string) => mockSavedTargets.find(target => target.notificationScope === scope && target.deviceId === device) ?? null,
}));
jest.mock('../remote/store', () => ({
  pushTarget: () => mockTarget, hubSupportsPush: () => mockSupports,
  onRemoteChange: (callback: () => void) => { mockRemoteListeners.add(callback); mockRemoteChange = () => mockRemoteListeners.forEach(listener => listener()); return () => mockRemoteListeners.delete(callback); },
  getRemoteState: () => mockRemoteState, onRemoteEvent: (callback: typeof mockRemoteEvent) => { mockRemoteEvent = callback; return () => { mockRemoteEvent = undefined; }; }, setRemoteFocus: (...args: unknown[]) => mockSetFocus(...args),
  sessionCursor: () => 0, hubSupportsWait: () => true, watchCredentials: () => mockTarget?.hub,
  useSavedConnection: (...args: unknown[]) => mockUseSaved(...args),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const modules = () => ({
  prefs: require('../remote/notification-preferences') as typeof import('../remote/notification-preferences'),
  push: require('../remote/push') as typeof import('../remote/push'),
});

beforeEach(() => {
  jest.resetModules(); jest.clearAllMocks();
  mockSavedTargets = [];
  mockGetSetting.mockResolvedValue('1'); mockSetSetting.mockResolvedValue(undefined);
  mockRegister.mockResolvedValue('fcm'); mockNative.pushToken.mockResolvedValue('synthetic-token');
  mockNative.canNotify.mockReturnValue(true); mockNative.requestPermission.mockResolvedValue(undefined);
  mockNative.startWatch.mockResolvedValue(true);
  mockNative.startStandby.mockResolvedValue(true);
  mockNative.watchStatus.mockReturnValue(undefined);
  mockNative.recoveredIngress.mockReset().mockReturnValue(null);
  mockAdoptIngress.mockReset().mockResolvedValue(true);
  require('react-native').AppState.currentState = 'active';
  mockSupports = true;
  mockTarget = { hub: { url: 'https://station-a.example.test', pairToken: 'synthetic-a' }, deviceId: 'pc-a' };
  mockRemoteState = { phase: 'ready', signingIn: null, sessions: {} }; mockRemoteListeners.clear();
  mockSetFocus.mockImplementation((focus: typeof mockRemoteState.focus) => { mockRemoteState.focus = focus; });
  mockRemoteChange = undefined; mockAppChange = undefined; mockRemoteEvent = undefined;
});

test('a sticky native routing cache is captured before stop and imported only after its exact pairing restores', async () => {
  const { prefs } = modules(); await prefs.loadNotificationPreference();
  const saved = mockTarget!;
  const scope = require('../remote/notification-scope').notificationScopeFor(saved.hub, saved.deviceId);
  const manifest = { signed_payload: 'opaque-public-signed-payload', signature: 'opaque-public-signature' };
  mockNative.recoveredIngress.mockReturnValueOnce(JSON.stringify({ hubUrl: saved.hub.url, navigationScope: scope, manifest }));
  mockTarget = null; mockRemoteState.phase = 'loading';
  const stop = require('../remote/notifications').startRemoteNotifications(() => undefined);
  try {
    expect(JSON.parse(mockNative.configureWatch.mock.calls[0][0]).follow).toBe(false);
    expect(mockNative.recoveredIngress.mock.invocationCallOrder[0]).toBeLessThan(mockNative.configureWatch.mock.invocationCallOrder[0]);
    expect(mockAdoptIngress).not.toHaveBeenCalled();
    mockTarget = saved; mockRemoteState.phase = 'ready'; mockRemoteChange?.(); await flush();
    expect(mockAdoptIngress).toHaveBeenCalledWith(saved.hub.url, manifest, expect.any(Function));
    const active = mockAdoptIngress.mock.calls[0][2]; expect(active()).toBe(true);
    mockTarget = { ...saved, hub: { ...saved.hub, pairToken: 'replacement-credential' } };
    expect(active()).toBe(false);
  } finally { stop(); }
});

test('a native routing hand-back from another pairing cannot import merely because the URL matches', async () => {
  const { prefs } = modules(); await prefs.loadNotificationPreference();
  mockNative.recoveredIngress.mockReturnValue(JSON.stringify({ hubUrl: mockTarget!.hub.url, navigationScope: 'ns1_' + 'f'.repeat(64), manifest: {} }));
  const stop = require('../remote/notifications').startRemoteNotifications(() => undefined);
  try { await flush(); expect(mockAdoptIngress).not.toHaveBeenCalled(); }
  finally { stop(); }
});

const extensionAgents = [
  ['deepseek-harness', 'DeepSeek Harness'], ['hermes', 'Hermes Agent'],
] as const;

test.each(extensionAgents)('running %s keeps its name before and after the session directory arrives', async (tool, agent) => {
  const { prefs } = modules(); await prefs.loadNotificationPreference();
  const notifications = require('../remote/notifications') as typeof import('../remote/notifications');
  const stop = notifications.startRemoteNotifications(() => undefined);
  const sessionKey = `${tool}:fixture`;
  try {
    notifications.noteTaskSent('pc-a', sessionKey); await flush();
    expect(mockNative.startWatch).toHaveBeenLastCalledWith(`${agent} 正在运行`, '远程任务');
    require('react-native').AppState.currentState = 'background'; mockAppChange?.('background'); await flush();
    const handoff = JSON.parse(mockNative.configureWatch.mock.calls.at(-1)![0]);
    expect(handoff).toMatchObject({ schema: 2, follow: true, connections: [{ sessions: [{ deviceId: 'pc-a', sessionKey, agent, title: '远程任务' }] }] });
    mockRemoteState.sessions['pc-a'] = { list: [{ sessionKey, tool, client: '', title: '测试任务', cwd: '', updatedAt: Date.now(), status: 'running', controllable: true }] };
    require('react-native').AppState.currentState = 'active'; mockAppChange?.('active'); await flush();
    expect(mockNative.startWatch).toHaveBeenLastCalledWith(`${agent} 正在运行`, '测试任务');
    require('react-native').AppState.currentState = 'background'; mockAppChange?.('background'); await flush();
    expect(JSON.parse(mockNative.configureWatch.mock.calls.at(-1)![0])).toMatchObject({ follow: true, connections: [{ sessions: [{ deviceId: 'pc-a', sessionKey, agent, title: '测试任务' }] }] });
  } finally { stop(); }
});

test.each(['invalid-key', 'codex:__salcara_start_v1__', 'hermes:', 'hermes:bad\nkey'])('a temporary task with no valid Agent namespace never claims Codex or Claude: %s', async sessionKey => {
  const { prefs } = modules(); await prefs.loadNotificationPreference();
  const notifications = require('../remote/notifications') as typeof import('../remote/notifications');
  const stop = notifications.startRemoteNotifications(() => undefined);
  try {
    notifications.noteTaskSent('pc-a', sessionKey); await flush();
    expect(mockNative.startWatch).toHaveBeenLastCalledWith('Agent 正在运行', '远程任务');
  } finally { stop(); }
});

test.each(extensionAgents.flatMap(([tool, agent]) => [false, true].flatMap(known =>
  ['completed', 'failed', 'reply'].map(kind => ({ tool, agent, known, kind })),
)))('background $tool $kind notification has the correct source (directory=$known)', async ({ tool, agent, known, kind }) => {
  const { prefs } = modules(); await prefs.loadNotificationPreference();
  const sessionKey = `${tool}:fixture`;
  if (known) mockRemoteState.sessions['pc-a'] = { list: [{ sessionKey, tool, client: '', title: '测试任务', status: 'idle' }] };
  const notifications = require('../remote/notifications') as typeof import('../remote/notifications');
  const stop = notifications.startRemoteNotifications(() => undefined);
  try {
    await flush();
    require('react-native').AppState.currentState = 'background';
    const base = { deviceId: 'pc-a', sessionKey, tool, ts: Date.now(), turnId: 'fixture-turn' };
    mockRemoteEvent?.(kind === 'reply'
      ? { ...base, type: 'message', id: 'reply', role: 'assistant', final: true, text: '完成' }
      : { ...base, type: 'turn', status: kind as 'completed' | 'failed' });
    await flush();
    const suffix = kind === 'completed' ? '完成了任务' : kind === 'failed' ? '的任务没有完成' : '有新回复';
    const title = known ? '测试任务' : '远程任务';
    expect(mockNative.notify).toHaveBeenCalledTimes(1);
    expect(mockNative.notify).toHaveBeenCalledWith(expect.any(String), `${agent} ${suffix}`, kind === 'reply' ? `${title} · 点开查看` : title, expect.any(String));
    expect(JSON.parse(mockNative.notify.mock.calls[0][3])).toMatchObject({ deviceId: 'pc-a', sessionKey, notificationScope: targetScope(mockTarget!), eventTs: base.ts });
    expect(mockNative.notify.mock.calls[0][3]).not.toContain('"text"');
  } finally { stop(); }
});

const targetScope = (target: NonNullable<typeof mockTarget>) => `ns1_${require('node:crypto').createHash('sha256')
  .update(JSON.stringify([target.hub.botToken ? 'salcara-notification-bot-scope-v1' : 'salcara-notification-scope-v1', target.hub.url, target.deviceId, target.hub.botToken ?? target.hub.pairToken])).digest('hex')}`;

test('switching the visible computer keeps both saved push subscriptions and reports each target separately', async () => {
  const first = mockTarget!;
  const second = { deviceId: 'pc-b', hub: { url: 'https://b.example.test', pairToken: 'second' } };
  mockSavedTargets = [first, second].map((target, index) => ({ ...target, connectionId: `saved-${index}`, notificationScope: targetScope(target) }));
  const { push } = modules();
  mockRegister.mockImplementation(async (_hub, device) => device === 'pc-a' ? 'fcm' : 'off');
  await push.syncPush();
  expect(mockRegister).toHaveBeenCalledTimes(2);
  expect(push.pushStatus()).toBe('fcm');
  mockTarget = second; await push.syncPush();
  expect(push.pushStatus()).toBe('hub-off');
  expect(mockRegister.mock.calls.filter(call => call[2] === '')).toEqual([]);
  expect(push.pushStatusFor(targetScope(first))).toBe('fcm');
});

test('more than four active tasks are all handed off with a device-level cursor and retained identities', async () => {
  const { prefs } = modules(); await prefs.loadNotificationPreference();
  mockRemoteState.sessions['pc-a'] = { list: Array.from({ length: 7 }, (_, index) => ({ sessionKey: `hermes:${index}`, tool: 'hermes', title: `任务${index}`, status: 'running', updatedAt: Date.now() })) };
  const notifications = require('../remote/notifications') as typeof import('../remote/notifications');
  const stop = notifications.startRemoteNotifications(jest.fn());
  try {
    await flush();
    require('react-native').AppState.currentState = 'background'; mockAppChange?.('background'); await flush();
    const connection = JSON.parse(mockNative.configureWatch.mock.calls.at(-1)![0]).connections[0];
    expect(connection.sessions).toHaveLength(7);
    expect(connection).toMatchObject({ deviceMode: true, standby: false, devices: [{ deviceId: 'pc-a' }] });
  } finally { stop(); }
});

test('a terminal result retires a watch even when the running directory snapshot is stale', async () => {
  const { prefs } = modules(); await prefs.loadNotificationPreference();
  const now = Date.now();
  mockRemoteState.sessions['pc-a'] = { list: [{ sessionKey: 'hermes:a', tool: 'hermes', title: '任务', status: 'running', updatedAt: now - 100 }] };
  const notifications = require('../remote/notifications') as typeof import('../remote/notifications');
  const stop = notifications.startRemoteNotifications(jest.fn());
  try {
    await flush(); mockNative.stopWatch.mockClear();
    mockRemoteEvent?.({ type: 'turn', status: 'completed', deviceId: 'pc-a', sessionKey: 'hermes:a', tool: 'hermes', ts: now, turnId: 'done' });
    await flush(); expect(mockNative.stopWatch).toHaveBeenCalled();
    mockNative.startWatch.mockClear();
    notifications.noteTaskSent('pc-a', 'hermes:a'); await flush();
    expect(mockNative.startWatch).toHaveBeenCalled();
  } finally { stop(); }
});

test('removing one saved target gates old notifications immediately and retries its failed unregister', async () => {
  const first = mockTarget!;
  const second = { deviceId: 'pc-b', hub: { url: 'https://b.example.test', pairToken: 'second' } };
  mockSavedTargets = [first, second].map((target, index) => ({ ...target, connectionId: `saved-${index}`, notificationScope: targetScope(target) }));
  const { push } = modules(); await push.syncPush();
  mockTarget = second; mockSavedTargets = mockSavedTargets.slice(1);
  mockRegister.mockRejectedValueOnce(new Error('offline'));
  await push.syncPush();
  expect(JSON.parse(mockNative.setNotificationTargets.mock.calls.at(-1)![0])).toEqual([{ deviceId: second.deviceId, notificationScope: targetScope(second) }]);
  expect(push.pushStatus()).toBe('fcm');
  await push.syncPush();
  expect(mockRegister.mock.calls.filter(call => call[2] === '').map(call => call[1])).toEqual(['pc-a', 'pc-a']);
});

test('a cross-computer notification only selects locally, revalidates scope and opens a summary as the list', async () => {
  const second = { deviceId: 'pc-b', hub: { url: 'https://b.example.test', pairToken: 'second' } };
  mockSavedTargets = [{ ...second, connectionId: 'saved-b', notificationScope: targetScope(second) }];
  mockUseSaved.mockImplementation(async () => { mockTarget = second; });
  const notifications = require('../remote/notifications') as typeof import('../remote/notifications');
  const open = jest.fn(), stop = notifications.startRemoteNotifications(open);
  try {
    const callback = mockNative.addListener.mock.calls.find(call => call[0] === 'onOpen')![1];
    callback({ payload: JSON.stringify({ deviceId: 'pc-b', sessionKey: 'hermes:b', notificationScope: targetScope(second), notificationCount: '3' }) });
    await flush();
    expect(mockUseSaved).toHaveBeenCalledWith('saved-b', true, { skipHandover: true, stillWanted: expect.any(Function) });
    expect(mockSetFocus).toHaveBeenLastCalledWith({ home: true });
    expect(open).toHaveBeenCalledTimes(1);
  } finally { stop(); }
});

test.each(['old-station', 'old-credential', 'legacy'] as const)('notification open never resolves an unrelated source against the current connection: %s', async source => {
  jest.useFakeTimers();
  const old = mockTarget!;
  const notificationScope = targetScope(old);
  mockTarget = source === 'old-station' ? { ...old, hub: { ...old.hub, url: 'https://station-b.example.test' } }
    : source === 'old-credential' ? { ...old, hub: { ...old.hub, pairToken: 'new-pairing' } } : old;
  const notifications = require('../remote/notifications') as typeof import('../remote/notifications');
  const open = jest.fn(), stop = notifications.startRemoteNotifications(open);
  const callback = mockNative.addListener.mock.calls.find(call => call[0] === 'onOpen')![1];
  callback({ payload: JSON.stringify({ deviceId: old.deviceId, sessionKey: 'codex:shared-id', ...(source === 'legacy' ? {} : { notificationScope }) }) });
  await flush();
  expect(mockSetFocus).toHaveBeenLastCalledWith({ home: true });
  expect(mockSetFocus).not.toHaveBeenCalledWith(expect.objectContaining({ sessionKey: 'codex:shared-id' }));
  expect(open).toHaveBeenCalledTimes(1);
  stop(); jest.clearAllTimers(); jest.useRealTimers();
});

test('a current scoped notification opens its exact task after cold-start pairing restore', async () => {
  jest.useFakeTimers();
  const saved = mockTarget!;
  const notificationScope = targetScope(saved);
  mockRemoteState.phase = 'loading'; mockTarget = null;
  const notifications = require('../remote/notifications') as typeof import('../remote/notifications');
  const open = jest.fn(), stop = notifications.startRemoteNotifications(open);
  const callback = mockNative.addListener.mock.calls.find(call => call[0] === 'onOpen')![1];
  callback({ payload: JSON.stringify({ deviceId: saved.deviceId, sessionKey: 'codex:original', notificationScope }) });
  expect(mockSetFocus).not.toHaveBeenCalled();
  mockRemoteState.phase = 'ready'; mockTarget = saved; mockRemoteChange?.();
  await flush();
  expect(mockSetFocus).toHaveBeenLastCalledWith({ deviceId: saved.deviceId, sessionKey: 'codex:original' });
  expect(open).toHaveBeenCalledTimes(1);
  stop(); jest.clearAllTimers(); jest.useRealTimers();
});

test('renewed credentials invalidate a notification focus before the screen consumes it', async () => {
  jest.useFakeTimers();
  const saved = mockTarget!;
  const notifications = require('../remote/notifications') as typeof import('../remote/notifications');
  const stop = notifications.startRemoteNotifications(jest.fn());
  const callback = mockNative.addListener.mock.calls.find(call => call[0] === 'onOpen')![1];
  callback({ payload: JSON.stringify({ deviceId: saved.deviceId, sessionKey: 'codex:old-pair', notificationScope: targetScope(saved) }) });
  await flush();
  expect(mockRemoteState.focus).toEqual({ deviceId: saved.deviceId, sessionKey: 'codex:old-pair' });
  mockTarget = { ...saved, hub: { ...saved.hub, pairToken: 'synthetic-new-pairing' } };
  mockRemoteChange?.();
  expect(mockRemoteState.focus).toEqual({ home: true });
  stop(); jest.clearAllTimers(); jest.useRealTimers();
});

test('recently sent tasks from A never become background watches using B credentials', async () => {
  const { prefs } = modules(); await prefs.loadNotificationPreference();
  const notifications = require('../remote/notifications') as typeof import('../remote/notifications');
  const stop = notifications.startRemoteNotifications(() => undefined);
  notifications.noteTaskSent('pc-a', 'codex:from-a'); await flush();
  expect(mockNative.startWatch).toHaveBeenCalled();
  mockTarget = { deviceId: 'pc-a', hub: { url: 'https://station-b.example.test', pairToken: 'synthetic-b' } };
  mockRemoteChange?.(); await flush();
  mockAppChange?.('background');
  expect(JSON.parse(mockNative.configureWatch.mock.calls.at(-1)![0])).toMatchObject({ follow: false });
  stop();
});

test('stored disabled preference reaches native before any FCM registration', async () => {
  mockGetSetting.mockResolvedValue('0');
  const { prefs, push } = modules();
  await push.syncPush();
  expect(prefs.remoteNotificationsEnabled()).toBe(false);
  expect(mockNative.setNotificationsEnabled).toHaveBeenLastCalledWith(false);
  expect(mockNative.pushToken).not.toHaveBeenCalled();
  expect(mockRegister).not.toHaveBeenCalled();
});

test('a denied OS notification permission does not register a remote push token', async () => {
  mockNative.canNotify.mockReturnValue(false);
  const { push } = modules();
  await push.syncPush();
  expect(push.pushStatus()).toBe('permission');
  expect(mockNative.pushToken).not.toHaveBeenCalled();
  expect(mockRegister).not.toHaveBeenCalled();
});

test('iOS registers FCM for APNs delivery without starting an Android background watcher', async () => {
  const reactNative = require('react-native');
  reactNative.Platform.OS = 'ios';
  const { prefs, push } = modules();
  await prefs.loadNotificationPreference();
  const notifications = require('../remote/notifications') as typeof import('../remote/notifications');
  expect(notifications.notificationsSupported()).toBe(true);
  await push.syncPush();
  expect(mockRegister).toHaveBeenCalledWith(expect.objectContaining({ url: expect.any(String) }), 'pc-a', 'synthetic-token', 'ios');
  notifications.noteTaskSent('pc-a', 'codex:ios-fixture');
  await flush();
  expect(mockNative.startWatch).not.toHaveBeenCalled();
  expect(mockNative.startStandby).not.toHaveBeenCalled();
  reactNative.Platform.OS = 'android';
});

test('iOS uses APNs and gates foreground banners by binding and exact visible thread (source contract)', () => {
  const module = readFileSync(join(__dirname, '../../modules/salcara-notify/ios/SalcaraNotifyModule.swift'), 'utf8');
  const podspec = readFileSync(join(__dirname, '../../modules/salcara-notify/ios/SalcaraNotify.podspec'), 'utf8');
  expect(module).toContain('FirebaseApp.configure(options: options)');
  expect(module).toContain('Messaging.messaging().token');
  expect(module).toContain('MessagingDelegate');
  expect(module).toContain('UIApplication.shared.registerForRemoteNotifications()');
  expect(module).toContain('completionHandler([])');
  expect(module).toContain('completionHandler([.banner, .list, .sound])');
  expect(module).toContain('visibleScope == (value["notificationScope"]');
  expect(module).toContain('Function("admitNotification")');
  expect(module).toContain('userInfo["notificationCount"]');
  expect(module).toContain('userInfo["notificationScope"]');
  expect(readFileSync(join(__dirname, '../remote/notifications.ts'), 'utf8')).toContain('if (Platform.OS === \'ios\') return;');
  expect(podspec).toContain("s.dependency 'Firebase/Messaging'");
});

test('unreadable stored preference does not implicitly enable background registration', async () => {
  mockGetSetting.mockRejectedValue(new Error('synthetic unavailable storage'));
  const { prefs, push } = modules();
  await push.syncPush();
  expect(prefs.remoteNotificationsEnabled()).toBe(false);
  expect(mockNative.pushToken).not.toHaveBeenCalled();
  expect(mockRegister).not.toHaveBeenCalled();
});

test('late stored preference cannot overwrite an explicit toggle; writes remain ordered', async () => {
  const read = deferred<string>(); const write = deferred<void>();
  mockGetSetting.mockReturnValue(read.promise);
  mockSetSetting.mockImplementationOnce(() => write.promise).mockResolvedValue(undefined);
  const { prefs } = modules();
  const loading = prefs.loadNotificationPreference();
  const first = prefs.setNotificationPreference(true);
  const last = prefs.setNotificationPreference(false);
  read.resolve('1'); await loading; await flush();
  expect(prefs.remoteNotificationsEnabled()).toBe(false);
  expect(mockNative.setNotificationsEnabled.mock.calls.map(call => call[0])).toEqual([true, false]);
  expect(mockSetSetting).toHaveBeenCalledTimes(1);
  write.resolve(); await Promise.all([first, last]);
  expect(mockSetSetting.mock.calls).toEqual([['remote.notifications', '1'], ['remote.notifications', '0']]);
});

test('disabling retires the registered Hub token and does not request another', async () => {
  const { prefs, push } = modules();
  await push.syncPush();
  await prefs.setNotificationPreference(false); await push.syncPush();
  expect(mockRegister.mock.calls.map(call => call[2])).toEqual(['synthetic-token', '']);
  expect(mockNative.pushToken).toHaveBeenCalledTimes(1);
  expect(push.pushStatus()).toBe('unpaired');
});

test('disable while obtaining the token prevents late registration', async () => {
  const token = deferred<string>(); mockNative.pushToken.mockReturnValueOnce(token.promise);
  const { prefs, push } = modules();
  const pending = push.syncPush(); await flush();
  expect(mockNative.pushToken).toHaveBeenCalledTimes(1);
  await prefs.setNotificationPreference(false);
  token.resolve('late-token'); await pending; await flush();
  expect(mockRegister).not.toHaveBeenCalled();
});

test('disable while Hub registration is pending retires that exact late registration', async () => {
  const registration = deferred<string>(); mockRegister.mockReturnValueOnce(registration.promise);
  const { prefs, push } = modules();
  const pending = push.syncPush(); await flush();
  expect(mockRegister).toHaveBeenCalledTimes(1);
  await prefs.setNotificationPreference(false);
  registration.resolve('fcm'); await pending; await flush();
  expect(mockRegister.mock.calls.map(call => call[2])).toEqual(['synthetic-token', '']);
  expect(push.pushStatus()).not.toBe('fcm');
});

test('switching station while reading token cannot register on the old station', async () => {
  const token = deferred<string>(); mockNative.pushToken.mockReturnValueOnce(token.promise);
  const { push } = modules();
  const pending = push.syncPush(); await flush();
  mockTarget = { hub: { url: 'https://station-b.example.test', pairToken: 'synthetic-b' }, deviceId: 'pc-b' };
  token.resolve('late-token'); await pending; await flush();
  expect(mockRegister).toHaveBeenCalledTimes(1);
  expect(mockRegister.mock.calls[0].slice(0, 2)).toEqual([mockTarget.hub, 'pc-b']);
});

test('pair token change on the same station/device retires the old credential scope', async () => {
  const { push } = modules();
  const stop = push.startRemotePush(); await flush();
  mockRemoteChange?.(); await flush();
  mockRegister.mockClear();
  const previous = mockTarget!;
  mockTarget = { ...previous, hub: { ...previous.hub, pairToken: 'synthetic-repaired' } };
  mockRemoteChange?.(); await flush();
  expect(mockRegister.mock.calls).toEqual([
    [previous.hub, previous.deviceId, '', 'android'], [mockTarget.hub, mockTarget.deviceId, 'synthetic-token', 'android'],
  ]);
  stop();
});

test('changing Pair to Bot authentication retires the former push registration even with matching URL and token',async()=>{
  const {push}=modules();const stop=push.startRemotePush();await flush();
  mockRemoteChange?.();await flush();mockRegister.mockClear();
  const previous=mockTarget!;
  mockTarget={...previous,hub:{...previous.hub,botToken:previous.hub.pairToken}};
  mockRemoteChange?.();await flush();
  expect(mockRegister.mock.calls).toEqual([
    [previous.hub,previous.deviceId,'','android'],[mockTarget.hub,mockTarget.deviceId,'synthetic-token','android'],
  ]);
  stop();
});

test('Hub without push support settles without a retry loop', async () => {
  mockSupports = false;
  mockRegister.mockResolvedValue('off');
  const { push } = modules(); await push.syncPush(); await flush();
  expect(push.pushStatus()).toBe('hub-off');
  expect(mockNative.pushToken).toHaveBeenCalledTimes(1);
  expect(mockRegister).toHaveBeenCalledTimes(1);
});

test('slow watch start cannot re-enable native following after notifications are disabled', async () => {
  const start = deferred<boolean>(); mockNative.startWatch.mockReturnValueOnce(start.promise);
  const { prefs } = modules(); await prefs.loadNotificationPreference();
  const notifications = require('../remote/notifications') as typeof import('../remote/notifications');
  const stop = notifications.startRemoteNotifications(() => undefined);
  await flush();
  notifications.noteTaskSent('pc-a', 'codex:fixture'); await flush();
  expect(mockNative.startWatch).toHaveBeenCalled();
  await notifications.setNotificationsEnabled(false);
  start.resolve(true); await flush();
  mockAppChange?.('background');
  expect(mockNative.configureWatch.mock.calls.map(call => JSON.parse(call[0])).every(config => config.follow === false)).toBe(true);
  expect(mockNative.stopWatch).toHaveBeenCalled(); stop();
});

test.each(['task', 'standby'] as const)('a slow native %s start hands over its current connection after the app backgrounds', async mode => {
  const start = deferred<boolean>();
  const { prefs, push } = modules(); await prefs.loadNotificationPreference();
  if (mode === 'standby') { await push.setStandbyEnabled(true); mockNative.startStandby.mockReturnValueOnce(start.promise); }
  else mockNative.startWatch.mockReturnValueOnce(start.promise);
  const notifications = require('../remote/notifications') as typeof import('../remote/notifications');
  const stop = notifications.startRemoteNotifications(() => undefined); await flush();
  if (mode === 'task') { notifications.noteTaskSent('pc-a', 'codex:fixture'); await flush(); }
  expect(mode === 'task' ? mockNative.startWatch : mockNative.startStandby).toHaveBeenCalled();
  require('react-native').AppState.currentState = 'background'; mockAppChange?.('background');
  expect(JSON.parse(mockNative.configureWatch.mock.calls.at(-1)![0]).follow).toBe(false);
  start.resolve(true); await flush();
  expect(JSON.parse(mockNative.configureWatch.mock.calls.at(-1)![0])).toMatchObject({ follow: true, connections: [{
    hubUrl: mockTarget!.hub.url, pairToken: mockTarget!.hub.pairToken, navigationScope: targetScope(mockTarget!) }] });
  stop();
});

test.each(['task','standby'] as const)('Bot %s supplies only Bot authentication to its scoped native watcher', async mode => {
  const botPin = { instanceId: 'a'.repeat(32), publicKey: Buffer.alloc(32, 1).toString('base64') };
  mockTarget = { hub: { url: 'https://bot.example/salcara-hub/v1', pairToken: 'bot-secret', botToken: 'bot-secret', botPin }, deviceId: 'pc-a' };
  const { prefs,push } = modules(); await prefs.loadNotificationPreference();
  if(mode==='standby')await push.setStandbyEnabled(true);
  const notifications = require('../remote/notifications') as typeof import('../remote/notifications');
  const stop = notifications.startRemoteNotifications(() => undefined); await flush();
  notifications.noteTaskSent('pc-a', 'codex:fixture'); await flush();
  require('react-native').AppState.currentState = 'background'; mockAppChange?.('background');
  await flush();
  const configurations = mockNative.configureWatch.mock.calls.map(call => JSON.parse(call[0]));
  expect(configurations.length).toBeGreaterThan(0);
  expect(configurations.at(-1)).toMatchObject({ schema: 2, follow: true, connections: [{ botToken: 'bot-secret', botPin }] });
  expect(configurations.at(-1).connections[0]).not.toHaveProperty('pairToken');
  stop();
});

test('legacy Bot without a saved pin never hands its token to the native watcher', async () => {
  mockTarget = { hub: { url: 'https://bot.example/salcara-hub/v1', pairToken: 'old-bot-secret', botToken: 'old-bot-secret' }, deviceId: 'pc-a' };
  const original = JSON.stringify(mockTarget);
  const { prefs } = modules(); await prefs.loadNotificationPreference();
  const notifications = require('../remote/notifications') as typeof import('../remote/notifications');
  const stop = notifications.startRemoteNotifications(() => undefined);
  try {
    notifications.noteTaskSent('pc-a', 'codex:fixture'); await flush();
    require('react-native').AppState.currentState = 'background'; mockAppChange?.('background'); await flush();
    expect(mockNative.configureWatch.mock.calls.every(call => !call[0].includes('old-bot-secret'))).toBe(true);
    expect(mockNative.configureWatch.mock.calls.map(call => JSON.parse(call[0])).every(value => !value.follow)).toBe(true);
    expect(JSON.stringify(mockTarget)).toBe(original);
  } finally { stop(); }
});

test('Bot recovery hand-back never overwrites the shared URL router or its saved binding pin', async () => {
  const botPin = { instanceId: 'a'.repeat(32), publicKey: Buffer.alloc(32, 1).toString('base64') };
  mockTarget = { hub: { url: 'https://bot.example/salcara-hub/v1', pairToken: 'bot-secret', botToken: 'bot-secret', botPin }, deviceId: 'pc-a' };
  mockNative.recoveredIngress.mockReturnValue(JSON.stringify({ hubUrl: mockTarget.hub.url,
    navigationScope: targetScope(mockTarget), manifest: { signed_payload: 'native-cache', signature: 'native-signature' } }));
  const stop = require('../remote/notifications').startRemoteNotifications(() => undefined);
  try { await flush(); expect(mockAdoptIngress).not.toHaveBeenCalled(); expect(mockTarget.hub.botPin).toEqual(botPin); }
  finally { stop(); }
});

test('a late standby preference read and slow earlier write cannot revive a disabled standby service', async () => {
  const read = deferred<string>(); const write = deferred<void>();
  mockGetSetting.mockImplementation((key: string) => key === 'remote.standby' ? read.promise : Promise.resolve('1'));
  mockSetSetting.mockImplementationOnce(() => write.promise).mockResolvedValue(undefined);
  const { push } = modules(); const stop = push.startRemotePush();
  const first = push.setStandbyEnabled(true), last = push.setStandbyEnabled(false);
  read.resolve('1'); await flush();
  expect(push.standbyEnabled()).toBe(false);
  expect(mockSetSetting).toHaveBeenCalledTimes(1);
  write.resolve(); await Promise.all([first, last]);
  expect(mockSetSetting.mock.calls).toEqual([['remote.standby', '1'], ['remote.standby', '0']]);
  stop();
});

test('turning standby off while its native start is pending stops the late service', async () => {
  const start = deferred<boolean>();
  const { prefs, push } = modules(); await prefs.loadNotificationPreference(); await push.setStandbyEnabled(true);
  mockNative.startStandby.mockReturnValueOnce(start.promise);
  const notifications = require('../remote/notifications') as typeof import('../remote/notifications');
  const stop = notifications.startRemoteNotifications(() => undefined); await flush();
  expect(mockNative.startStandby).toHaveBeenCalledTimes(1);
  await push.setStandbyEnabled(false); start.resolve(true); await flush();
  expect(mockNative.stopWatch).toHaveBeenCalled();
  require('react-native').AppState.currentState = 'background'; mockAppChange?.('background');
  expect(JSON.parse(mockNative.configureWatch.mock.calls.at(-1)![0]).follow).toBe(false);
  stop();
});

test('a failed new station registration cannot retain the previous stations successful push status', async () => {
  const { push } = modules(); await push.syncPush(); expect(push.pushStatus()).toBe('fcm');
  mockTarget = { deviceId: 'pc-b', hub: { url: 'https://station-b.example.test', pairToken: 'synthetic-b' } };
  mockRegister.mockResolvedValueOnce('off').mockRejectedValueOnce(new Error('Synthetic new station unavailable'));
  await push.syncPush(); await flush();
  expect(push.pushStatus()).toBe('error');
});

test('Android notification entry points share the persisted gate and bind actions to a watch scope (source contract)', () => {
  const source = (name: string) => readFileSync(join(__dirname, '../../modules/salcara-notify/android/kotlin', name), 'utf8');
  const module = source('SalcaraNotifyModule.kt'); const push = source('SalcaraPushService.kt'); const watch = source('SalcaraWatchService.kt');
  expect(module).toContain('Function("setNotificationsEnabled")');
  expect(module).toContain('getBoolean("enabled", false)');
  expect(module).toContain('context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)');
  expect(module).toContain('manager.areNotificationsEnabled()');
  expect(module).toContain('synchronized(notificationLock)');
  expect(module).toContain('org.json.JSONObject(json)');
  expect(module).not.toContain('UUID.randomUUID()');
  const center = source('SalcaraNotificationCenter.kt');
  const identity = source('SalcaraNotificationIdentity.kt');
  expect(module).toContain('Function("setNotificationTargets")');
  expect(module).toContain('Function("admitNotification")');
  expect(center).toContain('allowed[scope]');
  expect(center).toContain('policy.decide(');
  expect(center).toContain('policy.resolve(');
  expect(center).toContain('visibleScope == scope');
  expect(watch).toContain('SalcaraNotificationCenter.submit(this');
  expect(push).toContain('SalcaraNotificationCenter.submit(this');
  expect(push).not.toContain('if (inForeground(this)) return');
  expect(push).not.toContain('manager.notify(');
  expect(push).toContain('"reply" ->');
  expect(push).not.toContain('"ask" ->');
  expect(push).toContain('"question" ->');
  expect(watch).toContain('authorized(state)');
  expect(watch).toContain('"approval.request"');
  expect(watch).not.toContain('ACTION_DECIDE');
  expect(watch).not.toContain('manager.notify(');
  expect(identity).toContain('event.optString("messagePhase") != "commentary"');
});

test('a denied Android notification permission never starts a background watcher', async () => {
  mockNative.canNotify.mockReturnValue(false);
  const { prefs } = modules(); await prefs.loadNotificationPreference();
  const notifications = require('../remote/notifications') as typeof import('../remote/notifications');
  const stop = notifications.startRemoteNotifications(() => undefined);
  notifications.noteTaskSent('pc-a', 'codex:fixture'); await flush();
  expect(mockNative.startWatch).not.toHaveBeenCalled();
  expect(mockNative.startStandby).not.toHaveBeenCalled();
  stop(); mockNative.canNotify.mockReturnValue(true);
});

test('granting notification permission starts a task watch that was waiting for permission', async () => {
  mockNative.canNotify.mockReturnValue(false);
  mockNative.requestPermission.mockImplementationOnce(async () => { mockNative.canNotify.mockReturnValue(true); });
  const { prefs } = modules(); await prefs.loadNotificationPreference();
  const notifications = require('../remote/notifications') as typeof import('../remote/notifications');
  const stop = notifications.startRemoteNotifications(() => undefined);
  notifications.noteTaskSent('pc-a', 'codex:fixture'); await flush();
  expect(mockNative.startWatch).not.toHaveBeenCalled();
  await notifications.requestNotificationPermission(true); await flush();
  expect(mockNative.startWatch).toHaveBeenCalled();
  stop(); mockNative.canNotify.mockReturnValue(true); mockNative.requestPermission.mockReset(); mockNative.requestPermission.mockResolvedValue(undefined);
});

test('revoking notification permission stops an existing background watch on resume', async () => {
  const { prefs } = modules(); await prefs.loadNotificationPreference();
  const notifications = require('../remote/notifications') as typeof import('../remote/notifications');
  const stop = notifications.startRemoteNotifications(() => undefined);
  notifications.noteTaskSent('pc-a', 'codex:fixture'); await flush();
  expect(mockNative.startWatch).toHaveBeenCalled();
  mockNative.canNotify.mockReturnValue(false);
  mockAppChange?.('active'); await flush();
  expect(mockNative.stopWatch).toHaveBeenCalled();
  stop(); mockNative.canNotify.mockReturnValue(true);
});

test('resuming after Android ended standby reconciles native state and starts a fresh service', async () => {
  const { prefs, push } = modules(); await prefs.loadNotificationPreference(); await push.setStandbyEnabled(true);
  const notifications = require('../remote/notifications') as typeof import('../remote/notifications');
  const stop = notifications.startRemoteNotifications(() => undefined); await flush();
  expect(mockNative.startStandby).toHaveBeenCalledTimes(1);
  mockNative.watchStatus.mockReturnValue({ running: false, standby: false, recoveryReady: false, expiresAt: 0, reason: 'expired' });
  mockAppChange?.('active'); await flush();
  expect(mockNative.startStandby).toHaveBeenCalledTimes(2);
  stop();
});

test('visible notification retry does not start a service from the background', async () => {
  const { prefs, push } = modules(); await prefs.loadNotificationPreference(); await push.setStandbyEnabled(true);
  const notifications = require('../remote/notifications') as typeof import('../remote/notifications');
  require('react-native').AppState.currentState = 'background';
  await notifications.retryBackgroundNotifications();
  expect(mockNative.startStandby).not.toHaveBeenCalled();
  expect(mockNative.startWatch).not.toHaveBeenCalled();
  expect(mockRegister).not.toHaveBeenCalled();
});

test('retry cannot revive standby after the saved preference was switched off', async () => {
  const { prefs, push } = modules(); await prefs.loadNotificationPreference(); await push.setStandbyEnabled(false);
  const notifications = require('../remote/notifications') as typeof import('../remote/notifications');
  mockNative.watchStatus.mockReturnValue({ running: true, standby: true, recoveryReady: true, expiresAt: Date.now() + 1000, reason: '' });
  await notifications.retryBackgroundNotifications();
  expect(mockNative.stopWatch).toHaveBeenCalled();
  expect(mockNative.startStandby).not.toHaveBeenCalled();
});

test('cold foreground JS takes ownership from a restored native service before pairing is available', async () => {
  const { prefs, push } = modules(); await prefs.loadNotificationPreference(); await push.setStandbyEnabled(true);
  mockTarget = null; mockRemoteState.phase = 'loading';
  mockNative.watchStatus.mockReturnValue({ running: true, standby: true, recoveryReady: true, expiresAt: Date.now() + 1000, reason: '' });
  const notifications = require('../remote/notifications') as typeof import('../remote/notifications');
  const stop = notifications.startRemoteNotifications(() => undefined); await flush();
  expect(JSON.parse(mockNative.configureWatch.mock.calls[0][0])).toMatchObject({ follow: false });
  expect(mockNative.stopWatch).toHaveBeenCalled();
  expect(mockNative.startStandby).not.toHaveBeenCalled();
  stop();
});
