import { generateKeyPairSync, sign } from 'node:crypto';
import { bytesToHex } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  acknowledgeOperation, acknowledgeSessionEvents, bindBotPhone, botGroupDevices, command, confirmPairingHubIdentity,
  devices, diagnosticProbe, discoverSavedStation, openStream, prepareCommand, readOperation, registerPushToken, revokeBotPhone,
  sessionEventsPage, setHubFetch, verifyBotBindingStation, verifyHubAlias, type BotBindingPackage, type FetchLike, type Hub,
} from '../remote/client';
import type { IngressManifest } from '../remote/ingress';

const mockSecrets = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'fixture', getItemAsync: async (key: string) => mockSecrets.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { mockSecrets.set(key, value); },
  deleteItemAsync: async (key: string) => { mockSecrets.delete(key); },
}));
jest.mock('expo-crypto', () => ({ getRandomBytes: (size: number) => new Uint8Array(require('node:crypto').randomBytes(size)) }));

const binding: BotBindingPackage = { type: 'salcara-hub-bot-binding', version: 1, hubUrl: 'https://bot.example/salcara-hub', groupId: 'group', invite: 'c'.repeat(64), signature: 'd'.repeat(64) };
const canonical = `${binding.hubUrl}/v1`, backup = 'https://entry.example/salcara-hub/v1';
const token = 'b'.repeat(64), phoneId = 'f'.repeat(64), attemptId = 'c1a3c456-abcd-4bcd-8bcd-123456789abc';
const attempt = { attemptId, phoneToken: token };
const member = (id = 'a') => ({ deviceId: id, name: `电脑 ${id}`, tools: [], projects: [], online: true });
const reply = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
const hubId = 'a'.repeat(32);
const pin = { instanceId: hubId, publicKey };
const capabilities = ['device.identity.v1', 'pair.qr.v1', 'session.remote.v1', 'pair.revoke.v1', 'bot.phone.binding.v2'];
const discovery = { service: 'salcara-hub', protocol: 'salcara-remote', protocolVersion: 1, authModes: ['device-pairing'], capabilities };
function manifest(signed = true, instanceId = hubId, ttl = 86_400_000, now = Date.now()): IngressManifest {
  const body = { version: 1 as const, hub_instance_id: instanceId, identity_public_key: publicKey, canonical_url: canonical,
    revision: 3, issued_at: now, expires_at: now + ttl,
    endpoints: [{ id: 'canonical', url: canonical, priority: 100 }, { id: 'backup', url: backup, priority: 50 }] };
  if (!signed) return body;
  const bytes = Buffer.from(JSON.stringify(body));
  return { ...body, signed_payload: bytes.toString('base64'), signature: sign(null, Buffer.concat([Buffer.from('salcara-ingress-manifest-v1\n'), bytes]), keys.privateKey).toString('base64') };
}
function proof(url: string, instanceId = hubId, now = Date.now()) {
  const nonce = new URL(url).searchParams.get('nonce');
  const body = { version: 1, hub_instance_id: instanceId, nonce, issued_at: now, expires_at: now + 30_000 };
  const bytes = Buffer.from(`salcara-ingress-proof-v1\n${instanceId}\n${nonce}\n${body.issued_at}\n${body.expires_at}`);
  return { ...body, signature: sign(null, bytes, keys.privateKey).toString('base64') };
}
const pinKey = `salcara.ingress.v1.${bytesToHex(sha256(new TextEncoder().encode(canonical)))}`;
function setBotFetch(transport: FetchLike) {
  setHubFetch(async (url, init) => url.endsWith('/ingress/manifest') ? reply(manifest())
    : url.includes('/ingress/identity?') ? reply(proof(url)) : url.endsWith('/ping') ? reply(discovery) : transport(url, init), true);
}
const botHub = (): Hub => ({ url: canonical, botToken: token, botPin: { ...pin }, deviceId: 'a' });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function flush() { for (let index = 0; index < 100; index++) await Promise.resolve(); }

beforeEach(() => { mockSecrets.clear(); });
afterEach(() => setHubFetch(null));

