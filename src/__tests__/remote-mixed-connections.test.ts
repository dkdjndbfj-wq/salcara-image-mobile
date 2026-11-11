import { bindBotPhone, botBindingEndpoint, devices, parseBotBindingPackage, setHubFetch as setRawHubFetch, type FetchLike } from '../remote/client';
import { botConnectionId, botGroupId, confirmLegacyBotGroupPin, getBotGroup, connectionId, connectionToken, loadConnections, loadNotificationTargets, resolveNotificationTarget, onConnectionBindingsChange, forgetConnection, saveBotConnections as saveLegacyBotConnections, saveConnection, selectedConnection, type RemoteConnection } from '../remote/connections';
import { botStationFixture } from './fixtures/bot-station';
import { bootRemote, getRemoteState, probeSavedConnections, refreshDevices, reloadSavedConnections, resetRemoteForTests, revokeRemoteConnectionById, useSavedConnection, watchCredentials } from '../remote/store';

const mockSettings = new Map<string, string>(), mockSecrets = new Map<string, string>();
const mockWriteSetting = jest.fn();
jest.mock('../storage/database', () => ({
  getSetting: async (key: string) => mockSettings.get(key) ?? null,
  setSetting: (key: string, value: string | null) => mockWriteSetting(key, value),
}));
jest.mock('../storage/secure-keys', () => ({ getProviderKey: async () => null }));
jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'fixture', getItemAsync: async (key: string) => mockSecrets.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { mockSecrets.set(key, value); },
  deleteItemAsync: async (key: string) => { mockSecrets.delete(key); },
}));
jest.mock('expo-crypto', () => ({ randomUUID: () => require('node:crypto').randomUUID(), getRandomBytes: (size: number) => new Uint8Array(require('node:crypto').randomBytes(size)) }));

const hubUrl = 'https://mixed.example/salcara-hub/v1';
const station = botStationFixture(hubUrl);
const setHubFetch = (transport: FetchLike | null) => setRawHubFetch(transport ? station.wrap(transport) : null, true);
async function saveBotConnections(profiles: RemoteConnection[], token: string) {
  await saveLegacyBotConnections(profiles, token);
  const group = (await getBotGroup(botGroupId(profiles[0].hubUrl, profiles[0].botGroupId!)))!;
  if (!group.pin) await confirmLegacyBotGroupPin(group, station.pin);
  return loadConnections();
}
const token = 'a'.repeat(64), botToken = 'b'.repeat(64);
const device = (deviceId = 'a') => ({ deviceId, name: `电脑 ${deviceId}`, os: 'windows', tools: [], projects: [], online: true, lastSeen: 1 });
const profile = (deviceId = 'a', groupId?: string, computerId?: string): RemoteConnection => ({
  id: groupId ? botConnectionId(hubUrl, deviceId, groupId) : connectionId(hubUrl, deviceId), hubUrl, deviceId,
  deviceName: `电脑 ${deviceId}`, pairedAt: 1, ...(groupId ? { botGroupId: groupId } : {}), ...(computerId ? { computerId } : {}),
});
const binding = { type: 'salcara-hub-bot-binding' as const, version: 1 as const, hubUrl: 'https://mixed.example/salcara-hub', groupId: 'group', invite: 'c'.repeat(64), signature: 'd'.repeat(64) };
const reply = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
const transport: FetchLike = async endpoint => endpoint.endsWith('/ping')
  ? reply({ service: 'salcara-hub', protocol: 'salcara-remote', protocolVersion: 1, authModes: ['device-pairing'], capabilities: ['device.identity.v1', 'pair.qr.v1', 'session.remote.v1', 'pair.revoke.v1'] })
  : endpoint.endsWith('/app/devices') ? reply({ devices: [device('a'), device('b'), device('c')] })
    : endpoint.endsWith('/bot/phone/revoke') ? reply({ ok: true, groupId: 'group', invitationRevoked: true }) : reply({ ok: true });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function flush() { for (let i = 0; i < 100; i++) await Promise.resolve(); }
async function saveMixed() {
  await saveConnection(profile('a', undefined, 'physical-a'), token);
  await saveBotConnections([profile('a', 'group', 'physical-a'), profile('b', 'group', 'physical-b')], botToken);
  await bootRemote([]);
}

