import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import {
  devices, hubIngressSnapshot, isPairingAuthenticationError, setHubFetch, type FetchLike, type Hub,
} from '../remote/client';
import { createIngressRouter, verifyIngressProof, type IngressManifest } from '../remote/ingress';

const mockSecrets = new Map<string, string>();
const mockSecretWrites = jest.fn();
jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'fixture',
  getItemAsync: async (key: string) => mockSecrets.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { mockSecretWrites(key, value); mockSecrets.set(key, value); },
}));
jest.mock('expo-crypto', () => ({
  randomUUID: () => require('node:crypto').randomUUID(),
  getRandomBytes: (size: number) => new Uint8Array(require('node:crypto').randomBytes(size)),
}));

const canonical = 'https://clock-fixture.example/salcara-hub/v1';
const serverTime = Date.UTC(2026, 10, 13), clockDifference = 17_609_000;
const keys = generateKeyPairSync('ed25519'), otherKeys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
const hubId = 'a'.repeat(32), pin = { instanceId: hubId, publicKey };
const pairToken = 'b'.repeat(64), botToken = 'c'.repeat(64);
const cacheKey = `salcara.ingress.v1.${createHash('sha256').update(canonical).digest('hex')}`;
const reply = (value: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });
const discovery = { service: 'salcara-hub', protocol: 'salcara-remote', protocolVersion: 1,
  authModes: ['device-pairing'], capabilities: ['device.identity.v1', 'pair.qr.v1', 'session.remote.v1', 'pair.revoke.v1', 'bot.phone.binding.v2'] };

function signedManifest(issuedAt = serverTime, revision = 4, patch: Partial<IngressManifest> = {}, signingKeys = keys): IngressManifest {
  const value: IngressManifest = { version: 1, hub_instance_id: hubId, identity_public_key: publicKey,
    canonical_url: canonical, revision, issued_at: issuedAt, expires_at: issuedAt + 86_400_000,
    endpoints: [{ id: 'canonical', url: canonical, priority: 0 }], ...patch };
  const bytes = Buffer.from(JSON.stringify(value));
  return { ...value, signed_payload: bytes.toString('base64'),
    signature: sign(null, Buffer.concat([Buffer.from('salcara-ingress-manifest-v1\n'), bytes]), signingKeys.privateKey).toString('base64') };
}

function signedProof(nonce: string, issuedAt = serverTime, patch: Record<string, unknown> = {}, signingKeys = keys) {
  const value = { version: 1, hub_instance_id: hubId, nonce, issued_at: issuedAt, expires_at: issuedAt + 30_000, ...patch };
  const message = Buffer.from(`salcara-ingress-proof-v1\n${value.hub_instance_id}\n${value.nonce}\n${value.issued_at}\n${value.expires_at}`);
  return { ...value, signature: sign(null, message, signingKeys.privateKey).toString('base64') };
}

type Call = { url: string; init: Parameters<FetchLike>[1] };
const hasCredential = (call: Call) => Object.entries(call.init.headers as Record<string, unknown> ?? {})
  .some(([key, value]) => /^(authorization|x-salcara-(pair|bot)-token)$/i.test(key) && Boolean(value));

function transport(proofResponse = (nonce: string) => signedProof(nonce)) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    if (url === `${canonical}/ingress/manifest`) return reply(signedManifest());
    if (url.startsWith(`${canonical}/ingress/identity?`)) return reply(proofResponse(new URL(url).searchParams.get('nonce')!));
    if (url === `${canonical}/ping`) return reply(discovery);
    if (url === `${canonical}/app/devices`) return reply({ devices: [] });
    throw new Error('Unexpected offline fixture URL');
  };
  return { fetch, calls, credentialed: () => calls.filter(hasCredential) };
}

function routerFixture(initialClock: number, savedManifest = signedManifest(), proofResponse?: (nonce: string) => ReturnType<typeof signedProof>) {
  let now = initialClock, saved = JSON.stringify(savedManifest);
  const writes: string[] = [], network = transport(proofResponse);
  const router = createIngressRouter({ now: () => now, nonce: () => randomBytes(32).toString('hex'), fetch: network.fetch,
    storage: { read: async () => saved, write: async (_url, value) => { writes.push(value); saved = value; } } });
  return { router, ...network, writes, saved: () => saved, clock: (value: number) => { now = value; },
    read: () => router.fetch(canonical, '/app/devices', { headers: { 'X-Salcara-Pair-Token': pairToken } }) };
}