test.each(['initial Bot verification', 'saved Bot verification', 'alias', 'pair confirmation', 'ordinary read', 'Bot read'] as const)('%s retains the verified clock disagreement without dispatching credentials', async operation => {
  mockSecrets.set(pinKey, JSON.stringify(manifest()));
  let authenticated = 0;
  setHubFetch(async (url, init) => {
    const headers = init.headers as Record<string, unknown> | undefined;
    if (headers?.['X-Salcara-Pair-Token'] || headers?.['X-Salcara-Bot-Token']) authenticated++;
    return url.endsWith('/ingress/manifest') ? reply(manifest(true, hubId, 86_400_000, Date.now() + (operation === 'pair confirmation' ? 60_001 : 0)))
      : url.includes('/ingress/identity?') ? reply(proof(url, hubId, Date.now() + 60_001)) : reply(discovery);
  }, true);
  const pending = operation === 'initial Bot verification' ? verifyBotBindingStation(canonical)
    : operation === 'saved Bot verification' ? verifyBotBindingStation(canonical, pin)
      : operation === 'alias' ? verifyHubAlias(canonical, backup)
          : operation === 'pair confirmation' ? confirmPairingHubIdentity(canonical, () => true)
            : operation === 'ordinary read' ? devices({ url: canonical, pairToken: phoneId }) : botGroupDevices(botHub());
  await expect(pending).rejects.toMatchObject({ name: 'HubError', code: 'clock_skew', status: 409, message: expect.stringContaining('自动日期') });
  expect(authenticated).toBe(0);
});

test.each(['initial', 'saved'] as const)('%s Bot verification tries a healthy signed alias after another reports clock disagreement', async mode => {
  mockSecrets.set(pinKey, JSON.stringify(manifest()));
  const authenticated: string[] = [];
  setHubFetch(async (url, init) => {
    if ((init.headers as Record<string, unknown>)?.['X-Salcara-Bot-Token']) authenticated.push(url);
    return url.endsWith('/ingress/manifest') ? reply(manifest())
      : url.includes('/ingress/identity?') ? reply(proof(url, hubId, Date.now() + (url.startsWith(canonical) ? 60_001 : 0)))
        : url.endsWith('/ping') ? reply(discovery) : reply({ devices: [member()] });
  }, true);
  const target = await verifyBotBindingStation(canonical, mode === 'saved' ? pin : undefined);
  expect(target.endpoint).toBe(backup);
  expect(authenticated).toEqual([]);
  await expect(botGroupDevices(botHub(), target)).resolves.toEqual([member()]);
  expect(authenticated).toEqual([`${backup}/app/devices`]);
});

test.each(['relay', 'bot'] as const)('a verified clock disagreement closes the %s stream with its safe typed reason, without reconnecting', async mode => {
  mockSecrets.set(pinKey, JSON.stringify(manifest()));
  let authenticated = 0;
  setHubFetch(async (url, init) => {
    const headers = init.headers as Record<string, unknown> | undefined;
    if (headers?.['X-Salcara-Pair-Token'] || headers?.['X-Salcara-Bot-Token']) authenticated++;
    return url.endsWith('/ingress/manifest') ? reply(manifest())
      : url.includes('/ingress/identity?') ? reply(proof(url, hubId, Date.now() - 60_001)) : reply(discovery);
  }, true);
  const states: Array<{ state: string; error?: string; errorCode?: string }> = [], stopped = deferred<void>();
  const retry = jest.fn(async () => undefined);
  const handle = openStream({ hub: mode === 'bot' ? botHub() : { url: canonical, pairToken: phoneId }, onEvent: jest.fn(), onDevice: jest.fn(), wait: retry,
    onState: (state, info) => { states.push({ state, ...info }); if (state === 'closed') stopped.resolve(); } });
  try {
    await stopped.promise;
    expect(states).toEqual([{ state: 'connecting' }, { state: 'closed', errorCode: 'clock_skew', error: expect.stringContaining('自动日期') }]);
    expect(authenticated).toBe(0); expect(retry).not.toHaveBeenCalled();
  } finally { handle.close(); }
});

test('v2 sends exactly the original package and paired attempt fields, and accepts an empty group', async () => {
  const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
  setHubFetch(async (url, init) => { calls.push({ url, init }); return reply({ ok: true, groupId: binding.groupId, botToken: token, devices: [] }); });
  expect(await bindBotPhone(binding, phoneId, attempt)).toEqual({ groupId: 'group', botToken: token, devices: [] });
  expect(calls).toHaveLength(1); expect(calls[0].url).toBe(`${canonical}/bot/phone/bind`);
  expect(JSON.parse(String(calls[0].init.body))).toEqual({ binding, phoneId, attemptId, phoneToken: token });
  expect(calls[0].init.headers).toEqual({ Accept: 'application/json', 'Content-Type': 'application/json' });
  expect(calls[0].init.redirect).toBe('error');
});

