import { generateKeyPairSync, sign } from 'node:crypto';
import { createIngressRouter, IngressIdentityError, type IngressManifest } from '../remote/ingress';
import { confirmPairingHubIdentity, discoverSavedStation, discoverStation, setHubFetch } from '../remote/client';

const canonical = 'https://network186.example/salcara-hub/v1', backup = 'https://backup186.example/salcara-hub/v1';
const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
const hubId = 'a'.repeat(32), nextId = 'e'.repeat(32), nonce = 'b'.repeat(64);
const json = (value: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(value) });
const discovery = { service: 'salcara-hub', protocol: 'salcara-remote', protocolVersion: 1, authModes: ['device-pairing'],
  capabilities: ['device.identity.v1', 'pair.qr.v1', 'session.remote.v1', 'pair.revoke.v1'] };
function manifest(patch: Partial<IngressManifest> = {}): IngressManifest {
  const value = { version: 1 as const, hub_instance_id: hubId, identity_public_key: publicKey, canonical_url: canonical, revision: 3,
    issued_at: Date.now(), expires_at: Date.now() + 86_400_000,
    endpoints: [{ id: 'canonical', url: canonical, priority: 100 }, { id: 'backup', url: backup, priority: 50 }], ...patch };
  const bytes = Buffer.from(JSON.stringify(value));
  return { ...value, signed_payload: bytes.toString('base64'),
    signature: sign(null, Buffer.concat([Buffer.from('salcara-ingress-manifest-v1\n'), bytes]), keys.privateKey).toString('base64') };
}
function proof(n = nonce, id = hubId) {
  const value = { version: 1, hub_instance_id: id, nonce: n, issued_at: Date.now(), expires_at: Date.now() + 30_000 };
  return { ...value, signature: sign(null, Buffer.from(`salcara-ingress-proof-v1\n${id}\n${n}\n${value.issued_at}\n${value.expires_at}`), keys.privateKey).toString('base64') };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const delay = <T>(milliseconds: number, value: () => T) => new Promise<T>(resolve => setTimeout(() => resolve(value()), milliseconds));
const flush = async () => { for (let i = 0; i < 70; i++) await Promise.resolve(); };
beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(new Date('2026-11-12T00:00:00Z')); });
afterEach(() => { setHubFetch(null); jest.useRealTimers(); });

test('three-second discovery, manifest and identity responses remain usable', async () => {
  setHubFetch(async () => delay(3000, () => json(discovery)));
  const discovered = discoverStation(canonical).then(value => ({ value }), error => ({ error }));
  await jest.advanceTimersByTimeAsync(3001);
  expect(await discovered).toMatchObject({ value: { url: canonical } });
  const router = createIngressRouter({ nonce: () => nonce, fetch: async url => delay(3000, () => json(url.endsWith('/manifest') ? manifest() : proof())) });
  const refreshed = router.refresh(canonical); await jest.advanceTimersByTimeAsync(3001); await refreshed;
  expect(router.pinSnapshot(canonical)?.hub_instance_id).toBe(hubId);
  const resolved = router.resolve(canonical); await jest.advanceTimersByTimeAsync(3001);
  await expect(resolved).resolves.toBe(backup);
});

test('all eight hints get a bounded turn and a three-second final hint survives two hanging batches', async () => {
  const hints = Array.from({ length: 7 }, (_, i) => ({ id: `hint-${i}`, url: `https://hint186-${i}.example/v1`, priority: i }));
  const previous = manifest({ issued_at: Date.now() - 86_400_001, expires_at: Date.now() - 1,
    endpoints: [{ id: 'canonical', url: canonical, priority: 100 }, ...hints] });
  const surviving = hints[6].url;
  const next = manifest({ revision: 4, canonical_url: surviving, endpoints: [{ id: 'canonical', url: surviving, priority: 0 }] });
  let active = 0, peak = 0; const calls: string[] = [];
  const router = createIngressRouter({ nonce: () => nonce, storage: { read: async () => JSON.stringify(previous), write: async () => undefined },
    fetch: async (url, init) => {
      calls.push(url); active++; peak = Math.max(peak, active);
      let done = false;
      const finish = () => { if (!done) { done = true; active--; } };
      (init.signal as AbortSignal).addEventListener('abort', finish, { once: true });
      if (url === `${surviving}/ingress/manifest`) return delay(3000, () => { finish(); return json(next); });
      return new Promise(() => undefined);
    } });
  const started = Date.now(); let finished = false;
  const work = Promise.all([router.refresh(canonical), router.refresh(canonical)]).then(() => { finished = true; });
  await jest.advanceTimersByTimeAsync(15_001); await work;
  expect(finished).toBe(true); expect(Date.now() - started).toBeLessThanOrEqual(16_000);
  expect(calls).toHaveLength(8); expect(new Set(calls).size).toBe(8); expect(peak).toBeLessThanOrEqual(3); expect(active).toBe(0);
  expect(router.pinSnapshot(canonical)?.revision).toBe(4);
  await router.refresh(canonical); expect(calls).toHaveLength(8);
});

