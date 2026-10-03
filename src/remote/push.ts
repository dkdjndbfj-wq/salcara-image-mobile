import { useSyncExternalStore } from 'react';
import { AppState, Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';

import { registerPushToken } from './client';
import { hubSupportsPush, onRemoteChange, pushTarget } from './store';

/**
 * Task news while the app is closed (Android).
 *
 * 1. Firebase Cloud Messaging when the phone has Google services and the Hub
 *    was given a Firebase key (capability push.fcm.v1): the phone registers its
 *    token with its pairing; the Hub sends a data message carrying no task text,
 *    and the native receiver shows a generic notification.
 * 2. Otherwise (common on phones sold in mainland China, or a Hub without a key)
 *    the person can turn on 后台待命: a quiet foreground service keeps one
 *    connection to the Hub open and posts the same notifications itself.
 */
type Native = {
  pushToken?(): Promise<string | null>;
  addListener?(event: 'onPushToken', listener: (event: { token: string }) => void): { remove(): void };
};
const native = (() => { try { return requireOptionalNativeModule<Native>('SalcaraNotify'); } catch { return null; } })();

type SettingsStore = { getSetting: (key: string) => Promise<string | null>; setSetting: (key: string, value: string | null) => Promise<void> };
const settings = (): SettingsStore | null => { try { return require('../storage/database') as SettingsStore; } catch { return null; } };
const STANDBY = 'remote.standby';

export type PushStatus =
  | 'fcm'          // registered: news arrive even when the app is closed
  | 'no-google'    // this phone cannot receive Firebase messages
  | 'hub-off'      // the Hub has no Firebase key
  | 'unpaired'     // nothing to register yet
  | 'unsupported'; // iOS / no native module

let status: PushStatus = Platform.OS === 'android' && native?.pushToken ? 'unpaired' : 'unsupported';
let standby = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
let registered = '';
let syncing: Promise<void> | null = null;
let again = false;

async function sync(): Promise<void> {
  if (!native?.pushToken || Platform.OS !== 'android') return;
  const target = pushTarget();
  if (!target) { if (status !== 'unpaired') { status = 'unpaired'; emit(); } return; }
  if (!hubSupportsPush()) { if (status !== 'hub-off') { status = 'hub-off'; emit(); } return; }
  let token: string | null = null;
  try { token = await native.pushToken(); } catch { token = null; }
  if (!token) { if (status !== 'no-google') { status = 'no-google'; emit(); } return; }
  const key = `${target.hub.url}|${target.deviceId}|${token}`;
  if (key === registered && status === 'fcm') return;
  try {
    const result = await registerPushToken(target.hub, target.deviceId, token);
    registered = result === 'fcm' ? key : '';
    status = result === 'fcm' ? 'fcm' : 'hub-off';
  } catch { registered = ''; /* retried on the next change or when the app comes back */ }
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
  void settings()?.getSetting(STANDBY).then((value) => { standby = value === '1'; emit(); }).catch(() => undefined);
  let lastTarget = '';
  const changeSub = onRemoteChange(() => {
    const target = pushTarget();
    const id = target ? `${target.hub.url}|${target.deviceId}|${hubSupportsPush()}` : '';
    if (id !== lastTarget) { lastTarget = id; void syncPush(); }
  });
  const tokenSub = native?.addListener?.('onPushToken', () => { registered = ''; void syncPush(); });
  const appSub = AppState.addEventListener('change', (next) => { if (next === 'active') void syncPush(); });
  void syncPush();
  return () => { started = false; changeSub(); tokenSub?.remove(); appSub.remove(); };
}

export function pushStatus(): PushStatus { return status; }
export function standbyEnabled(): boolean { return standby; }

/** 后台待命: only offered when push cannot reach this phone. */
export async function setStandbyEnabled(value: boolean): Promise<void> {
  standby = value; emit();
  try { await settings()?.setSetting(STANDBY, value ? '1' : '0'); } catch { /* best effort */ }
}

export function usePushStatus(): { status: PushStatus; standby: boolean } {
  const snapshot = useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => `${status}|${standby}`, () => `${status}|${standby}`);
  const [s, b] = snapshot.split('|');
  return { status: s as PushStatus, standby: b === 'true' };
}

/** Subscribe outside React (notifications.ts starts / stops the standby service). */
export function onPushChange(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
