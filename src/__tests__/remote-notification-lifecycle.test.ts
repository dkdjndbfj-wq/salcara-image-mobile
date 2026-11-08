import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const mockNative = {
  setNotificationsEnabled: jest.fn(), pushToken: jest.fn(), addListener: jest.fn((_event: string, _listener: (...args: any[]) => void) => ({ remove: jest.fn() })),
  canNotify: jest.fn(() => true), requestPermission: jest.fn(async () => undefined), stopWatch: jest.fn(async () => undefined), startWatch: jest.fn(), startStandby: jest.fn(),
  configureWatch: jest.fn(), consumeLaunchPayload: jest.fn(() => null), watchStatus: jest.fn(),
};
const mockGetSetting = jest.fn();
const mockSetSetting = jest.fn();
const mockRegister = jest.fn();
const mockSetFocus = jest.fn();
let mockRemoteState: { phase: string; signingIn: string | null; sessions: Record<string, unknown>; focus?: { deviceId: string; sessionKey: string } | { home: true } | null };
const mockRemoteListeners = new Set<() => void>();
let mockTarget: { hub: { url: string; pairToken: string; botToken?: string }; deviceId: string } | null;
let mockSupports = true;
let mockRemoteChange: (() => void) | undefined;
let mockAppChange: ((state: string) => void) | undefined;
jest.mock('expo', () => ({ requireOptionalNativeModule: () => mockNative }));
jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  AppState: { currentState: 'active', addEventListener: (_: string, callback: (state: string) => void) => {
    mockAppChange = callback; return { remove: jest.fn() };
  } },
}));
jest.mock('../storage/database', () => ({ getSetting: (...args: unknown[]) => mockGetSetting(...args), setSetting: (...args: unknown[]) => mockSetSetting(...args) }));
jest.mock('../remote/client', () => ({ registerPushToken: (...args: unknown[]) => mockRegister(...args) }));
jest.mock('../remote/store', () => ({
  pushTarget: () => mockTarget, hubSupportsPush: () => mockSupports,
  onRemoteChange: (callback: () => void) => { mockRemoteListeners.add(callback); mockRemoteChange = () => mockRemoteListeners.forEach(listener => listener()); return () => mockRemoteListeners.delete(callback); },
  getRemoteState: () => mockRemoteState, onRemoteEvent: () => jest.fn(), setRemoteFocus: (...args: unknown[]) => mockSetFocus(...args),
  sessionCursor: () => 0, hubSupportsWait: () => true, watchCredentials: () => mockTarget?.hub,
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
  mockGetSetting.mockResolvedValue('1'); mockSetSetting.mockResolvedValue(undefined);
  mockRegister.mockResolvedValue('fcm'); mockNative.pushToken.mockResolvedValue('synthetic-token');
  mockNative.canNotify.mockReturnValue(true); mockNative.requestPermission.mockResolvedValue(undefined);
  mockNative.startWatch.mockResolvedValue(true);
  mockNative.startStandby.mockResolvedValue(true);
  mockNative.watchStatus.mockReturnValue(undefined);
  require('react-native').AppState.currentState = 'active';
  mockSupports = true;
  mockTarget = { hub: { url: 'https://station-a.example.test', pairToken: 'synthetic-a' }, deviceId: 'pc-a' };
  mockRemoteState = { phase: 'ready', signingIn: null, sessions: {} }; mockRemoteListeners.clear();
  mockSetFocus.mockImplementation((focus: typeof mockRemoteState.focus) => { mockRemoteState.focus = focus; });
  mockRemoteChange = undefined; mockAppChange = undefined;
});

const targetScope = (target: NonNullable<typeof mockTarget>) => `ns1_${require('node:crypto').createHash('sha256')
  .update(JSON.stringify(['salcara-notification-scope-v1', target.hub.url, target.deviceId, target.hub.pairToken])).digest('hex')}`;

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
  expect(mockSetFocus).toHaveBeenLastCalledWith({ deviceId: saved.deviceId, sessionKey: 'codex:original' });
  expect(open).toHaveBeenCalledTimes(1);
  stop(); jest.clearAllTimers(); jest.useRealTimers();
});