test('saved discovery budgets two unavailable proofs plus a slow surviving proof and ping', async () => {
  const edges = Array.from({ length: 3 }, (_, i) => ({ id: `edge-${i}`, url: `https://proof186-${i}.example/v1`, priority: i }));
  const pin = manifest({ endpoints: [{ id: 'canonical', url: canonical, priority: 100 }, ...edges] });
  const proofs: string[] = [], pings: string[] = [];
  setHubFetch(async url => {
    if (url.endsWith('/manifest')) return json(pin);
    if (url.includes('/identity?')) {
      proofs.push(url);
      return url.startsWith(edges[2].url) ? delay(3000, () => json(proof(new URL(url).searchParams.get('nonce')!))) : new Promise(() => undefined);
    }
    pings.push(url); return delay(3000, () => json(discovery));
  }, true);
  await confirmPairingHubIdentity(canonical, () => true);
  const work = discoverSavedStation(canonical).then(value => ({ value }), error => ({ error }));
  await jest.advanceTimersByTimeAsync(16_001);
  expect(await work).toMatchObject({ value: { url: canonical } });
  expect(proofs).toHaveLength(3); expect(pings).toEqual([`${edges[2].url}/ping`]);
});

test.each(['replace', 'failed-confirmation', 'same-identity'] as const)('an old proof cannot dispatch old credentials after %s', async kind => {
  const pending = deferred<ReturnType<typeof json>>(); let confirming = false, proofEntered = false; const sent: string[] = [];
  const router = createIngressRouter({ nonce: () => nonce, fetch: async url => {
    if (url.endsWith('/manifest')) {
      if (confirming && kind === 'failed-confirmation') return json({}, 500);
      return json(manifest(confirming && kind === 'replace' ? { hub_instance_id: nextId,
        endpoints: [{ id: 'canonical', url: canonical, priority: 0 }] } : {}));
    }
    if (url.startsWith(`${backup}/ingress/identity`)) { proofEntered = true; return pending.promise; }
    if (url.includes('/identity?')) return json(proof(nonce, confirming && kind === 'replace' ? nextId : hubId));
    sent.push(url); return json({});
  } });
  await router.refresh(canonical);
  const old = router.fetch(canonical, '/app/devices', { headers: { 'X-Salcara-Pair-Token': 'old-synthetic-owner' } }).then(() => 'sent', error => error);
  await flush(); expect(proofEntered).toBe(true); confirming = true;
  const confirmation = router.confirmPairingIdentity(canonical, () => true);
  if (kind === 'failed-confirmation') await expect(confirmation).rejects.toBeInstanceOf(IngressIdentityError); else await confirmation;
  pending.resolve(json(proof()));
  const result = await old;
  expect(sent).toEqual([]); expect(result).toBeInstanceOf(IngressIdentityError);
});

test('a delayed GET failure cannot retry its old credentials after a new identity is confirmed', async () => {
  const response = deferred<ReturnType<typeof json>>(); let changed = false; const sent: string[] = [];
  const router = createIngressRouter({ nonce: () => nonce, fetch: async url => {
    if (url.endsWith('/manifest')) return json(manifest(changed ? { hub_instance_id: nextId } : {}));
    if (url.includes('/identity?')) return json(proof(nonce, changed ? nextId : hubId));
    sent.push(url); return response.promise;
  } });
  await router.refresh(canonical);
  const request = router.fetch(canonical, '/app/devices', { method: 'GET', headers: { 'X-Salcara-Pair-Token': 'old-synthetic-owner' } }).then(() => 'sent', error => error);
  await flush(); expect(sent).toHaveLength(1);
  changed = true; await router.confirmPairingIdentity(canonical, () => true); response.resolve(json({}, 503));
  const result = await request;
  expect(sent).toHaveLength(1); expect(result).toBeInstanceOf(IngressIdentityError);
});

test('a same-identity signed revision refresh preserves the pending credential request', async () => {
  const pending = deferred<ReturnType<typeof json>>(); let revision = 3, proofEntered = false; const sent: string[] = [];
  const router = createIngressRouter({ nonce: () => nonce, fetch: async url => {
    if (url.endsWith('/manifest')) return json(manifest({ revision, expires_at: Date.now() + 30_000 }));
    if (url.startsWith(`${backup}/ingress/identity`)) { proofEntered = true; return pending.promise; }
    if (url.includes('/identity?')) return json(proof());
    sent.push(url); return json({});
  } });
  await router.refresh(canonical);
  const request = router.fetch(canonical, '/app/devices', { headers: { Authorization: 'same-synthetic-owner' } });
  await flush(); expect(proofEntered).toBe(true);
  revision = 4; await router.refresh(canonical); expect(router.pinSnapshot(canonical)?.revision).toBe(4);
  pending.resolve(json(proof())); await expect(request).resolves.toMatchObject({ endpoint: backup });
  expect(sent).toEqual([`${backup}/app/devices`]);
});

test('cancellation while a proof is pending never dispatches credentials after the late proof', async () => {
  const pending = deferred<ReturnType<typeof json>>(), controller = new AbortController(); let entered = false; const sent: string[] = [];
  const router = createIngressRouter({ nonce: () => nonce, fetch: async url => {
    if (url.endsWith('/manifest')) return json(manifest());
    if (url.includes('/identity?')) { entered = true; return pending.promise; }
    sent.push(url); return json({});
  } });
  await router.refresh(canonical);
  const request = router.fetch(canonical, '/app/devices', { signal: controller.signal, headers: { Authorization: 'old-synthetic-owner' } }).then(() => 'sent', error => error);
  await flush(); expect(entered).toBe(true); controller.abort(); pending.resolve(json(proof()));
  expect(await request).toEqual(expect.objectContaining({ message: 'ingress cancelled' })); expect(sent).toEqual([]);
});
