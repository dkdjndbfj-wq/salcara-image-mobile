import type { SessionInfo } from './client';

/**
 * Small on-device cache of recent 编程 threads and session lists, so a thread
 * opens instantly and stays readable while the computer is offline.
 *
 * - Scoped per pairing; cleared when that pairing is revoked.
 * - Only CLI/background sessions are cached. Desktop-native and read-only
 *   Claude Desktop history depend on a live desktop lease and are never stored.
 * - At most 40 threads × 300 items; least recently used threads are dropped.
 */
type CachedThread = { items: unknown[]; session?: SessionInfo; savedAt: number };
type SettingsStore = { getSetting: (key: string) => Promise<string | null>; setSetting: (key: string, value: string | null) => Promise<void> };
const settings = (): SettingsStore | null => { try { return require('../storage/database') as SettingsStore; } catch { return null; } };

const MAX_ITEMS = 300;
const MAX_THREADS = 40;
const MAX_BYTES = 600_000;
const threadKey = (scope: string, key: string) => `remote.cache.t.${scope}.${key}`;
const listKey = (scope: string, deviceId: string) => `remote.cache.s.${scope}.${deviceId}`;
const indexKey = (scope: string) => `remote.cache.index.${scope}`;

function cacheableSession(value: unknown): value is SessionInfo {
  if (!value || typeof value !== 'object') return false;
  const session = value as SessionInfo;
  return typeof session.sessionKey === 'string' && /^(codex|claude):[^|\u0000-\u001f]{1,160}$/.test(session.sessionKey)
    && (session.tool === 'codex' || session.tool === 'claude') && session.sessionKey.startsWith(`${session.tool}:`)
    && (session.controlSurface === undefined || session.controlSurface === 'cli')
    && typeof session.client === 'string' && typeof session.title === 'string' && typeof session.cwd === 'string' && Number.isSafeInteger(session.updatedAt)
    && ['idle', 'running', 'waiting_approval', 'failed'].includes(session.status) && typeof session.controllable === 'boolean';
}
function cacheableItem(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== 'string' || !Number.isSafeInteger(item.ts)) return false;
  switch (item.kind) {
    case 'message': return !item.local && (item.role === 'user' || item.role === 'assistant') && typeof item.text === 'string' && typeof item.final === 'boolean';
    case 'reasoning': return typeof item.text === 'string' && typeof item.final === 'boolean';
    case 'tool': return typeof item.title === 'string' && typeof item.tool === 'string' && ['running', 'done', 'failed'].includes(String(item.status))
      && (item.detail === undefined || typeof item.detail === 'string') && (item.output === undefined || typeof item.output === 'string') && (item.diff === undefined || typeof item.diff === 'string');
    case 'turn': return ['started', 'completed', 'failed', 'interrupted'].includes(String(item.status));
    case 'notice': return typeof item.text === 'string' && ['info', 'warn', 'error'].includes(String(item.level));
    default: return false;
  }
}

const timers = new Map<string, { scope: string; timer: ReturnType<typeof setTimeout> }>();
const writes = new Map<string, Promise<void>>();
const retired = new Set<string>();
let generation = 0;
function serial(scope: string, run: () => Promise<void>): Promise<void> {
  const next = (writes.get(scope) ?? Promise.resolve()).then(run, run);
  const tail = next.catch(() => undefined);
  writes.set(scope, tail);
  void tail.then(() => { if (writes.get(scope) === tail) writes.delete(scope); });
  return next;
}
function debounce(scope: string, id: string, run: (store: SettingsStore) => Promise<void>) {
  if (retired.has(scope)) return;
  // Capture the module during the operation, not from a late timer callback.
  const store = settings(); if (!store) return;
  const previous = timers.get(id);
  if (previous) clearTimeout(previous.timer);
  const revision = generation;
  const timer = setTimeout(() => {
    timers.delete(id);
    void serial(scope, async () => { if (revision === generation && !retired.has(scope)) await run(store); }).catch(() => undefined);
  }, 1500);
  timers.set(id, { scope, timer });
}

