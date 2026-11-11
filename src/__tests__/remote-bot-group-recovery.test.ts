import * as client from '../remote/client';
import { HubError, type BotBindingPackage, type DeviceStatus } from '../remote/client';
import { beginBotGroupRevocation, botConnectionId, botGroupId, connectionToken, deliveryCredentialId, getBotGroup, listBotGroupProfiles, loadBotGroups, loadConnections, saveBotConnections, selectConnection, selectedConnection } from '../remote/connections';
import { confirmLegacyBotIdentity, importBotBinding, previewLegacyBotIdentity, refreshBotGroup, retryBotGroupBinding, revokeBotGroup } from '../remote/bot-group-bindings';

const mockSettings = new Map<string, string>(), mockSecrets = new Map<string, string>();
const mockSetSecret = jest.fn(), mockSetSetting = jest.fn();
jest.mock('../storage/database', () => ({
  getSetting: async (key: string) => mockSettings.get(key) ?? null,
  setSetting: (key: string, value: string | null) => mockSetSetting(key, value),
}));
jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'fixture', getItemAsync: async (key: string) => mockSecrets.get(key) ?? null,
  setItemAsync: (key: string, value: string) => mockSetSecret(key, value),
  deleteItemAsync: async (key: string) => { mockSecrets.delete(key); },
}));
jest.mock('expo-crypto', () => ({
  randomUUID: () => require('node:crypto').randomUUID(),
  getRandomBytesAsync: async (length: number) => new Uint8Array(require('node:crypto').randomBytes(length)),
}));
jest.mock('../remote/phone-identity', () => ({ phoneIdentity: async () => 'f'.repeat(64) }));
jest.mock('../remote/client', () => ({
  ...jest.requireActual('../remote/client'),
  bindBotPhone: jest.fn(), botGroupDevices: jest.fn(), revokeBotPhone: jest.fn(), verifyBotBindingStation: jest.fn(), isBotStationCurrent: jest.fn(),
}));

const binding: BotBindingPackage = { type: 'salcara-hub-bot-binding', version: 1, hubUrl: 'https://bot.example/salcara-hub', groupId: 'group', invite: 'c'.repeat(64), signature: 'd'.repeat(64) };
const hubUrl = `${binding.hubUrl}/v1`, id = botGroupId(hubUrl, binding.groupId);
const pin = { instanceId: 'a'.repeat(32), publicKey: 'signed-public-key' };
const invalid = () => new HubError('invalid', 403, 'bot_credentials_invalid');
const members = (deviceId = 'pc-a'): DeviceStatus[] => [{ deviceId, name: `电脑 ${deviceId}`, os: 'windows', lastSeen: 1, tools: [], projects: [], online: true }];
const server = new Map<string, DeviceStatus[]>();
const bind = jest.mocked(client.bindBotPhone), read = jest.mocked(client.botGroupDevices), revoke = jest.mocked(client.revokeBotPhone), verify = jest.mocked(client.verifyBotBindingStation);
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function flush() { for (let i = 0; i < 150; i++) await Promise.resolve(); }

beforeEach(() => {
  mockSettings.clear(); mockSecrets.clear(); server.clear(); jest.clearAllMocks();
  mockSetSecret.mockReset().mockImplementation(async (key: string, value: string) => { mockSecrets.set(key, value); });
  mockSetSetting.mockReset().mockImplementation(async (key: string, value: string | null) => { if (value === null) mockSettings.delete(key); else mockSettings.set(key, value); });
  verify.mockReset().mockImplementation(async (_url, expected) => {
    if (expected && (expected.instanceId !== pin.instanceId || expected.publicKey !== pin.publicKey)) throw new HubError('changed', 409, 'hub_identity_changed');
    return { pin, endpoint: hubUrl };
  });
  jest.mocked(client.isBotStationCurrent).mockReset().mockReturnValue(true);
  read.mockReset().mockImplementation(async (hub, _target, beforeSend) => { beforeSend?.(); const result = server.get(hub.botToken!); if (!result) throw invalid(); return result; });
  bind.mockReset().mockImplementation(async (packageValue, _phone, attempt) => {
    if (!attempt) throw new Error('v2 required');
    const saved = await getBotGroup(botGroupId(`${packageValue.hubUrl}/v1`, packageValue.groupId));
    expect(saved).toMatchObject({ token: attempt.phoneToken, attemptId: attempt.attemptId, pin, status: 'pending' });
    server.set(attempt.phoneToken, []);
    return { groupId: packageValue.groupId, botToken: attempt.phoneToken, devices: [] };
  });
  revoke.mockReset().mockImplementation(async hub => { server.delete(hub.botToken!); });
});

