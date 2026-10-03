import { useEffect, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';

import type { HubEvent, SessionInfo } from './client';
import { onPushChange, pushStatus, standbyEnabled } from './push';
import { getRemoteState, hubSupportsWait, onRemoteEvent, pushTarget, sessionCursor, setRemoteFocus, watchCredentials } from './store';

/**
 * Task notifications for the 编程 space.
 *
 * While a task runs, Android shows a quiet "Codex 正在运行…" notification (a
 * foreground service) so the app may keep one long-poll open in background;
 * when the turn finishes, fails or asks for approval a normal notification is
 * posted and the watch ends. Nothing runs when no task is running.
 *
 * A fully closed app is reached by push from the Hub (push.ts, Firebase) or,
 * where Firebase cannot reach the phone, by 后台待命: the same service kept
 * running quietly and following the whole computer, not just one task.
 */
type Native = {
  canNotify(): boolean;
  requestPermission(): Promise<unknown>;
  notify(id: string, title: string, body: string, payload: string): Promise<void>;
  startWatch(title: string, body: string): Promise<boolean>;
  startStandby?(): Promise<boolean>;
  stopWatch(): Promise<void>;
  wait(ms: number): Promise<void>;
  configureWatch?(json: string): void;
  consumeLaunchPayload(): string | null;
  addListener?(event: 'onOpen', listener: (event: { payload: string }) => void): { remove(): void };
};
const native = (() => { try { return requireOptionalNativeModule<Native>('SalcaraNotify'); } catch { return null; } })();

const SETTING = 'remote.notifications';
const ASKED = 'remote.notifications.asked';
type SettingsStore = { getSetting: (key: string) => Promise<string | null>; setSetting: (key: string, value: string | null) => Promise<void> };
const settings = (): SettingsStore | null => { try { return require('../storage/database') as SettingsStore; } catch { return null; } };

let enabled = true;
const listeners = new Set<(value: boolean) => void>();
export const notificationsSupported = () => Boolean(native);
export const notificationsEnabled = () => enabled && Boolean(native);

export async function setNotificationsEnabled(value: boolean): Promise<void> {
  enabled = value; listeners.forEach((listener) => listener(value));
  try { await settings()?.setSetting(SETTING, value ? '1' : '0'); } catch { /* best effort */ }
  if (value) { await requestNotificationPermission(true); void ensureStandby(); }
  else void stopWatch();
}

/** Ask once, at a meaningful moment (the first task sent), never on launch. */
export async function requestNotificationPermission(force = false): Promise<boolean> {
  if (!native || !enabled) return false;
  try {
    if (native.canNotify()) return true;
    if (!force && await settings()?.getSetting(ASKED)) return false;
    await settings()?.setSetting(ASKED, '1');
    await native.requestPermission();
    return native.canNotify();
  } catch { return false; }
}

const AGENT = (session?: Pick<SessionInfo, 'tool' | 'client'>) => !session ? 'Agent' : session.tool === 'codex' ? 'Codex' : /Claude Desktop/i.test(session.client) ? 'Claude Desktop' : 'Claude Code';
const sessionOf = (deviceId: string, sessionKey: string) => getRemoteState().sessions[deviceId]?.list.find((item) => item.sessionKey === sessionKey);

/** The thread the user is looking at right now gets no notification. */
let visibleThread: string | null = null;
export function setVisibleThread(deviceId: string | null, sessionKey: string | null) { visibleThread = deviceId && sessionKey ? `${deviceId}|${sessionKey}` : null; }

const posted = new Map<string, number>();
async function post(kind: string, event: HubEvent, title: string, body: string) {
  if (!native || !enabled) return;
  const id = `${kind}:${event.deviceId}:${event.sessionKey}:${'approvalId' in event ? event.approvalId : event.seq ?? event.ts}`;
  if (posted.has(id)) return;
  posted.set(id, Date.now());
  if (posted.size > 200) posted.delete(posted.keys().next().value as string);
  try { if (native.canNotify()) await native.notify(id, title, body, JSON.stringify({ deviceId: event.deviceId, sessionKey: event.sessionKey })); } catch { /* decorative */ }
}

function onEvent(event: HubEvent) {
  if (Date.now() - event.ts > 10 * 60_000) return;
  const foreground = AppState.currentState === 'active';
  if (foreground && visibleThread === `${event.deviceId}|${event.sessionKey}`) return;
  // In the foreground the app's own toasts and badges already say this; in
  // background on Android the native watch posts them.
  if (foreground || nativeFollowing) return;
  const session = sessionOf(event.deviceId, event.sessionKey);
  const name = session?.title?.trim() || '远程任务';
  const agent = AGENT(session);
  if (event.type === 'turn' && event.status === 'completed') void post('done', event, `${agent} 完成了任务`, name);
  else if (event.type === 'turn' && event.status === 'failed') void post('failed', event, `${agent} 的任务没有完成`, event.error ? `${name} · ${event.error}` : name);
  else if (event.type === 'approval.request') void post('ask', event, event.kind === 'question' ? `${agent} 有问题想问你` : `${agent} 需要你批准`, `${event.title} · ${name}`);
}

// ——— background watch ———
// Android: a quiet foreground service keeps a "正在运行" notification while a task
// runs. When the app goes to background, the service follows the running
// sessions natively (JS timers pause there, and the JS runtime may be gone after
// a swipe-away) and posts the finished / approval notifications itself.

type Running = { deviceId: string; session: SessionInfo };
const recentlySent = new Map<string, { deviceId: string; sessionKey: string; at: number }>();
/** A task the user just sent counts as running before the computer reports it. */
export function noteTaskSent(deviceId: string, sessionKey: string) {
  recentlySent.set(`${deviceId}|${sessionKey}`, { deviceId, sessionKey, at: Date.now() });
  void ensureWatch();
}
const runningSessions = (): Running[] => {
  const state = getRemoteState();
  const live = Object.entries(state.sessions)
    .flatMap(([deviceId, entry]) => (entry?.list ?? []).map((session) => ({ deviceId, session })))
    .filter(({ session }) => !session.parentSessionKey && (session.status === 'running' || session.status === 'waiting_approval'));
  const keys = new Set(live.map(({ deviceId, session }) => `${deviceId}|${session.sessionKey}`));
  for (const [key, sent] of recentlySent) {
    const known = state.sessions[sent.deviceId]?.list.find((item) => item.sessionKey === sent.sessionKey);
    if (Date.now() - sent.at > 5 * 60_000 || (known && known.status !== 'running' && known.status !== 'waiting_approval' && known.updatedAt > sent.at)) { recentlySent.delete(key); continue; }
    if (!keys.has(key)) live.push({ deviceId: sent.deviceId, session: known ?? { sessionKey: sent.sessionKey, tool: 'codex', client: '', title: '远程任务', cwd: '', updatedAt: sent.at, status: 'running', controllable: true } });
  }
  return live.sort((a, b) => b.session.updatedAt - a.session.updatedAt).slice(0, 4);
};

let watching = false;
let nativeFollowing = false;
let configVersion = 0;
async function stopWatch() {
  nativeFollowing = false;
  standing = false;
  if (!watching) return;
  watching = false;
  try { await native?.stopWatch(); } catch { /* ignore */ }
}

/** 后台待命 is on, wanted (no push reaches this phone) and there is a paired computer. */
const standbyWanted = () => Platform.OS === 'android' && enabled && standbyEnabled() && pushStatus() !== 'fcm' && Boolean(pushTarget()) && Boolean(native?.startStandby);
let standing = false;
async function ensureStandby() {
  if (!native?.startStandby) return;
  if (standbyWanted()) {
    // A foreground service may only be started while the app is in front.
    if (!standing && AppState.currentState === 'active') {
      try { standing = await native.startStandby(); watching = standing || watching; } catch { standing = false; }
    }
  } else if (standing) {
    await stopWatch();
    void ensureWatch();
  }
}

/** Foreground: start / refresh / stop the quiet "正在运行" notification. */
async function ensureWatch() {
  if (!native || !enabled || Platform.OS !== 'android') return;
  if (standing) return; // the standby service already follows every task
  const running = runningSessions();
  if (!running.length) { if (AppState.currentState === 'active') void stopWatch(); return; }
  const first = running[0].session;
  const title = `${AGENT(first)} 正在运行`;
  const body = running.length > 1 ? `${first.title || '远程任务'} 等 ${running.length} 个任务` : first.title || '远程任务';
  try { watching = (await native.startWatch(title, body)) || watching; } catch { /* ignore */ }
}

/** Hand the running sessions to the native watch (background) or take them back (foreground). */
function configureNative(follow: boolean) {
  if (!native?.configureWatch || Platform.OS !== 'android') return;
  const credentials = watchCredentials();
  const running = follow ? runningSessions() : [];
  const target = standing ? pushTarget() : null;
  nativeFollowing = follow && watching && Boolean(credentials) && (running.length > 0 || Boolean(target));
  try {
    native.configureWatch(JSON.stringify(nativeFollowing && credentials ? {
      version: ++configVersion, follow: true, hubUrl: credentials.url, pairToken: credentials.pairToken ?? '', key: credentials.key ?? '', wait: hubSupportsWait(),
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
  void settings()?.getSetting(SETTING).then((value) => { if (value === '0') enabled = false; }).catch(() => undefined);
  const handleOpen = (payload: string | null | undefined) => {
    if (!payload || payload === lastOpen) return;
    lastOpen = payload; setTimeout(() => { if (lastOpen === payload) lastOpen = ''; }, 5000);
    try {
      const target = JSON.parse(payload) as { deviceId?: string; sessionKey?: string };
      if (typeof target.deviceId === 'string' && typeof target.sessionKey === 'string') { setRemoteFocus({ deviceId: target.deviceId, sessionKey: target.sessionKey }); open(); }
    } catch { /* ignore foreign payloads */ }
  };
  try { handleOpen(native?.consumeLaunchPayload()); } catch { /* ignore */ }
  const openSub = native?.addListener?.('onOpen', (event) => handleOpen(event.payload));
  const eventSub = onRemoteEvent((event) => {
    onEvent(event);
    if (event.type === 'session.updated' || event.type === 'turn') void ensureWatch();
  });
  const appSub = AppState.addEventListener('change', (next) => {
    if (next === 'active') { configureNative(false); try { handleOpen(native?.consumeLaunchPayload()); } catch { /* ignore */ } void ensureStandby().then(ensureWatch); }
    else if (next === 'background') configureNative(true);
  });
  const pushSub = onPushChange(() => { void ensureStandby(); });
  void ensureStandby();
  return () => { started = false; openSub?.remove(); eventSub(); appSub.remove(); pushSub(); standing = false; void stopWatch(); };
}

/** React hook for the settings row. */
export function useNotificationsEnabled(): boolean {
  const [value, setValue] = useState(enabled);
  useEffect(() => { setValue(enabled); listeners.add(setValue); return () => { listeners.delete(setValue); }; }, []);
  return value && Boolean(native);
}
