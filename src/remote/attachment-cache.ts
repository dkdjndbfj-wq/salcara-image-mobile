import { Directory, File, FileMode, Paths, type FileHandle } from 'expo-file-system';
import { sha256 } from '@noble/hashes/sha2.js';
import { createId } from '../domain-utils';
import type { AttachmentRef } from './client';
import { attachmentBytes, attachmentContentKey, attachmentMagic, attachmentRef, MAX_ATTACHMENT_BYTES } from './attachment-ref';
import { reserveAttachmentCache, touchCachedAttachment } from './attachment-cache-policy';

export type AttachmentPage = { id: string; mime: string; size: number; offset: number; nextOffset: number; complete: boolean; data: string };
type FetchPage = (offset: number, signal: AbortSignal) => Promise<AttachmentPage>;
type Flight = { scope: string; promise: Promise<string>; controller: AbortController; consumers: number };
const reads = new Map<string, Flight>();
// An aborted consumer may leave a native move in flight. Keep disk ownership
// until that move and its cleanup settle before another identical read starts.
const fileOperations = new Map<string, Promise<unknown>>();
const waiters: Array<() => void> = [];
let active = 0;
const cancelled = () => new Error('附件读取已取消');
const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const CACHE_DIRECTORY = 'salcara-remote-attachments';
const scopeHash = (scope: string) => hex(sha256(new TextEncoder().encode(scope))).slice(0, 32);
const retiredScopes = new Set<string>();
let cacheGeneration = 0;
const parentScope = (scope: string) => {
  const separator = scope.indexOf('\u0000');
  return separator > 0 ? scope.slice(0, separator) : scope;
};
/**
 * Materialized attachments are scoped by delivery credential, device and
 * session. Keep the child directory under the credential scope so revoking a
 * pairing can remove all of its session caches without enumerating opaque
 * hashes (and without touching another station's cache).
 *
 * The old, flat layout remains readable for callers that pass a legacy scope;
 * new session scopes contain a NUL separator and use the nested layout.
 */
function scopeDirectory(scope: string): Directory {
  const separator = scope.indexOf('\u0000');
  if (separator > 0) {
    const parent = scope.slice(0, separator);
    return new Directory(Paths.cache, CACHE_DIRECTORY, scopeHash(parent), scopeHash(scope));
  }
  return new Directory(Paths.cache, CACHE_DIRECTORY, scopeHash(scope));
}

/** Validate the JSON boundary before it reaches the file writer.  The Hub is
 * a remote input, so never rely on a TypeScript cast for binary metadata. */
export function parseAttachmentPage(value: unknown): AttachmentPage {
  if (!value || typeof value !== 'object') throw new Error('电脑返回的附件分片无效');
  const raw = value as Record<string, unknown>;
  const page: AttachmentPage = {
    id: typeof raw.id === 'string' ? raw.id : '',
    mime: typeof raw.mime === 'string' ? raw.mime.toLowerCase() : '',
    size: typeof raw.size === 'number' ? raw.size : NaN,
    offset: typeof raw.offset === 'number' ? raw.offset : NaN,
    nextOffset: typeof raw.nextOffset === 'number' ? raw.nextOffset : NaN,
    complete: raw.complete === true,
    data: typeof raw.data === 'string' ? raw.data : '',
  };
  if (!attachmentRef({ id: page.id, mime: page.mime, size: page.size })
    || !Number.isSafeInteger(page.size) || !Number.isSafeInteger(page.offset)
    || !Number.isSafeInteger(page.nextOffset) || page.offset < 0 || page.nextOffset <= page.offset
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(page.data) || page.data.length === 0) {
    throw new Error('电脑返回的附件分片无效');
  }
  return page;
}

async function withReadSlot<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  if (signal.aborted) throw cancelled();
  if (active >= 2) await new Promise<void>((resolve, reject) => {
    const enter = () => { signal.removeEventListener('abort', abort); active += 1; resolve(); };
    const abort = () => { const index = waiters.indexOf(enter); if (index >= 0) waiters.splice(index, 1); reject(cancelled()); };
    if (waiters.length >= 128) { reject(new Error('图片读取队列已满，请稍后重试')); return; }
    waiters.push(enter); signal.addEventListener('abort', abort, { once: true });
  });
  else active += 1;
  try { if (signal.aborted) throw cancelled(); return await run(); }
  finally { active -= 1; waiters.shift()?.(); }
}