test('an empty group is durably active without a fake profile or leaked secret', async () => {
  const result = await importBotBinding(binding);
  expect(result.group.status).toBe('active'); expect(result.devices).toEqual([]); expect(result.profiles).toEqual([]);
  expect(await loadConnections()).toEqual([]);
  expect(await loadBotGroups()).toEqual([result.group]);
  const record = (await getBotGroup(id))!;
  expect(record.token).toMatch(/^[a-f0-9]{64}$/); expect(record.binding).toEqual(binding);
  expect(JSON.stringify(result)).not.toContain(record.token);
  expect(JSON.stringify([...mockSettings])).not.toContain(record.token);
  expect(bind).toHaveBeenCalledTimes(1);
});

test.each(['secret', 'index'] as const)('a failed %s prewrite sends no secret-bearing network request', async failure => {
  if (failure === 'secret') mockSetSecret.mockRejectedValueOnce(new Error('locked'));
  else mockSetSetting.mockRejectedValueOnce(new Error('disk full'));
  await expect(importBotBinding(binding)).rejects.toThrow();
  expect(bind).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
});

test('missing v2 capability stops before durable candidate or any token request', async () => {
  verify.mockRejectedValueOnce(new HubError('upgrade', 426, 'bot_binding_upgrade_required'));
  await expect(importBotBinding(binding)).rejects.toMatchObject({ code: 'bot_binding_upgrade_required' });
  expect(await getBotGroup(id)).toBeNull(); expect(bind).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
});

test('a lost bind response recovers by GET with the original durable token and no second POST', async () => {
  bind.mockImplementationOnce(async (_package, _phone, attempt) => {
    server.set(attempt!.phoneToken, []);
    throw new HubError('response lost', 0, 'hub_unreachable');
  });
  await expect(importBotBinding(binding)).rejects.toMatchObject({ code: 'hub_unreachable' });
  const pending = (await getBotGroup(id))!;
  expect(pending.status).toBe('pending');
  const result = await retryBotGroupBinding(id);
  expect(result.group.status).toBe('active'); expect(result.group.generation).toBe(pending.generation);
  expect((await getBotGroup(id))!.token).toBe(pending.token); expect(bind).toHaveBeenCalledTimes(1);
});

test('an unknown bind retains one attempt across reimport and explicit retry', async () => {
  bind.mockRejectedValueOnce(new HubError('pending', 503, 'bot_phone_bind_pending'));
  await expect(importBotBinding(binding)).rejects.toMatchObject({ code: 'bot_phone_bind_pending' });
  const pending = (await getBotGroup(id))!;
  await expect(refreshBotGroup(id)).rejects.toMatchObject({ code: 'bot_credentials_invalid' });
  expect(bind).toHaveBeenCalledTimes(1); // Merely refreshing never binds.
  await importBotBinding(binding);
  const attempt = bind.mock.calls[1][2]!;
  expect(attempt).toEqual({ attemptId: pending.attemptId, phoneToken: pending.token });
});

test('a terminal old invitation failure is tombstoned and cannot become a fresh attempt', async () => {
  bind.mockRejectedValueOnce(invalid());
  await expect(importBotBinding(binding)).rejects.toMatchObject({ code: 'bot_credentials_invalid' });
  expect((await getBotGroup(id))!.status).toBe('revoked');
  await expect(importBotBinding(binding)).rejects.toMatchObject({ code: 'bot_binding_revoked' });
  expect(bind).toHaveBeenCalledTimes(1);
});

