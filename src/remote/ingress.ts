import { hashes, verify } from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { canonicalHubUrl } from './pairing';
import type { FetchLike } from './client';

hashes.sha512 = sha512;
const DAY = 86_400_000, SKEW = 30_000, MAX_BODY = 16_384;
export interface IngressManifest {
  version: 1; hub_instance_id: string; identity_public_key: string; canonical_url: string;
  revision: number; issued_at: number; expires_at: number;
  endpoints: Array<{ id: string; url: string; priority: number }>;
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function apiUrl(value: unknown): value is string {
  try { return typeof value === 'string' && value.startsWith('https://') && canonicalHubUrl(value) === value; } catch { return false; }
}
function base64(value: unknown, length: number): Uint8Array {
  if (typeof value !== 'string' || value.length !== Math.ceil(length / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('invalid ingress encoding');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', bytes = new Uint8Array(length);
  let bits = 0, buffer = 0, index = 0;
  for (const char of value.replace(/=+$/, '')) { buffer = (buffer << 6) | alphabet.indexOf(char); bits += 6; if (bits >= 8) { bits -= 8; if (index >= length) throw new Error('invalid ingress encoding'); bytes[index++] = (buffer >> bits) & 255; } }
  if (index !== length || (buffer & ((1 << bits) - 1)) !== 0 || !value.endsWith(length % 3 === 1 ? '==' : '=')) throw new Error('invalid ingress encoding');
  return bytes;
}
export function parseIngressManifest(value: unknown, canonical: string, now = Date.now()): IngressManifest {
  if (!apiUrl(canonical) || !record(value) || value.version !== 1 || value.canonical_url !== canonical
    || typeof value.hub_instance_id !== 'string' || !/^[a-f0-9]{32}$/.test(value.hub_instance_id)
    || !integer(value.revision) || !integer(value.issued_at) || !integer(value.expires_at)
    || value.issued_at > now + SKEW || value.expires_at <= now || value.expires_at <= value.issued_at || value.expires_at - value.issued_at > DAY
    || !Array.isArray(value.endpoints) || value.endpoints.length < 1 || value.endpoints.length > 8) throw new Error('invalid ingress manifest');
  base64(value.identity_public_key, 32);
  const ids = new Set(), urls = new Set();
  const endpoints = value.endpoints.map(endpoint => {
    if (!record(endpoint) || typeof endpoint.id !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(endpoint.id) || !apiUrl(endpoint.url)
      || !integer(endpoint.priority) || endpoint.priority > 1000 || ids.has(endpoint.id) || urls.has(endpoint.url)) throw new Error('invalid ingress endpoint');
    ids.add(endpoint.id); urls.add(endpoint.url); return { id: endpoint.id, url: endpoint.url, priority: endpoint.priority };
  });
  if (!endpoints.some(endpoint => endpoint.id === 'canonical' && endpoint.url === canonical)) throw new Error('missing canonical ingress');
  return { version: 1, hub_instance_id: value.hub_instance_id, identity_public_key: value.identity_public_key as string, canonical_url: canonical,
    revision: value.revision, issued_at: value.issued_at, expires_at: value.expires_at, endpoints };
}
export function verifyIngressProof(value: unknown, manifest: IngressManifest, nonce: string, now = Date.now()): boolean {
  try {
    if (!/^[a-f0-9]{64}$/.test(nonce) || !record(value) || value.version !== 1 || value.hub_instance_id !== manifest.hub_instance_id || value.nonce !== nonce
      || !integer(value.issued_at) || !integer(value.expires_at) || value.issued_at > now + SKEW || value.issued_at < now - SKEW
      || value.expires_at <= now || value.expires_at <= value.issued_at || value.expires_at - value.issued_at > 30_000 || manifest.expires_at <= now) return false;
    const message = new TextEncoder().encode(`salcara-ingress-proof-v1\n${manifest.hub_instance_id}\n${nonce}\n${value.issued_at}\n${value.expires_at}`);
    return verify(base64(value.signature, 64), message, base64(manifest.identity_public_key, 32), { zip215: false });
  } catch { return false; }
}

interface Storage { read(canonical: string): Promise<string | null>; write(canonical: string, value: string): Promise<void> }
interface Entry { manifest?: IngressManifest; loaded: Promise<void>; refreshing?: Promise<void>; retryAt: number; failed: Map<string, number>; leases: Map<string, number>; proofs: Map<string, Promise<void>> }
/** Only transport URLs change. Canonical identity, credentials, cursors and receipts stay with callers. */
export function createIngressRouter(options: { fetch: FetchLike; nonce: () => string; storage?: Storage; now?: () => number }) {
  const now = options.now ?? Date.now, entries = new Map<string, Entry>();
  function entry(canonical: string): Entry {
    const cached = entries.get(canonical); if (cached) return cached;
    const value: Entry = { loaded: Promise.resolve(), retryAt: 0, failed: new Map(), leases: new Map(), proofs: new Map() };
    entries.set(canonical, value); if (entries.size > 32) entries.delete(entries.keys().next().value!);
    value.loaded = (async () => { try { const raw = await options.storage?.read(canonical); if (raw && raw.length <= MAX_BODY && !value.manifest) value.manifest = parseIngressManifest(JSON.parse(raw), canonical, now()); } catch { /* Missing, expired or invalid cache never authorizes an alternate. */ } })();
    return value;
  }
  async function publicJson(url: string, signal?: AbortSignal): Promise<unknown> {
    const controller = new AbortController(), abort = () => controller.abort();
    if (signal?.aborted) controller.abort(); else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 2500);
    const aborted = new Promise<never>((_, reject) => { if (controller.signal.aborted) reject(new Error('ingress cancelled')); else controller.signal.addEventListener('abort', () => reject(new Error('ingress cancelled')), { once: true }); });
    try {
      return await Promise.race([aborted, (async () => {
        if (controller.signal.aborted) throw new Error('ingress cancelled');
        const response = await options.fetch(url, { method: 'GET', headers: { Accept: 'application/json' }, credentials: 'omit', redirect: 'error', signal: controller.signal });
        if (!response.ok || response.redirected || response.url && response.url !== url) throw new Error('invalid ingress response');
        if (Number(response.headers?.get?.('content-length')) > MAX_BODY) throw new Error('invalid ingress response');
        const reader = (response.body as { getReader?: () => { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel?(): Promise<unknown> } } | undefined)?.getReader?.();
        let raw = '';
        if (reader) {
          let length = 0;
          const decoder = new TextDecoder(), stop = () => { void reader.cancel?.().catch(() => undefined); };
          controller.signal.addEventListener('abort', stop, { once: true });
          try {
            while (true) {
              if (controller.signal.aborted) throw new Error('ingress cancelled');
              const part = await reader.read(); if (part.done) break;
              if (!(part.value instanceof Uint8Array) || (length += part.value.byteLength) > MAX_BODY) throw new Error('invalid ingress response');
              raw += decoder.decode(part.value, { stream: true });
            }
            raw += decoder.decode();
          } finally { controller.signal.removeEventListener('abort', stop); stop(); }
        } else raw = response.text ? await response.text() : JSON.stringify(await response.json?.());
        if (!raw || raw.length > MAX_BODY) throw new Error('invalid ingress response'); return JSON.parse(raw);
      })()]);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  async function refresh(canonical: string): Promise<void> {
    if (!apiUrl(canonical)) return;
    const current = entry(canonical); await current.loaded;
    if (current.refreshing) return current.refreshing;
    if (current.retryAt > now()) return;
    current.retryAt = now() + 60_000;
    current.refreshing = (async () => {
      try {
        const manifest = parseIngressManifest(await publicJson(`${canonical}/ingress/manifest`), canonical, now()), old = current.manifest;
        if (old && (old.hub_instance_id !== manifest.hub_instance_id || old.identity_public_key !== manifest.identity_public_key || manifest.revision < old.revision)) return;
        current.manifest = manifest; current.leases.clear(); current.failed.clear(); current.retryAt = now() + 6 * 60 * 60_000;
        await options.storage?.write(canonical, JSON.stringify(manifest));
      } catch { /* Original canonical remains usable; stale authority is never extended. */ }
      finally { current.refreshing = undefined; }
    })();
    return current.refreshing;
  }
  function fail(canonical: string, endpoint: string) { const value = entries.get(canonical); value?.failed.set(endpoint, now() + 30_000); value?.leases.delete(endpoint); }
  async function prove(canonical: string, current: Entry, manifest: IngressManifest, endpoint: string) {
    const pending = current.proofs.get(endpoint); if (pending) return pending;
    const task = Promise.resolve().then(async () => {
      try {
        const nonce = options.nonce();
        if (!/^[a-f0-9]{64}$/.test(nonce)) throw new Error('invalid ingress nonce');
        const proof = await publicJson(`${endpoint}/ingress/identity?nonce=${nonce}`);
        const trusted = current.manifest;
        if (!verifyIngressProof(proof, manifest, nonce, now()) || !trusted || trusted.hub_instance_id !== manifest.hub_instance_id
          || trusted.identity_public_key !== manifest.identity_public_key || !trusted.endpoints.some(item => item.url === endpoint)
          || trusted.expires_at <= now()) throw new Error('unverified ingress');
        current.leases.set(endpoint, Math.min((proof as { expires_at: number }).expires_at, manifest.expires_at, trusted.expires_at, now() + 10_000));
      } catch (error) { fail(canonical, endpoint); throw error; }
      finally { current.proofs.delete(endpoint); }
    });
    current.proofs.set(endpoint, task); return task;
  }
  async function resolve(canonical: string, signal?: AbortSignal): Promise<string> {
    if (!apiUrl(canonical)) return canonical;
    const current = entry(canonical); await current.loaded;
    if (signal?.aborted) throw new Error('ingress cancelled');
    const manifest = current.manifest;
    if (!manifest || manifest.expires_at <= now()) { if (manifest) void refresh(canonical); return canonical; }
    // At most three public checks per call. Failed entries cool down so the next
    // request can try the remaining entries without an unbounded serial delay.
    let checks = 0;
    for (const endpoint of [...manifest.endpoints].sort((a, b) => a.priority - b.priority)) {
      if (signal?.aborted) throw new Error('ingress cancelled');
      if ((current.failed.get(endpoint.url) ?? 0) > now()) continue;
      if (endpoint.url === canonical) return canonical;
      if ((current.leases.get(endpoint.url) ?? 0) > now()) return endpoint.url;
      if (++checks > 3) break;
      try {
        await prove(canonical, current, manifest, endpoint.url);
        if (signal?.aborted) throw new Error('ingress cancelled');
        if ((current.leases.get(endpoint.url) ?? 0) > now()) return endpoint.url;
      } catch { if (signal?.aborted) throw new Error('ingress cancelled'); }
    }
    // Canonical is the original, user-trusted address; it needs no alternate authorization.
    if (signal?.aborted) throw new Error('ingress cancelled'); return canonical;
  }
  async function fetch(canonical: string, path: string, init: Record<string, unknown>) {
    if (!path.startsWith('/') || path.startsWith('//') || /[\\\r\n]/.test(path)) throw new Error('invalid ingress path');
    const signal = init.signal as AbortSignal | undefined, attempts = String(init.method ?? 'GET').toUpperCase() === 'GET' ? 2 : 1;
    let last: unknown;
    for (let index = 0; index < attempts; index++) {
      const endpoint = await resolve(canonical, signal);
      if (signal?.aborted) throw new Error('ingress cancelled');
      try {
        const response = await options.fetch(`${endpoint}${path}`, { ...init, redirect: 'error', credentials: 'omit' });
        if (response.status >= 300 && response.status < 400 || response.redirected || response.url && response.url !== `${endpoint}${path}`) { fail(canonical, endpoint); throw new Error('ingress redirect rejected'); }
        if ([502, 503, 504].includes(response.status)) { fail(canonical, endpoint); if (index + 1 < attempts && entries.get(canonical)?.manifest?.expires_at! > now()) continue; }
        return { response, endpoint };
      } catch (error) { last = error; if (!signal?.aborted) fail(canonical, endpoint); if (signal?.aborted || (entries.get(canonical)?.manifest?.expires_at ?? 0) <= now() || index + 1 >= attempts) throw error; }
    }
    throw last;
  }
  return { refresh, resolve, fetch, fail, snapshot(canonical: string): IngressManifest | undefined { const value = entries.get(canonical)?.manifest; return value && value.expires_at > now() ? JSON.parse(JSON.stringify(value)) : undefined; } };
}
