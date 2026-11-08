import { requireOptionalNativeModule } from 'expo';

type NativePreferences = { setNotificationsEnabled?(value: boolean): void };
const native = (() => { try { return requireOptionalNativeModule<NativePreferences>('SalcaraNotify'); } catch { return null; } })();
type SettingsStore = { getSetting(key: string): Promise<string | null>; setSetting(key: string, value: string | null): Promise<void> };
const settings = (): SettingsStore | null => { try { return require('../storage/database') as SettingsStore; } catch { return null; } };
const SETTING = 'remote.notifications';

// No background side effects until the stored choice is known. Android keeps
// the same choice natively so it also applies while the JS runtime is absent.
let enabled = false;
let revision = 0;
let loading: Promise<void> | null = null;
let writes: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();
export const remoteNotificationsEnabled = () => enabled;
export function onNotificationPreferenceChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function apply(value: boolean) {
  enabled = value;
  try { native?.setNotificationsEnabled?.(value); } catch { /* Older native builds use JS gating. */ }
  listeners.forEach(listener => listener());
}

export function loadNotificationPreference(): Promise<void> {
  if (!loading) {
    const generation = revision;
    loading = (async () => {
      try {
        const store = settings();
        if (!store) return;
        const stored = await store.getSetting(SETTING);
        if (generation === revision) apply(stored !== '0');
      } catch { /* An unreadable preference must not turn notifications on. */ }
    })();
  }
  return loading;
}

export function setNotificationPreference(value: boolean): Promise<void> {
  revision++;
  apply(value);
  // Rapid toggles must persist in the same order as their immediate native
  // updates; a slow earlier database write cannot resurrect the old choice.
  writes = writes.then(async () => {
    try { await settings()?.setSetting(SETTING, value ? '1' : '0'); } catch { /* best effort */ }
  });
  return writes;
}