test('a failed member projection leaves the accepted group recoverable without rebinding', async () => {
  let failed = false;
  mockSetSetting.mockImplementation(async (key: string, value: string | null) => {
    if (key === 'remote_device_connections_v1' && !failed) { failed = true; throw new Error('index busy'); }
    if (value === null) mockSettings.delete(key); else mockSettings.set(key, value);
  });
  await expect(importBotBinding(binding)).rejects.toThrow('index busy');
  expect((await getBotGroup(id))!.status).toBe('active');
  await retryBotGroupBinding(id);
  expect(bind).toHaveBeenCalledTimes(1); expect(await loadConnections()).toEqual([]);
});

test('membership empty→A→A+B→B→empty does not select or modify another group', async () => {
  await importBotBinding(binding);
  const second = { ...binding, groupId: 'second' }; await importBotBinding(second);
  const record = (await getBotGroup(id))!;
  await selectConnection('unrelated-selection');
  for (const list of [members(), [...members(), ...members('pc-b')], members('pc-b'), []]) {
    server.set(record.token!, list);
    const result = await refreshBotGroup(id);
    expect(result.profiles.map(item => item.deviceId)).toEqual(list.map(item => item.deviceId));
    expect(await selectedConnection()).toBe('unrelated-selection');
    expect((await getBotGroup(botGroupId(hubUrl, 'second')))!.status).toBe('active');
  }
});

test('a newer member read wins and a delayed old read cannot restore removed computers', async () => {
  await importBotBinding(binding);
  const pending = deferred<DeviceStatus[]>(); read.mockImplementationOnce(() => pending.promise);
  const old = refreshBotGroup(id); await flush();
  const record = (await getBotGroup(id))!; server.set(record.token!, members('pc-b'));
  await refreshBotGroup(id);
  pending.resolve(members('pc-a'));
  await expect(old).rejects.toMatchObject({ code: 'bot_binding_changed' });
  expect((await loadConnections()).map(item => item.deviceId)).toEqual(['pc-b']);
});

test('revocation marks durable pending before the hook and keeps its token after 503', async () => {
  await importBotBinding(binding);
  const record = (await getBotGroup(id))!; server.set(record.token!, members()); await refreshBotGroup(id);
  revoke.mockRejectedValueOnce(new HubError('retry', 503, 'bot_phone_revoke_pending'));
  let hookCalled = false;
  await expect(revokeBotGroup(id, { onRevoking: async current => {
    expect((await getBotGroup(id))!.status).toBe('revoking'); expect(current.token).toBe(record.token); hookCalled = true;
    expect(await connectionToken((await loadConnections())[0])).toBeNull();
  } })).rejects.toMatchObject({ code: 'bot_phone_revoke_pending' });
  expect(hookCalled).toBe(true); expect(await getBotGroup(id)).toMatchObject({ status: 'revoking', token: record.token });
  await expect(refreshBotGroup(id)).rejects.toMatchObject({ code: 'bot_revoke_unconfirmed' });
  await revokeBotGroup(id);
  expect((await getBotGroup(id))!.status).toBe('revoked'); expect(await loadConnections()).toEqual([]);
  expect(revoke.mock.calls.map(call => call[0].botToken)).toEqual([record.token, record.token]);
});

test('local receipt cleanup failure leaves a retryable revoking record after server success', async () => {
  await importBotBinding(binding);
  const record = (await getBotGroup(id))!; server.set(record.token!, members()); await refreshBotGroup(id);
  await expect(revokeBotGroup(id, { beforeComplete: async () => { throw new Error('receipt busy'); } })).rejects.toThrow('receipt busy');
  expect(await getBotGroup(id)).toMatchObject({ status: 'revoking', token: record.token });
  expect(await loadConnections()).toHaveLength(1);
  await revokeBotGroup(id);
  expect((await getBotGroup(id))!.status).toBe('revoked');
});

test('a revoke 403 is not cleared when the required same-pin confirmation fails', async () => {
  await importBotBinding(binding);
  revoke.mockRejectedValueOnce(invalid());
  verify.mockImplementationOnce(async () => ({ pin, endpoint: hubUrl })).mockRejectedValueOnce(new HubError('offline', 0, 'hub_unreachable'));
  await expect(revokeBotGroup(id)).rejects.toMatchObject({ code: 'hub_unreachable' });
  expect((await getBotGroup(id))!.status).toBe('revoking');
});