function withFileOwnership<T>(key: string, run: () => Promise<T>): Promise<T> {
  const prior = fileOperations.get(key) ?? Promise.resolve();
  const owned = prior.catch(() => undefined).then(run);
  fileOperations.set(key, owned);
  void owned.finally(() => { if (fileOperations.get(key) === owned) fileOperations.delete(key); }).catch(() => undefined);
  return owned;
}

async function download(scope: string, ref: AttachmentRef, fetchPage: FetchPage, signal: AbortSignal): Promise<string> {
  const generation = cacheGeneration;
  const revoked = () => signal.aborted || generation !== cacheGeneration || retiredScopes.has(parentScope(scope));
  if (revoked()) throw cancelled();
  const directory = scopeDirectory(scope);
  directory.create({ idempotent: true, intermediates: true });
  const extension = ref.mime === 'image/png' ? 'png' : ref.mime === 'image/webp' ? 'webp' : 'jpg';
  // A late unverified/older reference must never overwrite a newly verified
  // image using the same attachment id. Each expected content identity owns
  // its final file; display-only metadata does not split the cache.
  const identity = hex(sha256(new TextEncoder().encode(attachmentContentKey(ref))));
  const file = new File(directory, `${ref.id}-${identity}.${extension}`);
  // Older releases used the id alone. Read those files only after validating
  // the current reference, and never write a new download over a legacy URI.
  const legacy = new File(directory, `${ref.id}.${extension}`);
  for (const candidate of [file, legacy]) {
    if (!candidate.exists || (candidate.size ?? 0) <= 0 || (candidate.size ?? 0) > MAX_ATTACHMENT_BYTES
      || ref.size !== undefined && candidate.size !== ref.size) continue;
    const bytes = await candidate.bytes();
    if (revoked()) throw cancelled();
    if (bytes.length > 0 && bytes.length <= MAX_ATTACHMENT_BYTES && (ref.size === undefined || bytes.length === ref.size)
      && attachmentMagic(bytes, ref.mime) && (!ref.sha256 || hex(sha256(bytes)) === ref.sha256)) { touchCachedAttachment(candidate.uri); return candidate.uri; }
  }
  if (signal.aborted) throw cancelled();
  const tmp = new File(directory, `${ref.id}-${createId()}.part`);
  const digest = sha256.create();
  let offset = 0, expectedSize = ref.size, complete = false;
  let handle: FileHandle | undefined;
  const releaseBudget = await reserveAttachmentCache(ref.size ?? MAX_ATTACHMENT_BYTES);
  try {
    tmp.create({ overwrite: true, intermediates: true });
    handle = tmp.open(FileMode.Truncate);
    for (let page = 0; page < 128; page += 1) {
      if (signal.aborted) throw cancelled();
      const result = await fetchPage(offset, signal);
      if (signal.aborted) throw cancelled();
      if (!result || result.id !== ref.id || result.mime !== ref.mime || result.offset !== offset
        || !Number.isSafeInteger(result.size) || result.size <= 0 || result.size > MAX_ATTACHMENT_BYTES
        || !Number.isSafeInteger(result.nextOffset) || result.nextOffset <= offset || result.nextOffset > result.size
        || typeof result.data !== 'string' || typeof result.complete !== 'boolean') throw new Error('电脑返回的附件分片无效');
      if (expectedSize !== undefined && expectedSize !== result.size) throw new Error('附件大小已变更，请重新读取');
      expectedSize = result.size;
      const bytes = attachmentBytes(result.data, 90_000);
      if (result.nextOffset !== offset + bytes.length || result.complete !== (result.nextOffset === expectedSize)) throw new Error('电脑返回了错误的附件游标');
      if (offset === 0 && !attachmentMagic(bytes, ref.mime)) throw new Error('图片内容和类型不符');
      handle.writeBytes(bytes); digest.update(bytes);
      offset = result.nextOffset;
      if (result.complete) { complete = true; break; }
    }
    handle.close(); handle = undefined;
    if (!complete || expectedSize !== offset || tmp.size !== expectedSize) throw new Error('附件读取不完整');
    if (ref.sha256 && hex(digest.digest()) !== ref.sha256) throw new Error('图片校验失败，请重新读取');
    if (signal.aborted) throw cancelled();
    // move() is asynchronous in the installed Expo SDK. Checking exists before
    // awaiting it used to report a false failure or leave an unhandled rejection.
    await tmp.move(file, { overwrite: true });
    // Revocation can win while the native filesystem move is in flight. It
    // cannot be cancelled, so remove its completed target before exposing any
    // URI; otherwise the late rename can recreate bytes after unpair cleanup.
    if (revoked()) {
      try { if (file.exists) file.delete(); } catch { /* only this revoked attachment */ }
      throw cancelled();
    }
    if (!file.exists || file.size !== expectedSize) throw new Error('附件保存失败');
    touchCachedAttachment(file.uri);
    return file.uri;
  } finally {
    releaseBudget();
    handle?.close();
    try { if (tmp.exists && tmp.uri !== file.uri) tmp.delete(); } catch { /* only this incomplete private cache file */ }
  }
}

