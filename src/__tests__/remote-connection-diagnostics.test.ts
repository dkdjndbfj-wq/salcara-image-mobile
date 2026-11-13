import { diagnosticProbe, HubError, setHubFetch, type FetchLike, type Hub } from '../remote/client';
import { diagnosticSummary, measureConnection } from '../remote/connection-diagnostics';
import { botStationFixture } from './fixtures/bot-station';

jest.mock('expo-crypto', () => ({ randomUUID: () => require('node:crypto').randomUUID(), getRandomBytes: (size: number) => new Uint8Array(require('node:crypto').randomBytes(size)) }));
const owner: Hub = { url: 'https://private-station.example/salcara-hub/v1', pairToken: 'private-pair-token', deviceId: 'private-pc' };
const reply = (body: unknown, status = 200) => ({ ok: status === 200, status, text: async () => JSON.stringify(body) });
const echo = (body: Record<string, unknown>): Record<string, unknown> => ({ version: 1, ...body, status: 'ok', ...(body.target === 'hub' ? { deviceOnline: true, lastSeen: 123 } : { hubDeviceMs: 12 }) });
let requests: Array<{ endpoint: string; init: Parameters<FetchLike>[1]; body: Record<string, unknown> }>;
let now: number;
beforeEach(() => {
  requests = []; now = 0; jest.spyOn(performance, 'now').mockImplementation(() => now);
  setHubFetch(async (endpoint, init) => { const body = JSON.parse(String(init.body)); requests.push({ endpoint, init, body }); now += body.target === 'hub' ? 25 : 60; return reply(echo(body)); });
});
afterEach(() => { setHubFetch(null); jest.restoreAllMocks(); jest.useRealTimers(); });

test('separate authenticated probes measure local round trips and use fresh nonce without command/model APIs', async () => {
  const measured = await measureConnection(owner, owner.deviceId!);
  expect(measured.hub).toMatchObject({ status: 'ok', ms: 25 });
  expect(measured.computer).toMatchObject({ status: 'ok', ms: 12 });
  expect(measured.roundTrip).toMatchObject({ status: 'ok', ms: 60 });
  expect(requests).toHaveLength(2); expect(requests[0].body.nonce).not.toBe(requests[1].body.nonce);
  for (const request of requests) {
    expect(request.endpoint).toBe(`${owner.url}/app/diagnostics`);
    expect(request.init).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error', headers: { 'X-Salcara-Pair-Token': owner.pairToken } });
    expect(Object.keys(request.body).sort()).toEqual(['deviceId', 'nonce', 'target']);
  }
  const summary = diagnosticSummary(measured);
  for (const secret of [owner.url, owner.pairToken!, owner.deviceId!, ...requests.map(request => String(request.body.nonce))]) expect(summary).not.toContain(secret);
});

test.each([{ url: owner.url }, { ...owner, deviceId: 'other-pc' }])('unpaired/mismatched targets never send a probe', async hub => {
  await expect(diagnosticProbe(hub, owner.deviceId!, 'nonce-1234567890', 'hub')).rejects.toMatchObject({ status: 403 });
  expect(requests).toHaveLength(0);
});

test.each([
  [404, '', 'unsupported'], [405, '', 'unsupported'], [401, '', 'reauth'], [403, '', 'reauth'],
  [429, 'diagnostic_rate_limited', 'busy'], [503, 'diagnostic_busy', 'busy'], [504, 'diagnostic_timeout', 'timeout'],
  [409, 'diagnostic_device_offline', 'offline'], [502, 'diagnostic_reply_invalid', 'invalid'], [500, 'unknown', 'unreachable'],
  [403, 'pair_credentials_invalid', 'reauth'], [403, 'device_credentials_invalid', 'enrollment'],
  [403, 'source_grant_required', 'denied'], [403, 'station_policy_invalid', 'denied'], [423, 'user_disabled', 'denied'],
  [403, 'unknown_policy', 'denied'],
  [409, 'hub_identity_changed', 'identity'],
  [409, 'clock_skew', 'clock_skew'],
])('HTTP %s %s produces a bounded reason and no fabricated duration', async (status, code, expected) => {
  setHubFetch(async () => reply({ error: `${owner.url} secret-raw-error`, code }, status as number));
  const measured = await measureConnection(owner, owner.deviceId!);
  expect(measured.hub).toMatchObject({ status: expected, ms: null });
  expect(measured.computer.status).toBe('not_measured');
  expect(JSON.stringify(measured)).not.toContain('secret-raw-error');
  expect(diagnosticSummary(measured)).not.toContain(owner.url);
});

