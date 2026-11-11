import { useEffect, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';

import { adoptRecoveredHubIngress, hubIngressSnapshot, type HubEvent, type SessionInfo } from './client';
import { onPushChange, standbyEnabled, syncPush } from './push';
import { getRemoteState, hubSupportsWait, onRemoteChange, onRemoteEvent, pushTarget, sessionCursor, setRemoteFocus, useSavedConnection, watchCredentials } from './store';
import { loadNotificationPreference, onNotificationPreferenceChange, remoteNotificationsEnabled, setNotificationPreference } from './notification-preferences';
import { notificationScopeFor, validNotificationScope } from './notification-scope';
import { createTaskNotificationPolicy } from './notification-policy';
import { notificationTargets, publishNotificationTargets, currentNoticeTarget, type NoticeTarget } from './notification-targets';
import { onConnectionBindingsChange, resolveNotificationTarget } from './connections';
import { sessionAgentDisplayName } from './agent-catalog';
import { sessionKeyAgentId } from './projection';

/**
 * Task notifications for the 编程 space.
 *
 * While a task runs, Android shows a quiet "Codex 正在运行…" notification (a
 * foreground service) so the app may keep one long-poll open in background;
 * actionable requests and results share the same durable notification ledger.
 * Terminal events drain their trailing pages before the task watch ends.
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
  admitNotification?(id: string, payload: string): boolean;
  setVisibleNotificationTarget?(scope: string | null, sessionKey: string | null): void;
  startWatch(title: string, body: string): Promise<boolean>;
  startStandby?(): Promise<boolean>;
  stopWatch(): Promise<void>;
  watchStatus?(): BackgroundWatchStatus;
  wait(ms: number): Promise<void>;
  configureWatch?(json: string): void;
  recoveredIngress?(): string | null;
  consumeLaunchPayload(): string | null;
  addListener?(event: 'onOpen' | 'onPermissionChange', listener: (event: { payload?: string; allowed?: boolean }) => void): { remove(): void };
};
export type BackgroundWatchStatus = { running: boolean; standby: boolean; recoveryReady: boolean; expiresAt: number; reason: string;
  notificationStorageReady?: boolean; unavailableConnections?: number; connections?: Array<{ notificationScope: string; running: boolean; reason: string }> };
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

const sessionOf = (deviceId: string, sessionKey: string) => getRemoteState().sessions[deviceId]?.list.find((item) => item.sessionKey === sessionKey);
const currentNotificationScope = () => { const target = pushTarget(); return target ? notificationScopeFor(target.hub, target.deviceId) : null; };

/** The thread the user is looking at right now gets no notification. */
let visibleThread: string | null = null;
export function setVisibleThread(deviceId: string | null, sessionKey: string | null) {
  visibleThread = deviceId && sessionKey ? `${deviceId}|${sessionKey}` : null;
  try { native?.setVisibleNotificationTarget?.(visibleThread ? currentNotificationScope() : null, visibleThread ? sessionKey : null); } catch { /* Older builds. */ }
}
export function isVisibleThread(deviceId: string, sessionKey: string): boolean { return visibleThread === `${deviceId}|${sessionKey}`; }

const backgroundPolicy = createTaskNotificationPolicy();
/** The native identity reducer needs only event metadata, never task contents. */
function eventMetadata(event: HubEvent) {
  const allowed = ['type', 'status', 'role', 'final', 'messagePhase', 'parentId', 'id', 'seq', 'ts', 'turnId', 'approvalId', 'kind', 'expiresAt'];
  return Object.fromEntries(Object.entries(event).filter(([key]) => allowed.includes(key)));
}
export function admitForegroundNotification(id: string, event: HubEvent, kind: string): boolean {
  if (!native?.admitNotification) return true;
  const notificationScope = currentNotificationScope();
  if (!notificationScope) return false;
  const marker = id.indexOf(':approval:') >= 0 ? id.indexOf(':approval:') : id.indexOf(':task:');
  const nativeId = marker >= 0 ? `${notificationScope}${id.slice(marker)}` : id;
  try { return native.admitNotification(nativeId, JSON.stringify({ deviceId: event.deviceId, sessionKey: event.sessionKey,
    notificationScope, kind, eventTs: event.ts, ...('expiresAt' in event ? { expiresAt: event.expiresAt } : {}),
    ...('approvalId' in event ? { approvalId: event.approvalId } : {}), event: eventMetadata(event) })); } catch { return false; }
}
function onEvent(event: HubEvent) {
  if (!notificationsSupported() || !native || !remoteNotificationsEnabled()) return;
  const scope = currentNotificationScope();
  if (!scope) return;
  if (event.type === 'turn' && !event.parentId) {
    const key = `${scope}|${event.deviceId}|${event.sessionKey}`;
    if (event.status === 'started' && event.ts >= (finishedTasks.get(key) ?? 0)) finishedTasks.delete(key);
    else if (['completed', 'failed', 'interrupted'].includes(event.status) && (recentlySent.get(key)?.at ?? 0) <= event.ts) {
      finishedTasks.set(key, Math.max(event.ts, finishedTasks.get(key) ?? 0)); recentlySent.delete(key);
      const running = runningByScope.get(scope);
      if (running) {
        running.tasks = running.tasks.filter(item => item.deviceId !== event.deviceId || item.session.sessionKey !== event.sessionKey || item.session.updatedAt > event.ts);
        if (!running.tasks.length) runningByScope.delete(scope);
      }
    }
    if (finishedTasks.size > 1000) finishedTasks.delete(finishedTasks.keys().next().value!);
  }
  const decision = backgroundPolicy.observe(event, scope);
  if (event.type === 'approval.resolved' || event.type === 'turn' && event.status === 'started') {
    admitForegroundNotification(`${scope}:approval:${event.deviceId}:${event.sessionKey}:${'approvalId' in event ? event.approvalId : ''}`, event,
      event.type === 'approval.resolved' ? 'resolved' : 'started');
  }
  const foreground = AppState.currentState === 'active';
  if (foreground && decision && isVisibleThread(event.deviceId, event.sessionKey)) admitForegroundNotification(decision.id, event, decision.kind);
  // In the foreground the app's own toasts and badges already say this; in
  // background on Android the native watch posts them.
  let nativeOwnsScope = nativeFollowing;
  try {
    const status = native?.watchStatus?.();
    if (status) nativeOwnsScope = nativeFollowing && status.running
      && (!status.connections || status.connections.some(connection => connection.notificationScope === scope && connection.running));
  } catch { nativeOwnsScope = false; }
  if (foreground || nativeOwnsScope) return;
  // iOS suspends JS in background; APNs owns reliable background delivery.
  // Avoid racing a local alert against the APNs alert for the same event.
  if (Platform.OS === 'ios') return;
  if (!decision && event.type !== 'approval.resolved' && !(event.type === 'turn' && event.status === 'started')) return;
  const session = sessionOf(event.deviceId, event.sessionKey);
  const name = session?.title?.trim() || '远程任务';
  const agent = sessionAgentDisplayName(session, event.tool);
  const kind = decision?.kind ?? (event.type === 'approval.resolved' ? 'resolved' : 'started');
  const suffix = { completed: '完成了任务', failed: '的任务没有完成', reply: '有新回复', approval: '需要批准', question: '需要你回答', resolved: '', started: '' }[kind];
  const id = decision?.id ?? `${scope}:approval:${event.deviceId}:${event.sessionKey}:${'approvalId' in event ? event.approvalId : ''}`;
  void (async () => {
    try {
      const targets = await notificationTargets();
      if (!remoteNotificationsEnabled() || currentNotificationScope() !== scope || !targets.some(target => target.notificationScope === scope)) return;
      publishNotificationTargets(targets);
      if (native.canNotify()) await native.notify(id, `${agent} ${suffix}`, kind === 'reply' ? `${name} · 点开查看` : name,
        JSON.stringify({ deviceId: event.deviceId, sessionKey: event.sessionKey, notificationScope: scope, kind, eventTs: event.ts,
          ...('approvalId' in event ? { approvalId: event.approvalId } : {}), ...('expiresAt' in event ? { expiresAt: event.expiresAt } : {}), event: eventMetadata(event) }));
    } catch { /* OS permission/network state is surfaced separately. */ }
  })();
}

// ——— background watch ———
// Android: a quiet foreground service keeps a "正在运行" notification while a task
// runs. When the app goes to background, the service follows the running
// sessions natively (JS timers pause there, and the JS runtime may be gone after
// a swipe-away) and posts requests, failures, and batched ordinary results.

type Running = { deviceId: string; session: Pick<SessionInfo, 'sessionKey' | 'title' | 'updatedAt'> & Partial<Pick<SessionInfo, 'tool' | 'client'>> };
const recentlySent = new Map<string, { deviceId: string; sessionKey: string; at: number; scope: string }>();
const finishedTasks = new Map<string, number>();
const runningByScope = new Map<string, { tasks: Running[]; at: number }>();
let knownTargets: NoticeTarget[] = [];
/** A task the user just sent counts as running before the computer reports it. */
export function noteTaskSent(deviceId: string, sessionKey: string) {
  if (!native || !remoteNotificationsEnabled() || Platform.OS !== 'android') return;
  const target = pushTarget(), scope = currentNotificationScope();
  if (!scope || target?.deviceId !== deviceId) return;
  finishedTasks.delete(`${scope}|${deviceId}|${sessionKey}`);
  recentlySent.set(`${scope}|${deviceId}|${sessionKey}`, { deviceId, sessionKey, at: Date.now(), scope });
  void ensureWatch();
}
const runningSessions = (): Running[] => {
  const state = getRemoteState();
  const target = pushTarget(), scope = currentNotificationScope();
  if (!target || !scope) return [];
  const live: Running[] = Object.entries(state.sessions)
    .flatMap(([deviceId, entry]) => (entry?.list ?? []).map((session) => ({ deviceId, session })))
    .filter(({ deviceId, session }) => deviceId === target.deviceId && !session.parentSessionKey && (session.status === 'running' || session.status === 'waiting_approval')
      && (finishedTasks.get(`${scope}|${deviceId}|${session.sessionKey}`) ?? -1) < session.updatedAt);
  const keys = new Set(live.map(({ deviceId, session }) => `${deviceId}|${session.sessionKey}`));
  for (const [key, sent] of recentlySent) {
    if (sent.scope !== scope || sent.deviceId !== target.deviceId) continue;
    const known = state.sessions[sent.deviceId]?.list.find((item) => item.sessionKey === sent.sessionKey);
    if (Date.now() - sent.at > 5 * 60_000 || (known && known.status !== 'running' && known.status !== 'waiting_approval' && known.updatedAt > sent.at)) { recentlySent.delete(key); continue; }
    if (!keys.has(`${sent.deviceId}|${sent.sessionKey}`)) live.push({ deviceId: sent.deviceId, session: known ?? { sessionKey: sent.sessionKey, tool: sessionKeyAgentId(sent.sessionKey), title: '远程任务', updatedAt: sent.at } });
  }
  // A status snapshot can precede its final event. Keep a short drain window.
  const old = runningByScope.get(scope);
  if (live.length) runningByScope.set(scope, { tasks: live, at: Date.now() });
  else if (old && Date.now() - old.at > 30_000) runningByScope.delete(scope);
  return live.length ? live : old && Date.now() - old.at <= 30_000 ? old.tasks : [];
};
async function refreshTargets(): Promise<void> {
  const targets = await notificationTargets();
  knownTargets = targets;
  publishNotificationTargets(targets);
  const valid = new Set(targets.map(target => target.notificationScope));
  for (const [scope, entry] of runningByScope) if (!valid.has(scope) || Date.now() - entry.at > 2 * 60 * 60_000) runningByScope.delete(scope);
  for (const [key, sent] of recentlySent) if (!valid.has(sent.scope) || Date.now() - sent.at > 5 * 60_000) recentlySent.delete(key);
}

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

/** Standby is an explicit battery tradeoff across all saved connections. */
const standbyWanted = () => Platform.OS === 'android' && remoteNotificationsEnabled() && notificationPermissionGranted() && standbyEnabled() && knownTargets.length > 0 && Boolean(native?.startStandby);
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
  try { await refreshTargets(); } catch { return; }
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
  try { await refreshTargets(); } catch { return; }
  if (!notificationPermissionGranted()) { if (watching || standing) await stopWatch(); return; }
  if (standing) return; // the standby service already follows every task
  runningSessions();
  const running = [...runningByScope.values()].flatMap(entry => entry.tasks);
  if (!running.length) { if (AppState.currentState === 'active') void stopWatch(); return; }
  const first = running[0].session;
  const title = `${sessionAgentDisplayName(first)} 正在运行`;
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

// A sticky native service may predate JS pairing restoration. Keep only its
// public signed authority until that exact credential-scoped owner is loaded.
const recoveredIngress = new Map<string, { hubUrl: string; manifest: unknown; serialized: string; retryAt: number }>();
const recoveringIngress = new Set<string>();
function captureRecoveredIngress() {
  try {
    const raw = native?.recoveredIngress?.();
    if (!raw || raw.length > 128 * 1024) return;
    const value = JSON.parse(raw);
    const entries = value?.schema === 2 && Array.isArray(value.connections) ? value.connections.slice(0, 64) : [value];
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).length !== 3
        || !validNotificationScope(entry.navigationScope) || typeof entry.hubUrl !== 'string' || entry.hubUrl.length > 512
        || !entry.manifest || typeof entry.manifest !== 'object') continue;
      const serialized = JSON.stringify(entry.manifest), existing = recoveredIngress.get(entry.navigationScope);
      if (existing && existing.hubUrl === entry.hubUrl && existing.serialized === serialized) continue;
      recoveredIngress.set(entry.navigationScope, { hubUrl: entry.hubUrl, manifest: entry.manifest, serialized, retryAt: 0 });
      if (recoveredIngress.size > 64) recoveredIngress.delete(recoveredIngress.keys().next().value!);
    }
  } catch { /* Old native builds have no routing hand-back API. */ }
}
function restoreRecoveredIngress() {
  const credentials = watchCredentials(), scope = currentNotificationScope();
  if (!credentials || credentials.botToken || !scope) return;
  const entry = recoveredIngress.get(scope);
  if (!entry || entry.hubUrl !== credentials.url || recoveringIngress.has(scope) || entry.retryAt > Date.now()) return;
  const active = () => currentNotificationScope() === scope && watchCredentials()?.url === entry.hubUrl;
  if (!adoptRecoveredHubIngress) return;
  recoveringIngress.add(scope);
  void adoptRecoveredHubIngress(entry.hubUrl, entry.manifest, active).then(accepted => {
    if (accepted && recoveredIngress.get(scope) === entry) recoveredIngress.delete(scope);
  }).catch(() => undefined).finally(() => {
    recoveringIngress.delete(scope);
    // Native may already have cleared its checkpoint. Keep a cancelled or
    // failed import for this exact owner, with bounded retries while active.
    if (recoveredIngress.get(scope) === entry) entry.retryAt = active() ? Date.now() + 60_000 : 0;
  });
}