test.each(['token', 'group', 'ok', 'duplicate', 'device', 'computer'] as const)('v2 rejects a malformed %s result', async failure => {
  const list = failure === 'duplicate' ? [member(), member()] : failure === 'device' ? [{ ...member(), deviceId: '../bad' }]
    : failure === 'computer' ? [{ ...member(), computerId: '../bad' }] : [];
  setHubFetch(async () => reply({ ok: failure !== 'ok', groupId: failure === 'group' ? 'other' : 'group', botToken: failure === 'token' ? 'e'.repeat(64) : token, devices: list }));
  await expect(bindBotPhone(binding, phoneId, attempt)).rejects.toMatchObject({ code: 'bot_binding_invalid' });
});

test('an invalid attempt is rejected before network and never falls back to v1', async () => {
  const transport = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>(); setHubFetch(transport);
  await expect(bindBotPhone(binding, phoneId, { attemptId: 'bad', phoneToken: token })).rejects.toMatchObject({ code: 'bot_phone_invalid' });
  expect(transport).not.toHaveBeenCalled();
});

test('a revoked local generation cancels dispatch and server errors never echo secrets', async () => {
  const transport = jest.fn(async () => reply({ code: 'bot_phone_bind_pending', error: `${binding.invite} ${token}` }, 503));
  setHubFetch(transport);
  await expect(bindBotPhone(binding, phoneId, attempt, canonical, { stillCurrent: async () => false })).rejects.toMatchObject({ code: 'bot_binding_changed' });
  expect(transport).not.toHaveBeenCalled();
  try { await bindBotPhone(binding, phoneId, attempt); throw new Error('expected rejection'); }
  catch (error) {
    expect(error).toMatchObject({ code: 'bot_phone_bind_pending', status: 503 });
    expect((error as Error).message).not.toContain(token);
    expect((error as Error).message).not.toContain(binding.invite);
  }
});

test('a pin replaced during the final durable-generation check cannot receive the old invitation', async () => {
  let posts = 0;
  const transport: FetchLike = async (url, init) => {
    if (init.method === 'POST') posts++;
    return url.endsWith('/ingress/manifest') ? reply(manifest()) : url.includes('/ingress/identity?') ? reply(proof(url)) : reply(discovery);
  };
  setHubFetch(transport, true);
  await verifyBotBindingStation(canonical, pin);
  await expect(bindBotPhone(binding, phoneId, attempt, canonical, {
    pin, stillCurrent: async () => { setHubFetch(transport, true); return true; },
  })).rejects.toMatchObject({ code: 'hub_identity_changed' });
  expect(posts).toBe(0);
});

test.each(['members', 'revoke'] as const)('a pin change at %s dispatch cannot reroute the frozen group token', async operation => {
  let authenticated = 0;
  const transport: FetchLike = async (url, init) => {
    if ((init.headers as Record<string, string>)?.['X-Salcara-Bot-Token']) authenticated++;
    return url.endsWith('/ingress/manifest') ? reply(manifest()) : url.includes('/ingress/identity?') ? reply(proof(url)) : reply(discovery);
  };
  setHubFetch(transport, true);
  const target = await verifyBotBindingStation(canonical, pin);
  const pending = operation === 'members' ? botGroupDevices(botHub(), target)
    : revokeBotPhone(botHub(), 'group', target);
  setHubFetch(transport, true); // Change the authority before the request's send microtask.
  await expect(pending).rejects.toMatchObject({ code: 'hub_identity_changed' });
  expect(authenticated).toBe(0);
});

test('group discovery sees all members while existing selected-device reads remain scoped', async () => {
  const calls: Record<string, unknown>[] = [];
  setBotFetch(async (_url, init) => { calls.push(init); return reply({ devices: [member('a'), member('b')] }); });
  const hub = { ...botHub(), pairToken: 'e'.repeat(64), deviceId: 'b', key: 'unrelated-api-key' };
  expect(await botGroupDevices(hub)).toEqual([member('a'), member('b')]);
  expect(calls[0].headers).toEqual({ Accept: 'application/json', 'X-Salcara-Bot-Token': token });
  expect(await devices(hub)).toEqual([member('b')]);
});