test('late authentication failure cannot invalidate a replacement generation', async () => {
  await importBotBinding(binding);
  const pending = deferred<DeviceStatus[]>(); read.mockImplementationOnce(() => pending.promise);
  const old = refreshBotGroup(id); await flush();
  await revokeBotGroup(id);
  const replacement = await importBotBinding({ ...binding, invite: 'e'.repeat(64), signature: 'a'.repeat(64) });
  pending.reject(invalid()); await expect(old).rejects.toMatchObject({ code: 'bot_credentials_invalid' });
  expect(await getBotGroup(id)).toMatchObject({ status: 'active', generation: replacement.group.generation });
});

test('a pending server revoke disables local ordinary access without clearing recovery material', async () => {
  await importBotBinding(binding);
  read.mockRejectedValueOnce(new HubError('pending', 503, 'bot_phone_revoke_pending'));
  await expect(refreshBotGroup(id)).rejects.toMatchObject({ code: 'bot_phone_revoke_pending' });
  expect((await getBotGroup(id))!.status).toBe('revoking');
});

test('revoking an unconfirmed first POST retires the same attempt before discarding its credential', async () => {
  const delayed = deferred<Awaited<ReturnType<typeof client.bindBotPhone>>>();
  bind.mockImplementationOnce(() => delayed.promise);
  const importing = importBotBinding(binding);
  const outcome = expect(importing).rejects.toMatchObject({ code: 'bot_binding_changed' });
  await flush();
  const pending = (await getBotGroup(id))!;
  expect(pending.status).toBe('pending'); expect(bind).toHaveBeenCalledTimes(1);
  revoke.mockRejectedValueOnce(invalid());
  bind.mockImplementationOnce(async (_package, _phone, attempt) => {
    expect(await getBotGroup(id)).toMatchObject({ status: 'revoking', token: pending.token, attemptId: pending.attemptId });
    expect(attempt).toEqual({ attemptId: pending.attemptId, phoneToken: pending.token });
    server.set(attempt!.phoneToken, []);
    return { groupId: 'group', botToken: attempt!.phoneToken, devices: [] };
  });
  await revokeBotGroup(id);
  expect(revoke).toHaveBeenCalledTimes(2); expect(bind).toHaveBeenCalledTimes(2);
  expect((await getBotGroup(id))!.status).toBe('revoked');
  delayed.resolve({ groupId: 'group', botToken: pending.token!, devices: members() });
  await outcome;
  expect(await loadConnections()).toEqual([]); expect(server.has(pending.token!)).toBe(false);
});

test('an unresolved retirement bind cannot turn unknown-token revoke into local success', async () => {
  bind.mockRejectedValueOnce(new HubError('lost', 0, 'hub_unreachable'));
  await expect(importBotBinding(binding)).rejects.toMatchObject({ code: 'hub_unreachable' });
  const pending = (await getBotGroup(id))!;
  revoke.mockRejectedValueOnce(invalid());
  bind.mockRejectedValueOnce(new HubError('pending', 503, 'bot_phone_bind_pending'));
  await expect(revokeBotGroup(id)).rejects.toMatchObject({ code: 'bot_phone_bind_pending' });
  expect(await getBotGroup(id)).toMatchObject({ status: 'revoking', token: pending.token, attemptId: pending.attemptId });
  expect(revoke).toHaveBeenCalledTimes(1);
});

test('invite-only revocation cannot hide a phone accepted between the first revoke and recovery replay', async () => {
  bind.mockRejectedValueOnce(new HubError('response lost', 0, 'hub_unreachable'));
  await expect(importBotBinding(binding)).rejects.toMatchObject({ code: 'hub_unreachable' });
  const pending = (await getBotGroup(id))!;
  revoke.mockImplementationOnce(async hub => {
    // The first revoke found no token, but the original bind commits before
    // its response arrives. Admin now revokes only invitations, not the phone.
    server.set(hub.botToken!, []);
    throw invalid();
  });
  bind.mockRejectedValueOnce(invalid()); // The invitation is no longer usable.
  await revokeBotGroup(id);
  expect(revoke).toHaveBeenCalledTimes(2);
  expect(server.has(pending.token!)).toBe(false);
  expect((await getBotGroup(id))!.status).toBe('revoked');
});