beforeEach(() => { mockSecrets.clear(); mockSecretWrites.mockClear(); });
afterEach(() => { setHubFetch(null); jest.restoreAllMocks(); });

test('cold start retains a future-issued saved identity and never falls back to an unpinned credential send', async () => {
  const saved = signedManifest(), fixture = routerFixture(serverTime - clockDifference, saved);
  await expect(fixture.read()).rejects.toMatchObject({ name: 'IngressClockSkewError' });
  expect(fixture.router.pinSnapshot(canonical)).toMatchObject(pinManifestFields(saved));
  expect(fixture.credentialed()).toEqual([]);
  expect(fixture.saved()).toBe(JSON.stringify(saved));
  expect(fixture.writes).not.toContain('{}');
  expect(fixture.router.isVerifiedPinnedEndpoint(canonical, canonical, pin)).toBe(false);
});

function pinManifestFields(value: IngressManifest) {
  return { hub_instance_id: value.hub_instance_id, identity_public_key: value.identity_public_key, signature: value.signature };
}

test.each([-clockDifference, clockDifference])('a cached identity reports verified time mismatch (%i ms) without authorizing a request', async difference => {
  // This older cached directory loads even on 1.8.6 when the phone is behind;
  // the failure must therefore come from the fresh, signed nonce response.
  const fixture = routerFixture(serverTime + difference, signedManifest(serverTime - clockDifference - 60_000, 3));
  await expect(fixture.read()).rejects.toMatchObject({ name: 'IngressClockSkewError' });
  expect(fixture.credentialed()).toEqual([]);
  expect(fixture.router.pinSnapshot(canonical)).toMatchObject({ hub_instance_id: hubId, identity_public_key: publicKey });
  expect(fixture.router.hasIdentityMismatch(canonical)).toBe(false);
});

test.each([-clockDifference, clockDifference])('an in-memory pin survives a later phone clock change (%i ms)', async difference => {
  const fixture = routerFixture(serverTime);
  await fixture.router.refresh(canonical);
  expect(fixture.router.pinSnapshot(canonical)).toMatchObject({ hub_instance_id: hubId, identity_public_key: publicKey });
  fixture.clock(serverTime + difference);
  await expect(fixture.read()).rejects.toMatchObject({ name: 'IngressClockSkewError' });
  expect(fixture.credentialed()).toEqual([]);
  expect(fixture.router.pinSnapshot(canonical)).toMatchObject({ hub_instance_id: hubId, identity_public_key: publicKey });
});

test.each([-clockDifference, clockDifference])('the same saved binding resumes after correcting its clock (%i ms)', async difference => {
  const fixture = routerFixture(serverTime + difference);
  await expect(fixture.read()).rejects.toMatchObject({ name: 'IngressClockSkewError' });
  expect(fixture.credentialed()).toEqual([]);
  fixture.clock(serverTime);
  await expect(fixture.read()).resolves.toMatchObject({ endpoint: canonical });
  expect(fixture.credentialed()).toHaveLength(1);
  expect(fixture.router.pinSnapshot(canonical)).toMatchObject({ hub_instance_id: hubId, identity_public_key: publicKey });
  expect(fixture.writes).not.toContain('{}');
});

test('QR identity confirmation cannot replace a saved future-issued identity with an empty record', async () => {
  const saved = signedManifest(), fixture = routerFixture(serverTime - clockDifference, saved);
  await expect(fixture.router.confirmPairingIdentity(canonical, () => true)).rejects.toBeInstanceOf(Error);
  expect(fixture.saved()).toBe(JSON.stringify(saved));
  expect(fixture.writes).toEqual([]);
  expect(fixture.router.pinSnapshot(canonical)).toMatchObject(pinManifestFields(saved));
  expect(fixture.router.isConfirming(canonical)).toBe(false);
  expect(fixture.credentialed()).toEqual([]);
});