beforeEach(() => {
  resetRemoteForTests(); mockSettings.clear(); mockSecrets.clear();
  mockWriteSetting.mockReset().mockImplementation(async (key: string, value: string | null) => { if (value === null) mockSettings.delete(key); else mockSettings.set(key, value); });
  setHubFetch(transport);
});
afterEach(() => { resetRemoteForTests(); setHubFetch(null); });

test('Bot import retains verified computer identities with identical display names through persistence and restart', async () => {
  setHubFetch(async () => reply({ groupId: 'group', botToken, devices: [
    { ...device('a'), name: '电脑', computerId: 'physical-a' }, { ...device('b'), name: '电脑', computerId: 'physical-b' },
  ] }));
  const result = await bindBotPhone(binding, 'f'.repeat(64));
  const profiles = result.devices.map(item => ({ ...profile(item.deviceId, result.groupId, item.computerId), deviceName: item.name }));
  await saveBotConnections(profiles, result.botToken);
  resetRemoteForTests(); await bootRemote([]);
  expect(getRemoteState().connections.map(item => item.computerId).sort()).toEqual(['physical-a', 'physical-b']);
  expect(await connectionToken(profiles[0])).toBe(botToken);
  expect(await connectionToken(profiles[1])).toBe(botToken);
});

test('notification target snapshots separate Pair/Bot identities and re-pair removes the old scope', async () => {
  const changed = jest.fn(), stop = onConnectionBindingsChange(changed);
  try {
    await saveMixed();
    const targets = await loadNotificationTargets();
    expect(targets).toHaveLength(3);
    expect(new Set(targets.map(target => target.notificationScope)).size).toBe(3);
    const oldPair = targets.find(target => !target.hub.botToken)!;
    expect(targets.filter(target => target.hub.botToken).every(target => target.hub.botToken === botToken)).toBe(true);
    await saveConnection(profile('a', undefined, 'physical-a'), 'f'.repeat(64));
    expect(await resolveNotificationTarget(oldPair.notificationScope, 'a')).toBeNull();
    expect((await loadNotificationTargets()).filter(target => target.hub.botToken)).toHaveLength(2);
    await forgetConnection(profile('b', 'group', 'physical-b'), botToken);
    expect(await loadNotificationTargets()).toHaveLength(2);
    expect(changed).toHaveBeenCalledTimes(5);
  } finally { stop(); }
});

test('different proven computers may share a device ID across separate Hubs without a station handover', async () => {
  const first = profile('a', undefined, 'physical-a'), otherHub = 'https://other.example/salcara-hub/v1';
  const second = { ...profile('a', undefined, 'physical-b'), hubUrl: otherHub, id: connectionId(otherHub, 'a') };
  await saveConnection(first, token); await saveConnection(second, 'e'.repeat(64)); await bootRemote([]);
  const commands: string[] = [];
  setHubFetch(async (url, init) => { if (init.method === 'POST') commands.push(url); return transport(url, init); });
  await useSavedConnection(first.id); await useSavedConnection(second.id);
  expect(getRemoteState().connectionId).toBe(second.id);
  expect(watchCredentials()).toMatchObject({ url: otherHub, pairToken: 'e'.repeat(64) });
  expect(getRemoteState().devices.map(item => item.deviceId)).toEqual(['a']);
  expect(commands).toEqual([]);
});

test.each(['revoked', 'network'] as const)('a Bot %s response cleans only confirmed group credentials, never another mode or group', async failure => {
  await saveMixed();
  const otherGroup = profile('a', 'other'); await saveBotConnections([otherGroup], 'e'.repeat(64)); await reloadSavedConnections();
  await useSavedConnection(profile('a', 'group').id);
  setHubFetch(async (url, init) => url.endsWith('/ping') ? transport(url, init) : reply({ code: failure === 'revoked' ? 'bot_credentials_invalid' : 'service_unavailable' }, failure === 'revoked' ? 403 : 503));
  await refreshDevices(true);
  const remaining = await loadConnections();
  expect(remaining.some(item => item.id === profile().id)).toBe(true);
  expect(await connectionToken(otherGroup)).toBe('e'.repeat(64));
  expect(remaining.filter(item => item.botGroupId === 'group')).toHaveLength(failure === 'revoked' ? 0 : 3);
  if (failure === 'revoked') expect(watchCredentials()).toBeNull();
  resetRemoteForTests(); await bootRemote([]);
  expect(getRemoteState().connections.filter(item => item.botGroupId === 'group')).toHaveLength(failure === 'revoked' ? 0 : 3);
});

