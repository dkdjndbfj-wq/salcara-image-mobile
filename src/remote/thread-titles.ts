import { useCallback, useEffect, useSyncExternalStore } from 'react';

/** Phone-only names, scoped to the exact pairing, computer and session. */
const SETTING = 'remote_thread_titles_v2';
const MAX = 300;
const MAX_TITLE = 80;
type Titles = Record<string, string>;
type TitleLookup = (deviceId: string | null | undefined, sessionKey: string | null | undefined, fallback: string) => string;
let titles: Titles = {};
let loaded: Promise<void> | null = null;
let edits: Promise<unknown> = Promise.resolve();
let generation = 0;
const retired = new Set<string>();
const listeners = new Set<() => void>();
const settings = () => require('../storage/database') as typeof import('../storage/database');
// The store calls retirement during unpairing; defer this reverse dependency
// until an interaction so module initialization has no store/title cycle.
const remoteStore = () => require('./store') as typeof import('./store');
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => titles;
const keyOf = (scope: string, deviceId: string, sessionKey: string) => JSON.stringify([scope, deviceId, sessionKey]);
const validScope = (scope: string) => typeof scope === 'string' && scope.length <= 4096 && /^.+\|credential:[^|\u0000-\u001f\u007f]+$/.test(scope);
const validPart = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);

function scopeOf(key: string): string | undefined {
  try {
    const parts: unknown = JSON.parse(key);
    if (Array.isArray(parts) && parts.length === 3 && validScope(parts[0]) && validPart(parts[1], 128) && validPart(parts[2], 2048)
      && key === keyOf(parts[0], parts[1], parts[2])) return parts[0];
  } catch { /* Old device-only keys cannot prove a pairing and are not migrated. */ }
}
function publish(next: Titles) {
  titles = Object.fromEntries(Object.entries(next).filter(([key]) => !retired.has(scopeOf(key) ?? '')).slice(-MAX));
  listeners.forEach(listener => listener());
}
function currentScope(): string {
  const readScope = remoteStore().remoteDeliveryScope;
  const scope = typeof readScope === 'function' ? readScope() : '';
  return validScope(scope) ? scope : '';
}
function ensureLoaded(): Promise<void> {
  if (loaded) return loaded;
  const owner = generation;
  const loading = (async () => {
    const [encoded, removed] = await Promise.all([
      settings().getSetting(SETTING),
      (require('./delivery') as typeof import('./delivery')).retiredDeliveryScopes(),
    ]);
    if (encoded && encoded.length > 2_000_000) throw new Error('本地对话名称记录无效，请核对应用存储');
    const raw: unknown = encoded === null ? {} : JSON.parse(encoded);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length > MAX) throw new Error('本地对话名称记录无效，请核对应用存储');
    const next: Titles = {};
    for (const [key, value] of Object.entries(raw)) {
      if (!scopeOf(key) || typeof value !== 'string' || !value || value !== cleanThreadTitle(value)) throw new Error('本地对话名称记录无效，请核对应用存储');
      next[key] = value;
    }
    if (owner !== generation) return;
    removed.forEach(scope => retired.add(scope));
    publish(next);
  })();
  loaded = loading;
  void loading.catch(() => { if (loaded === loading) loaded = null; });
  return loading;
}
function serialize(run: () => Promise<void>): Promise<void> {
  const owner = generation;
  const next = edits.then(async () => { if (owner === generation) await run(); });
  edits = next.catch(() => undefined);
  return next;
}
function requireCurrentScope(scope: string) {
  if (!scope || scope !== currentScope() || retired.has(scope)) throw new Error('电脑连接已改变，请重新打开对话后改名');
}

export function cleanThreadTitle(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
}

/** Capture expectedScope when opening the editor, before any asynchronous work. */
export function renameThread(deviceId: string, sessionKey: string, title: string, expectedScope = currentScope()): Promise<void> {
  const clean = cleanThreadTitle(title);
  return serialize(async () => {
    requireCurrentScope(expectedScope);
    if (!validPart(deviceId, 128) || !validPart(sessionKey, 2048)) throw new Error('对话标识无效');
    await ensureLoaded();
    requireCurrentScope(expectedScope);
    const key = keyOf(expectedScope, deviceId, sessionKey);
    const next = { ...titles };
    delete next[key];
    if (clean) next[key] = clean;
    const bounded = Object.fromEntries(Object.entries(next).slice(-MAX));
    await settings().setSetting(SETTING, JSON.stringify(bounded));
    // Retirement can arrive while SQLite is writing. It hides this scope
    // immediately, and its queued cleanup removes these bytes next.
    publish(bounded);
  });
}

/** Called after the delivery ledger permanently retires this exact pairing. */
export function retireThreadTitleScope(exactScope: string): Promise<void> {
  if (!exactScope || exactScope.length > 4096) return Promise.resolve();
  retired.add(exactScope);
  publish(titles);
  return serialize(async () => {
    await ensureLoaded();
    const next = Object.fromEntries(Object.entries(titles).filter(([key]) => scopeOf(key) !== exactScope));
    await settings().setSetting(SETTING, JSON.stringify(next));
    publish(next);
  });
}

export function threadTitle(deviceId: string | null | undefined, sessionKey: string | null | undefined, fallback: string): string {
  const scope = currentScope();
  return scope && !retired.has(scope) && deviceId && sessionKey ? titles[keyOf(scope, deviceId, sessionKey)] ?? fallback : fallback;
}

/** Stable until the exact pairing or the title snapshot changes. */
export function useThreadTitles(): TitleLookup {
  const { useRemote } = remoteStore();
  useRemote();
  const scope = currentScope();
  useEffect(() => { void ensureLoaded().catch(() => undefined); }, []);
  const names = useSyncExternalStore(subscribe, snapshot, snapshot);
  return useCallback((deviceId, sessionKey, fallback) => scope && !retired.has(scope) && deviceId && sessionKey
    ? names[keyOf(scope, deviceId, sessionKey)] ?? fallback : fallback, [names, scope]);
}

export function resetThreadTitlesForTests() { generation += 1; titles = {}; retired.clear(); loaded = null; edits = Promise.resolve(); }
