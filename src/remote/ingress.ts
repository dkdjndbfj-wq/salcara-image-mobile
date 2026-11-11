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
  signed_payload?: string; signature?: string;
}
export class IngressIdentityError extends Error {
  constructor() { super('无法确认原远程服务身份，请检查连接信息；已保存的配对和聊天记录保留'); this.name = 'IngressIdentityError'; }
}
class IngressUnavailableError extends Error {
  constructor() { super('暂时无法核验远程入口，请检查网络后重试；已保存的配对保留'); this.name = 'IngressUnavailableError'; }
}
class PublicIngressError extends Error { constructor(readonly status: number) { super('invalid ingress response'); } }
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
  const padding = length % 3 === 1 ? '==' : length % 3 === 2 ? '=' : '';
  if (index !== length || (buffer & ((1 << bits) - 1)) !== 0 || value.length - value.replace(/=+$/, '').length !== padding.length) throw new Error('invalid ingress encoding');
  return bytes;
}
export function parseIngressManifest(value: unknown, canonical: string, now = Date.now(), allowExpired = false, requireLogicalMembership = true): IngressManifest {
  let signature: { signed_payload: string; signature: string } | undefined;
  if (record(value) && ('signed_payload' in value || 'signature' in value)) {
    if (typeof value.signed_payload !== 'string' || value.signed_payload.length > 12_000) throw new Error('invalid signed ingress manifest');
    const length = value.signed_payload.length / 4 * 3 - (value.signed_payload.endsWith('==') ? 2 : value.signed_payload.endsWith('=') ? 1 : 0);
    const payload = base64(value.signed_payload, length), decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
    if (!record(decoded) || 'signed_payload' in decoded || 'signature' in decoded) throw new Error('invalid signed ingress payload');
    const prefix = new TextEncoder().encode('salcara-ingress-manifest-v1\n'), message = new Uint8Array(prefix.length + payload.length);
    message.set(prefix); message.set(payload, prefix.length);
    if (!verify(base64(value.signature, 64), message, base64(decoded.identity_public_key, 32), { zip215: false })) throw new Error('invalid ingress signature');
    signature = { signed_payload: value.signed_payload, signature: value.signature as string };
    value = decoded; // Only signed fields may authorize forwarding credentials.
  }
  const manifestCanonical = signature && record(value) ? value.canonical_url : canonical;
  if (!apiUrl(canonical) || !apiUrl(manifestCanonical) || !record(value) || value.version !== 1 || value.canonical_url !== manifestCanonical
    || typeof value.hub_instance_id !== 'string' || !/^[a-f0-9]{32}$/.test(value.hub_instance_id)
    || !integer(value.revision) || value.revision < 1 || !integer(value.issued_at) || !integer(value.expires_at)
    || value.issued_at > now + SKEW || !allowExpired && value.expires_at <= now || value.expires_at <= value.issued_at || value.expires_at - value.issued_at > DAY
    || !Array.isArray(value.endpoints) || value.endpoints.length < 1 || value.endpoints.length > 8) throw new Error('invalid ingress manifest');
  base64(value.identity_public_key, 32);
  const ids = new Set(), urls = new Set();
  const endpoints = value.endpoints.map(endpoint => {
    if (!record(endpoint) || typeof endpoint.id !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(endpoint.id) || !apiUrl(endpoint.url)
      || !integer(endpoint.priority) || endpoint.priority > 1000 || ids.has(endpoint.id) || urls.has(endpoint.url)) throw new Error('invalid ingress endpoint');
    ids.add(endpoint.id); urls.add(endpoint.url); return { id: endpoint.id, url: endpoint.url, priority: endpoint.priority };
  });
  if (!endpoints.some(endpoint => endpoint.id === 'canonical' && endpoint.url === manifestCanonical)) throw new Error('missing canonical ingress');
  if (signature && requireLogicalMembership && !endpoints.some(endpoint => endpoint.url === canonical)) throw new Error('logical ingress is not authorized');
  return { version: 1, hub_instance_id: value.hub_instance_id, identity_public_key: value.identity_public_key as string, canonical_url: manifestCanonical,
    revision: value.revision, issued_at: value.issued_at, expires_at: value.expires_at, endpoints, ...signature };
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
interface Entry { manifest?: IngressManifest; epoch: number; confirming?: number; invalidIdentity?: boolean; loaded: Promise<void>; refreshing?: Promise<void>; initialAnchor?: string; retryAt: number; lastRefreshAt: number; hintCursor: number; proofCursor: number; lastSuccess?: string; failed: Map<string, number>; leases: Map<string, number>; proofs: Map<string, Promise<void>> }
/** Only transport URLs change. Canonical identity, credentials, cursors and receipts stay with callers. */
export function createIngressRouter(options: { fetch: FetchLike; nonce: () => string; storage?: Storage; now?: () => number }) {
  const now = options.now ?? Date.now, entries = new Map<string, Entry>();
  // Cache eviction must not split writes to one durable pin into independent
  // queues. Retain only active storage tails, including an already-started write.
  const persisting = new Map<string, Promise<void>>();
  function entry(canonical: string): Entry {
    const cached = entries.get(canonical); if (cached) return cached;
    const value: Entry = { epoch: 0, loaded: Promise.resolve(), retryAt: 0, lastRefreshAt: -Infinity, hintCursor: 0, proofCursor: 0, failed: new Map(), leases: new Map(), proofs: new Map() };
    entries.set(canonical, value); if (entries.size > 32) entries.delete(entries.keys().next().value!);
    value.loaded = (async () => { try { const raw = await options.storage?.read(canonical); if (raw && raw.length <= MAX_BODY && !value.manifest) value.manifest = parseIngressManifest(JSON.parse(raw), canonical, now(), true, false); } catch { /* An expired valid cache retains its pin, but cannot authorize an alternate. */ } })();
    return value;
  }
  function persist(canonical: string, current: Entry, manifest: IngressManifest | undefined, epoch: number, active: () => boolean = () => true): Promise<void> {
    const next = (persisting.get(canonical) ?? Promise.resolve()).then(async () => {
      if (entries.get(canonical) === current && current.epoch === epoch && active()) await options.storage?.write(canonical, JSON.stringify(manifest ?? {}));
    });
    const settled = next.catch(() => undefined);
    persisting.set(canonical, settled);
    void settled.then(() => { if (persisting.get(canonical) === settled) persisting.delete(canonical); });
    return next;
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
        if (!response.ok) throw new PublicIngressError(response.status);
        if (response.redirected || response.url && response.url !== url) throw new Error('invalid ingress response');
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
  async function refresh(canonical: string, expectedPin?: { instanceId: string; publicKey: string }): Promise<void> {
    if (!apiUrl(canonical)) return;
    const anchor = expectedPin ? { ...expectedPin } : undefined;
    if (anchor) {
      if (!/^[a-f0-9]{32}$/.test(anchor.instanceId)) throw new IngressIdentityError();
      try { base64(anchor.publicKey, 32); } catch { throw new IngressIdentityError(); }
    }
    const anchorKey = anchor ? JSON.stringify([anchor.instanceId, anchor.publicKey]) : undefined;
    const current = entry(canonical); await current.loaded;
    if (current.confirming !== undefined) return;
    const matchesAnchor = () => !anchor || !current.manifest || current.manifest.hub_instance_id === anchor.instanceId && current.manifest.identity_public_key === anchor.publicKey;
    if (!matchesAnchor()) throw new IngressIdentityError();
    if (current.refreshing) {
      await current.refreshing;
      if (!matchesAnchor()) throw new IngressIdentityError();
      if (!anchor || current.manifest || current.initialAnchor === anchorKey || current.confirming !== undefined) return;
      // An unanchored public probe may have rejected a signed move that no
      // longer lists the old URL. Retry once using the saved group's anchor.
      if (current.refreshing) return current.refreshing;
    }
    const anchoredInitial = Boolean(anchor && !current.manifest);
    if (current.retryAt > now() && (!anchoredInitial || current.initialAnchor === anchorKey)) return;
    if (anchoredInitial) current.initialAnchor = anchorKey;
    current.lastRefreshAt = now();
    current.retryAt = now() + 60_000;
    const epoch = current.epoch;
    // Expired signed entries are anonymous discovery hints only, not authority
    // to forward credentials. Never use endpoints from unsigned metadata.
    const previous = current.manifest;
    const primary = [...new Set([current.lastSuccess, canonical].filter((url): url is string => Boolean(url)))];
    const hints = previous?.signature ? previous.endpoints.map(item => item.url).filter(url => !primary.includes(url)) : [];
    const offset = hints.length ? current.hintCursor % hints.length : 0;
    const candidates = [...primary, ...hints.slice(offset), ...hints.slice(0, offset)].slice(0, 8);
    // A retired logical/last-success URL can add two slots to the eight signed
    // members. Rotate the remaining slots so no surviving hint is starved.
    if (hints.length) current.hintCursor = (offset + candidates.length - primary.length) % hints.length;
    current.refreshing = (async () => {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
      let identityMismatch = false;
      let newest: IngressManifest | undefined;
      try {
        // Three bounded anonymous probes at a time can examine all eight
        // hints within the eight-second round, even when early hosts hang.
        for (let start = 0; start < candidates.length; start += 3) {
          if (current.epoch !== epoch) return;
          if (controller.signal.aborted) break;
          const batch = candidates.slice(start, start + 3);
          const responses = await Promise.allSettled(batch.map(candidate => publicJson(`${candidate}/ingress/manifest`, controller.signal)));
          if (current.epoch !== epoch) return;
          if (controller.signal.aborted) break;
          for (const [index, result] of responses.entries()) {
            if (result.status !== 'fulfilled') continue;
            const candidate = batch[index];
            try {
              const old = current.manifest;
              const manifest = parseIngressManifest(result.value, canonical, now(), false, !old && !anchoredInitial);
              if (anchoredInitial && (!manifest.signature || manifest.hub_instance_id !== anchor!.instanceId || manifest.identity_public_key !== anchor!.publicKey)) {
                identityMismatch = true; continue;
              }
              if (old && (old.hub_instance_id !== manifest.hub_instance_id || old.identity_public_key !== manifest.identity_public_key)) {
                identityMismatch = true; continue;
              }
              if (old && (manifest.revision < old.revision || old.signature && !manifest.signature)) continue;
              if (candidate !== canonical && !manifest.signature) continue;
              // An old but still valid entry must not hide a newer signed
              // migration returned elsewhere in this same bounded round.
              if (!newest || manifest.revision > newest.revision
                || manifest.revision === newest.revision && manifest.expires_at > newest.expires_at) newest = manifest;
            } catch { /* Try another pinned hint; malformed/expired data is not proof of replacement. */ }
          }
        }
        if (current.epoch !== epoch) return;
        const old = current.manifest;
        if (newest && newest.expires_at > now() && (!old || newest.hub_instance_id === old.hub_instance_id
          && newest.identity_public_key === old.identity_public_key && newest.revision >= old.revision && (!old.signature || newest.signature))) {
          current.invalidIdentity = false;
          current.manifest = newest; current.leases.clear(); current.failed.clear();
          current.retryAt = Math.min(now() + 6 * 60 * 60_000, Math.max(now(), newest.expires_at - 60_000));
          await persist(canonical, current, newest, epoch).catch(() => undefined);
        } else if (current.manifest === previous && identityMismatch) current.invalidIdentity = true;
      } finally { clearTimeout(timer); current.refreshing = undefined; }
    })();
    await current.refreshing;
    if (anchor && !current.manifest && current.invalidIdentity) throw new IngressIdentityError();
  }
  function fail(canonical: string, endpoint: string) {
    const value = entries.get(canonical); value?.failed.set(endpoint, now() + 30_000); value?.leases.delete(endpoint);
    // A failed route may have moved again; permit a renewal without scanning on
    // every request. A refresh round still has a one-minute failure backoff.
    if (value) value.retryAt = Math.min(value.retryAt, value.lastRefreshAt + 60_000);
  }
  async function prove(canonical: string, current: Entry, manifest: IngressManifest, endpoint: string) {
    const pending = current.proofs.get(endpoint); if (pending) return pending;
    const task = Promise.resolve().then(async () => {
      try {
        const nonce = options.nonce();
        if (!/^[a-f0-9]{64}$/.test(nonce)) throw new Error('invalid ingress nonce');
        const proof = await publicJson(`${endpoint}/ingress/identity?nonce=${nonce}`);
        const trusted = current.manifest;
        const checkedAt = now();
        if (manifest.expires_at <= checkedAt || record(proof) && integer(proof.expires_at) && proof.expires_at <= checkedAt) throw new IngressUnavailableError();
        if (!verifyIngressProof(proof, manifest, nonce, checkedAt)) throw new IngressIdentityError();
        if (!trusted || trusted.hub_instance_id !== manifest.hub_instance_id
          || trusted.identity_public_key !== manifest.identity_public_key || !trusted.endpoints.some(item => item.url === endpoint)
          || trusted.expires_at <= now()) throw new IngressUnavailableError();
        current.leases.set(endpoint, Math.min((proof as { expires_at: number }).expires_at, manifest.expires_at, trusted.expires_at, now() + 10_000));
        current.invalidIdentity = false;
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
    // Rotate attempted entries too: a polling interval above the cooldown
    // must not indefinitely retry only the same first three dead endpoints.
    let checks = 0;
    const endpoints = [...manifest.endpoints].sort((a, b) => a.priority - b.priority);
    const start = current.proofCursor % endpoints.length;
    for (let index = 0; index < endpoints.length; index++) {
      const position = (start + index) % endpoints.length, endpoint = endpoints[position];
      if (signal?.aborted) throw new Error('ingress cancelled');
      if ((current.failed.get(endpoint.url) ?? 0) > now()) continue;
      if (endpoint.url === canonical) { current.proofCursor = (position + 1) % endpoints.length; return canonical; }
      if (!manifest.signature) continue;
      if ((current.leases.get(endpoint.url) ?? 0) > now()) return endpoint.url;
      if (++checks > 3) break;
      current.proofCursor = (position + 1) % endpoints.length;
      try {
        await prove(canonical, current, manifest, endpoint.url);
        if (signal?.aborted) throw new Error('ingress cancelled');
        if ((current.leases.get(endpoint.url) ?? 0) > now()) { current.proofCursor = position; return endpoint.url; }
      } catch { if (signal?.aborted) throw new Error('ingress cancelled'); }
    }
    // Canonical is the original, user-trusted address; it needs no alternate authorization.
    if (signal?.aborted) throw new Error('ingress cancelled'); return canonical;
  }
  async function fetch(canonical: string, path: string, init: Record<string, unknown>) {
    if (!path.startsWith('/') || path.startsWith('//') || /[\\\r\n]/.test(path)) throw new Error('invalid ingress path');
    const signal = init.signal as AbortSignal | undefined, attempts = String(init.method ?? 'GET').toUpperCase() === 'GET' ? 2 : 1;
    const headers = init.headers as Record<string, unknown> | undefined;
    const authenticated = headers && Object.keys(headers).some(key => /^(authorization|x-salcara-(pair|bot)-token)$/i.test(key) && headers[key]);
    const current = entry(canonical); await current.loaded;
    if (authenticated) {
      await refresh(canonical);
      if (current.manifest && current.manifest.expires_at <= now()) throw current.invalidIdentity ? new IngressIdentityError() : new IngressUnavailableError();
    }
    let last: unknown;
    for (let index = 0; index < attempts; index++) {
      let endpoint = await resolve(canonical, signal);
      if (authenticated && current.manifest && endpoint === canonical && (current.leases.get(canonical) ?? 0) <= now()) {
        try { await prove(canonical, current, current.manifest, canonical); }
        catch (error) {
          endpoint = await resolve(canonical, signal);
          if (endpoint === canonical) throw error instanceof IngressIdentityError ? error : current.invalidIdentity ? new IngressIdentityError() : new IngressUnavailableError();
        }
      }
      if (signal?.aborted) throw new Error('ingress cancelled');
      if (authenticated && current.manifest && (current.manifest.expires_at <= now()
        || !current.manifest.endpoints.some(item => item.url === endpoint)
        || (current.leases.get(endpoint) ?? 0) <= now())) throw new IngressUnavailableError();
      try {
        const response = await options.fetch(`${endpoint}${path}`, { ...init, redirect: 'error', credentials: 'omit' });
        if (response.status >= 300 && response.status < 400 || response.redirected || response.url && response.url !== `${endpoint}${path}`) { fail(canonical, endpoint); throw new Error('ingress redirect rejected'); }
        if ([502, 503, 504].includes(response.status)) { fail(canonical, endpoint); if (index + 1 < attempts && entries.get(canonical)?.manifest?.expires_at! > now()) continue; }
        if (response.ok) {
          current.lastSuccess = endpoint;
          if (authenticated) current.invalidIdentity = false;
          current.proofCursor = Math.max(0, [...(current.manifest?.endpoints ?? [])].sort((a, b) => a.priority - b.priority).findIndex(item => item.url === endpoint));
        }
        return { response, endpoint };
      } catch (error) { last = error; if (!signal?.aborted) fail(canonical, endpoint); if (signal?.aborted || (entries.get(canonical)?.manifest?.expires_at ?? 0) <= now() || index + 1 >= attempts) throw error; }
    }
    throw last;
  }
  async function verifyAlias(canonical: string, candidate: string): Promise<boolean> {
    if (!apiUrl(canonical) || !apiUrl(candidate)) return false;
    const current = entry(canonical); await current.loaded; await refresh(canonical);
    const pin = current.manifest, epoch = current.epoch;
    if (!pin || current.confirming !== undefined) return false;
    try {
      const next = parseIngressManifest(await publicJson(`${candidate}/ingress/manifest`), canonical, now(), false, false);
      if (!next.signature || next.hub_instance_id !== pin.hub_instance_id || next.identity_public_key !== pin.identity_public_key
        || next.revision < pin.revision || !next.endpoints.some(endpoint => endpoint.url === candidate)) return false;
      const nonce = options.nonce();
      const proof = await publicJson(`${candidate}/ingress/identity?nonce=${nonce}`);
      if (!verifyIngressProof(proof, next, nonce, now()) || current.manifest !== pin || current.epoch !== epoch || current.confirming !== undefined) return false;
      current.manifest = next; current.invalidIdentity = false; current.leases.clear(); current.failed.clear();
      current.leases.set(candidate, Math.min(next.expires_at, (proof as { expires_at: number }).expires_at, now() + 10_000));
      await persist(canonical, current, next, current.epoch);
      return true;
    } catch { return false; }
  }
  /** Import a native watcher's signed routing cache, never a new identity or a
   * credential. Expired lists are only hints; fetch still renews and proves. */
  async function adoptPinnedManifest(canonical: string, value: unknown, active: () => boolean): Promise<boolean> {
    if (!apiUrl(canonical) || !active()) return false;
    const current = entry(canonical); await current.loaded;
    if (!active()) return false;
    const pin = current.manifest, epoch = current.epoch;
    if (!pin || current.confirming !== undefined) return false;
    try {
      const next = parseIngressManifest(value, canonical, now(), true, false);
      if (!next.signature || next.hub_instance_id !== pin.hub_instance_id || next.identity_public_key !== pin.identity_public_key
        || next.revision < pin.revision || next.revision === pin.revision && next.expires_at < pin.expires_at) return false;
      if (!active() || current.epoch !== epoch) return false;
      current.manifest = next; current.leases.clear(); current.failed.clear(); current.retryAt = 0;
      await persist(canonical, current, next, epoch, active);
      return active() && current.epoch === epoch;
    } catch { return false; }
  }
  /** A saved Bot group may restore routing with its own durable identity even
   * when the shared cache is empty. It cannot replace another binding's pin. */
  async function adoptPinnedBotManifest(canonical: string, value: unknown, expectedPin: { instanceId: string; publicKey: string }, active: () => boolean): Promise<boolean> {
    if (!apiUrl(canonical) || !active()) return false;
    const anchor = { ...expectedPin };
    try {
      if (!/^[a-f0-9]{32}$/.test(anchor.instanceId)) return false;
      base64(anchor.publicKey, 32);
      const current = entry(canonical); await current.loaded;
      const previous = current.manifest, epoch = current.epoch;
      const matches = (manifest: IngressManifest) => manifest.hub_instance_id === anchor.instanceId && manifest.identity_public_key === anchor.publicKey;
      const wanted = () => active() && entries.get(canonical) === current && current.epoch === epoch
        && current.confirming === undefined && current.manifest === previous;
      if (!wanted() || previous && !matches(previous)) return false;
      const next = parseIngressManifest(value, canonical, now(), true, false);
      if (!next.signature || !matches(next) || previous && (next.revision < previous.revision
        || next.revision === previous.revision && next.expires_at < previous.expires_at)) return false;
      // Save only public, signed routing metadata. This grants no proof lease;
      // the first authenticated request must still renew/prove its endpoint.
      await persist(canonical, current, next, epoch, wanted);
      if (!wanted()) return false;
      current.manifest = next; current.leases.clear(); current.failed.clear(); current.retryAt = 0;
      return true;
    } catch { return false; }
  }
  /** A successful, explicitly confirmed new QR binding may replace a reset Hub's pin. */
  async function confirmPairingIdentity(canonical: string, active: () => boolean): Promise<void> {
    const current = entry(canonical); await current.loaded;
    if (!active()) return;
    const epoch = ++current.epoch;
    current.confirming = epoch;
    try {
      let next: IngressManifest | undefined;
      try { next = parseIngressManifest(await publicJson(`${canonical}/ingress/manifest`), canonical, now()); }
      catch (error) {
        if (!(error instanceof PublicIngressError && error.status === 404) && current.manifest) throw new IngressIdentityError();
      }
      if (!active() || current.epoch !== epoch) return;
      await persist(canonical, current, next, epoch, active);
      if (!active() || current.epoch !== epoch) return;
      current.manifest = next; current.invalidIdentity = false; current.leases.clear(); current.failed.clear();
      current.retryAt = now() + (next ? 6 * 60 * 60_000 : 60_000);
    } finally { if (current.confirming === epoch) current.confirming = undefined; }
  }
  function pinSnapshot(canonical: string): IngressManifest | undefined {
    const value = entries.get(canonical)?.manifest;
    return value ? JSON.parse(JSON.stringify(value.signature ? value : { ...value, endpoints: value.endpoints.filter(endpoint => endpoint.url === canonical) })) : undefined;
  }
  return { refresh, resolve, fetch, fail, verifyAlias, adoptPinnedManifest, adoptPinnedBotManifest, confirmPairingIdentity, pinSnapshot,
    isConfirming(canonical: string): boolean { return entries.get(canonical)?.confirming !== undefined; },
    hasIdentityMismatch(canonical: string): boolean { return entries.get(canonical)?.invalidIdentity === true; },
    isVerifiedPinnedEndpoint(canonical: string, endpoint: string, expected: { instanceId: string; publicKey: string }): boolean {
      const current = entries.get(canonical), manifest = current?.manifest;
      return Boolean(current && current.confirming === undefined && !current.invalidIdentity && manifest?.signature && manifest.expires_at > now()
        && manifest.hub_instance_id === expected.instanceId && manifest.identity_public_key === expected.publicKey
        && manifest.endpoints.some(item => item.url === endpoint) && (current.leases.get(endpoint) ?? 0) > now());
    },
    snapshot(canonical: string): IngressManifest | undefined { const value = entries.get(canonical)?.manifest; return value && value.expires_at > now() ? pinSnapshot(canonical) : undefined; } };
}