/** Removes every materialized attachment for a revoked pairing scope.  These
 * files live in the OS cache, not the SQLite cache, so clearing thread records
 * alone would leave private screenshots on disk after an unpair. */
export function clearCachedAttachments(scope: string): void {
  retiredScopes.add(parentScope(scope));
  try {
    const directory = new Directory(Paths.cache, CACHE_DIRECTORY, scopeHash(scope));
    // The first-level scope directory owns every device/session child. This
    // is deliberately an exact hash, not a prefix scan, so a different
    // station or a newly paired credential can never be removed by accident.
    if (directory.exists) directory.delete();
  } catch { /* best effort; the OS may be cleaning the cache concurrently */ }
  // Keep cancellation independent from filesystem cleanup. If the cache
  // directory was already removed (or the OS denied the delete), an in-flight
  // download must still be fenced from recreating it after unpair.
  for (const [key, flight] of reads) {
    if (flight.scope === scope || flight.scope.startsWith(`${scope}\u0000`)) {
      flight.controller.abort();
      if (reads.get(key) === flight) reads.delete(key);
    }
  }
}

/** Two concurrent downloads, shared per credential/device/session/content identity. Each
 * mounted consumer can cancel without aborting another consumer of the image. */
export function cachedAttachment(scope: string, value: AttachmentRef, fetchPage: FetchPage, signal?: AbortSignal): Promise<string> {
  const ref = attachmentRef(value);
  if (!ref || signal?.aborted || retiredScopes.has(parentScope(scope))) return Promise.reject(ref ? cancelled() : new Error('附件编号或元数据无效'));
  const key = `${scope}\u0000${attachmentContentKey(ref)}`;
  let flight = reads.get(key);
  if (!flight || flight.controller.signal.aborted) {
    const controller = new AbortController();
    const created: Flight = { scope, controller, consumers: 0, promise: Promise.resolve('') };
    created.promise = withFileOwnership(key, () => withReadSlot(controller.signal, () => download(scope, ref, fetchPage, controller.signal))).finally(() => {
      if (reads.get(key) === created) reads.delete(key);
    });
    reads.set(key, created); flight = created;
  }
  const joined = flight;
  joined.consumers += 1;
  return new Promise<string>((resolve, reject) => {
    let finished = false;
    const finish = (uri?: string, error?: unknown) => {
      if (finished) return;
      finished = true; signal?.removeEventListener('abort', abort);
      joined.consumers -= 1;
      if (!joined.consumers) joined.controller.abort();
      if (error) reject(error); else resolve(uri!);
    };
    const abort = () => finish(undefined, cancelled());
    signal?.addEventListener('abort', abort, { once: true });
    joined.promise.then(uri => finish(uri), error => finish(undefined, error));
    if (signal?.aborted) abort();
  });
}

/** Test-only lifecycle reset; production pairing scopes remain retired for the
 * process lifetime, even if a late component still holds the old URI. */
export function resetAttachmentCacheForTests(): void {
  cacheGeneration += 1;
  for (const flight of reads.values()) flight.controller.abort();
  reads.clear(); retiredScopes.clear();
  // Preserve pending fileOperations: an old native move still owns its path
  // until its generation check and cleanup finish, including across a reset.
}
