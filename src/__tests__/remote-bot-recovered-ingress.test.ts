import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { adoptRecoveredBotHubIngress, devices, hubIngressSnapshot, setHubFetch, type FetchLike, type Hub } from '../remote/client';
import type { IngressManifest } from '../remote/ingress';

const mockSecure = new Map<string, string>();
const mockSecureRead = jest.fn(), mockSecureWrite = jest.fn();
jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'fixture',
  getItemAsync: (key: string) => mockSecureRead(key),
  setItemAsync: (key: string, value: string) => mockSecureWrite(key, value),
}));
jest.mock('expo-crypto', () => ({ randomUUID: () => require('node:crypto').randomUUID(), getRandomBytes: (size: number) => new Uint8Array(require('node:crypto').randomBytes(size)) }));

const canonical = 'https://retired-bot.example/salcara-hub/v1';
const moved = 'https://recovered-bot.example/salcara-hub/v1';
const keys = generateKeyPairSync('ed25519'), otherKeys = generateKeyPairSync('ed25519');
const token = 'a'.repeat(64), deviceId = 'saved-pc';
const expectedPin = { instanceId: '1'.repeat(32), publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64') };
const cacheKey = `salcara.ingress.v1.${createHash('sha256').update(canonical).digest('hex')}`;
const member = { deviceId, name: 'Recovered computer', os: 'windows', tools: [], projects: [], online: true, lastSeen: 1 };
const discovery = { service: 'salcara-hub', protocol: 'salcara-remote', protocolVersion: 1,
  authModes: ['device-pairing'], capabilities: ['device.identity.v1', 'pair.qr.v1', 'session.remote.v1', 'pair.revoke.v1', 'bot.phone.binding.v2'] };
const bot = (fields: Partial<Hub> = {}): Hub => ({ url: canonical, botToken: token, botPin: expectedPin, deviceId, ...fields });
const reply = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function manifest(at = moved, signingKeys = keys, instanceId = expectedPin.instanceId): IngressManifest {
  const now = Date.now();
  const body = { version: 1 as const, hub_instance_id: instanceId,
    identity_public_key: signingKeys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'),
    canonical_url: at, revision: 7, issued_at: now, expires_at: now + 86_400_000,
    endpoints: [{ id: 'canonical', url: at, priority: 0 }] };
  const bytes = Buffer.from(JSON.stringify(body));
  return { ...body, signed_payload: bytes.toString('base64'),
    signature: sign(null, Buffer.concat([Buffer.from('salcara-ingress-manifest-v1\n'), bytes]), signingKeys.privateKey).toString('base64') };
}
function proof(url: string, valid = true) {
  const nonce = new URL(url).searchParams.get('nonce'), now = Date.now();
  const body = { version: 1, hub_instance_id: expectedPin.instanceId, nonce, issued_at: now, expires_at: now + 30_000 };
  return { ...body, signature: sign(null, Buffer.from(`salcara-ingress-proof-v1\n${body.hub_instance_id}\n${nonce}\n${body.issued_at}\n${body.expires_at}`), (valid ? keys : otherKeys).privateKey).toString('base64') };
}
function transport(recovered: IngressManifest, validProof = true) {
  const calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
  setHubFetch(async (url, init) => {
    calls.push({ url, init });
    if (url.startsWith(`${canonical}/`)) {
      expect(init.headers).not.toHaveProperty('X-Salcara-Bot-Token');
      throw new Error('retired address is offline');
    }
    if (url === `${moved}/ingress/manifest`) return reply(recovered);
    if (url.startsWith(`${moved}/ingress/identity?`)) return reply(proof(url, validProof));
    if (url === `${moved}/ping`) return reply(discovery);
    if (url === `${moved}/app/devices`) return reply({ devices: [member] });
    throw new Error('Unexpected fixture route');
  }, true);
  return calls;
}
function authenticated(calls: ReturnType<typeof transport>) {
  return calls.filter(call => Boolean((call.init.headers as Record<string, unknown> | undefined)?.['X-Salcara-Bot-Token']));
}
function expectPublicMetadata(calls: ReturnType<typeof transport>) {
  for (const call of calls.filter(item => !item.url.endsWith('/app/devices'))) {
    expect(JSON.stringify(call.init)).not.toContain(token);
  }
}

beforeEach(() => {
  mockSecure.clear();
  mockSecureRead.mockReset().mockImplementation(async (key: string) => mockSecure.get(key) ?? null);
  mockSecureWrite.mockReset().mockImplementation(async (key: string, value: string) => { mockSecure.set(key, value); });
});
afterEach(() => { setHubFetch(null); jest.restoreAllMocks(); });

test('native recovered directory bootstraps an empty global cache and a real foreground Bot read proves the new-only endpoint', async () => {
  const recovered = manifest(), calls = transport(recovered);
  expect(recovered.endpoints.map(endpoint => endpoint.url)).toEqual([moved]);
  expect(hubIngressSnapshot(canonical)).toBeUndefined();
  expect(await adoptRecoveredBotHubIngress(canonical, recovered, expectedPin, () => true)).toBe(true);
  expect(calls).toEqual([]); // Native directory import alone grants no fresh proof.
  expect(JSON.stringify([...mockSecure.values()])).not.toContain(token);
  await expect(devices(bot())).resolves.toEqual([member]);
  expect(calls.some(call => call.url.startsWith(`${canonical}/`))).toBe(true);
  const sent = authenticated(calls);
  expect(sent).toHaveLength(1);
  expect(sent[0].url).toBe(`${moved}/app/devices`);
  expect(sent[0].init.headers).toMatchObject({ 'X-Salcara-Bot-Token': token });
  expect(sent[0].init.headers).not.toHaveProperty('X-Salcara-Pair-Token');
  const freshProof = calls.findIndex(call => call.url.startsWith(`${moved}/ingress/identity?`));
  expect(freshProof).toBeGreaterThanOrEqual(0);
  expect(freshProof).toBeLessThan(calls.indexOf(sent[0]));
  expectPublicMetadata(calls);
});

test('an adopted signed directory does not authorize a Bot request without a valid fresh proof', async () => {
  const recovered = manifest(), calls = transport(recovered, false);
  expect(await adoptRecoveredBotHubIngress(canonical, recovered, expectedPin, () => true)).toBe(true);
  await expect(devices(bot())).rejects.toThrow();
  expect(calls.some(call => call.url.startsWith(`${moved}/ingress/identity?`))).toBe(true);
  expect(authenticated(calls)).toEqual([]); expectPublicMetadata(calls);
});

test('a different durable global identity rejects native hand-back and the old Bot token never leaves the foreground client', async () => {
  const other = manifest(canonical, otherKeys, '2'.repeat(32));
  mockSecure.set(cacheKey, JSON.stringify(other));
  const recovered = manifest(), calls = transport(recovered);
  expect(await adoptRecoveredBotHubIngress(canonical, recovered, expectedPin, () => true)).toBe(false);
  expect(hubIngressSnapshot(canonical)).toEqual(other);
  expect(mockSecureWrite).not.toHaveBeenCalled();
  await expect(devices(bot())).rejects.toMatchObject({ code: 'hub_identity_changed' });
  expect(authenticated(calls)).toEqual([]); expectPublicMetadata(calls);
});

test('an owner lost while loading the cache cannot adopt routing or send the old Bot credential', async () => {
  const reached = deferred<void>(), read = deferred<string | null>();
  mockSecureRead.mockImplementationOnce(async () => { reached.resolve(); return read.promise; });
  const recovered = manifest(), calls = transport(recovered);
  let active = true;
  const pending = adoptRecoveredBotHubIngress(canonical, recovered, expectedPin, () => active);
  await reached.promise; active = false; read.resolve(null);
  expect(await pending).toBe(false);
  expect(hubIngressSnapshot(canonical)).toBeUndefined();
  expect(mockSecureWrite).not.toHaveBeenCalled();
  await expect(devices(bot({ dispatchGuard: () => active }))).rejects.toThrow();
  expect(authenticated(calls)).toEqual([]); expectPublicMetadata(calls);
});

test.each(['current', 'revoking', 'token replaced'] as const)('recovered foreground dispatch respects a %s owner after queued authorization', async change => {
  const recovered = manifest(), calls = transport(recovered);
  let status = 'active', currentToken = token;
  const active = () => status === 'active' && currentToken === token;
  expect(await adoptRecoveredBotHubIngress(canonical, recovered, expectedPin, active)).toBe(true);
  const reached = deferred<void>(), release = deferred<void>();
  const authorize: NonNullable<Hub['authorizeDispatch']> = async <T,>(dispatch: () => T) => {
    reached.resolve(); await release.promise;
    return active() ? { value: dispatch() } : null;
  };
  const pending = devices(bot({ authorizeDispatch: authorize }));
  const outcome = change === 'current' ? expect(pending).resolves.toEqual([member])
    : expect(pending).rejects.toMatchObject({ status: 409, code: 'bot_binding_changed' });
  try {
    await reached.promise;
    expect(authenticated(calls)).toEqual([]);
    if (change === 'revoking') status = 'revoking';
    if (change === 'token replaced') currentToken = 'b'.repeat(64);
    release.resolve(); await outcome;
    expect(authenticated(calls).map(call => call.url)).toEqual(change === 'current' ? [`${moved}/app/devices`] : []);
    expectPublicMetadata(calls);
  } finally { release.resolve(); }
});
