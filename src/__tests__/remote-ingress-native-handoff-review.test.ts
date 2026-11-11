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