test.each([{}, { devices: 'bad' }, { devices: [member(), member()] }])('invalid group discovery is not mistaken for an empty group', async body => {
  setBotFetch(async () => reply(body));
  await expect(botGroupDevices(botHub())).rejects.toMatchObject({ code: 'bot_binding_invalid' });
});

test('revoke sends only the Bot header and validates group plus invitation retirement', async () => {
  const calls: Record<string, unknown>[] = [];
  setBotFetch(async (_url, init) => { calls.push(init); return reply({ ok: true, groupId: 'group', invitationRevoked: true }); });
  await revokeBotPhone({ ...botHub(), pairToken: phoneId, key: 'api-key' }, 'group');
  expect(calls[0].headers).toEqual({ Accept: 'application/json', 'X-Salcara-Bot-Token': token });
  expect(calls[0].body).toBeUndefined(); expect(calls[0].method).toBe('POST');
  setBotFetch(async () => reply({ ok: true }));
  await expect(revokeBotPhone(botHub(), 'group')).rejects.toMatchObject({ code: 'bot_revoke_unconfirmed' });
});

test('binding discovery freshly proves the pin and reads capabilities anonymously', async () => {
  const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
  setHubFetch(async (url, init) => {
    calls.push({ url, init });
    return url.endsWith('/ingress/manifest') ? reply(manifest()) : url.includes('/ingress/identity?') ? reply(proof(url)) : reply(discovery);
  }, true);
  expect(await verifyBotBindingStation(canonical)).toEqual({ pin, endpoint: canonical });
  expect(calls.some(call => call.url.includes('/ingress/identity?'))).toBe(true);
  expect(calls.every(call => !JSON.stringify(call.init).includes(token) && !JSON.stringify(call.init).includes(binding.invite))).toBe(true);
});

test('missing v2 capability or a mismatched pin rejects without a binding POST', async () => {
  const calls: string[] = [];
  setHubFetch(async url => {
    calls.push(url);
    return url.endsWith('/ingress/manifest') ? reply(manifest()) : url.includes('/ingress/identity?') ? reply(proof(url))
      : reply({ ...discovery, capabilities: capabilities.filter(value => value !== 'bot.phone.binding.v2') });
  }, true);
  await expect(verifyBotBindingStation(canonical)).rejects.toMatchObject({ code: 'bot_binding_upgrade_required' });
  await expect(verifyBotBindingStation(canonical, { ...pin, instanceId: 'e'.repeat(32) })).rejects.toMatchObject({ code: 'hub_identity_changed' });
  expect(calls.every(url => !url.includes('/bot/phone/'))).toBe(true);
});

test('a retired original address recovers through its signed same-pin entry without editing the package', async () => {
  mockSecrets.set(pinKey, JSON.stringify(manifest()));
  const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
  setHubFetch(async (url, init) => {
    calls.push({ url, init });
    if (url.startsWith(canonical)) throw new Error('original address gone');
    if (url.endsWith('/ingress/manifest')) return reply(manifest());
    if (url.includes('/ingress/identity?')) return reply(proof(url));
    if (url.endsWith('/ping')) return reply(discovery);
    return reply({ ok: true, groupId: 'group', botToken: token, devices: [] });
  }, true);
  const verified = await verifyBotBindingStation(canonical, pin);
  expect(verified.endpoint).toBe(backup);
  await bindBotPhone(binding, phoneId, attempt, verified.endpoint);
  const post = calls.filter(call => call.init.method === 'POST');
  expect(post).toHaveLength(1); expect(post[0].url).toBe(`${backup}/bot/phone/bind`);
  expect(JSON.parse(String(post[0].init.body)).binding).toEqual(binding);
});