test.each(['hub', 'device'] as const)('a typed clock error on the %s segment keeps a safe actionable diagnosis', async target => {
  setHubFetch(async (_endpoint, init) => {
    const body = JSON.parse(String(init.body));
    if (body.target === target) throw new HubError('secret-raw-error', 409, 'clock_skew');
    now += 25; return reply(echo(body));
  });
  const measured = await measureConnection(owner, owner.deviceId!);
  const segment = target === 'hub' ? measured.hub : measured.computer;
  expect(segment).toMatchObject({ status: 'clock_skew', ms: null });
  expect(segment.detail).toContain('自动日期');
  expect(segment.detail).toMatch(/配对.*聊天.*保留/);
  expect(diagnosticSummary(measured)).toContain('设备时间不一致');
  expect(JSON.stringify(measured)).not.toMatch(/secret-raw-error|重新配对|电脑离线/);
});

test('offline computer stops after the Hub exchange', async () => {
  const fetch = jest.fn(async (_endpoint, init) => reply({ ...echo(JSON.parse(String(init.body))), deviceOnline: false }));
  setHubFetch(fetch); const measured = await measureConnection(owner, owner.deviceId!);
  expect(measured.hub.status).toBe('ok'); expect(measured.computer).toMatchObject({ status: 'offline', ms: null });
  expect(measured.roundTrip.status).toBe('not_measured'); expect(fetch).toHaveBeenCalledTimes(1);
});

test('Bot diagnostics use the Bot credential, label the measured route and explain re-binding without a QR instruction', async () => {
  const station = botStationFixture(owner.url);
  const bot: Hub = { url: owner.url, botToken: 'private-bot-token', botPin: station.pin, deviceId: owner.deviceId };
  setHubFetch(station.wrap(async (endpoint, init) => {
    const body = JSON.parse(String(init.body)); requests.push({ endpoint, init, body }); now += body.target === 'hub' ? 25 : 60; return reply(echo(body));
  }, true), true);
  const measured = await measureConnection(bot, bot.deviceId!);
  expect(measured.roundTrip.status).toBe('ok');
  for (const segment of [measured.hub, measured.computer, measured.roundTrip]) {
    expect(segment.detail).toContain('Bot');expect(segment.detail).not.toMatch(/Hub|中转站/);
  }
  for (const request of requests) {
    expect(request.init.headers).toMatchObject({ 'X-Salcara-Bot-Token': bot.botToken });
    expect(request.init.headers).not.toHaveProperty('X-Salcara-Pair-Token');
  }
  setHubFetch(station.wrap(async () => reply({ error: 'private-bot-token' }, 401), true), true);
  const rejected = await measureConnection(bot, bot.deviceId!);
  expect(rejected.hub).toMatchObject({ status: 'reauth', ms: null });
  expect(rejected.hub.detail).toContain('重新绑定 Bot');expect(rejected.hub.detail).not.toContain('扫码');
  expect(JSON.stringify(rejected)).not.toContain(bot.botToken);
});

test.each(['nonce', 'deviceId', 'extra', 'clock', 'target'])('rejects a malformed %s response', async corruption => {
  setHubFetch(async (_endpoint, init) => {
    const body = JSON.parse(String(init.body)); now += 60; const response = echo(body);
    if (corruption === 'extra') response.private = 'secret';
    else if (corruption === 'clock') { if (body.target === 'device') response.hubDeviceMs = 8000; }
    else response[corruption] = 'wrong';
    return reply(response);
  });
  const measured = await measureConnection(owner, owner.deviceId!);
  expect(corruption === 'clock' ? measured.computer.status : measured.hub.status).toBe('invalid');
  expect(diagnosticSummary(measured)).not.toContain('secret');
});

test('external cancellation releases the request even if transport ignores abort', async () => {
  setHubFetch(async () => new Promise(() => {})); const abort = new AbortController();
  const pending = measureConnection(owner, owner.deviceId!, abort.signal);
  const rejected = expect(pending).rejects.toMatchObject({ code: 'aborted' }); abort.abort(); await rejected;
});

test('bounded timeout works even if a native body read never settles', async () => {
  jest.useFakeTimers(); setHubFetch(async () => ({ ok: true, status: 200, text: async () => new Promise(() => {}) }));
  const pending = measureConnection(owner, owner.deviceId!);
  await jest.advanceTimersByTimeAsync(6100);
  expect((await pending).hub).toMatchObject({ status: 'timeout', ms: null });
  expect(jest.getTimerCount()).toBe(0);
});