test('a concurrent successful Bot rebind survives old group-token revocation cleanup', async () => {
  await saveMixed(); await useSavedConnection(profile('a', 'group').id);
  const pending = deferred<Awaited<ReturnType<FetchLike>>>();
  setHubFetch(async (url, init) => url.endsWith('/ping') ? transport(url, init) : pending.promise);
  const refreshing = refreshDevices(true); await flush();
  const replacement = { ...profile('b', 'group'), pairedAt: 2 };
  await saveBotConnections([replacement], 'e'.repeat(64));
  pending.resolve(reply({ code: 'bot_credentials_invalid' }, 403)); await refreshing;
  expect(await connectionToken(replacement)).toBe('e'.repeat(64));
  expect(await connectionToken(profile('a', 'group'))).toBeNull();
  expect(await connectionToken(profile())).toBe(token);
});

test('ordinary pairing, two Bot groups and identical device IDs have independent credentials', async () => {
  const relay = profile(), first = profile('a', 'one'), second = profile('a', 'two');
  await saveConnection(relay, token); await saveBotConnections([first], botToken); await saveBotConnections([second], 'e'.repeat(64));
  expect(await loadConnections()).toHaveLength(3);
  expect(await connectionToken(relay)).toBe(token);
  expect(await connectionToken(first)).toBe(botToken);
  expect(await connectionToken(second)).toBe('e'.repeat(64));
  expect(await connectionToken({ ...first, botGroupId: 'two' })).toBeNull();
  expect(mockSettings.get('remote_device_connections_v1')).not.toContain(botToken);
});

test('legacy Bot metadata and startup selection migrate to a mode and group scoped keychain record', async () => {
  const old = { ...profile('a', 'group'), id: connectionId(hubUrl, 'a') };
  mockSettings.set('remote_device_connections_v1', JSON.stringify([old]));
  mockSettings.set('remote_device_connection_v1', old.id);
  mockSecrets.set(`remote-device-${old.id}`, JSON.stringify({ hubUrl, deviceId: 'a', token: botToken }));
  expect(await loadConnections()).toEqual([profile('a', 'group')]);
  expect(await selectedConnection()).toBe(profile('a', 'group').id);
  expect(await connectionToken(profile('a', 'group'))).toBe(botToken);
  expect(mockSecrets.has(`remote-device-${old.id}`)).toBe(false);
  await saveConnection(profile(), token);
  expect(await connectionToken(profile())).toBe(token);
  expect(await connectionToken(profile('a', 'group'))).toBe(botToken);
});

test('migration never replaces a newer scoped Bot credential and retains another valid relay record', async () => {
  const scoped = profile('a', 'group'), relay = profile('b');
  await saveConnection(scoped, 'e'.repeat(64)); await saveConnection(relay, token);
  const old = { ...scoped, id: connectionId(hubUrl, 'a') };
  mockSettings.set('remote_device_connections_v1', JSON.stringify([old, scoped, relay]));
  mockSecrets.set(`remote-device-${old.id}`, JSON.stringify({ hubUrl, deviceId: 'a', token: botToken }));
  expect(await loadConnections()).toEqual([scoped, relay]);
  expect(await connectionToken(scoped)).toBe('e'.repeat(64));
  expect(await connectionToken(relay)).toBe(token);
});

test('a failed migration index write restores the legacy selection and credential for retry', async () => {
  const old = { ...profile('a', 'group'), id: connectionId(hubUrl, 'a') };
  const raw = JSON.stringify([old]);
  mockSettings.set('remote_device_connections_v1', raw); mockSettings.set('remote_device_connection_v1', old.id);
  mockSecrets.set(`remote-device-${old.id}`, JSON.stringify({ hubUrl, deviceId: 'a', token: botToken }));
  mockWriteSetting.mockRejectedValueOnce(new Error('disk busy'));
  await expect(loadConnections()).rejects.toThrow('disk busy');
  expect(mockSettings.get('remote_device_connections_v1')).toBe(raw);
  expect(mockSettings.get('remote_device_connection_v1')).toBe(old.id);
  expect(mockSecrets.has(`remote-device-${old.id}`)).toBe(true);
  expect(mockSecrets.has(`remote-device-${profile('a', 'group').id}`)).toBe(false);
  expect(await loadConnections()).toEqual([profile('a', 'group')]);
});