const ticket = { operationId: attemptId, ticket: 'fixture-ticket', dispatchNotAfter: Date.now() + 60_000, storageEpoch: 'fixture-epoch' };
const ordinaryRequests: Array<[string, (hub: Hub) => Promise<unknown>]> = [
  ['command', hub => command(hub, 'a', { type: 'agents.status' })],
  ['receipt-only command', hub => command(hub, 'a', { type: 'agents.status' }, attemptId, undefined, { receiptOnly: true })],
  ['prepare', hub => prepareCommand(hub, 'a', attemptId, { type: 'agents.status' })],
  ['receipt read', hub => readOperation(hub, 'a', ticket)],
  ['receipt ack', hub => acknowledgeOperation(hub, 'a', ticket)],
  ['events', hub => sessionEventsPage(hub, 'a', 'thread')],
  ['event ack', hub => acknowledgeSessionEvents(hub, 'a', 'thread', 1, 'epoch')],
  ['push', hub => registerPushToken(hub, 'a', 'fixture-push')],
  ['diagnostic', hub => diagnosticProbe(hub, 'a', 'c'.repeat(64), 'hub')],
];
test.each(ordinaryRequests)('%s cannot send the old Bot token to a replaced global Hub identity', async (_name, invoke) => {
  let authenticated = 0;
  const replacement = 'e'.repeat(32);
  setHubFetch(async (url, init) => {
    if ((init.headers as Record<string, string>)?.['X-Salcara-Bot-Token']) authenticated++;
    return url.endsWith('/ingress/manifest') ? reply(manifest(true, replacement))
      : url.includes('/ingress/identity?') ? reply(proof(url, replacement)) : reply(discovery);
  }, true);
  await expect(invoke(botHub())).rejects.toMatchObject({ code: 'hub_identity_changed' });
  expect(authenticated).toBe(0);
});

test.each(ordinaryRequests)('%s without a durable Bot pin preserves the credential without any network', async (_name, invoke) => {
  const calls = jest.fn(async () => reply(discovery)); setHubFetch(calls, true);
  await expect(invoke({ url: canonical, botToken: token, deviceId: 'a' })).rejects.toMatchObject({ code: 'bot_identity_unavailable' });
  expect(calls).not.toHaveBeenCalled();
});

test('a command freezes its nested durable pin and uses only the proved exact endpoint', async () => {
  const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
  setBotFetch(async (url, init) => { calls.push({ url, init }); return reply({ ok: true, result: { tools: [] } }); });
  const hub = { ...botHub(), key: 'unrelated-provider-key', pairToken: phoneId };
  const result = command(hub, 'a', { type: 'agents.status' });
  hub.botPin!.instanceId = 'e'.repeat(32);
  await expect(result).resolves.toEqual({ tools: [] });
  expect(calls).toHaveLength(1); expect(calls[0].url).toBe(`${canonical}/app/commands`);
  expect(calls[0].init.headers).toEqual({ Accept: 'application/json', 'Content-Type': 'application/json', 'X-Salcara-Bot-Token': token });
});

test('a QR identity confirmation in progress blocks an already-proved Bot dispatch', async () => {
  let hold = false, authenticated = 0;
  const waiting = deferred<Awaited<ReturnType<FetchLike>>>();
  setHubFetch(async (url, init) => {
    if ((init.headers as Record<string, string>)?.['X-Salcara-Bot-Token']) authenticated++;
    if (url.endsWith('/ingress/manifest')) return hold ? waiting.promise : reply(manifest());
    return url.includes('/ingress/identity?') ? reply(proof(url)) : reply(discovery);
  }, true);
  const target = await verifyBotBindingStation(canonical, pin);
  hold = true;
  const confirming = confirmPairingHubIdentity(canonical, () => true); await flush();
  await expect(botGroupDevices(botHub(), target)).rejects.toMatchObject({ code: 'bot_identity_unavailable' });
  expect(authenticated).toBe(0);
  hold = false; waiting.resolve(reply(manifest())); await confirming;
});

test.each(['missing', 'replaced'] as const)('SSE with a %s durable identity closes without sending its Bot token', async failure => {
  let authenticated = 0;
  const replacement = 'e'.repeat(32), closed = deferred<void>();
  setHubFetch(async (url, init) => {
    if ((init.headers as Record<string, string>)?.['X-Salcara-Bot-Token']) authenticated++;
    return url.endsWith('/ingress/manifest') ? reply(manifest(true, replacement))
      : url.includes('/ingress/identity?') ? reply(proof(url, replacement)) : reply(discovery);
  }, true);
  const states: string[] = [];
  const handle = openStream({ hub: failure === 'missing' ? { url: canonical, botToken: token } : botHub(),
    onEvent: jest.fn(), onDevice: jest.fn(), onState: state => { states.push(state); if (state === 'closed') closed.resolve(); } });
  await closed.promise; handle.close();
  expect(states).toEqual(['connecting', 'closed']); expect(authenticated).toBe(0);
});