test('auth-invalid cleanup survives secret removal and completes locally before a new package is imported', async () => {
  await importBotBinding(binding);
  const original = (await getBotGroup(id))!; server.set(original.token!, members()); await refreshBotGroup(id);
  server.delete(original.token!);
  await expect(refreshBotGroup(id)).rejects.toMatchObject({ code: 'bot_credentials_invalid' });
  expect(await getBotGroup(id)).toMatchObject({ status: 'revoked', retiredCredentialId: deliveryCredentialId(original.token!) });
  expect((await getBotGroup(id))!.token).toBeUndefined();
  expect(await listBotGroupProfiles(id)).toHaveLength(1);
  verify.mockClear(); revoke.mockClear();
  const cleanup = jest.fn(async record => {
    expect(record.retiredCredentialId).toBe(deliveryCredentialId(original.token!));
    expect(await listBotGroupProfiles(id)).toHaveLength(1);
  });
  await revokeBotGroup(id, { expectedGeneration: original.generation, beforeComplete: cleanup });
  expect(cleanup).toHaveBeenCalledTimes(1); expect(verify).not.toHaveBeenCalled(); expect(revoke).not.toHaveBeenCalled();
  expect(await listBotGroupProfiles(id)).toEqual([]);
  const next = await importBotBinding({ ...binding, invite: 'e'.repeat(64), signature: 'a'.repeat(64) });
  expect(next.group.generation).not.toBe(original.generation); expect(next.group.status).toBe('active');
});

test('new-package import retires the old authenticated scope before replacing its generation', async () => {
  await importBotBinding(binding);
  const original = (await getBotGroup(id))!; server.set(original.token!, members()); await refreshBotGroup(id);
  server.delete(original.token!);
  let cleaned = false;
  const replacement = await importBotBinding({ ...binding, invite: 'e'.repeat(64), signature: 'a'.repeat(64) }, {
    onRetired: async record => {
      expect(record.token).toBe(original.token); expect((await getBotGroup(id))!.status).toBe('revoked');
      await revokeBotGroup(id, { expectedGeneration: record.generation, beforeComplete: () => { cleaned = true; } });
    },
  });
  expect(cleaned).toBe(true); expect(replacement.group.generation).not.toBe(original.generation);
  expect(revoke).not.toHaveBeenCalled();
});

test.each([new HubError('proxy denied', 403), new HubError('maintenance', 503, 'service_unavailable')])('generic authorization or server failures never invalidate a saved group', async failure => {
  await importBotBinding(binding);
  const original = (await getBotGroup(id))!; read.mockRejectedValueOnce(failure);
  await expect(refreshBotGroup(id)).rejects.toBe(failure);
  expect(await getBotGroup(id)).toMatchObject({ status: 'active', token: original.token, generation: original.generation });
});

test('unknown final revoke after invalid invite replay retains the original token for another retry', async () => {
  bind.mockRejectedValueOnce(new HubError('lost', 0, 'hub_unreachable'));
  await expect(importBotBinding(binding)).rejects.toMatchObject({ code: 'hub_unreachable' });
  const original = (await getBotGroup(id))!;
  revoke.mockRejectedValueOnce(invalid()).mockRejectedValueOnce(new HubError('pending', 503, 'bot_phone_revoke_pending'));
  bind.mockRejectedValueOnce(invalid());
  await expect(revokeBotGroup(id)).rejects.toMatchObject({ code: 'bot_phone_revoke_pending' });
  expect(await getBotGroup(id)).toMatchObject({ status: 'revoking', token: original.token, attemptId: original.attemptId });
});

async function legacyGroup() {
  const token = '9'.repeat(64);
  await saveBotConnections([{ id: botConnectionId(hubUrl, 'pc-a', 'group'), hubUrl, deviceId: 'pc-a', deviceName: '旧电脑', botGroupId: 'group', pairedAt: 1 }], token);
  server.set(token, members());
  return (await getBotGroup(id))!;
}

