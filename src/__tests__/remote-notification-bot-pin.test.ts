import { generateKeyPairSync, sign } from 'node:crypto';
import type { IngressManifest } from '../remote/ingress';

const mockSnapshot = jest.fn();
beforeAll(() => { Object.defineProperty(globalThis, 'fetch', { value: jest.fn(), configurable: true, writable: true }); });
jest.mock('expo', () => ({ requireOptionalNativeModule: () => null }));
jest.mock('react-native', () => ({ Platform: { OS: 'android' }, AppState: { currentState: 'active' } }));
jest.mock('../remote/client', () => ({ hubIngressSnapshot: (...args: unknown[]) => mockSnapshot(...args) }));
jest.mock('../remote/push', () => ({}));
jest.mock('../remote/store', () => ({}));
jest.mock('../remote/connections', () => ({}));
jest.mock('../remote/notification-targets', () => ({}));
jest.mock('../remote/notification-preferences', () => ({}));

import { nativeNotificationWatchAuthority } from '../remote/notifications';

const url = 'https://bot.example/salcara-hub/v1';
const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
const botPin = { instanceId: 'a'.repeat(32), publicKey };
const hub = () => ({ url, pairToken: 'must-not-send-as-pair', botToken: 'synthetic-bot-token', botPin: { ...botPin } });
function manifest(overrides: Partial<IngressManifest> = {}): IngressManifest {
  const now = Date.now();
  return { version: 1, hub_instance_id: botPin.instanceId, identity_public_key: publicKey, canonical_url: url,
    revision: 1, issued_at: now - 1000, expires_at: now + 60_000,
    endpoints: [{ id: 'canonical', url, priority: 0 }], ...overrides };
}
function signed(value = manifest()): IngressManifest {
  const bytes = Buffer.from(JSON.stringify(value));
  return { ...value, signed_payload: bytes.toString('base64'),
    signature: sign(null, Buffer.concat([Buffer.from('salcara-ingress-manifest-v1\n'), bytes]), keys.privateKey).toString('base64') };
}

beforeEach(() => { mockSnapshot.mockReset().mockReturnValue(undefined); });

test('pinned Bot hands off its durable identity with no shared cache and never Pair credentials', () => {
  const source = hub();
  expect(nativeNotificationWatchAuthority(source)).toEqual({ hubUrl: url, botToken: source.botToken, botPin });
  expect(source.pairToken).toBe('must-not-send-as-pair');
});

test('a shared URL cache for B cannot replace saved Bot A or forward B endpoints', () => {
  mockSnapshot.mockReturnValue(signed(manifest({ hub_instance_id: 'b'.repeat(32) })));
  expect(nativeNotificationWatchAuthority(hub())).toEqual({ hubUrl: url, botToken: 'synthetic-bot-token', botPin });
});

test('even matching unsigned outer fields cannot hide another identity inside the signed envelope', () => {
  const foreign = signed(manifest({ hub_instance_id: 'b'.repeat(32) }));
  mockSnapshot.mockReturnValue({ ...foreign, hub_instance_id: botPin.instanceId, identity_public_key: botPin.publicKey });
  expect(nativeNotificationWatchAuthority(hub())).not.toHaveProperty('ingressManifest');
});

test('a correctly signed same-pin cache is copied as a hint without aliasing source identities', () => {
  const source = hub(), snapshot = signed();
  mockSnapshot.mockReturnValue(snapshot);
  const authority = nativeNotificationWatchAuthority(source)!;
  expect(authority).toMatchObject({ botPin, ingressManifest: snapshot });
  if (!('botPin' in authority)) throw new Error('Expected a pinned Bot handoff');
  expect(authority.botPin).not.toBe(source.botPin);
  expect(authority.ingressManifest).not.toBe(snapshot);
  source.botPin.instanceId = 'c'.repeat(32); snapshot.endpoints[0].url = 'https://changed.example/v1';
  expect(authority.botPin).toEqual(botPin);
  expect(authority.ingressManifest!.endpoints[0].url).toBe(url);
});

test.each(['unsigned', 'invalid-signature', 'wrong-public-key'] as const)('Bot ignores %s cache without changing its durable pin', variant => {
  const snapshot = variant === 'unsigned' ? manifest() : signed();
  if (variant === 'invalid-signature') snapshot.signature = Buffer.alloc(64).toString('base64');
  const source = hub();
  if (variant === 'wrong-public-key') source.botPin.publicKey = Buffer.alloc(32, 2).toString('base64');
  mockSnapshot.mockReturnValue(snapshot);
  const authority = nativeNotificationWatchAuthority(source)!;
  expect(authority).not.toHaveProperty('ingressManifest');
  if (!('botPin' in authority)) throw new Error('Expected a pinned Bot handoff');
  expect(authority.botPin).toEqual(source.botPin);
});

test('expired but signed same-pin cache is only a hint; a moved canonical does not replace the saved URL', () => {
  const now = Date.now(), moved = 'https://moved.example/salcara-hub/v1';
  mockSnapshot.mockReturnValue(signed(manifest({ canonical_url: moved, issued_at: now - 120_000, expires_at: now - 60_000,
    endpoints: [{ id: 'canonical', url: moved, priority: 0 }] })));
  expect(nativeNotificationWatchAuthority(hub())).toMatchObject({ hubUrl: url, botPin, ingressManifest: { canonical_url: moved } });
});

test.each([undefined, null, {}, { instanceId: 'a'.repeat(32) }, { instanceId: 'wrong', publicKey },
  { instanceId: 'a'.repeat(32), publicKey: 'invalid' }])('legacy or malformed Bot pin is not promoted from the global cache: %j', pin => {
  mockSnapshot.mockReturnValue(signed());
  const source = { url, botToken: 'legacy-secret', botPin: pin };
  expect(nativeNotificationWatchAuthority(source as Parameters<typeof nativeNotificationWatchAuthority>[0])).toBeNull();
  expect(mockSnapshot).not.toHaveBeenCalled();
  expect(source.botToken).toBe('legacy-secret'); // User storage is untouched.
});

test('Pair-only handoff retains its current cache and credentials unchanged', () => {
  const cache = manifest(); mockSnapshot.mockReturnValue(cache);
  expect(nativeNotificationWatchAuthority({ url, pairToken: 'pair-secret' })).toEqual({ hubUrl: url, pairToken: 'pair-secret', ingressManifest: cache });
});