async function readJson<T>(key: string, store = settings()): Promise<T | null> {
  try { const raw = await store?.getSetting(key); return raw && raw.length <= MAX_BYTES ? JSON.parse(raw) as T : null; } catch { return null; }
}

async function readIndex(store: SettingsStore, scope: string): Promise<string[]> {
  const index = await readJson<unknown>(indexKey(scope), store);
  return Array.isArray(index) && index.length <= MAX_THREADS && index.every(key => typeof key === 'string' && key.length <= 512) ? index : [];
}

async function touchIndex(store: SettingsStore, scope: string, key: string) {
  const index = await readIndex(store, scope);
  const next = [key, ...index.filter((item) => item !== key)];
  for (const stale of next.slice(MAX_THREADS)) await store.setSetting(threadKey(scope, stale), null);
  await store.setSetting(indexKey(scope), JSON.stringify(next.slice(0, MAX_THREADS)));
}

export function saveCachedThread(scope: string, key: string, timeline: { items: unknown[]; session?: SessionInfo }) {
  if (key.includes('|claude-desktop:') || timeline.session?.controlSurface === 'desktop' || timeline.session?.controlSurface === 'read-only') return;
  debounce(scope, `t:${scope}:${key}`, async store => {
    let items = timeline.items.slice(-MAX_ITEMS);
    let json = JSON.stringify({ items, session: timeline.session, savedAt: Date.now() } satisfies CachedThread);
    while (json.length > MAX_BYTES && items.length > 20) {
      items = items.slice(Math.floor(items.length / 3));
      json = JSON.stringify({ items, session: timeline.session, savedAt: Date.now() } satisfies CachedThread);
    }
    if (json.length > MAX_BYTES) return;
    await store.setSetting(threadKey(scope, key), json);
    await touchIndex(store, scope, key);
  });
}

export async function loadCachedThread(scope: string, key: string): Promise<CachedThread | null> {
  const cached = await readJson<CachedThread>(threadKey(scope, key));
  if (!cached || !Array.isArray(cached.items) || cached.items.length > MAX_ITEMS || !Number.isSafeInteger(cached.savedAt)
    || !cacheableSession(cached.session) || cached.session.sessionKey !== key.slice(key.indexOf('|') + 1)) return null;
  return { ...cached, items: cached.items.filter(cacheableItem) };
}

export function saveCachedSessions(scope: string, deviceId: string, list: SessionInfo[]) {
  debounce(scope, `s:${scope}:${deviceId}`, async store => {
    const json = JSON.stringify(list.filter((item) => !item.sessionKey.startsWith('claude-desktop:') && item.controlSurface !== 'desktop' && item.controlSurface !== 'read-only').slice(0, 100));
    if (json.length <= MAX_BYTES) await store.setSetting(listKey(scope, deviceId), json);
  });
}

export async function loadCachedSessions(scope: string, deviceId: string): Promise<SessionInfo[] | null> {
  const list = await readJson<SessionInfo[]>(listKey(scope, deviceId));
  return Array.isArray(list) && list.length <= 100 && list.every(cacheableSession) ? list : null;
}

/** Forget everything cached for one pairing (on unpair). */
export async function clearRemoteCache(scope: string, deviceIds: string[] = []) {
  retired.add(scope);
  for (const [id, pending] of timers) if (pending.scope === scope) { clearTimeout(pending.timer); timers.delete(id); }
  const store = settings(); if (!store) return;
  await serial(scope, async () => {
    for (const key of await readIndex(store, scope)) await store.setSetting(threadKey(scope, key), null);
    for (const deviceId of deviceIds) await store.setSetting(listKey(scope, deviceId), null);
    await store.setSetting(indexKey(scope), null);
  }).catch(() => undefined);
}

/** Cancels deferred work synchronously; await the returned drain before replacing a test DB. */
export function resetRemoteCacheForTests(): Promise<void> {
  generation += 1;
  for (const pending of timers.values()) clearTimeout(pending.timer);
  timers.clear(); retired.clear();
  // Storage already inside setSetting cannot be cancelled. Wait for those
  // operations before a fixture is cleared or its module is torn down.
  return Promise.all([...writes.values()]).then(() => undefined);
}