test('Bot import uses the versioned API without altering its signed package and selected reads only expose its target', async () => {
  const calls: Array<{ endpoint: string; init: Parameters<FetchLike>[1] }> = [];
  setHubFetch(async (endpoint, init) => {
    calls.push({ endpoint, init });
    return endpoint.endsWith('/bot/phone/bind') ? reply({ groupId: 'group', botToken, devices: [device('a'), device('b')] }) : transport(endpoint, init);
  });
  const parsed = parseBotBindingPackage(JSON.stringify(binding));
  expect(parsed).toEqual(binding); expect(botBindingEndpoint(parsed)).toBe(hubUrl);
  expect((await bindBotPhone(parsed, 'f'.repeat(64))).devices).toHaveLength(2);
  expect(calls[0].endpoint).toBe(`${hubUrl}/bot/phone/bind`);
  expect(JSON.parse(String(calls[0].init.body)).binding).toEqual(binding);
  expect(await devices({ url: hubUrl, botToken, botPin: station.pin, deviceId: 'b' })).toEqual([device('b')]);
  const selectedRead = calls.find(call => call.endpoint.endsWith('/app/devices'))!;
  expect(selectedRead.init.headers).toMatchObject({ 'X-Salcara-Bot-Token': botToken });
  expect(selectedRead.init.headers).not.toHaveProperty('X-Salcara-Pair-Token');
});

test.each(['wrong-group', 'duplicate', 'invalid-device', 'invalid-computer', 'empty'] as const)('Bot import rejects the entire %s response', async failure => {
  const body = { groupId: failure === 'wrong-group' ? 'other' : 'group', botToken,
    devices: failure === 'duplicate' ? [device(), device()] : failure === 'invalid-device' ? [{ ...device(), deviceId: '../bad' }] : failure === 'invalid-computer' ? [{ ...device(), computerId: '../bad' }] : failure === 'empty' ? [] : [device()] };
  setHubFetch(async () => reply(body));
  await expect(bindBotPhone(binding, 'f'.repeat(64))).rejects.toMatchObject({ code: 'bot_binding_invalid' });
});

test('Bot and ordinary profiles on one computer switch locally without a station handover and probes use the correct auth mode', async () => {
  await saveMixed();
  const calls: Array<{ endpoint: string; init: Parameters<FetchLike>[1] }> = [];
  setHubFetch(async (endpoint, init) => { calls.push({ endpoint, init }); return transport(endpoint, init); });
  await useSavedConnection(profile('a', undefined, 'physical-a').id);
  await useSavedConnection(profile('a', 'group').id);
  expect(getRemoteState().devices).toEqual([device('a')]);
  expect(watchCredentials()).toMatchObject({ pairToken: botToken, botToken });
  await useSavedConnection(profile('b', 'group').id);
  expect(getRemoteState().devices).toEqual([device('b')]);
  const selected = getRemoteState().connectionId;
  const health = await probeSavedConnections();
  expect(Object.values(health)).toEqual(['online', 'online', 'online', 'online']); // Group refresh discovers c without selecting it.
  expect(getRemoteState().connectionId).toBe(selected);
  expect(calls.some(call => call.endpoint.endsWith('/app/commands'))).toBe(false);
  const botCalls = calls.filter(call => call.endpoint.endsWith('/app/devices') && (call.init.headers as Record<string, string>)['X-Salcara-Bot-Token']);
  expect(botCalls.length).toBeGreaterThanOrEqual(4);
  expect(botCalls.every(call => !(call.init.headers as Record<string, string>)['X-Salcara-Pair-Token'])).toBe(true);
});