test.each([
  ['bad signature', (nonce: string) => signedProof(nonce, serverTime, {}, otherKeys)],
  ['wrong nonce', () => signedProof('f'.repeat(64))],
  ['wrong identity', (nonce: string) => signedProof(nonce, serverTime, { hub_instance_id: 'e'.repeat(32) })],
  ['invalid duration', (nonce: string) => signedProof(nonce, serverTime, { expires_at: serverTime + 30_001 })],
  ['invalid schema', (nonce: string) => signedProof(nonce, serverTime, { version: 2 })],
] as const)('a %s response cannot diagnose clock skew or authorize credentials', async (_name, response) => {
  const fixture = routerFixture(serverTime - clockDifference, signedManifest(serverTime - clockDifference - 60_000, 3), response);
  const error = await fixture.read().then(() => null, value => value as Error);
  expect(error).toBeInstanceOf(Error);
  expect(error?.name).not.toBe('IngressClockSkewError');
  expect(fixture.credentialed()).toEqual([]);
});

test('a future-issued saved directory alone is not evidence of clock skew when the new proof signature is invalid', async () => {
  const fixture = routerFixture(serverTime - clockDifference, signedManifest(), nonce => signedProof(nonce, serverTime, {}, otherKeys));
  const error = await fixture.read().then(() => null, value => value as Error);
  expect(error).toBeInstanceOf(Error);
  expect(error?.name).not.toBe('IngressClockSkewError');
  expect(fixture.router.pinSnapshot(canonical)).toMatchObject({ hub_instance_id: hubId, identity_public_key: publicKey });
  expect(fixture.credentialed()).toEqual([]);
});

test('the original 30-second proof window remains unchanged', () => {
  const nonce = randomBytes(32).toString('hex'), saved = signedManifest(serverTime - 60_000), proof = signedProof(nonce);
  expect(verifyIngressProof(proof, saved, nonce, serverTime)).toBe(true);
  expect(verifyIngressProof(proof, saved, nonce, serverTime - 30_000)).toBe(true);
  expect(verifyIngressProof(proof, saved, nonce, serverTime - 30_001)).toBe(false);
  expect(verifyIngressProof(proof, saved, nonce, serverTime + 30_000)).toBe(false);
  expect(verifyIngressProof(proof, saved, 'f'.repeat(64), serverTime)).toBe(false);
});

test.each(['ordinary', 'bot'] as const)('the real %s client retains its saved pin and reports clock_skew on cold start', async kind => {
  let now = serverTime - clockDifference;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  const saved = signedManifest(); mockSecrets.set(cacheKey, JSON.stringify(saved));
  const network = transport(); setHubFetch(network.fetch, true);
  const hub: Hub = { url: canonical, ...(kind === 'bot' ? { botToken, botPin: { ...pin } } : { pairToken }) };
  const error = await devices(hub).then(() => null, value => value);
  expect(error).toMatchObject({ code: 'clock_skew' });
  expect(isPairingAuthenticationError(error)).toBe(false);
  expect(network.credentialed()).toEqual([]);
  expect(hubIngressSnapshot(canonical)).toMatchObject(pinManifestFields(saved));
  expect(mockSecrets.get(cacheKey)).toBe(JSON.stringify(saved));
  expect(mockSecretWrites.mock.calls.some(([, value]) => value === '{}')).toBe(false);
  now = serverTime;
  await expect(devices(hub)).resolves.toEqual([]);
  expect(network.credentialed()).toHaveLength(1);
  expect(network.credentialed()[0].url).toBe(`${canonical}/app/devices`);
});

test('the real ordinary client reports an ahead clock without retiring the pairing', async () => {
  jest.spyOn(Date, 'now').mockReturnValue(serverTime + clockDifference);
  mockSecrets.set(cacheKey, JSON.stringify(signedManifest()));
  const network = transport(); setHubFetch(network.fetch, true);
  const error = await devices({ url: canonical, pairToken }).then(() => null, value => value);
  expect(error).toMatchObject({ code: 'clock_skew' });
  expect(isPairingAuthenticationError(error)).toBe(false);
  expect(network.credentialed()).toEqual([]);
});

test('an old signed proof replayed for a different fresh nonce is not clock evidence', async () => {
  const replay = signedProof('d'.repeat(64), serverTime - clockDifference);
  const fixture = routerFixture(serverTime, signedManifest(), () => replay);
  await expect(fixture.read()).rejects.toMatchObject({ name: 'IngressIdentityError' });
  expect(fixture.credentialed()).toEqual([]);
  expect(fixture.router.isVerifiedPinnedEndpoint(canonical, canonical, pin)).toBe(false);
});

