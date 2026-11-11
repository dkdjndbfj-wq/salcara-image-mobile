import { generateKeyPairSync, sign } from 'node:crypto';
import { createIngressRouter, type IngressManifest } from '../remote/ingress';

const canonical = 'https://handoff-review.example/v1';
const originalKeys = generateKeyPairSync('ed25519');
const replacementKeys = generateKeyPairSync('ed25519');
function manifest(keys = originalKeys, hubId = 'a'.repeat(32), revision = 3): IngressManifest {
  const now = Date.now();
  const payload = {
    version: 1 as const, hub_instance_id: hubId,
    identity_public_key: keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'),
    canonical_url: canonical, revision, issued_at: now, expires_at: now + 86_400_000,
    endpoints: [{ id: 'canonical', url: canonical, priority: 0 }],
  };
  const bytes = Buffer.from(JSON.stringify(payload));
  return { ...payload, signed_payload: bytes.toString('base64'),
    signature: sign(null, Buffer.concat([Buffer.from('salcara-ingress-manifest-v1\n'), bytes]), keys.privateKey).toString('base64') };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };

test('a native hand-back while a replacement identity is being saved cannot persist the previous pin after it', async () => {
  const previous = manifest();
  const replacement = manifest(replacementKeys, 'b'.repeat(32));
  const nativeRefresh = manifest(originalKeys, previous.hub_instance_id, 4);
  const firstWrite = deferred<void>();
  let saved = JSON.stringify(previous), oldScopeActive = true;
  const write = jest.fn(async (_url: string, raw: string) => {
    if (write.mock.calls.length === 1) await firstWrite.promise;
    saved = raw;
  });
  const router = createIngressRouter({
    nonce: () => 'c'.repeat(64),
    storage: { read: async () => saved, write },
    fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(replacement) }),
  });
  // The store keeps the original credential owner until explicit QR identity
  // confirmation has completed. This models its ordinary deferred activation.
  const confirmed = router.confirmPairingIdentity(canonical, () => true).then(() => { oldScopeActive = false; });
  await flush();
  expect(write).toHaveBeenCalledTimes(1);
  const adopted = router.adoptPinnedManifest(canonical, nativeRefresh, () => oldScopeActive);
  await flush();
  firstWrite.resolve();
  await Promise.all([confirmed, adopted]);
  expect(router.pinSnapshot(canonical)?.hub_instance_id).toBe(replacement.hub_instance_id);
  expect(JSON.parse(saved).hub_instance_id).toBe(replacement.hub_instance_id);
});

test('a hand-back whose credential owner changes while the persisted pin loads writes nothing', async () => {
  const read = deferred<string>();
  const write = jest.fn(async () => undefined);
  let active = true;
  const router = createIngressRouter({
    nonce: () => 'c'.repeat(64), storage: { read: () => read.promise, write },
    fetch: jest.fn(async () => ({ ok: true, status: 200, text: async () => '{}' })),
  });
  const adopted = router.adoptPinnedManifest(canonical, manifest(originalKeys, 'a'.repeat(32), 4), () => active);
  active = false;
  read.resolve(JSON.stringify(manifest()));
  expect(await adopted).toBe(false);
  expect(write).not.toHaveBeenCalled();
  expect(router.pinSnapshot(canonical)?.revision).toBe(3);
});

function movedManifest(revision = 4, expiresAt = Date.now() + 86_400_000): IngressManifest {
  const moved = 'https://moved-bot.example/v1', now = Date.now();
  const payload = { version: 1 as const, hub_instance_id: 'a'.repeat(32),
    identity_public_key: originalKeys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'),
    canonical_url: moved, revision, issued_at: now, expires_at: expiresAt,
    endpoints: [{ id: 'canonical', url: moved, priority: 0 }] };
  const bytes = Buffer.from(JSON.stringify(payload));
  return { ...payload, signed_payload: bytes.toString('base64'),
    signature: sign(null, Buffer.concat([Buffer.from('salcara-ingress-manifest-v1\n'), bytes]), originalKeys.privateKey).toString('base64') };
}
const savedBotPin = () => ({ instanceId: 'a'.repeat(32), publicKey: manifest().identity_public_key });

