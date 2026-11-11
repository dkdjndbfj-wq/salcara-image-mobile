import { useSyncExternalStore } from 'react';
import { AppState, Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';

import { registerPushToken } from './client';
import { getRemoteState, onRemoteChange, pushTarget } from './store';
import { notificationScopeFor } from './notification-scope';
import { currentNoticeTarget, notificationTargets, publishNotificationTargets, type NoticeTarget } from './notification-targets';
import { onConnectionBindingsChange } from './connections';
import { loadNotificationPreference, onNotificationPreferenceChange, remoteNotificationsEnabled } from './notification-preferences';

/**
 * Task news while the app is backgrounded or closed.
 *
 * 1. Firebase Cloud Messaging when the phone has Google services and the Hub
 *    was given a Firebase key (capability push.fcm.v1): the phone registers its
 *    token with its pairing; the Hub sends a data message carrying no task text,
 *    and the native receiver shows a generic notification. iOS uses the same
 *    FCM token routed through APNs and presents a generic system alert.
 * 2. Otherwise (common on phones sold in mainland China, or a Hub without a key)
 *    the person can turn on 后台待命: a quiet foreground service follows the
 *    saved connections with a bounded worker pool and posts the same notices.
 */
type Native = {
  pushToken?(): Promise<string | null>;
  canNotify?(): boolean;
  addListener?(event: 'onPushToken' | 'onPermissionChange', listener: (event: { token?: string; allowed?: boolean }) => void): { remove(): void };
};
const native = (() => { try { return requireOptionalNativeModule<Native>('SalcaraNotify'); } catch { return null; } })();

type SettingsStore = { getSetting: (key: string) => Promise<string | null>; setSetting: (key: string, value: string | null) => Promise<void> };
const settings = (): SettingsStore | null => { try { return require('../storage/database') as SettingsStore; } catch { return null; } };
const STANDBY = 'remote.standby';

export type PushStatus =
  | 'fcm'          // token registered; delivery still depends on OS/network/provider
  | 'no-google'    // this phone cannot receive Firebase messages
  | 'unconfigured' // iOS Firebase/APNs config is absent in this app build
  | 'hub-off'      // the Hub has no Firebase key
  | 'error'        // registration on the current station is not confirmed
  | 'permission'   // system notification permission is denied
  | 'unpaired'     // nothing to register yet
  | 'unsupported'; // no compatible native module

type PushPlatform = 'android' | 'ios';
const currentPlatform = (): PushPlatform | null => Platform.OS === 'android' || Platform.OS === 'ios' ? Platform.OS : null;
let status: PushStatus = currentPlatform() && native?.pushToken ? 'unpaired' : 'unsupported';
let standby = false;
let standbyRevision = 0;
let standbyWrites: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
const registered = new Map<string, { target: NoticeTarget; token: string }>();
const pendingRemoval = new Map<string, NoticeTarget>();
const targetStatuses = new Map<string, PushStatus>();
let syncing: Promise<void> | null = null;
let again = false;
function refreshStatus(fallback: PushStatus = 'unpaired') {
  const current = pushTarget();
  const scope = current && notificationScopeFor(current.hub, current.deviceId);
  status = scope ? targetStatuses.get(scope) ?? fallback : fallback;
  emit();
}
async function removeTarget(target: NoticeTarget) {
  const scope = target.notificationScope;
  registered.delete(scope); targetStatuses.delete(scope);
  pendingRemoval.set(scope, target);
  try {
    await registerPushToken(target.hub, target.deviceId, '', currentPlatform() ?? 'android');
    pendingRemoval.delete(scope);
  } catch { /* Keep exact old ownership for a later cleanup; native allowlist already excludes it. */ }
}

async function sync(): Promise<void> {
  const platform = currentPlatform();
  if (!native?.pushToken || !platform) return;
  await loadNotificationPreference();
  const targets = remoteNotificationsEnabled() ? await notificationTargets() : [];
  publishNotificationTargets(targets);
  const wanted = new Set(targets.map(target => target.notificationScope));
  for (const [scope, item] of registered) if (!wanted.has(scope)) pendingRemoval.set(scope, item.target);
  for (const target of [...pendingRemoval.values()]) await removeTarget(target);
  if (!remoteNotificationsEnabled() || !targets.length) { targetStatuses.clear(); refreshStatus(); return; }
  let permitted = true;
  try { if (native.canNotify) permitted = native.canNotify(); } catch { permitted = false; }
  if (!permitted) {
    publishNotificationTargets([]);
    for (const item of [...registered.values()]) await removeTarget(item.target);
    for (const target of targets) targetStatuses.set(target.notificationScope, 'permission');
    refreshStatus('permission');
    return;
  }
  let token: string | null = null;
  try { token = await native.pushToken(); } catch { token = null; }
  if (!token) {
    const unavailable: PushStatus = platform === 'ios' ? 'unconfigured' : 'no-google';
    for (const item of [...registered.values()]) await removeTarget(item.target);
    for (const target of targets) targetStatuses.set(target.notificationScope, unavailable);
    refreshStatus(unavailable);
    return;
  }
  const register = async (target: NoticeTarget) => {
    const scope = target.notificationScope;
    const valid = async () => remoteNotificationsEnabled() && await currentNoticeTarget(target);
    if (!await valid()) { again = true; return; }
    if (registered.get(scope)?.token === token) return;
    try {
      // Ask this target, never infer B's capability from A's current UI state.
      const result = await registerPushToken(target.hub, target.deviceId, token!, platform);
      if (!await valid()) { await removeTarget(target); again = true; return; }
      if (result === 'fcm') { registered.set(scope, { target, token: token! }); pendingRemoval.delete(scope); }
      else registered.delete(scope);
      targetStatuses.set(scope, result === 'fcm' ? 'fcm' : 'hub-off');
    } catch {
      // A lost response may still have registered the token remotely.
      if (!await valid()) { await removeTarget(target); again = true; }
      else { registered.delete(scope); targetStatuses.set(scope, 'error'); }
    }
  };
  for (let i = 0; i < targets.length; i += 2) await Promise.all(targets.slice(i, i + 2).map(register));
  refreshStatus();
}

/** Re-checks registration; overlapping calls collapse into one follow-up run. */
export function syncPush(): Promise<void> {
  if (syncing) { again = true; return syncing; }
  syncing = (async () => { do { again = false; await sync(); } while (again); })()
    .catch(() => { refreshStatus('error'); }).finally(() => { syncing = null; });
  return syncing;
}

let started = false;
/** Call once from the app root, next to startRemoteNotifications. */
export function startRemotePush(): () => void {
  if (started) return () => undefined;
  started = true;
  let alive = true;
  const readRevision = standbyRevision;
  void settings()?.getSetting(STANDBY).then((value) => {
    if (!alive || readRevision !== standbyRevision) return;
    standby = value === '1'; emit();
  }).catch(() => undefined);
  let lastTargets = '';
  const changeSub = onRemoteChange(() => {
    const target = pushTarget();
    const signature = JSON.stringify([target && notificationScopeFor(target.hub, target.deviceId), getRemoteState().connections]);
    if (signature !== lastTargets) {
      lastTargets = signature;
      void syncPush();
    }
  });
  const tokenSub = native?.addListener?.('onPushToken', () => { void syncPush(); });
  const permissionSub = native?.addListener?.('onPermissionChange', () => { void syncPush(); });
  const preferenceSub = onNotificationPreferenceChange(() => { if (!remoteNotificationsEnabled()) publishNotificationTargets([]); void syncPush(); });
  const bindingSub = onConnectionBindingsChange(() => { void syncPush(); });
  const appSub = AppState.addEventListener('change', (next) => { if (next === 'active') void syncPush(); });
  void syncPush();
  return () => { alive = false; started = false; changeSub(); bindingSub(); tokenSub?.remove(); permissionSub?.remove(); preferenceSub(); appSub.remove(); };
}

export function pushStatus(): PushStatus { return status; }
export function pushStatusFor(scope: string): PushStatus { return targetStatuses.get(scope) ?? 'unpaired'; }
export function standbyEnabled(): boolean { return standby; }

/** 后台待命 is an explicit battery tradeoff, including mixed push capabilities. */
export async function setStandbyEnabled(value: boolean): Promise<void> {
  standbyRevision++; standby = value; emit();
  standbyWrites = standbyWrites.then(async () => {
    try { await settings()?.setSetting(STANDBY, value ? '1' : '0'); } catch { /* best effort */ }
  });
  await standbyWrites;
}

export function usePushStatus(): { status: PushStatus; standby: boolean; pendingCleanup: number } {
  const snapshot = useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => `${status}|${standby}|${pendingRemoval.size}`, () => `${status}|${standby}|${pendingRemoval.size}`);
  const [s, b, cleanup] = snapshot.split('|');
  return { status: s as PushStatus, standby: b === 'true', pendingCleanup: Number(cleanup) };
}

/** Subscribe outside React (notifications.ts starts / stops the standby service). */
export function onPushChange(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