test('a proof crossing its existing freshness boundary while in flight is unavailable, not clock skew', async () => {
  let wall = serverTime, elapsed = 0;
  jest.spyOn(globalThis.performance, 'now').mockImplementation(() => elapsed);
  let credentialed = 0;
  const saved = signedManifest(serverTime - 60_000);
  const router = createIngressRouter({ now: () => wall, nonce: () => randomBytes(32).toString('hex'),
    storage: { read: async () => JSON.stringify(saved), write: async () => undefined }, fetch: async (url, init) => {
      if (url.endsWith('/manifest')) return reply(saved);
      if (url.includes('/identity?')) {
        const proof = signedProof(new URL(url).searchParams.get('nonce')!, wall - 29_000);
        wall += 2_000; elapsed += 2_000;
        return reply(proof);
      }
      if (hasCredential({ url, init })) credentialed++;
      return reply({});
    } });
  await expect(router.fetch(canonical, '/app/devices', { headers: { 'X-Salcara-Pair-Token': pairToken } }))
    .rejects.toMatchObject({ name: 'IngressUnavailableError' });
  expect(credentialed).toBe(0);
  expect(router.isVerifiedPinnedEndpoint(canonical, canonical, pin)).toBe(false);
});

test.each([-3_600_000, 3_600_000])('a wall-clock jump during a nonce request (%i ms) grants neither a lease nor a clock diagnosis', async jump => {
  let wall = serverTime, elapsed = 0, credentialed = 0;
  jest.spyOn(globalThis.performance, 'now').mockImplementation(() => elapsed);
  const saved = signedManifest();
  const router = createIngressRouter({ now: () => wall, nonce: () => randomBytes(32).toString('hex'),
    storage: { read: async () => JSON.stringify(saved), write: async () => undefined }, fetch: async (url, init) => {
      if (url.endsWith('/manifest')) return reply(saved);
      if (url.includes('/identity?')) {
        const proof = signedProof(new URL(url).searchParams.get('nonce')!);
        wall += jump; elapsed += 10;
        return reply(proof);
      }
      if (hasCredential({ url, init })) credentialed++;
      return reply({});
    } });
  await expect(router.fetch(canonical, '/app/devices', { headers: { 'X-Salcara-Pair-Token': pairToken } }))
    .rejects.toMatchObject({ name: 'IngressUnavailableError' });
  expect(credentialed).toBe(0);
  expect(router.isVerifiedPinnedEndpoint(canonical, canonical, pin)).toBe(false);
});

test('an established lease cannot be reused after the phone clock rolls back one hour', async () => {
  const fixture = routerFixture(serverTime);
  await fixture.read();
  expect(fixture.credentialed()).toHaveLength(1);
  expect(fixture.router.isVerifiedPinnedEndpoint(canonical, canonical, pin)).toBe(true);
  fixture.clock(serverTime - 3_600_000);
  await expect(fixture.read()).rejects.toMatchObject({ name: 'IngressClockSkewError' });
  expect(fixture.credentialed()).toHaveLength(1);
  expect(fixture.router.isVerifiedPinnedEndpoint(canonical, canonical, pin)).toBe(false);
});

test('a signed alternate with clock skew cannot hide another healthy pinned entry', async () => {
  const bad = 'https://clock-bad.example/salcara-hub/v1', healthy = 'https://clock-good.example/salcara-hub/v1';
  const saved = signedManifest(serverTime, 4, { endpoints: [
    { id: 'clock-bad', url: bad, priority: 0 }, { id: 'clock-good', url: healthy, priority: 1 },
    { id: 'canonical', url: canonical, priority: 100 },
  ] });
  const calls: Call[] = [];
  const router = createIngressRouter({ now: () => serverTime, nonce: () => randomBytes(32).toString('hex'),
    storage: { read: async () => JSON.stringify(saved), write: async () => undefined }, fetch: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/manifest')) return reply(saved);
      if (url.includes('/identity?')) return reply(signedProof(new URL(url).searchParams.get('nonce')!,
        url.startsWith(bad) ? serverTime + clockDifference : serverTime));
      return reply({ devices: [] });
    } });
  await expect(router.fetch(canonical, '/app/devices', { headers: { 'X-Salcara-Pair-Token': pairToken } }))
    .resolves.toMatchObject({ endpoint: healthy });
  expect(calls.filter(hasCredential).map(call => call.url)).toEqual([`${healthy}/app/devices`]);
});