test('a durable Bot pin restores a signed moved directory into an empty cache without granting a proof lease', async () => {
  const moved = movedManifest(), write = jest.fn(async () => undefined), fetch = jest.fn();
  const router = createIngressRouter({ nonce: () => 'c'.repeat(64), fetch, storage: { read: async () => null, write } });
  expect(await router.adoptPinnedBotManifest(canonical, moved, savedBotPin(), () => true)).toBe(true);
  expect(router.pinSnapshot(canonical)).toEqual(moved);
  expect(write).toHaveBeenCalledWith(canonical, JSON.stringify(moved));
  expect(fetch).not.toHaveBeenCalled();
  expect(router.isVerifiedPinnedEndpoint(canonical, moved.canonical_url, savedBotPin())).toBe(false);
});

test.each(['other-global', 'wrong-pin', 'unsigned', 'tampered', 'rollback', 'shorter-expiry'] as const)('Bot hand-back rejects %s without replacing the current cache', async kind => {
  const previous = kind === 'other-global' ? manifest(replacementKeys, 'b'.repeat(32)) : manifest();
  const write = jest.fn(async () => undefined), fetch = jest.fn();
  const router = createIngressRouter({ nonce: () => 'c'.repeat(64), fetch, storage: { read: async () => JSON.stringify(previous), write } });
  let next = movedManifest(), pin = savedBotPin();
  if (kind === 'wrong-pin') pin = { ...pin, instanceId: 'c'.repeat(32) };
  if (kind === 'unsigned') { delete next.signed_payload; delete next.signature; }
  if (kind === 'tampered') next.signature = 'A'.repeat(86) + '==';
  if (kind === 'rollback') next = movedManifest(2);
  if (kind === 'shorter-expiry') next = movedManifest(3, previous.expires_at - 1000);
  expect(await router.adoptPinnedBotManifest(canonical, next, pin, () => true)).toBe(false);
  expect(router.pinSnapshot(canonical)).toEqual(previous);
  expect(write).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});

test('Bot hand-back checks its owner after loading durable cache', async () => {
  const read = deferred<string | null>(), write = jest.fn(async () => undefined);
  let active = true;
  const router = createIngressRouter({ nonce: () => 'c'.repeat(64), fetch: jest.fn(), storage: { read: () => read.promise, write } });
  const adopted = router.adoptPinnedBotManifest(canonical, movedManifest(), savedBotPin(), () => active);
  active = false; read.resolve(null);
  expect(await adopted).toBe(false); expect(write).not.toHaveBeenCalled();
  expect(router.pinSnapshot(canonical)).toBeUndefined();
});

test.each(['cancelled', 'storage'] as const)('Bot hand-back does not publish a cache when its pending save is %s', async kind => {
  const saving = deferred<void>(), entered = deferred<void>(); let active = true;
  const router = createIngressRouter({ nonce: () => 'c'.repeat(64), fetch: jest.fn(), storage: {
    read: async () => null, write: async () => { entered.resolve(); await saving.promise; if (kind === 'storage') throw new Error('disk busy'); },
  } });
  const adopted = router.adoptPinnedBotManifest(canonical, movedManifest(), savedBotPin(), () => active);
  await entered.promise; if (kind === 'cancelled') active = false; saving.resolve();
  expect(await adopted).toBe(false); expect(router.pinSnapshot(canonical)).toBeUndefined();
});

test('Bot hand-back cannot replace an in-flight QR identity confirmation', async () => {
  const previous = manifest(), replacement = manifest(replacementKeys, 'b'.repeat(32));
  const saving = deferred<void>(), entered = deferred<void>(); let saved = JSON.stringify(previous);
  const router = createIngressRouter({ nonce: () => 'c'.repeat(64), storage: { read: async () => saved,
    write: async (_url, raw) => { entered.resolve(); await saving.promise; saved = raw; } },
    fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(replacement) }),
  });
  const confirming = router.confirmPairingIdentity(canonical, () => true); await entered.promise;
  expect(await router.adoptPinnedBotManifest(canonical, movedManifest(), savedBotPin(), () => true)).toBe(false);
  saving.resolve(); await confirming;
  expect(router.pinSnapshot(canonical)).toEqual(replacement);
  expect(JSON.parse(saved)).toEqual(replacement);
});
