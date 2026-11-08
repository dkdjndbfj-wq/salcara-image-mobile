import type { SessionInfo } from './client';
import { attachmentRef, localImageUri, MAX_OUTPUT_ATTACHMENTS } from './attachment-ref';
import { clearCachedAttachments } from './attachment-cache';
import { clearDurableEventScope } from './durable-events';
import { retireDurableCommandScope } from './durable-commands';
import { clearRemoteQueuedScope } from './drafts';
import { messageContextReferences, boundedClientId, messageOrigin, messageSkills, sessionMetadata } from './conversation-metadata';
import { markRemoteImagesInUse } from './queued-image-files';

/**
 * Small on-device cache of recent 编程 threads and session lists, so a thread
 * opens instantly and stays readable while the computer is offline.
 *
 * - Scoped per pairing; cleared when that pairing is revoked.
 * - Only CLI/background sessions are cached. Desktop-native and read-only
 *   Claude Desktop history depend on a live desktop lease and are never stored.
 * - At most 40 threads × 300 items; least recently used threads are dropped.
 */
type CachedThread = { items: unknown[]; session?: SessionInfo; revertedTurns?: string[]; revertedItems?: string[]; revertOperations?:string[]; savedAt: number };
type SettingsStore = { getSetting: (key: string) => Promise<string | null>; setSetting: (key: string, value: string | null) => Promise<void> };
const settings = (): SettingsStore | null => { try { return require('../storage/database') as SettingsStore; } catch { return null; } };

const MAX_ITEMS = 300;
const MAX_THREADS = 40;
const MAX_BYTES = 600_000;
const threadKey = (scope: string, key: string) => `remote.cache.t.${scope}.${key}`;
const listKey = (scope: string, deviceId: string) => `remote.cache.s.${scope}.${deviceId}`;
const indexKey = (scope: string) => `remote.cache.index.${scope}`;

function cacheableAttachments(value: unknown, maximum: number): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > maximum) return false;
  const ids = new Set<string>();
  return value.every((item) => {
    const ref = attachmentRef(item);
    if (!ref || ids.has(ref.id)) return false;
    ids.add(ref.id);
    const uri = item && typeof item === 'object' ? (item as Record<string, unknown>).uri : undefined;
    return uri === undefined || localImageUri(uri);
  });
}