test.each(['ordinary', 'bot'] as const)('the real %s client can use a healthy pinned entry when canonical reports clock skew', async kind => {
  jest.spyOn(Date, 'now').mockReturnValue(serverTime);
  const healthy = 'https://clock-good.example/salcara-hub/v1';
  const saved = signedManifest(serverTime, 4, { endpoints: [
    { id: 'canonical', url: canonical, priority: 0 }, { id: 'healthy', url: healthy, priority: 1 },
  ] });
  mockSecrets.set(cacheKey, JSON.stringify(saved));
  const calls: Call[] = [];
  setHubFetch(async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/manifest')) return reply(saved);
    if (url.includes('/identity?')) return reply(signedProof(new URL(url).searchParams.get('nonce')!,
      url.startsWith(canonical) ? serverTime + clockDifference : serverTime));
    if (url.endsWith('/ping')) return reply(discovery);
    return reply({ devices: [] });
  }, true);
  const hub: Hub = { url: canonical, ...(kind === 'bot' ? { botToken, botPin: { ...pin } } : { pairToken }) };
  await expect(devices(hub)).resolves.toEqual([]);
  expect(calls.filter(hasCredential).map(call => call.url)).toEqual([`${healthy}/app/devices`]);
});

test.each(['confirm', 'evict-and-confirm'] as const)('a late clock response cannot mutate the new identity after %s', async change => {
  let wall = serverTime - clockDifference, responseManifest = signedManifest(), heldNonce = '';
  let releaseProof!: (value: ReturnType<typeof reply>) => void, proofStarted!: () => void;
  const heldProof = new Promise<ReturnType<typeof reply>>(resolve => { releaseProof = resolve; });
  const started = new Promise<void>(resolve => { proofStarted = resolve; });
  const storage = new Map([[canonical, JSON.stringify(responseManifest)]]), calls: Call[] = [];
  const nextId = 'e'.repeat(32), nextPublicKey = otherKeys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  const next = signedManifest(serverTime, 5, { hub_instance_id: nextId, identity_public_key: nextPublicKey }, otherKeys);
  let hold = true;
  const router = createIngressRouter({ now: () => wall, nonce: () => randomBytes(32).toString('hex'),
    storage: { read: async url => storage.get(url) ?? null, write: async (url, value) => { storage.set(url, value); } },
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/manifest')) return reply(responseManifest);
      if (url.includes('/identity?')) {
        const nonce = new URL(url).searchParams.get('nonce')!;
        if (hold) { hold = false; heldNonce = nonce; proofStarted(); return heldProof; }
        return reply(signedProof(nonce, serverTime, { hub_instance_id: nextId }, otherKeys));
      }
      return reply({ devices: [] });
    } });
  const old = router.fetch(canonical, '/app/devices', { headers: { 'X-Salcara-Pair-Token': pairToken } })
    .then(() => null, error => error as Error);
  await started;
  if (change === 'evict-and-confirm') {
    for (let i = 0; i < 33; i++) await router.resolve(`https://evict-${i}.example/salcara-hub/v1`);
  }
  wall = serverTime; responseManifest = next;
  await router.confirmPairingIdentity(canonical, () => true);
  releaseProof(reply(signedProof(heldNonce, serverTime + clockDifference)));
  const error = await old;
  expect(error).toBeInstanceOf(Error);
  expect(error?.name).not.toBe('IngressClockSkewError');
  expect(calls.filter(hasCredential)).toEqual([]);
  expect(router.pinSnapshot(canonical)).toMatchObject(pinManifestFields(next));
  expect(JSON.parse(storage.get(canonical)!)).toMatchObject(pinManifestFields(next));
  expect(router.hasIdentityMismatch(canonical)).toBe(false);
  expect(router.isConfirming(canonical)).toBe(false);
  await expect(router.fetch(canonical, '/app/devices', { headers: { 'X-Salcara-Pair-Token': 'new-fixture-token' } }))
    .resolves.toMatchObject({ endpoint: canonical });
  expect(calls.filter(hasCredential)).toHaveLength(1);
});
