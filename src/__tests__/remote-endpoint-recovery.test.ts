import { generateKeyPairSync, sign } from 'node:crypto';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { devices, HubError, setHubFetch, type FetchLike } from '../remote/client';
import { connectionFailure } from '../remote/connection-errors';
import { remoteConnectionState } from '../remote/connection-state';
import { botConnectionId, connectionId, connectionToken, saveConnection, type RemoteConnection } from '../remote/connections';
import { bootRemote, getRemoteState, resetRemoteForTests, useSavedConnection } from '../remote/store';
import type { IngressManifest } from '../remote/ingress';

const mockSettings = new Map<string, string>(), mockSecrets = new Map<string, string>();
jest.mock('../storage/database', () => ({
  getSetting: async (key: string) => mockSettings.get(key) ?? null,
  setSetting: async (key: string, value: string | null) => { if (value === null) mockSettings.delete(key); else mockSettings.set(key, value); },
}));
jest.mock('../storage/secure-keys', () => ({ getProviderKey: async () => null }));
jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'fixture', getItemAsync: async (key: string) => mockSecrets.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { mockSecrets.set(key, value); },
  deleteItemAsync: async (key: string) => { mockSecrets.delete(key); },
}));
jest.mock('expo-crypto', () => ({
  randomUUID: () => require('node:crypto').randomUUID(), getRandomBytes: (length: number) => new Uint8Array(require('node:crypto').randomBytes(length)),
}));

const canonical = 'https://original.example/salcara-hub/v1', backup = 'https://current.example/salcara-hub/v1';
const token = 'c'.repeat(64), hubId = 'a'.repeat(32), keys = generateKeyPairSync('ed25519');
const key = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
const capabilities = ['device.identity.v1', 'pair.qr.v1', 'session.remote.v1', 'pair.revoke.v1'];
const discovery = { service: 'salcara-hub', protocol: 'salcara-remote', protocolVersion: 1, authModes: ['device-pairing'], capabilities };
const device = { deviceId: 'pc-a', name: '电脑', tools: [], projects: [], online: true };
const json = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
function signedManifest(now = Date.now()): IngressManifest {
  const value = { version: 1 as const, hub_instance_id: hubId, identity_public_key: key, canonical_url: canonical,
    revision: 3, issued_at: now, expires_at: now + 86_400_000,
    endpoints: [{ id: 'canonical', url: canonical, priority: 100 }, { id: 'current', url: backup, priority: 50 }] };
  const bytes = Buffer.from(JSON.stringify(value));
  return { ...value, signed_payload: bytes.toString('base64'), signature: sign(null, Buffer.concat([Buffer.from('salcara-ingress-manifest-v1\n'), bytes]), keys.privateKey).toString('base64') };
}
function proof(url: string) {
  const nonce = new URL(url).searchParams.get('nonce'), now = Date.now();
  const value = { version: 1, hub_instance_id: hubId, nonce, issued_at: now, expires_at: now + 30_000 };
  const bytes = Buffer.from(`salcara-ingress-proof-v1\n${hubId}\n${nonce}\n${value.issued_at}\n${value.expires_at}`);
  return { ...value, signature: sign(null, bytes, keys.privateKey).toString('base64') };
}
const pinKey = `salcara.ingress.v1.${bytesToHex(sha256(new TextEncoder().encode(canonical)))}`;

beforeEach(() => { resetRemoteForTests(); mockSettings.clear(); mockSecrets.clear(); });
afterEach(() => { resetRemoteForTests(); setHubFetch(null); });

test.each(['relay', 'bot'] as const)('restoring a saved %s computer can use its pinned signed endpoint when the original address is gone', async mode => {
  const profile: RemoteConnection = { id: mode === 'bot' ? botConnectionId(canonical, device.deviceId, 'group') : connectionId(canonical, device.deviceId),
    hubUrl: canonical, deviceId: device.deviceId, deviceName: device.name, pairedAt: 1, ...(mode === 'bot' ? { botGroupId: 'group' } : {}) };
  await saveConnection(profile, token);
  await bootRemote([]);
  const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    if (url.startsWith(canonical)) throw new Error('Original address no longer exists');
    if (url.endsWith('/ingress/manifest')) return json(signedManifest());
    if (url.includes('/ingress/identity?')) return json(proof(url));
    if (url.endsWith('/ping')) return json(discovery);
    if (url.endsWith('/app/devices')) return json({ devices: [device] });
    return json({ ok: true });
  };
  mockSecrets.set(pinKey, JSON.stringify(signedManifest()));
  setHubFetch(fetch, true);
  await useSavedConnection(profile.id, false, { requireOnline: true });
  expect(getRemoteState()).toMatchObject({ connectionId: profile.id, selectedHubUrl: canonical, connection: 'open' });
  expect(await connectionToken(profile)).toBe(token);
  expect(getRemoteState().devices).toEqual([device]);
  const credentialed = calls.filter(call => JSON.stringify(call.init.headers).includes(token));
  expect(credentialed.length).toBeGreaterThan(0);
  expect(credentialed.every(call => call.url.startsWith(`${backup}/`))).toBe(true);
  expect(calls.filter(call => call.url.includes('/ingress/')).every(call => !JSON.stringify(call.init).includes(token))).toBe(true);
  expect(calls.some(call => call.url === `${backup}/ping`)).toBe(true);
});

test('an expired identity authority during a network outage does not report that the computer must enroll again', async () => {
  mockSecrets.set(pinKey, JSON.stringify(signedManifest(Date.now() - 86_400_001)));
  const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
  setHubFetch(async (url, init) => { calls.push({ url, init }); throw new Error('Temporarily offline'); }, true);
  await expect(devices({ url: canonical, pairToken: token, deviceId: device.deviceId })).rejects.toMatchObject({ code: 'hub_unreachable' });
  expect(calls.every(call => !JSON.stringify(call.init.headers).includes(token))).toBe(true);
  expect(mockSecrets.get(pinKey)).toBeTruthy();
});

test('a canonical nonce check that cannot reach the network preserves pairing without claiming identity replacement', async () => {
  const manifest = signedManifest();
  mockSecrets.set(pinKey, JSON.stringify(manifest));
  setHubFetch(async url => url.endsWith('/ingress/manifest') ? json(manifest) : Promise.reject(new Error('Network offline')), true);
  await expect(devices({ url: canonical, botToken: token, deviceId: device.deviceId })).rejects.toMatchObject({ code: 'hub_unreachable' });
});

test('a confirmed identity mismatch has its own safe recovery state rather than requiring computer enrollment', () => {
  const failure = connectionFailure(new HubError('private server details', 409, 'hub_identity_changed'));
  expect(failure.connectionProblem).toBe('identity');
  const visible = remoteConnectionState({ connection: 'error', ...failure });
  expect(visible.label).toBe('连接身份待确认');
  expect(visible.detail).not.toMatch(/重新登记|管理员密码|private/);
});