test('renewed credentials invalidate a notification focus before the screen consumes it', () => {
  jest.useFakeTimers();
  const saved = mockTarget!;
  const notifications = require('../remote/notifications') as typeof import('../remote/notifications');
  const stop = notifications.startRemoteNotifications(jest.fn());
  const callback = mockNative.addListener.mock.calls.find(call => call[0] === 'onOpen')![1];
  callback({ payload: JSON.stringify({ deviceId: saved.deviceId, sessionKey: 'codex:old-pair', notificationScope: targetScope(saved) }) });
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

test('iOS notifications use FCM/APNs in background and suppress system banners in foreground (source contract)', () => {
  const module = readFileSync(join(__dirname, '../../modules/salcara-notify/ios/SalcaraNotifyModule.swift'), 'utf8');
  const podspec = readFileSync(join(__dirname, '../../modules/salcara-notify/ios/SalcaraNotify.podspec'), 'utf8');
  expect(module).toContain('FirebaseApp.configure(options: options)');
  expect(module).toContain('Messaging.messaging().token');
  expect(module).toContain('MessagingDelegate');
  expect(module).toContain('UIApplication.shared.registerForRemoteNotifications()');
  expect(module).toContain('completionHandler([])');
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
  const { push } = modules(); await push.syncPush(); await flush();
  expect(push.pushStatus()).toBe('hub-off');
  expect(mockNative.pushToken).not.toHaveBeenCalled();
  expect(mockRegister).not.toHaveBeenCalled();
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
  expect(JSON.parse(mockNative.configureWatch.mock.calls.at(-1)![0])).toMatchObject({ follow: true,
    hubUrl: mockTarget!.hub.url, pairToken: mockTarget!.hub.pairToken, navigationScope: targetScope(mockTarget!) });
  stop();
});

test.each(['task','standby'] as const)('Bot %s never starts or supplies credentials to the Pair-only native watcher', async mode => {
  mockTarget = { hub: { url: 'https://bot.example/salcara-hub/v1', pairToken: 'bot-secret', botToken: 'bot-secret' }, deviceId: 'pc-a' };
  const { prefs,push } = modules(); await prefs.loadNotificationPreference();
  if(mode==='standby')await push.setStandbyEnabled(true);
  const notifications = require('../remote/notifications') as typeof import('../remote/notifications');
  const stop = notifications.startRemoteNotifications(() => undefined); await flush();
  notifications.noteTaskSent('pc-a', 'codex:fixture'); await flush();
  require('react-native').AppState.currentState = 'background'; mockAppChange?.('background');
  const configurations = mockNative.configureWatch.mock.calls.map(call => JSON.parse(call[0]));
  expect(configurations.length).toBeGreaterThan(0);
  expect(configurations.every(config => config.follow === false && !config.pairToken && !config.botToken)).toBe(true);
  expect(mockNative.startWatch).not.toHaveBeenCalled();expect(mockNative.startStandby).not.toHaveBeenCalled();
  stop();
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
  expect(watch).toContain('current.optString("navigationScope")');
  expect(watch).toContain('if (SalcaraPushService.inForeground(this)) return');
  expect(push).toContain('if (!SalcaraNotifyModule.notificationsAllowed(this)) return');
  expect(push).toContain('if (inForeground(this)) return');
  expect(push).toContain('SalcaraNotifyModule.postTaskNotification(this');
  expect(push).not.toContain('manager.notify(');
  expect(push).toContain('"reply" ->');
  expect(push).not.toContain('"ask" ->');
  expect(push).not.toContain('"question" ->');
  expect(watch.match(/config !== current \|\| !SalcaraNotifyModule.notificationsAllowed\(this\)/g)?.length).toBeGreaterThanOrEqual(3);
  expect(watch).toContain('"message" -> if (event.optString("role") == "assistant"');
  expect(watch).not.toContain('"approval.request" ->');
  expect(watch).not.toContain('ACTION_DECIDE');
  expect(watch).not.toContain('manager.notify(');
  expect(watch).toContain('event.optString("messagePhase") != "commentary"');
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