function cacheableSession(value: unknown): value is SessionInfo {
  if (!value || typeof value !== 'object') return false;
  const session = value as SessionInfo;
  // Extension adapters use the same `<tool>:<opaque-id>` namespace as the
  // built-ins. Keep the namespace bounded and require the key prefix to match
  // the advertised tool so a malformed/foreign session cannot enter cache.
  const tool = typeof session.tool === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(session.tool) ? session.tool : '';
  return Boolean(tool) && typeof session.sessionKey === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}:[^|\u0000-\u001f]{1,160}$/.test(session.sessionKey)
    && session.sessionKey.startsWith(`${tool}:`)
    && (session.controlSurface === undefined || session.controlSurface === 'cli')
    && typeof session.client === 'string' && typeof session.title === 'string' && typeof session.cwd === 'string' && Number.isSafeInteger(session.updatedAt)
    && ['idle', 'running', 'waiting_approval', 'failed', 'unknown'].includes(session.status) && typeof session.controllable === 'boolean';
}
function cacheableItem(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== 'string' || !Number.isSafeInteger(item.ts)
    || item.seq !== undefined && (!Number.isSafeInteger(item.seq) || Number(item.seq) < 0)
    || item.orderSeq !== undefined && (!Number.isSafeInteger(item.orderSeq) || Number(item.orderSeq) < 0)) return false;
  switch (item.kind) {
    case 'message': {
      if (item.local || (item.role !== 'user' && item.role !== 'assistant') || typeof item.text !== 'string' || typeof item.final !== 'boolean') return false;
      const imageLimit = item.role === 'user' ? 4 : MAX_OUTPUT_ATTACHMENTS;
      if (!cacheableAttachments(item.attachments, imageLimit)) return false;
      return item.images === undefined || Array.isArray(item.images) && item.images.length <= imageLimit && item.images.every(localImageUri);
    }
    case 'reasoning': return typeof item.text === 'string' && typeof item.final === 'boolean';
    case 'tool': return typeof item.title === 'string' && typeof item.tool === 'string' && ['running', 'done', 'failed'].includes(String(item.status))
      && cacheableAttachments(item.attachments, MAX_OUTPUT_ATTACHMENTS)
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

export function saveCachedThread(scope: string, key: string, timeline: { items: unknown[]; session?: SessionInfo; revertedTurns?:string[]; revertedItems?:string[];revertOperations?:string[] }) {
  markRemoteImagesInUse();
  if (key.includes('|claude-desktop:') || timeline.session?.controlSurface === 'desktop' || timeline.session?.controlSurface === 'read-only') return;
  debounce(scope, `t:${scope}:${key}`, async store => {
    let items = timeline.items.slice(-MAX_ITEMS).map(item => {
      if (!item || typeof item !== 'object' || (item as Record<string, unknown>).kind !== 'message') return item;
      const row = item as Record<string, unknown>;
      return { ...row, contextReferences: messageContextReferences(row.contextReferences, row.role), skills: messageSkills(row.skills, row.role) };
    });
    let json = JSON.stringify({ items, session: timeline.session, revertedTurns:timeline.revertedTurns,revertedItems:timeline.revertedItems,revertOperations:timeline.revertOperations, savedAt: Date.now() } satisfies CachedThread);
    while (json.length > MAX_BYTES && items.length > 20) {
      items = items.slice(Math.floor(items.length / 3));
      json = JSON.stringify({ items, session: timeline.session, revertedTurns:timeline.revertedTurns,revertedItems:timeline.revertedItems,revertOperations:timeline.revertOperations, savedAt: Date.now() } satisfies CachedThread);
    }
    if (json.length > MAX_BYTES) return;
    await store.setSetting(threadKey(scope, key), json);
    await touchIndex(store, scope, key);
  });
}

export async function loadCachedThread(scope: string, key: string): Promise<CachedThread | null> {
  markRemoteImagesInUse();
  const cached = await readJson<CachedThread>(threadKey(scope, key));
  if (!cached || !Array.isArray(cached.items) || cached.items.length > MAX_ITEMS || !Number.isSafeInteger(cached.savedAt)
    || !cacheableSession(cached.session) || cached.session.sessionKey !== key.slice(key.indexOf('|') + 1)) return null;
  return { ...cached, revertOperations:Array.isArray(cached.revertOperations)?cached.revertOperations.filter(id=>typeof id==='string'&&id.length<=512):undefined, revertedTurns:Array.isArray(cached.revertedTurns)?cached.revertedTurns.filter(id=>typeof id==='string'&&id.length<=512):undefined,revertedItems:Array.isArray(cached.revertedItems)?cached.revertedItems.filter(id=>typeof id==='string'&&id.length<=512):undefined, session: sessionMetadata(cached.session), items: cached.items.filter(cacheableItem).map((item) => {
    if (!item || typeof item !== 'object' || ((item as Record<string, unknown>).kind !== 'message' && (item as Record<string, unknown>).kind !== 'tool')) return item;
    const original = item as Record<string, unknown>;
    const row = original.kind === 'message' ? { ...original, contextReferences: messageContextReferences(original.contextReferences, original.role), messageOrigin: messageOrigin(original.messageOrigin), clientId: boundedClientId(original.clientId), skills: messageSkills(original.skills, original.role),
      messagePhase: original.messagePhase === 'commentary' || original.messagePhase === 'final_answer' ? original.messagePhase : undefined } : original;
    if (!Array.isArray(row.attachments)) return row;
    // Never hydrate a cache with an arbitrary URI. Only the local file/content
    // schemes are renderable; remote refs are fetched through attachment.read.
    const attachments = row.attachments.map((value) => {
      if (!value || typeof value !== 'object') return value;
      const ref = value as Record<string, unknown>;
      return ref.uri && /^(?:file|content):/i.test(String(ref.uri)) ? ref : { ...ref, uri: undefined };
    });
    return { ...row, attachments,
      ...(row.kind === 'message' && Array.isArray(row.images) ? { images: row.images.filter(localImageUri) } : {}) };
  }) };
}

export function saveCachedSessions(scope: string, deviceId: string, list: SessionInfo[]) {
  debounce(scope, `s:${scope}:${deviceId}`, async store => {
    const json = JSON.stringify(list.filter((item) => !item.sessionKey.startsWith('claude-desktop:') && item.controlSurface !== 'desktop' && item.controlSurface !== 'read-only').slice(0, 100));
    if (json.length <= MAX_BYTES) await store.setSetting(listKey(scope, deviceId), json);
  });
}

export async function loadCachedSessions(scope: string, deviceId: string): Promise<SessionInfo[] | null> {
  const list = await readJson<SessionInfo[]>(listKey(scope, deviceId));
  return Array.isArray(list) && list.length <= 100 && list.every(cacheableSession) ? list.map(sessionMetadata) : null;
}

/** Forget everything cached for one pairing (on unpair). */
export async function clearRemoteCache(scope: string, deviceIds: string[] = []) {
  retired.add(scope);
  for (const [id, pending] of timers) if (pending.scope === scope) { clearTimeout(pending.timer); timers.delete(id); }
  // Attachment bytes are kept under Expo's filesystem cache and are not part
  // of the SQLite settings cleared below. Remove the exact pairing scope too,
  // otherwise unpairing would leave private screenshots readable on-device.
  clearCachedAttachments(scope);
  await clearDurableEventScope(scope);
  await retireDurableCommandScope(scope);
  // The queue owns exact scoped produced files, not arbitrary picker or
  // history paths. Persist its retirement fence before any late writer runs.
  if (typeof clearRemoteQueuedScope === 'function') await clearRemoteQueuedScope(scope).catch(() => undefined);
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