test('legacy refresh and revoke without a durable pin preserve the original group without token traffic', async () => {
  const legacy = await legacyGroup();
  await expect(refreshBotGroup(id)).rejects.toMatchObject({ code: 'bot_identity_unavailable' });
  await expect(revokeBotGroup(id)).rejects.toMatchObject({ code: 'bot_identity_unavailable' });
  expect(await getBotGroup(id)).toMatchObject({ status: 'active', token: legacy.token, generation: legacy.generation });
  expect(verify).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled(); expect(revoke).not.toHaveBeenCalled();
});

test('legacy preview reveals only the complete public identity and sends no saved credential', async () => {
  const legacy = await legacyGroup();
  const preview = await previewLegacyBotIdentity(id);
  expect(preview).toEqual({ id, generation: legacy.generation, hubUrl, groupId: 'group', pin, target: { pin, endpoint: hubUrl } });
  expect(JSON.stringify(preview)).not.toContain(legacy.token);
  expect(read).not.toHaveBeenCalled(); expect(bind).not.toHaveBeenCalled(); expect(revoke).not.toHaveBeenCalled();
  expect((await getBotGroup(id))!.pin).toBeUndefined();
});

test('explicit legacy confirmation durably saves the displayed identity before reading the original token', async () => {
  const legacy = await legacyGroup(); const preview = await previewLegacyBotIdentity(id);
  read.mockImplementationOnce(async (hub, _target, beforeSend) => {
    beforeSend?.();
    expect(await getBotGroup(id)).toMatchObject({ pin, token: legacy.token, generation: legacy.generation });
    expect(hub.botPin).toEqual(pin); expect(hub.botToken).toBe(legacy.token);
    return members();
  });
  const result = await confirmLegacyBotIdentity(id, preview);
  expect(result.group.pin).toEqual(pin); expect(result.group.generation).toBe(legacy.generation);
  expect(bind).not.toHaveBeenCalled(); expect(revoke).not.toHaveBeenCalled(); expect(read).toHaveBeenCalledTimes(1);
  expect((await getBotGroup(id))!.attemptId).toBeUndefined();
});

test.each(['closed', 'storage', 'generation', 'pin'] as const)('legacy confirmation cancelled by %s sends no old token', async failure => {
  const legacy = await legacyGroup(); const preview = await previewLegacyBotIdentity(id);
  if (failure === 'storage') mockSetSecret.mockRejectedValueOnce(new Error('locked'));
  if (failure === 'generation') await beginBotGroupRevocation(legacy);
  if (failure === 'pin') verify.mockRejectedValueOnce(new HubError('changed', 409, 'hub_identity_changed'));
  await expect(confirmLegacyBotIdentity(id, preview, () => failure !== 'closed')).rejects.toThrow();
  expect(read).not.toHaveBeenCalled(); expect(bind).not.toHaveBeenCalled(); expect(revoke).not.toHaveBeenCalled();
});

test('legacy confirmation closes during the final dispatch guard without sending its old token', async () => {
  await legacyGroup(); const preview = await previewLegacyBotIdentity(id);
  let wanted = true, sent = false;
  read.mockImplementationOnce(async (_hub, _target, beforeSend) => {
    wanted = false;
    beforeSend?.();
    sent = true;
    return members();
  });
  await expect(confirmLegacyBotIdentity(id, preview, () => wanted)).rejects.toMatchObject({ code: 'bot_binding_changed' });
  expect(sent).toBe(false); expect(bind).not.toHaveBeenCalled();
});

test('legacy confirmation rejects a global identity change while saving the pin', async () => {
  await legacyGroup(); const preview = await previewLegacyBotIdentity(id);
  mockSetSecret.mockImplementationOnce(async (key: string, value: string) => {
    mockSecrets.set(key, value); jest.mocked(client.isBotStationCurrent).mockReturnValue(false);
  });
  await expect(confirmLegacyBotIdentity(id, preview)).rejects.toMatchObject({ code: 'bot_binding_changed' });
  expect(read).not.toHaveBeenCalled(); expect(bind).not.toHaveBeenCalled();
});
