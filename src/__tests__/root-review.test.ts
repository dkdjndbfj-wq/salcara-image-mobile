import { generateKeyPairSync, sign } from 'node:crypto';
import { createIngressRouter, IngressIdentityError, type IngressManifest } from '../remote/ingress';
import type { FetchLike } from '../remote/client';

const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
const canonical = 'https://old.example/salcara-hub/v1', backup = 'https://hint.example/salcara-hub/v1', moved = 'https://new.example/salcara-hub/v1';
const hubId = 'a'.repeat(32), nonce = 'b'.repeat(64);
const json = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
function manifest(now: number, patch: Partial<IngressManifest> = {}): IngressManifest {
  return { version: 1, hub_instance_id: hubId, identity_public_key: publicKey, canonical_url: canonical,
    revision: 1, issued_at: now, expires_at: now + 3_600_000,
    endpoints: [{ id: 'canonical', url: canonical, priority: 100 }, { id: 'backup', url: backup, priority: 50 }], ...patch };
}
function signed(value: IngressManifest): IngressManifest {
  const bytes = Buffer.from(JSON.stringify(value));
  return { ...value, signed_payload: bytes.toString('base64'), signature: sign(null,
    Buffer.concat([Buffer.from('salcara-ingress-manifest-v1\n'), bytes]), keys.privateKey).toString('base64') };
}
function proof(now: number) {
  const body = { version: 1, hub_instance_id: hubId, nonce, issued_at: now, expires_at: now + 30_000 };
  return { ...body, signature: sign(null, Buffer.from(`salcara-ingress-proof-v1\n${hubId}\n${nonce}\n${body.issued_at}\n${body.expires_at}`), keys.privateKey).toString('base64') };
}

test('review: a newer same-pin manifest already fetched in the batch enables migration past stale manifest caches', async () => {
  const now = Date.now(), old = signed(manifest(now));
  const next = signed(manifest(now, { revision: 2, canonical_url: moved, endpoints: [{ id: 'canonical', url: moved, priority: 0 }] }));
  const calls: Array<{ url: string; authenticated: boolean }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, authenticated: Boolean((init.headers as Record<string, string>)['X-Salcara-Pair-Token']) });
    if (url === `${canonical}/ingress/manifest`) return json(old); // Stale public manifest cache.
    if (url === `${backup}/ingress/manifest`) return json(next); // Same round already received the renewal.
    if (url.startsWith(`${moved}/ingress/identity?`)) return json(proof(now));
    if (url === `${moved}/app/devices`) return json({ devices: [] });
    throw new Error('old control endpoint retired');
  };
  const router = createIngressRouter({ now: () => now, nonce: () => nonce, fetch,
    storage: { read: async () => JSON.stringify(old), write: async () => undefined } });
  await expect(router.fetch(canonical, '/app/devices', { headers: { 'X-Salcara-Pair-Token': 'private' } })).resolves.toMatchObject({ endpoint: moved });
  expect(router.pinSnapshot(canonical)?.revision).toBe(2);
  expect(calls.filter(call => call.authenticated).map(call => call.url)).toEqual([`${moved}/app/devices`]);
});

test('review: authority expiring during a valid nonce response is unavailable, not a changed identity', async () => {
  let now = Date.now(); const start = now;
  const pin = signed(manifest(now, { expires_at: now + 500, endpoints: [{ id: 'canonical', url: canonical, priority: 0 }] }));
  const router = createIngressRouter({ now: () => now, nonce: () => nonce,
    storage: { read: async () => JSON.stringify(pin), write: async () => undefined }, fetch: async url => {
      if (url.endsWith('/manifest')) return json(pin);
      if (url.includes('/identity?')) { now = start + 600; return json(proof(now)); }
      throw new Error('credentials must never be sent');
    } });
  const error = await router.fetch(canonical, '/app/devices', { headers: { 'X-Salcara-Pair-Token': 'private' } }).catch(reason => reason);
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(IngressIdentityError);
});

test('review: a replaced candidate cannot block a still-authorized alternate with a fresh valid identity proof', async () => {
  const now = Date.now(), pin = signed(manifest(now));
  const replacement = signed(manifest(now, { hub_instance_id: 'c'.repeat(32) }));
  const authenticated: string[] = [];
  const router = createIngressRouter({ now: () => now, nonce: () => nonce,
    storage: { read: async () => JSON.stringify(pin), write: async () => undefined }, fetch: async (url, init) => {
      if ((init.headers as Record<string, string>)['X-Salcara-Bot-Token']) authenticated.push(url);
      if (url === `${canonical}/ingress/manifest`) return json(replacement);
      if (url === `${backup}/ingress/manifest`) throw new Error('manifest refresh temporarily unavailable');
      if (url.startsWith(`${backup}/ingress/identity?`)) return json(proof(now));
      if (url === `${backup}/app/devices`) return json({ devices: [] });
      throw new Error('do not contact replaced identity with credentials');
    } });
  await expect(router.fetch(canonical, '/app/devices', { headers: { 'X-Salcara-Bot-Token': 'private' } })).resolves.toMatchObject({ endpoint: backup });
  expect(authenticated).toEqual([`${backup}/app/devices`]);
  expect(router.pinSnapshot(canonical)?.hub_instance_id).toBe(hubId);
});