/** Hand the running sessions to the native watch (background) or take them back (foreground). */
function configureNative(follow: boolean) {
  if (!native?.configureWatch || Platform.OS !== 'android') return;
  // Capture before configureWatch(false) clears the native checkpoint. Stop
  // immediately; importing this public cache must never keep a revoked watch alive.
  captureRecoveredIngress();
  const version = ++configVersion;
  if (!follow || !remoteNotificationsEnabled() || !watching) {
    nativeFollowing = false;
    try { native.configureWatch(JSON.stringify({ version, follow: false })); } catch { /* Native stopped. */ }
    restoreRecoveredIngress();
    return;
  }
  runningSessions();
  void refreshTargets().then(() => {
    if (version !== configVersion || !remoteNotificationsEnabled() || !appIsBackgrounded()) return;
    const activeScope = currentNotificationScope();
    const connections = knownTargets.flatMap(target => {
      const tasks = runningByScope.get(target.notificationScope)?.tasks ?? [];
      if (!standing && !tasks.length) return [];
      const deviceWide = standing || tasks.length > 4;
      return [{ version, follow: true, standby: standing, hubUrl: target.hub.url,
        ...(target.hub.botToken ? { botToken: target.hub.botToken } : { pairToken: target.hub.pairToken }),
        wait: target.notificationScope === activeScope ? hubSupportsWait() : true,
        navigationScope: target.notificationScope,
        ...(!target.hub.botToken ? { ingressManifest: hubIngressSnapshot?.(target.hub.url) } : {}),
        ...(deviceWide ? { devices: [{ deviceId: target.deviceId }] } : {}),
        ...(!standing && deviceWide ? { deviceMode: true } : {}),
        sessions: tasks.map(({ deviceId, session }) => ({ deviceId, sessionKey: session.sessionKey,
          title: session.title?.trim() || '远程任务', agent: sessionAgentDisplayName(session),
          after: target.notificationScope === activeScope ? sessionCursor(deviceId, session.sessionKey) : 0 })),
      }];
    });
    nativeFollowing = connections.length > 0;
    native.configureWatch!(JSON.stringify({ schema: 2, version, follow: nativeFollowing, standby: standing, connections }));
    const status = native.watchStatus?.();
    if (status && !status.running) nativeFollowing = false;
  }).catch(() => { nativeFollowing = false; });
  restoreRecoveredIngress();
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
  let alive = true, openGeneration = 0;
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingOpen: { deviceId: string; sessionKey: string; notificationScope?: unknown; notificationCount?: unknown } | null = null;
  const openPending = () => {
    if (!pendingOpen || getRemoteState().phase === 'loading' || getRemoteState().signingIn) return;
    const requested = pendingOpen; pendingOpen = null;
    const generation = ++openGeneration;
    const stillWanted = () => alive && generation === openGeneration;
    void (async () => {
      let matched = false;
      if (validNotificationScope(requested.notificationScope)) {
        const saved = await resolveNotificationTarget(requested.notificationScope, requested.deviceId);
        if (!stillWanted()) return;
        if (saved) {
          // Navigation must never remotely switch a station or run a command.
          await useSavedConnection(saved.connectionId, true, { skipHandover: true, stillWanted });
          matched = stillWanted() && await currentNoticeTarget(saved) && currentNotificationScope() === saved.notificationScope;
        } else {
          const current = pushTarget();
          matched = !getRemoteState().connectionId && Boolean(current && current.deviceId === requested.deviceId
            && requested.notificationScope === notificationScopeFor(current.hub, current.deviceId));
        }
      }
      if (!stillWanted()) return;
      setRemoteFocus(matched && Number(requested.notificationCount ?? 1) <= 1
        ? { deviceId: requested.deviceId, sessionKey: requested.sessionKey } : { home: true });
      open();
    })().catch(() => { if (stillWanted()) { setRemoteFocus({ home: true }); open(); } });
  };
  const handleOpen = (payload: string | null | undefined) => {
    if (!payload || payload === lastOpen) return;
    if (payload.length > 4096) return;
    lastOpen = payload;
    if (openTimer) clearTimeout(openTimer);
    openTimer = setTimeout(() => { if (lastOpen === payload) lastOpen = ''; }, 5000);
    try {
      const target = JSON.parse(payload) as { deviceId?: unknown; sessionKey?: unknown; notificationScope?: unknown; notificationCount?: unknown; notificationStatus?: unknown };
      if (typeof target.notificationStatus === 'string' && target.sessionKey === undefined) { target.sessionKey = 'notification-status'; target.notificationCount = 2; }
      if (typeof target?.deviceId === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(target.deviceId)
        && typeof target.sessionKey === 'string' && target.sessionKey.length > 0 && target.sessionKey.length <= 512 && !/[|\p{Cc}\p{Cf}]/u.test(target.sessionKey)) {
        pendingOpen = { deviceId: target.deviceId, sessionKey: target.sessionKey, notificationScope: target.notificationScope, notificationCount: target.notificationCount }; openPending();
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
  const bindingSub = onConnectionBindingsChange(() => {
    void refreshTargets().then(() => { if (appIsBackgrounded()) configureNative(true); else void ensureStandby().then(ensureWatch); }).catch(() => undefined);
  });
  let observedScope = currentNotificationScope();
  const connectionSub = onRemoteChange(() => {
    const next = currentNotificationScope();
    if (next !== observedScope) {
      observedScope = next; setVisibleThread(null, null);
      // Re-pairing may replace credentials without resetting the connection.
      // Retire a queued navigation before the screen consumes it in an effect.
      if (getRemoteState().focus) setRemoteFocus({ home: true });
      configureNative(false);
      void ensureStandby().then(ensureWatch).then(() => { if (appIsBackgrounded()) configureNative(true); });
    }
    runningSessions();
    openPending();
    restoreRecoveredIngress();
  });
  // A sticky Android service can predate this JS runtime. Foreground launch
  // must retire its old handoff before asynchronous pairing restoration runs.
  reconcileNativeWatch();
  configureNative(false);
  void ensureStandby().then(ensureWatch);
  return () => { alive = false; openGeneration++; started = false; pendingOpen = null; if (openTimer) clearTimeout(openTimer); lastOpen = ''; recoveredIngress.clear(); recoveringIngress.clear(); preferenceSub(); openSub?.remove(); eventSub(); appSub.remove(); pushSub(); bindingSub(); connectionSub(); standing = false; void stopWatch(); };
}

/** Native truth while the notification menu is visible; a saved switch is not a running service. */
export function useBackgroundWatchStatus(visible: boolean): BackgroundWatchStatus | null {
  const [value, setValue] = useState<BackgroundWatchStatus | null>(null);
  useEffect(() => {
    if (!visible || Platform.OS !== 'android' || !native?.watchStatus) return;
    const update = () => {
      if (AppState.currentState !== 'active') return;
      try {
        const raw = native.watchStatus?.() ?? null;
        const unavailableConnections = raw?.connections?.filter(item => item.reason && !['completed', 'foreground', 'stopped'].includes(item.reason)).length ?? 0;
        const reason = raw?.notificationStorageReady === false ? 'storage' : unavailableConnections ? 'partial'
          : raw && !['completed', 'foreground', 'stopped'].includes(raw.reason) ? raw.reason : '';
        const next = raw ? { ...raw, reason, unavailableConnections } : null;
        setValue(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
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
