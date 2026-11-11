import { bindBotPhone, botGroupDevices, devices, HubError, isPairingAuthenticationError, setHubFetch, type Hub } from '../remote/client';
import { connectionFailure, connectionProblem } from '../remote/connection-errors';
import { measureConnection } from '../remote/connection-diagnostics';
import { botStationFixture } from './fixtures/bot-station';

jest.mock('expo-crypto', () => ({ randomUUID: () => require('node:crypto').randomUUID(), getRandomBytes: (size: number) => new Uint8Array(require('node:crypto').randomBytes(size)) }));
const canonical = 'https://bot-auth.example/salcara-hub/v1';
const station = botStationFixture(canonical);
const bot: Hub = { url: canonical, botToken: 'a'.repeat(64), botPin: station.pin, deviceId: 'pc' };
const binding = { type: 'salcara-hub-bot-binding' as const, version: 1 as const, hubUrl: 'https://bot-auth.example/salcara-hub', groupId: 'group', invite: 'b'.repeat(64), signature: 'c'.repeat(64) };
const reply = (status: number, code?: string) => ({ ok: false, status, text: async () => JSON.stringify({ code, error: `private-${bot.botToken}-${binding.invite}` }) });
afterEach(() => setHubFetch(null));

test.each([
  [403, 'bot_credentials_invalid', true, 'pairing', 'reauth'],
  [403, 'bot_phone_credentials_invalid', true, 'pairing', 'reauth'],
  [503, 'bot_phone_bind_pending', false, 'unavailable', 'unreachable'],
  [503, 'bot_phone_revoke_pending', false, 'unavailable', 'unreachable'],
  [403, 'source_grant_required', false, 'permission', 'denied'],
  [403, 'station_policy_invalid', false, 'permission', 'denied'],
  [403, 'unknown_policy', false, 'permission', 'denied'],
] as const)('authenticated HTTP %s %s is classified precisely by ordinary reads, Bot wrapper and diagnostics', async (status, code, pairing, problem, diagnostic) => {
  const fetch = jest.fn(async (_url, init) => {
    expect(init.headers).toMatchObject({ 'X-Salcara-Bot-Token': bot.botToken });
    return reply(status, code);
  });
  setHubFetch(station.wrap(fetch, true), true);
  for (const read of [devices, botGroupDevices]) {
    const error = await read(bot).catch(value => value);
    expect(error).toBeInstanceOf(HubError);
    expect(isPairingAuthenticationError(error)).toBe(pairing);
    expect(connectionProblem(error)).toBe(problem);
    expect(JSON.stringify(connectionFailure(error))).not.toContain(bot.botToken);
  }
  const measured = await measureConnection(bot, bot.deviceId!);
  expect(measured.hub).toMatchObject({ status: diagnostic, ms: null });
  if (pairing) expect(measured.hub.detail).toContain('重新绑定 Bot');
  expect(JSON.stringify(measured)).not.toContain(bot.botToken);
  expect(fetch).toHaveBeenCalledTimes(3);
});

test.each([[403, 'bot_credentials_invalid'], [401, undefined], [403, undefined]] as const)('anonymous bind HTTP %s %s does not imply saved phone credential revocation', async (status, code) => {
  const fetch = jest.fn(async (url, init) => {
    expect(url).toBe(`${canonical}/bot/phone/bind`);
    expect(init.headers).not.toHaveProperty('X-Salcara-Bot-Token');
    expect(init.headers).not.toHaveProperty('X-Salcara-Pair-Token');
    return reply(status, code);
  });
  setHubFetch(station.wrap(fetch, true), true);
  const error = await bindBotPhone(binding, 'f'.repeat(64)).catch(value => value);
  expect(error).toMatchObject({ status, ...(code ? { code } : {}) });
  expect(isPairingAuthenticationError(error)).toBe(false);
  expect(connectionProblem(error)).toBe('permission');
  expect(String(error)).not.toContain(binding.invite);
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('legacy synthetic authentication errors remain compatible', () => {
  expect(isPairingAuthenticationError(new HubError('legacy', 401))).toBe(true);
  expect(isPairingAuthenticationError(new HubError('legacy', 403, 'bot_credentials_invalid'))).toBe(true);
});