test('an established Bot SSE cannot publish events after the global identity changes', async () => {
  const opened = deferred<void>(), closed = deferred<void>(), chunk = deferred<{ done: boolean; value?: string }>();
  const onEvent = jest.fn(), onDevice = jest.fn(); let reads = 0;
  setBotFetch(async () => ({ ok: true, status: 200, headers: { get: () => 'text/event-stream' },
    body: { getReader: () => ({ read: () => ++reads === 1 ? chunk.promise : Promise.resolve({ done: true }), cancel: () => undefined }) } }));
  const handle = openStream({ hub: botHub(), onEvent, onDevice,
    onState: state => { if (state === 'open') opened.resolve(); if (state === 'closed') closed.resolve(); } });
  await opened.promise;
  setHubFetch(async () => reply(discovery), true); // Retire the global authority before the next received event.
  chunk.resolve({ done: false, value: `event: device\ndata: ${JSON.stringify({ ...member(), os: 'windows', lastSeen: 1 })}\n\n` });
  await closed.promise; handle.close();
  expect(onEvent).not.toHaveBeenCalled(); expect(onDevice).not.toHaveBeenCalled();
});

test('a quiet Bot SSE closes on pin replacement even when its reader ignores cancellation', async () => {
  jest.useFakeTimers();
  const opened = deferred<void>(), closed = deferred<void>(), cancel = jest.fn();
  setBotFetch(async () => ({ ok: true, status: 200, headers: { get: () => 'text/event-stream' },
    body: { getReader: () => ({ read: () => new Promise(() => undefined), cancel }) } }));
  const handle = openStream({ hub: botHub(), onEvent: jest.fn(), onDevice: jest.fn(),
    onState: state => { if (state === 'open') opened.resolve(); if (state === 'closed') closed.resolve(); } });
  try {
    await opened.promise;
    setHubFetch(async () => reply(discovery), true);
    await jest.advanceTimersByTimeAsync(5000);
    await closed.promise;
    expect(cancel).toHaveBeenCalled();
  } finally { handle.close(); jest.useRealTimers(); }
});

test.each(['bind', 'members', 'revoke'] as const)('an expired proof lease blocks %s dispatch even while its signed manifest is valid', async operation => {
  jest.useFakeTimers();
  let sent = 0;
  setBotFetch(async () => { sent++; return reply({ ok: true, groupId: 'group', invitationRevoked: true, botToken: token, devices: [] }); });
  try {
    const target = await verifyBotBindingStation(canonical, pin);
    jest.setSystemTime(Date.now() + 10_001);
    const request = operation === 'bind' ? bindBotPhone(binding, phoneId, attempt, target.endpoint, { pin })
      : operation === 'members' ? botGroupDevices(botHub(), target) : revokeBotPhone(botHub(), 'group', target);
    await expect(request).rejects.toMatchObject({ code: 'bot_identity_unavailable' });
    expect(sent).toBe(0);
  } finally { jest.useRealTimers(); }
});

test('ordinary command dispatch rechecks proof expiry after a slow anonymous capability read', async () => {
  jest.useFakeTimers(); let pings = 0, sent = 0;
  setHubFetch(async (url, init) => {
    if ((init.headers as Record<string, string>)?.['X-Salcara-Bot-Token']) sent++;
    if (url.endsWith('/ingress/manifest')) return reply(manifest());
    if (url.includes('/ingress/identity?')) return reply(proof(url));
    if (url.endsWith('/ping') && ++pings === 2) jest.setSystemTime(Date.now() + 10_001);
    return reply(discovery);
  }, true);
  try {
    await expect(command(botHub(), 'a', { type: 'agents.status' })).rejects.toMatchObject({ code: 'bot_identity_unavailable' });
    expect(sent).toBe(0);
  } finally { jest.useRealTimers(); }
});

test('a command response after the ten-second proof lease remains valid on the same identity', async () => {
  jest.useFakeTimers();
  setBotFetch(async () => {
    jest.setSystemTime(Date.now() + 11_000);
    return reply({ ok: true, result: { completed: true } });
  });
  try { await expect(command(botHub(), 'a', { type: 'agents.status' })).resolves.toEqual({ completed: true }); }
  finally { jest.useRealTimers(); }
});

