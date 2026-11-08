import { setHubFetch, type FetchLike } from '../remote/client';
import { bootRemote, connectStation, pairRemoteQr, parseRemoteQr, remoteDeliveryScope, resetRemoteForTests, sendToSession, getPendingRemoteMessage } from '../remote/store';
import { resetDeliveryForTests } from '../remote/delivery';

const mockSettings = new Map<string, string>();
const mockSecrets = new Map<string, string>();
const mockHandoff = jest.fn(async (_scope: string, images: Array<{ uri: string }>) => images.map(image => ({ ...image, uri: `file://private/remote-images-v2/submission/${image.uri.split('/').pop() ?? 'image.jpg'}` })));

jest.mock('../storage/database', () => ({
  getSetting: async (key: string) => mockSettings.get(key) ?? null,
  setSetting: async (key: string, value: string | null) => { if (value === null) mockSettings.delete(key); else mockSettings.set(key, value); },
}));
jest.mock('../storage/secure-keys', () => ({ getProviderKey: async () => null }));
jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'private',
  getItemAsync: async (key: string) => mockSecrets.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { mockSecrets.set(key, value); },
  deleteItemAsync: async (key: string) => { mockSecrets.delete(key); },
}));
jest.mock('expo-crypto', () => ({ randomUUID: () => '0199aaa1-1234-4678-9abc-000000000001' }));
jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file://private/',
  EncodingType: { Base64: 'base64' },
  getInfoAsync: jest.fn(async () => ({ exists: true, isDirectory: false })),
  readAsStringAsync: jest.fn(async () => 'AQID'),
  makeDirectoryAsync: jest.fn(async () => undefined),
  copyAsync: jest.fn(async () => undefined),
}));
jest.mock('../remote/queued-image-files', () => ({
  handoffQueuedImages: (...args: unknown[]) => mockHandoff(...args as [string, Array<{ uri: string }>]),
  markRemoteImagesInUse: () => undefined, collectRemoteImagesAtStartup: async () => ({ removedFiles: 0, freedBytes: 0, deferred: false }),
}));

const origin = 'https://handoff-fixture.example';
const hubUrl = `${origin}/salcara-hub/v1`;
const device = { deviceId: 'pc', name: 'Fixture', os: 'windows', tools: [], projects: [], online: true, lastSeen: 1 };
const response = (value: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(value) });
let writes: Array<{ command: Record<string, unknown>; requestId?: string }> = [];

beforeEach(async () => {
  resetRemoteForTests(); resetDeliveryForTests(); mockSettings.clear(); mockSecrets.clear(); writes = []; mockHandoff.mockClear();
  setHubFetch((async (url, init) => {
    if (url.endsWith('/ping')) return response({ service: 'salcara-hub', protocol: 'salcara-remote', protocolVersion: 1, authModes: ['device-pairing'], capabilities: ['device.identity.v1', 'pair.qr.v1', 'session.remote.v1', 'pair.revoke.v1', 'commands.idempotency.v1'] });
    if (url.endsWith('/app/pair/qr')) return response({ pair_token: 'a'.repeat(64), device });
    if (url.endsWith('/app/devices')) return response({ devices: [device] });
    if (url.endsWith('/app/commands')) {
      const body = JSON.parse(String(init.body)) as { command: Record<string, unknown>; requestId?: string };
      writes.push(body);
      if (body.command.type === 'attachment.put') return response({ ok: true, result: {} });
      if (body.command.type === 'session.send') return response({ ok: false, error: 'synthetic lost', code: 'command_delivery_uncertain' }, 200);
      return response({ ok: true, result: {} });
    }
    throw new Error(`unexpected endpoint ${url}`);
  }) as FetchLike);
  await bootRemote([]); await connectStation(origin);
  await pairRemoteQr(parseRemoteQr(JSON.stringify({ type: 'salcara-remote-pair', version: 1, hubUrl, deviceId: 'pc', deviceName: 'Fixture', ticket: 'b'.repeat(64), expiresAt: Date.now() + 120_000 })));
});

afterEach(() => { resetRemoteForTests(); resetDeliveryForTests(); setHubFetch(null); });

test('sends queued images only after handing ownership to submission storage', async () => {
  const image = { uri: `file://private/remote-images-v2/${'a'.repeat(64)}/queue-${'b'.repeat(64)}.jpg`, base64: 'AQID', mime: 'image/jpeg' as const, width: 1, height: 1 };
  await expect(sendToSession('pc', 'codex:session', 'with image', { images: [image], surface: 'cli', newSubmission: true }))
    .rejects.toMatchObject({ name: 'DeliveryPendingError' });
  expect(mockHandoff).toHaveBeenCalledWith(remoteDeliveryScope(), [expect.objectContaining({ uri: image.uri })]);
  const pending = await getPendingRemoteMessage('pc', 'codex:session');
  expect(pending?.attachmentSources?.[0].uri).toContain('/submission/');
  expect(pending?.attachmentSources?.[0].uri).not.toBe(image.uri);
  expect(writes.map(item => item.command.type)).toEqual(['attachment.put', 'session.send']);
});