test('cancelled saved connection selection leaves the old runtime and startup selection intact', async () => {
  await saveMixed(); await useSavedConnection(profile().id);
  const selected = getRemoteState().connectionId;
  const wait = deferred<Awaited<ReturnType<FetchLike>>>(); let wanted = true, entered = false;
  setHubFetch(async (endpoint, init) => { if (endpoint.endsWith('/ping')) { entered = true; return wait.promise; } return transport(endpoint, init); });
  const pending = useSavedConnection(profile('b', 'group').id, false, { stillWanted: () => wanted });
  await flush(); expect(entered).toBe(true); wanted = false;
  wait.resolve(await transport(`${hubUrl}/ping`, {})); await pending;
  expect(getRemoteState().connectionId).toBe(selected);
  expect(getRemoteState().devices).toEqual([device('a')]);
  expect(await selectedConnection()).toBe(selected);
  expect(watchCredentials()).toMatchObject({ pairToken: token });
  expect(getRemoteState().signingIn).toBeNull();
});

test('a late selection cannot overwrite the profile or startup choice selected afterwards', async () => {
  await saveMixed();
  const wait = deferred<Awaited<ReturnType<FetchLike>>>(); let first = true;
  setHubFetch(async (endpoint, init) => { if (endpoint.endsWith('/ping') && first) { first = false; return wait.promise; } return transport(endpoint, init); });
  const old = useSavedConnection(profile().id); await flush();
  await useSavedConnection(profile('b', 'group').id);
  wait.resolve(await transport(`${hubUrl}/ping`, {})); await old;
  expect(getRemoteState().connectionId).toBe(profile('b', 'group').id);
  expect(getRemoteState().devices).toEqual([device('b')]);
  expect(await selectedConnection()).toBe(profile('b', 'group').id);
});

test.each(['offline', 'missing', 'unauthorized', 'discovery', 'missing-credential'] as const)('online-only selection preserves the active computer when the target is %s', async failure => {
  await saveMixed(); await useSavedConnection(profile().id);
  const before = getRemoteState(), credentials = watchCredentials(), target = profile('b', 'group');
  if (failure === 'missing-credential') mockSecrets.delete(`remote-device-${target.id}`);
  setHubFetch(async (endpoint, init) => {
    if (failure === 'discovery' && endpoint.endsWith('/ping')) return reply({ error: 'offline' }, 503);
    if (endpoint.endsWith('/app/devices')) {
      if (failure === 'unauthorized') return reply({ error: 'revoked' }, 403);
      return reply({ devices: failure === 'missing' ? [device('c')] : [{ ...device('b'), online: false }] });
    }
    return transport(endpoint, init);
  });
  await expect(useSavedConnection(target.id, false, { requireOnline: true })).rejects.toThrow();
  expect(getRemoteState()).toMatchObject({ connectionId: before.connectionId, selectedHubUrl: before.selectedHubUrl,
    devices: before.devices, connection: 'open', signingIn: null });
  expect(watchCredentials()).toEqual(credentials);
  expect(await selectedConnection()).toBe(before.connectionId);
});

test.each(['cancel', 'newer-selection'] as const)('an online confirmation arriving after %s cannot activate the old choice', async action => {
  await saveMixed(); await useSavedConnection(profile().id);
  const wait = deferred<Awaited<ReturnType<FetchLike>>>(); let wanted = true, entered = false;
  const started = deferred<void>();
  setHubFetch(async (endpoint, init) => {
    if (endpoint.endsWith('/app/devices') && !entered) { entered = true; started.resolve(); return wait.promise; }
    return transport(endpoint, init);
  });
  const pending = useSavedConnection(profile('b', 'group').id, false, { requireOnline: true, stillWanted: () => wanted });
  await Promise.race([started.promise, pending]); expect(entered).toBe(true);
  expect(getRemoteState().connectionId).toBe(profile().id);
  expect(await selectedConnection()).toBe(profile().id);
  if (action === 'cancel') wanted = false;
  else await useSavedConnection(profile('a', 'group').id, false, { requireOnline: true });
  wait.resolve(reply({ devices: [device('b')] })); await pending;
  const expected = action === 'cancel' ? profile() : profile('a', 'group');
  expect(getRemoteState()).toMatchObject({ connectionId: expected.id, devices: [device('a')], connection: 'open', signingIn: null });
  expect(await selectedConnection()).toBe(expected.id);
  expect(watchCredentials()).toMatchObject({ pairToken: action === 'cancel' ? token : botToken });
});

