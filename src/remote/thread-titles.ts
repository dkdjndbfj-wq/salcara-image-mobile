import { useEffect, useSyncExternalStore } from 'react';

/**
 * Phone-side names for remote threads. Agents name their own sessions and the
 * computer offers no rename command, so a rename is kept on this phone only
 * and shown everywhere the thread appears here. Clearing it restores the
 * computer's title. Keyed by device and session; at most 300 names are kept.
 */
const SETTING = 'remote_thread_titles_v1';
const MAX = 300;
const MAX_TITLE = 80;

type Titles = Record<string, string>;
let titles: Titles = {};
let loaded: Promise<void> | null = null;
let edits: Promise<unknown> = Promise.resolve();
const listeners = new Set<() => void>();

const keyOf = (deviceId: string, sessionKey: string) => `${deviceId}|${sessionKey}`;
const settings = () => { try { return require('../storage/database') as typeof import('../storage/database'); } catch { return null; } };

function emit() { listeners.forEach((listener) => listener()); }

function ensureLoaded(): Promise<void> {
  if (!loaded) {
    loaded = (async () => {
      try {
        const raw: unknown = JSON.parse(await settings()?.getSetting(SETTING) ?? '{}');
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
        const next: Titles = {};
        for (const [key, value] of Object.entries(raw as Record<string, unknown>).slice(-MAX)) {
          if (key.length <= 2048 && typeof value === 'string' && value.trim() && value.length <= MAX_TITLE) next[key] = value;
        }
        titles = { ...next, ...titles };
        emit();
      } catch { /* optional */ }
    })();
  }
  return loaded;
}

export function cleanThreadTitle(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
}

/** Saves (or, with an empty title, clears) the phone-side name of a thread. */
export function renameThread(deviceId: string, sessionKey: string, title: string): Promise<void> {
  const key = keyOf(deviceId, sessionKey);
  const clean = cleanThreadTitle(title);
  const next = { ...titles };
  delete next[key];
  if (clean) next[key] = clean;
  titles = next;
  emit();
  const run = edits.then(async () => {
    await ensureLoaded();
    await settings()?.setSetting(SETTING, JSON.stringify(Object.fromEntries(Object.entries(titles).slice(-MAX))));
  });
  edits = run.catch(() => undefined);
  return run;
}

export function threadTitle(deviceId: string | null | undefined, sessionKey: string | null | undefined, fallback: string): string {
  if (!deviceId || !sessionKey) return fallback;
  return titles[keyOf(deviceId, sessionKey)] ?? fallback;
}

/** Re-renders when any phone-side name changes; returns a lookup function. */
export function useThreadTitles(): (deviceId: string | null | undefined, sessionKey: string | null | undefined, fallback: string) => string {
  useEffect(() => { void ensureLoaded(); }, []);
  const snapshot = useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => titles, () => titles);
  return (deviceId, sessionKey, fallback) => (deviceId && sessionKey ? snapshot[keyOf(deviceId, sessionKey)] : undefined) ?? fallback;
}

export function resetThreadTitlesForTests() { titles = {}; loaded = null; edits = Promise.resolve(); }
