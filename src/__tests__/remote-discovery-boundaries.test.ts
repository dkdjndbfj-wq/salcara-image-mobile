import { discoverStation, setHubFetch } from '../remote/client';

const origin = 'https://discovery.example/Custom/v1';
const endpoints = ['https://discovery.example/Custom/salcara-hub/v1', 'https://discovery.example/salcara-hub/v1'];
const discovery = { service: 'salcara-hub', protocol: 'salcara-remote', protocolVersion: 1, authModes: ['device-pairing'],
  capabilities: ['device.identity.v1', 'pair.qr.v1', 'session.remote.v1', 'pair.revoke.v1'] };
const json = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
afterEach(() => { setHubFetch(null); jest.useRealTimers(); });

test('only an actually missing route continues anonymous discovery', async () => {
  const calls: string[] = [];
  setHubFetch(async (url, init) => {
    calls.push(url); expect(init.headers).toEqual({ Accept: 'application/json' });
    expect(init).toMatchObject({ credentials: 'omit', redirect: 'error' });
    return calls.length === 1 ? json({}, 404) : json(discovery);
  });
  await expect(discoverStation(origin)).resolves.toMatchObject({ url: endpoints[1] });
  expect(calls).toEqual(endpoints.map(url => `${url}/ping`));
});

test.each([401, 403, 405, 503])('HTTP %s cannot silently search another route', async status => {
  const calls: string[] = [];
  setHubFetch(async url => { calls.push(url); return calls.length === 1 ? json({}, status) : json(discovery); });
  await expect(discoverStation(origin)).rejects.toMatchObject({ status });
  expect(calls).toEqual([`${endpoints[0]}/ping`]);
});

test.each(['wrong-service', 'old-version', 'missing-capability'])('incompatible successful discovery (%s) stops with actionable wording', async kind => {
  let calls = 0;
  const result = kind === 'wrong-service' ? {} : kind === 'old-version' ? { ...discovery, protocolVersion: 2 } : { ...discovery, capabilities: [] };
  setHubFetch(async () => { calls++; return json(calls === 1 ? result : discovery); });
  await expect(discoverStation(origin)).rejects.toMatchObject({ code: 'remote_unsupported', message: expect.not.stringContaining('没有安装') });
  expect(calls).toBe(1);
});

test('redirects and stalled discovery are bounded and do not trigger route guessing', async () => {
  let calls = 0;
  setHubFetch(async () => { calls++; return { ...json(discovery), redirected: true }; });
  await expect(discoverStation(origin)).rejects.toThrow('重定向'); expect(calls).toBe(1);
  jest.useFakeTimers(); calls = 0;
  setHubFetch(async () => { calls++; return new Promise(() => undefined); });
  const pending = expect(discoverStation(origin)).rejects.toMatchObject({ code: 'hub_timeout' });
  await jest.advanceTimersByTimeAsync(2600); await pending; expect(calls).toBe(1);
});