test('an established SSE continues past its dispatch lease without confusing expiry with identity change', async () => {
  jest.useFakeTimers();
  const opened = deferred<void>(), delivered = deferred<void>(), chunk = deferred<{ done: boolean; value?: string }>();
  const states: string[] = []; let reads = 0;
  setBotFetch(async () => ({ ok: true, status: 200, headers: { get: () => 'text/event-stream' },
    body: { getReader: () => ({ read: () => ++reads === 1 ? chunk.promise : new Promise(() => undefined), cancel: () => undefined }) } }));
  const handle = openStream({ hub: botHub(), onEvent: jest.fn(), onDevice: () => delivered.resolve(),
    onState: state => { states.push(state); if (state === 'open') opened.resolve(); } });
  try {
    await opened.promise;
    await jest.advanceTimersByTimeAsync(11_000);
    expect(states).toEqual(['connecting', 'open']);
    chunk.resolve({ done: false, value: `event: device\ndata: ${JSON.stringify({ ...member(), os: 'windows', lastSeen: 1 })}\n\n` });
    await delivered.promise;
    expect(states).toEqual(['connecting', 'open']);
  } finally { handle.close(); await flush(); jest.useRealTimers(); }
});

function movedManifest(instanceId = hubId): IngressManifest {
  const body = { ...manifest(false, instanceId), canonical_url: backup, endpoints: [{ id: 'canonical', url: backup, priority: 0 }] };
  const bytes = Buffer.from(JSON.stringify(body));
  return { ...body, signed_payload: bytes.toString('base64'), signature: sign(null, Buffer.concat([Buffer.from('salcara-ingress-manifest-v1\n'), bytes]), keys.privateKey).toString('base64') };
}

test.each(['same', 'different'] as const)('a durable group pin bootstraps a signed moved directory with %s identity and no global manifest', async identity => {
  const instanceId = identity === 'same' ? hubId : 'e'.repeat(32), sent: string[] = [];
  setHubFetch(async (url, init) => {
    if ((init.headers as Record<string, string>)?.['X-Salcara-Bot-Token']) sent.push(url);
    if (url.endsWith('/ingress/manifest')) return reply(movedManifest(instanceId));
    if (url.includes('/ingress/identity?')) return reply(proof(url, instanceId));
    if (url.endsWith('/ping')) return reply(discovery);
    return reply({ devices: [member()] });
  }, true);
  if (identity === 'same') {
    expect(await devices(botHub())).toEqual([member()]);
    expect(sent).toEqual([`${backup}/app/devices`]);
  } else {
    await expect(devices(botHub())).rejects.toMatchObject({ code: 'hub_identity_changed' });
    expect(sent).toEqual([]);
  }
});

test('first-time unanchored discovery still rejects a directory that omits the original logical address', async () => {
  setHubFetch(async url => url.endsWith('/ingress/manifest') ? reply(movedManifest()) : url.includes('/ingress/identity?') ? reply(proof(url)) : reply(discovery), true);
  await expect(verifyBotBindingStation(canonical)).rejects.toMatchObject({ code: 'bot_identity_unavailable' });
});

test('a refresh-detected identity mismatch blocks dispatch while the old manifest and proof lease still exist', async () => {
  jest.useFakeTimers(); let replacement = false, sent = 0;
  setHubFetch(async (url, init) => {
    if ((init.headers as Record<string, string>)?.['X-Salcara-Bot-Token']) sent++;
    const instanceId = replacement ? 'e'.repeat(32) : hubId;
    if (url.endsWith('/ingress/manifest')) return reply(manifest(true, instanceId, 65_000));
    if (url.includes('/ingress/identity?')) return reply(proof(url, instanceId));
    return reply(discovery);
  }, true);
  try {
    const target = await verifyBotBindingStation(canonical, pin);
    jest.setSystemTime(Date.now() + 6000); // Manifest renewal due; the 10-second proof lease is still fresh.
    replacement = true;
    await discoverSavedStation(canonical);
    await expect(botGroupDevices(botHub(), target)).rejects.toMatchObject({ code: 'hub_identity_changed' });
    expect(sent).toBe(0);
  } finally { jest.useRealTimers(); }
});
