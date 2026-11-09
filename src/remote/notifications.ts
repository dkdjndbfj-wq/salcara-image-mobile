import { useEffect, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';

import { hubIngressSnapshot, type HubEvent, type SessionInfo } from './client';
import { onPushChange, pushStatus, standbyEnabled, syncPush } from './push';
import { getRemoteState, hubSupportsWait, onRemoteChange, onRemoteEvent, pushTarget, sessionCursor, setRemoteFocus, watchCredentials } from './store';
import { loadNotificationPreference, onNotificationPreferenceChange, remoteNotificationsEnabled, setNotificationPreference } from './notification-preferences';
import { notificationScopeFor, validNotificationScope } from './notification-scope';
import { taskNoticeKind } from './notification-policy';

/**
 * Task notifications for the 编程 space.
 *
 * While a task runs, Android shows a quiet "Codex 正在运行…" notification (a
 * foreground service) so the app may keep one long-poll open in background;
 * when the turn finishes, fails or returns a final reply a normal notification is
 * posted and the watch ends. Nothing runs when no task is running.
 *
 * A fully closed app is reached by push from the Hub (push.ts, Firebase) or,
 * where Firebase cannot reach the phone, by 后台待命: the same service kept
 * running quietly and following the whole computer, not just one task.
 */
type Native = {
  pushToken?(): Promise<string | null>;
  canNotify(): boolean;
  requestPermission(): Promise<unknown>;
  notify(id: string, title: string, body: string, payload: string): Promise<void>;
  startWatch(title: string, body: string): Promise<boolean>;
  startStandby?(): Promise<boolean>;
  stopWatch(): Promise<void>;
  watchStatus?(): BackgroundWatchStatus;
  wait(ms: number): Promise<void>;
  configureWatch?(json: string): void;
  consumeLaunchPayload(): string | null;
  addListener?(event: 'onOpen' | 'onPermissionChange', listener: (event: { payload?: string; allowed?: boolean }) => void): { remove(): void };
};
export type BackgroundWatchStatus = { running: boolean; standby: boolean; recoveryReady: boolean; expiresAt: number; reason: string };
const native = (() => { try { return requireOptionalNativeModule<Native>('SalcaraNotify'); } catch { return null; } })();

const ASKED = 'remote.notifications.asked';
type SettingsStore = { getSetting: (key: string) => Promise<string | null>; setSetting: (key: string, value: string | null) => Promise<void> };
const settings = (): SettingsStore | null => { try { return require('../storage/database') as SettingsStore; } catch { return null; } };

// Android uses FCM or its foreground-service watcher. iOS uses an APNs alert
// delivered through FCM; neither platform polls in the background indefinitely.
export const notificationsSupported = () => (Platform.OS === 'android' || Platform.OS === 'ios') && Boolean(native?.pushToken);
const notificationPermissionGranted = () => { try { return Boolean(native?.canNotify()); } catch { return false; } };
const notificationStateListeners = new Set<() => void>();
const emitNotificationState = () => notificationStateListeners.forEach(listener => listener());
// The settings switch reflects the user's saved preference. OS permission is a
// separate gate; conflating them made a denied permission impossible to turn
// off because the switch kept snapping back to disabled.
export const notificationsEnabled = () => notificationsSupported() && remoteNotificationsEnabled();

export async function setNotificationsEnabled(value: boolean): Promise<void> {
  if (!notificationsSupported()) return;
  const saved = setNotificationPreference(value);
  if (!value) { configureNative(false); void stopWatch(); }
  await saved;
  if (value && remoteNotificationsEnabled()) { await requestNotificationPermission(true); void ensureStandby(); }
}

/** Ask once, at a meaningful moment (the first task sent), never on launch. */
export async function requestNotificationPermission(force = false): Promise<boolean> {
  if (!notificationsSupported() || !native || !remoteNotificationsEnabled()) return false;
  try {
    if (native.canNotify()) return true;
    if (!force && await settings()?.getSetting(ASKED)) return false;
    await settings()?.setSetting(ASKED, '1');
    await native.requestPermission();
    const granted = native.canNotify();
    emitNotificationState();
    if (granted) void syncPush();
    if (granted) void ensureStandby().then(ensureWatch);
    return granted;
  } catch { return false; }
}

const AGENT = (session?: Pick<SessionInfo, 'tool' | 'client'>) => !session ? 'Agent' : session.tool === 'codex' ? 'Codex' : /Claude Desktop/i.test(session.client) ? 'Claude Desktop' : 'Claude Code';
const sessionOf = (deviceId: string, sessionKey: string) => getRemoteState().sessions[deviceId]?.list.find((item) => item.sessionKey === sessionKey);
const currentNotificationScope = () => { const target = pushTarget(); return target ? notificationScopeFor(target.hub, target.deviceId) : null; };

/** The thread the user is looking at right now gets no notification. */
let visibleThread: string | null = null;
export function setVisibleThread(deviceId: string | null, sessionKey: string | null) { visibleThread = deviceId && sessionKey ? `${deviceId}|${sessionKey}` : null; }
export function isVisibleThread(deviceId: string, sessionKey: string): boolean { return visibleThread === `${deviceId}|${sessionKey}`; }

const posted = new Map<string, number>();
const repliedTurns = new Set<string>();
async function post(kind: string, event: HubEvent, title: string, body: string) {
  if (!native || !remoteNotificationsEnabled()) return;
  const notificationScope = currentNotificationScope();
  const taskRef = event.turnId || ('approvalId' in event ? event.approvalId : undefined) || String(event.seq ?? event.ts);
  const id = `${notificationScope ?? 'legacy'}:task:${event.deviceId}:${event.sessionKey}:${taskRef}`;
  if (posted.has(id)) return;
  posted.set(id, Date.now());
  if (posted.size > 200) posted.delete(posted.keys().next().value as string);
  try { if (native.canNotify()) await native.notify(id, title, body, JSON.stringify({ deviceId: event.deviceId, sessionKey: event.sessionKey, ...(notificationScope ? { notificationScope } : {}) })); } catch { /* decorative */ }
}

function onEvent(event: HubEvent) {
  if (!notificationsSupported()) return;
  if (Date.now() - event.ts > 10 * 60_000) return;
  const foreground = AppState.currentState === 'active';
  if (foreground && visibleThread === `${event.deviceId}|${event.sessionKey}`) return;
  // In the foreground the app's own toasts and badges already say this; in
  // background on Android the native watch posts them.
  if (foreground || nativeFollowing) return;
  // iOS suspends JS in background; APNs owns reliable background delivery.
  // Avoid racing a local alert against the APNs alert for the same event.
  if (Platform.OS === 'ios') return;
  const session = sessionOf(event.deviceId, event.sessionKey);
  const name = session?.title?.trim() || '远程任务';
  const agent = AGENT(session);
  const turnKey = event.turnId ? `${event.deviceId}|${event.sessionKey}|${event.turnId}` : null;
  switch (taskNoticeKind(event)) {
    case 'completed':
      if (!turnKey || !repliedTurns.has(turnKey)) void post('done', event, `${agent} 完成了任务`, name);
      if (turnKey) repliedTurns.delete(turnKey);
      break;
    case 'failed': void post('failed', event, `${agent} 的任务没有完成`, name); break;
    case 'reply':
      if (turnKey) { repliedTurns.add(turnKey); if (repliedTurns.size > 200) repliedTurns.delete(repliedTurns.values().next().value as string); }
      void post('reply', event, `${agent} 有新回复`, `${name} · 点开查看`);
      break;
    default: break;
  }
}

// ——— background watch ———
// Android: a quiet foreground service keeps a "正在运行" notification while a task
// runs. When the app goes to background, the service follows the running
// sessions natively (JS timers pause there, and the JS runtime may be gone after
// a swipe-away) and posts completion, failure, or final-reply notifications.

type Running = { deviceId: string; session: SessionInfo };
const recentlySent = new Map<string, { deviceId: string; sessionKey: string; at: number; scope: string }>();
/** A task the user just sent counts as running before the computer reports it. */
export function noteTaskSent(deviceId: string, sessionKey: string) {
  if (!native || !remoteNotificationsEnabled() || Platform.OS !== 'android') return;
  const target = pushTarget(), scope = currentNotificationScope();
  if (!scope || target?.deviceId !== deviceId) return;
  recentlySent.set(`${deviceId}|${sessionKey}`, { deviceId, sessionKey, at: Date.now(), scope });
  void ensureWatch();
}
const runningSessions = (): Running[] => {
  const state = getRemoteState();
  const target = pushTarget(), scope = currentNotificationScope();
  if (!target || !scope) { recentlySent.clear(); return []; }
  const live = Object.entries(state.sessions)
    .flatMap(([deviceId, entry]) => (entry?.list ?? []).map((session) => ({ deviceId, session })))
    .filter(({ deviceId, session }) => deviceId === target.deviceId && !session.parentSessionKey && (session.status === 'running' || session.status === 'waiting_approval'));
  const keys = new Set(live.map(({ deviceId, session }) => `${deviceId}|${session.sessionKey}`));
  for (const [key, sent] of recentlySent) {
    if (sent.scope !== scope || sent.deviceId !== target.deviceId) { recentlySent.delete(key); continue; }
    const known = state.sessions[sent.deviceId]?.list.find((item) => item.sessionKey === sent.sessionKey);
    if (Date.now() - sent.at > 5 * 60_000 || (known && known.status !== 'running' && known.status !== 'waiting_approval' && known.updatedAt > sent.at)) { recentlySent.delete(key); continue; }
    if (!keys.has(key)) live.push({ deviceId: sent.deviceId, session: known ?? { sessionKey: sent.sessionKey, tool: 'codex', client: '', title: '远程任务', cwd: '', updatedAt: sent.at, status: 'running', controllable: true } });
  }
  return live.sort((a, b) => b.session.updatedAt - a.session.updatedAt).slice(0, 4);
};

let watching = false;
let nativeFollowing = false;
let configVersion = 0;
let watchGeneration = 0;
async function stopWatch() {
  watchGeneration++;
  nativeFollowing = false;
  standing = false;
  watching = false;
  try { await native?.stopWatch(); } catch { /* ignore */ }
}

/** 后台待命 is on, wanted (no push reaches this phone) and there is a paired computer. */
const nativeWatchSupported = () => !watchCredentials()?.botToken;
const standbyWanted = () => Platform.OS === 'android' && nativeWatchSupported() && remoteNotificationsEnabled() && notificationPermissionGranted() && standbyEnabled() && pushStatus() !== 'fcm' && Boolean(pushTarget()) && Boolean(native?.startStandby);
const appIsBackgrounded = () => AppState.currentState === 'background';
let standing = false;
function reconcileNativeWatch() {
  try {
    const status = native?.watchStatus?.();
    if (status) { watching = status.running; standing = status.running && status.standby; }
  } catch { /* Older native versions keep the existing JS lifecycle. */ }
}

/** A visible retry only; never silently starts a service while Android has us in background. */
export async function retryBackgroundNotifications(): Promise<void> {
  if (AppState.currentState !== 'active') return;
  reconcileNativeWatch();
  await syncPush();
  await ensureStandby();
  await ensureWatch();
  emitNotificationState();
}

async function ensureStandby() {
  if (!native?.startStandby) return;
  if (standbyWanted()) {
    // A foreground service may only be started while the app is in front.
    if (!standing && AppState.currentState === 'active') {
      const generation = watchGeneration;
      try {
        const started = await native.startStandby();
        if (generation !== watchGeneration) return;
        if (!standbyWanted()) {
          // Turning standby off before Android resolves its start must also
          // stop the physical service, even though standing is still false.
          if (started) { await stopWatch(); void ensureWatch(); }
          return;
        }
        standing = started; watching = standing || watching;
        if (watching && appIsBackgrounded()) configureNative(true);
      } catch { if (generation === watchGeneration) standing = false; }
    }
  } else if (standing) {
    await stopWatch();
    void ensureWatch();
  }
}

/** Foreground: start / refresh / stop the quiet "正在运行" notification. */
async function ensureWatch() {
  if (!native || !remoteNotificationsEnabled() || Platform.OS !== 'android') return;
  if (!nativeWatchSupported()) { if (watching || standing) await stopWatch(); return; }
  if (!notificationPermissionGranted()) { if (watching || standing) await stopWatch(); return; }
  if (standing) return; // the standby service already follows every task
  const running = runningSessions();
  if (!running.length) { if (AppState.currentState === 'active') void stopWatch(); return; }
  const first = running[0].session;
  const title = `${AGENT(first)} 正在运行`;
  const body = running.length > 1 ? `${first.title || '远程任务'} 等 ${running.length} 个任务` : first.title || '远程任务';
  const generation = watchGeneration;
  try {
    const started = await native.startWatch(title, body);
    if (generation === watchGeneration && remoteNotificationsEnabled()) {
      watching = started || watching;
      // The one background event may arrive before Android finishes starting.
      // Transfer ownership now instead of leaving a running but idle service.
      if (watching && appIsBackgrounded() && !nativeFollowing) configureNative(true);
    }
  } catch { /* ignore */ }
}

/** Hand the running sessions to the native watch (background) or take them back (foreground). */
function configureNative(follow: boolean) {
  if (!native?.configureWatch || Platform.OS !== 'android') return;
  const credentials = watchCredentials();
  const navigationScope = currentNotificationScope();
  const running = follow ? runningSessions() : [];
  const target = standing ? pushTarget() : null;
  // The installed native watcher currently authenticates only Pair credentials.
  // Never hand a Bot group secret to that Pair header; foreground requests retain botToken.
  nativeFollowing = remoteNotificationsEnabled() && follow && watching && Boolean(credentials) && !credentials?.botToken && Boolean(navigationScope) && (running.length > 0 || Boolean(target));
  try {
    native.configureWatch(JSON.stringify(nativeFollowing && credentials ? {
      version: ++configVersion, follow: true, hubUrl: credentials.url, pairToken: credentials.pairToken ?? '', wait: hubSupportsWait(),
      navigationScope,
      ingressManifest: hubIngressSnapshot?.(credentials.url),
      // 后台待命: follow the whole computer (Hub scope=device), not only the running tasks.
      ...(target ? { standby: true, devices: [{ deviceId: target.deviceId }] } : {}),
      sessions: running.map(({ deviceId, session }) => ({ deviceId, sessionKey: session.sessionKey, title: session.title?.trim() || '远程任务', agent: AGENT(session), after: sessionCursor(deviceId, session.sessionKey) })),
    } : { version: ++configVersion, follow: false }));
  } catch { nativeFollowing = false; }
}

let started = false;
let lastOpen = '';
/** Call once from the app root. `open` switches to the 编程 space. */
export function startRemoteNotifications(open: () => void): () => void {
  if (started) return () => undefined;
  started = true;
  const preferenceSub = onNotificationPreferenceChange(() => {
    if (!remoteNotificationsEnabled()) { configureNative(false); void stopWatch(); }
    else void ensureStandby().then(ensureWatch);
  });
  void loadNotificationPreference();
  let pendingOpen: { deviceId: string; sessionKey: string; notificationScope?: unknown } | null = null;
  const openPending = () => {
    if (!pendingOpen || getRemoteState().phase === 'loading' || getRemoteState().signingIn) return;
    const requested = pendingOpen; pendingOpen = null;
    const target = pushTarget();
    // A legacy or stale notification is a navigation hint only. In particular,
    // identical device/thread IDs on another Hub do not prove the same task.
    if (target && requested.deviceId === target.deviceId && validNotificationScope(requested.notificationScope)
      && requested.notificationScope === notificationScopeFor(target.hub, target.deviceId)) {
      setRemoteFocus({ deviceId: requested.deviceId, sessionKey: requested.sessionKey });
    } else setRemoteFocus({ home: true });
    open();
  };
  const handleOpen = (payload: string | null | undefined) => {
    if (!payload || payload === lastOpen) return;
    if (payload.length > 4096) return;
    lastOpen = payload; setTimeout(() => { if (lastOpen === payload) lastOpen = ''; }, 5000);
    try {
      const target = JSON.parse(payload) as { deviceId?: unknown; sessionKey?: unknown; notificationScope?: unknown };
      if (typeof target?.deviceId === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(target.deviceId)
        && typeof target.sessionKey === 'string' && target.sessionKey.length > 0 && target.sessionKey.length <= 512 && !/[|\p{Cc}\p{Cf}]/u.test(target.sessionKey)) {
        pendingOpen = { deviceId: target.deviceId, sessionKey: target.sessionKey, notificationScope: target.notificationScope }; openPending();
      }
    } catch { /* ignore foreign payloads */ }
  };
  try { handleOpen(native?.consumeLaunchPayload()); } catch { /* ignore */ }
  const openSub = native?.addListener?.('onOpen', (event) => handleOpen(event.payload));
  const eventSub = onRemoteEvent((event) => {
    onEvent(event);
    if (event.type === 'session.updated' || event.type === 'turn') void ensureWatch();
  });
  const appSub = AppState.addEventListener('change', (next) => {
    if (next === 'active') { reconcileNativeWatch(); emitNotificationState(); configureNative(false); try { handleOpen(native?.consumeLaunchPayload()); } catch { /* ignore */ } void ensureStandby().then(ensureWatch); }
    else if (next === 'background') configureNative(true);
  });
  const pushSub = onPushChange(() => { void ensureStandby(); });
  let observedScope = currentNotificationScope();
  const connectionSub = onRemoteChange(() => {
    const next = currentNotificationScope();
    if (next !== observedScope) {
      observedScope = next; recentlySent.clear(); posted.clear(); repliedTurns.clear(); visibleThread = null;
      // Re-pairing may replace credentials without resetting the connection.
      // Retire a queued navigation before the screen consumes it in an effect.
      if (getRemoteState().focus) setRemoteFocus({ home: true });
      configureNative(false);
      void stopWatch().then(() => ensureStandby()).then(() => ensureWatch());
    }
    openPending();
  });
  // A sticky Android service can predate this JS runtime. Foreground launch
  // must retire its old handoff before asynchronous pairing restoration runs.
  reconcileNativeWatch();
  configureNative(false);
  void ensureStandby().then(ensureWatch);
  return () => { started = false; pendingOpen = null; preferenceSub(); openSub?.remove(); eventSub(); appSub.remove(); pushSub(); connectionSub(); standing = false; void stopWatch(); };
}

/** Native truth while the notification menu is visible; a saved switch is not a running service. */
export function useBackgroundWatchStatus(visible: boolean): BackgroundWatchStatus | null {
  const [value, setValue] = useState<BackgroundWatchStatus | null>(null);
  useEffect(() => {
    if (!visible || Platform.OS !== 'android' || !native?.watchStatus) return;
    const update = () => {
      if (AppState.currentState !== 'active') return;
      try {
        const next = native.watchStatus?.() ?? null;
        setValue(previous => previous && next && previous.running === next.running && previous.standby === next.standby
          && previous.recoveryReady === next.recoveryReady && previous.expiresAt === next.expiresAt && previous.reason === next.reason ? previous : next);
      } catch { setValue(null); }
    };
    update();
    const timer = setInterval(update, 2000);
    notificationStateListeners.add(update);
    const pushSub = onPushChange(update);
    const appSub = AppState.addEventListener('change', next => { if (next === 'active') update(); });
    return () => { clearInterval(timer); notificationStateListeners.delete(update); pushSub(); appSub.remove(); };
  }, [visible]);
  return value;
}

/** React hook for the settings row. */
export function useNotificationsEnabled(): boolean {
  const [value, setValue] = useState(notificationsEnabled);
  useEffect(() => {
    const update = () => setValue(notificationsEnabled());
    update();
    notificationStateListeners.add(update);
    const preferenceSub = onNotificationPreferenceChange(update);
    const permissionSub = native?.addListener?.('onPermissionChange', update);
    const appSub = AppState.addEventListener('change', next => { if (next === 'active') update(); });
    return () => { notificationStateListeners.delete(update); preferenceSub(); permissionSub?.remove(); appSub.remove(); };
  }, []);
  return value;
}

/** OS authorization is a separate live setting; it must not flip the user's switch. */
export function useNotificationPermissionGranted(): boolean {
  const [value, setValue] = useState(notificationPermissionGranted);
  useEffect(() => {
    const update = () => setValue(notificationPermissionGranted());
    update();
    notificationStateListeners.add(update);
    const permissionSub = native?.addListener?.('onPermissionChange', update);
    const appSub = AppState.addEventListener('change', next => { if (next === 'active') update(); });
    return () => { notificationStateListeners.delete(update); permissionSub?.remove(); appSub.remove(); };
  }, []);
  return value;
}
