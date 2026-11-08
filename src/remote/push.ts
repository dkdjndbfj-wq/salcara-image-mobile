import { useSyncExternalStore } from 'react';
import { AppState, Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';

import { registerPushToken, type Hub } from './client';
import { hubSupportsPush, onRemoteChange, pushTarget } from './store';
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
 *    the person can turn on 后台待命: a quiet foreground service keeps one
 *    connection to the Hub open and posts the same notifications itself.
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
  | 'unsupported'; // iOS / no native module

type PushPlatform = 'android' | 'ios';
const currentPlatform = (): PushPlatform | null => Platform.OS === 'android' || Platform.OS === 'ios' ? Platform.OS : null;
let status: PushStatus = currentPlatform() && native?.pushToken ? 'unpaired' : 'unsupported';
let standby = false;
let standbyRevision = 0;
let standbyWrites: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
let registered = '';
// Kept in memory only. It lets a Hub switch explicitly unregister the old
// target before the same FCM token is registered on the new station.
let registeredTarget: { hub: Hub; deviceId: string; token: string } | null = null;
let syncing: Promise<void> | null = null;
let again = false;
const sameTarget = (a: { hub: Hub; deviceId: string } | null, b: { hub: Hub; deviceId: string }) =>
  a?.deviceId === b.deviceId && a.hub.url === b.hub.url && a.hub.pairToken === b.hub.pairToken && a.hub.botToken === b.hub.botToken && a.hub.key === b.hub.key;

async function unregisterOldTarget(next?: { hub: Hub; deviceId: string }): Promise<void> {
  const old = registeredTarget;
  if (!old || (next && sameTarget(old, next))) return;
  registeredTarget = null;
  registered = '';
  if (status === 'fcm') { status = 'unpaired'; emit(); }
  try { await registerPushToken(old.hub, old.deviceId, '', currentPlatform() ?? 'android'); } catch { /* revoked/old stations may already be gone */ }
}

async function sync(): Promise<void> {
  const platform = currentPlatform();
  if (!native?.pushToken || !platform) return;
  await loadNotificationPreference();
  if (!remoteNotificationsEnabled()) {
    await unregisterOldTarget();
    if (status !== 'unpaired') { status = 'unpaired'; emit(); }
    return;
  }
  const target = pushTarget();
  if (!target) { await unregisterOldTarget(); if (status !== 'unpaired') { status = 'unpaired'; emit(); } return; }
  await unregisterOldTarget(target);
  const stillCurrent = () => remoteNotificationsEnabled() && sameTarget(pushTarget(), target) && hubSupportsPush();
  if (!hubSupportsPush()) { await unregisterOldTarget(); if (status !== 'hub-off') { status = 'hub-off'; emit(); } return; }
  if (!stillCurrent()) { again = true; return; }
  let permitted = true;
  try { if (native.canNotify) permitted = native.canNotify(); } catch { permitted = false; }
  if (!permitted) {
    await unregisterOldTarget();
    if (status !== 'permission') { status = 'permission'; emit(); }
    return;
  }
  let token: string | null = null;
  try { token = await native.pushToken(); } catch { token = null; }
  if (!stillCurrent()) { again = true; return; }
  if (!token) {
    const unavailable: PushStatus = platform === 'ios' ? 'unconfigured' : 'no-google';
    if (status !== unavailable) { status = unavailable; emit(); }
    return;
  }
  const key = `${target.hub.url}|${target.deviceId}|${token}`;
  if (key === registered && status === 'fcm') return;
  try {
    const result = await registerPushToken(target.hub, target.deviceId, token, platform);
    if (!stillCurrent()) {
      // Registration can finish after disabling notifications or switching
      // station/credentials. Retire that exact old target, never the new one.
      try { await registerPushToken(target.hub, target.deviceId, '', platform); } catch { /* native preference still gates delivery */ }
      registered = ''; registeredTarget = null; again = true;
      return;
    }
    registered = result === 'fcm' ? key : '';
    registeredTarget = result === 'fcm' ? { hub: target.hub, deviceId: target.deviceId, token } : null;
    status = result === 'fcm' ? 'fcm' : 'hub-off';
  } catch {
    registered = ''; registeredTarget = null;
    if (stillCurrent()) status = 'error'; else again = true;
    // Retried on the next change or when the app comes back. Never retain an
    // old station's success while the current registration is unconfirmed.
  }
  emit();
}

/** Re-checks registration; overlapping calls collapse into one follow-up run. */
export function syncPush(): Promise<void> {
  if (syncing) { again = true; return syncing; }
  syncing = sync().finally(() => {
    syncing = null;
    if (again) { again = false; void syncPush(); }
  });
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
  let lastTarget: { hub: Hub; deviceId: string } | null = null;
  let lastSupportsPush = false;
  const changeSub = onRemoteChange(() => {
    const target = pushTarget();
    const supportsPush = hubSupportsPush();
    if ((target ? !sameTarget(lastTarget, target) : lastTarget !== null) || supportsPush !== lastSupportsPush) {
      lastTarget = target ? { deviceId: target.deviceId, hub: { ...target.hub } } : null;
      lastSupportsPush = supportsPush;
      void syncPush();
    }
  });
  const tokenSub = native?.addListener?.('onPushToken', () => { registered = ''; void syncPush(); });
  const permissionSub = native?.addListener?.('onPermissionChange', () => { void syncPush(); });
  const preferenceSub = onNotificationPreferenceChange(() => { void syncPush(); });
  const appSub = AppState.addEventListener('change', (next) => { if (next === 'active') void syncPush(); });
  void syncPush();
  return () => { alive = false; started = false; changeSub(); tokenSub?.remove(); permissionSub?.remove(); preferenceSub(); appSub.remove(); };
}

export function pushStatus(): PushStatus { return status; }
export function standbyEnabled(): boolean { return standby; }

/** 后台待命: only offered when push cannot reach this phone. */
export async function setStandbyEnabled(value: boolean): Promise<void> {
  standbyRevision++; standby = value; emit();
  standbyWrites = standbyWrites.then(async () => {
    try { await settings()?.setSetting(STANDBY, value ? '1' : '0'); } catch { /* best effort */ }
  });
  await standbyWrites;
}

export function usePushStatus(): { status: PushStatus; standby: boolean } {
  const snapshot = useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => `${status}|${standby}`, () => `${status}|${standby}`);
  const [s, b] = snapshot.split('|');
  return { status: s as PushStatus, standby: b === 'true' };
}

/** Subscribe outside React (notifications.ts starts / stops the standby service). */
export function onPushChange(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