test('online-only Bot selection commits only after authenticated target confirmation', async () => {
  await saveMixed(); await useSavedConnection(profile().id);
  const calls: Array<Parameters<FetchLike>[1]> = [];
  setHubFetch(async (endpoint, init) => {
    if (endpoint.endsWith('/app/devices')) {
      expect(getRemoteState().connectionId).toBe(profile().id);
      calls.push(init);
    }
    return transport(endpoint, init);
  });
  await useSavedConnection(profile('b', 'group').id, false, { requireOnline: true });
  expect(calls).toHaveLength(1);
  expect(calls[0].headers).toMatchObject({ 'X-Salcara-Bot-Token': botToken });
  expect(calls[0].headers).not.toHaveProperty('X-Salcara-Pair-Token');
  expect(getRemoteState()).toMatchObject({ connectionId: profile('b', 'group').id, devices: [device('b')], connection: 'open', devicesLoaded: true });
  expect(await selectedConnection()).toBe(profile('b', 'group').id);
});

test.each(['before-dispatch', 'after-dispatch'] as const)('cancelled same-computer station selection at %s does not activate its late target', async pauseAt => {
  await saveMixed(); await useSavedConnection(profile().id);
  const backupUrl = 'https://backup.example/salcara-hub/v1';
  const backup = { ...profile('c', undefined, 'physical-a'), id: connectionId(backupUrl, 'c'), hubUrl: backupUrl };
  await saveConnection(backup, 'c'.repeat(64)); await reloadSavedConnections();
  const wait = deferred<void>(); let wanted = true, entered = false, dispatches = 0;
  if (pauseAt === 'before-dispatch') mockWriteSetting.mockImplementation(async (key: string, value: string | null) => {
    if (key === 'remote_station_handover_v1' && value !== null) { entered = true; await wait.promise; }
    if (value === null) mockSettings.delete(key); else mockSettings.set(key, value);
  });
  setHubFetch(async (endpoint, init) => {
    if (endpoint.endsWith('/app/commands')) {
      const body = JSON.parse(String(init.body));
      if (body.command?.type === 'remote.station.switch') {
        dispatches += 1;
        if (pauseAt === 'after-dispatch') { entered = true; await wait.promise; }
      }
      return reply({ ok: true, result: {} });
    }
    return transport(endpoint, init);
  });
  const pending = useSavedConnection(backup.id, false, { requireOnline: true, stillWanted: () => wanted });
  for (let attempt = 0; attempt < 10 && !entered; attempt++) await flush();
  expect(entered).toBe(true); wanted = false; wait.resolve(); await pending;
  expect(dispatches).toBe(pauseAt === 'after-dispatch' ? 1 : 0);
  expect(getRemoteState().connectionId).toBe(profile().id);
  expect(await selectedConnection()).toBe(profile().id);
  expect(watchCredentials()).toMatchObject({ pairToken: token });
  expect(mockSettings.has('remote_station_handover_v1')).toBe(pauseAt === 'after-dispatch');
});

test.each(['relay', 'bot'] as const)('revoking %s preserves the other mode even with the same physical identity', async kind => {
  await saveMixed();
  const revoked: string[] = [];
  setHubFetch(async (endpoint, init) => { if (endpoint.endsWith('/revoke')) revoked.push(endpoint); return transport(endpoint, init); });
  const target = kind === 'relay' ? profile().id : profile('a', 'group').id;
  const keep = kind === 'relay' ? profile('a', 'group').id : profile().id;
  await useSavedConnection(keep);
  await revokeRemoteConnectionById(target);
  expect(getRemoteState().connectionId).toBe(keep);
  expect(getRemoteState().connections.map(item => item.id).sort()).toEqual((kind === 'relay' ? [profile('a', 'group').id, profile('b', 'group').id, profile('c', 'group').id] : [profile().id]).sort());
  expect(revoked.every(endpoint => endpoint.endsWith(kind === 'relay' ? '/app/pair/revoke' : '/bot/phone/revoke'))).toBe(true);
  expect(await connectionToken(kind === 'relay' ? profile('a', 'group') : profile())).toBe(kind === 'relay' ? botToken : token);
});
