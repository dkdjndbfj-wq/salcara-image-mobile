import { registerPushToken, setHubFetch, type FetchLike } from '../remote/client';
import { notificationScopeFor, validNotificationScope } from '../remote/notification-scope';

afterEach(() => setHubFetch(null));

test('notification identity follows station, device and exact pairing generation without exposing credentials', () => {
  const hub = { url: 'https://station.example/salcara-hub/v1', pairToken: 'a'.repeat(64) };
  const scope = notificationScopeFor(hub, 'pc')!;
  expect(scope).toMatch(/^ns1_[a-f0-9]{64}$/);
  expect(scope).not.toContain(hub.url); expect(scope).not.toContain(hub.pairToken);
  expect(notificationScopeFor({ ...hub }, 'pc')).toBe(scope);
  expect(notificationScopeFor({ ...hub, url: 'https://other.example/salcara-hub/v1' }, 'pc')).not.toBe(scope);
  expect(notificationScopeFor({ ...hub, pairToken: 'b'.repeat(64) }, 'pc')).not.toBe(scope);
  expect(notificationScopeFor(hub, 'other-pc')).not.toBe(scope);
  expect(notificationScopeFor({ url: hub.url }, 'pc')).toBeNull();
  expect([undefined, null, '', 'ns1_' + 'g'.repeat(64), scope + '\n'].map(validNotificationScope)).toEqual([false, false, false, false, false]);
});

test('push registration transports the same non-secret scope checked on notification open', async () => {
  const hub = { url: 'https://station.example/salcara-hub/v1', pairToken: 'a'.repeat(64), deviceId: 'pc' };
  const fetcher = jest.fn(async (_url: string, _init: Record<string, unknown>) => ({ ok: true, status: 200, text: async () => JSON.stringify({ push: 'fcm' }) }));
  setHubFetch(fetcher as FetchLike);
  await expect(registerPushToken(hub, 'pc', 'synthetic-fcm-token')).resolves.toBe('fcm');
  const [url, init] = fetcher.mock.calls[0];
  expect(url).toBe(`${hub.url}/app/push/register`);
  expect(JSON.parse(String(init.body))).toEqual({ deviceId: 'pc', token: 'synthetic-fcm-token', platform: 'android', notificationScope: notificationScopeFor(hub, 'pc') });
  expect(String(init.body)).not.toContain(hub.pairToken);
});
