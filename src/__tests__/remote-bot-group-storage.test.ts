import { randomUUID } from 'expo-crypto';
import { beginBotGroupRevocation, botBindingFingerprint, botConnectionId, botGroupId, commitBotGroupMembers,
  completeBotGroupRevocation, confirmLegacyBotGroupPin, connectionHub, connectionId, connectionToken, forgetConnection, getBotGroup, invalidateBotGroup, listBotGroupProfiles,
  loadBotGroups, loadConnections, loadNotificationTargets, onConnectionBindingsChange, prepareBotGroup, resolveNotificationTarget, saveConnection,
  selectConnection, selectedConnection, type BotGroupRecord, type RemoteConnection } from '../remote/connections';

const mockSettings = new Map<string, string>(), mockSecrets = new Map<string, string>();
const mockWriteSetting = jest.fn(), mockWriteSecret = jest.fn(), mockDeleteSecret = jest.fn();
jest.mock('../storage/database', () => ({ getSetting: async (key: string) => mockSettings.get(key) ?? null,
  setSetting: (key: string, value: string | null) => mockWriteSetting(key, value) }));
jest.mock('expo-crypto', () => ({ randomUUID: () => require('node:crypto').randomUUID() }));
jest.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'fixture',
  getItemAsync: async (key: string) => mockSecrets.get(key) ?? null,
  setItemAsync: (key: string, value: string) => mockWriteSecret(key, value), deleteItemAsync: (key: string) => mockDeleteSecret(key) }));

const hubUrl = 'https://bot-storage.example/salcara-hub/v1';
const token = 'b'.repeat(64);
const binding = (groupId = 'group') => ({ type: 'salcara-hub-bot-binding' as const, version: 1 as const,
  hubUrl: 'https://bot-storage.example/salcara-hub', groupId, invite: 'c'.repeat(64), signature: 'd'.repeat(64) });
const candidate = (groupId = 'group', secret = token): BotGroupRecord => {
  const packet = binding(groupId);
  return { id: botGroupId(hubUrl, groupId), hubUrl, groupId, generation: randomUUID(), status: 'pending', pairedAt: 1,
    fingerprint: botBindingFingerprint(packet), pin: { instanceId: 'hub-1', publicKey: 'fixture-public-key' },
    token: secret, phoneId: 'a'.repeat(64), attemptId: randomUUID(), binding: packet };
};
const profile = (group: BotGroupRecord, deviceId = 'a'): RemoteConnection => ({
  id: botConnectionId(group.hubUrl, deviceId, group.groupId), hubUrl: group.hubUrl, botGroupId: group.groupId,
  deviceId, deviceName: `电脑 ${deviceId}`, pairedAt: 1,
});
async function active(group = candidate(), members = ['a']) {
  await prepareBotGroup(group);
  await commitBotGroupMembers(group, members.map(id => profile(group, id)));
  return (await getBotGroup(group.id))!;
}
beforeEach(() => {
  mockSettings.clear(); mockSecrets.clear();
  mockWriteSetting.mockReset().mockImplementation(async (key: string, value: string | null) => { if (value === null) mockSettings.delete(key); else mockSettings.set(key, value); });
  mockWriteSecret.mockReset().mockImplementation(async (key: string, value: string) => { mockSecrets.set(key, value); });
  mockDeleteSecret.mockReset().mockImplementation(async (key: string) => { mockSecrets.delete(key); });
});

test('pending survives reload with identical attempt, token, original package and pin; public storage has no secret', async () => {
  const expected = candidate();
  await prepareBotGroup(expected);
  const restored = await getBotGroup(expected.id);
  expect(restored).toEqual(expected);
  expect(await prepareBotGroup(candidate())).toEqual(expected);
  expect(await loadConnections()).toEqual([]);
  expect(await loadBotGroups()).toEqual([expect.objectContaining({ id: expected.id, status: 'pending' })]);
  const publicState = JSON.stringify([await loadBotGroups(), [...mockSettings]]);
  for (const secret of [token, expected.phoneId!, expected.binding!.invite, expected.binding!.signature]) expect(publicState).not.toContain(secret);
  expect(publicState).not.toContain('attemptId');
});

test('empty active group persists independently and later membership never steals another selection', async () => {
  const group = await active(candidate(), []);
  expect(await loadConnections()).toEqual([]);
  expect((await loadBotGroups())[0].status).toBe('active');
  await selectConnection('unrelated-current');
  await commitBotGroupMembers(group, [profile(group, 'a'), profile(group, 'b')]);
  expect(await selectedConnection()).toBe('unrelated-current');
  const list = await loadConnections();
  expect(list.map(item => item.deviceId)).toEqual(['a', 'b']);
  expect(await connectionToken(list[0])).toBe(token);
  await selectConnection(list[0].id);
  await commitBotGroupMembers(group, [profile(group, 'b')]);
  expect(await selectedConnection()).toBeNull();
  await commitBotGroupMembers(group, []);
  expect(await loadConnections()).toEqual([]);
  expect((await getBotGroup(group.id))?.token).toBe(token);
});

test('public-index or SecureStore failure cannot yield an unpersisted prepared attempt', async () => {
  const group = candidate();
  mockWriteSetting.mockRejectedValueOnce(new Error('index full'));
  await expect(prepareBotGroup(group)).rejects.toThrow('index full');
  expect(mockWriteSecret).not.toHaveBeenCalled();
  mockWriteSecret.mockRejectedValueOnce(new Error('keychain locked'));
  await expect(prepareBotGroup(group)).rejects.toThrow('keychain locked');
  expect(await getBotGroup(group.id)).toBeNull();
  expect(await prepareBotGroup(group)).toEqual(group);
});

test('write acknowledgement loss retains exact attempt and member-index failure is recoverable without another bind', async () => {
  const group = candidate();
  mockWriteSecret.mockImplementationOnce(async (key: string, value: string) => { mockSecrets.set(key, value); throw new Error('ack lost'); });
  await expect(prepareBotGroup(group)).rejects.toThrow('ack lost');
  expect(await prepareBotGroup(candidate())).toEqual(group);
  mockWriteSetting.mockRejectedValueOnce(new Error('projection unavailable'));
  await expect(commitBotGroupMembers(group, [profile(group)])).rejects.toThrow('projection unavailable');
  expect((await getBotGroup(group.id))?.status).toBe('active');
  expect((await getBotGroup(group.id))?.token).toBe(token);
  expect(await commitBotGroupMembers(group, [profile(group)])).toBe(true);
  expect(await connectionToken((await loadConnections())[0])).toBe(token);
});

test('revoking is durable, disables ordinary credentials and blocks delayed bind/member commits', async () => {
  const group = await active();
  const before = (await loadConnections())[0];
  const revoking = await beginBotGroupRevocation(group);
  expect(revoking?.status).toBe('revoking');
  expect(await connectionToken(before)).toBeNull();
  expect((await getBotGroup(group.id))?.token).toBe(token);
  expect(await commitBotGroupMembers(group, [profile(group, 'late')])).toBe(false);
  await expect(prepareBotGroup(candidate())).rejects.toThrow('撤销');
  expect(await listBotGroupProfiles(group.id)).toHaveLength(1);
  await completeBotGroupRevocation(revoking!);
  expect(await loadConnections()).toEqual([]);
  expect((await getBotGroup(group.id))?.token).toBeUndefined();
  expect(await commitBotGroupMembers(group, [profile(group)])).toBe(false);
  await expect(prepareBotGroup(candidate())).rejects.toThrow('新绑定包');
});

test('reset and same-token ABA cannot be overwritten or invalidated by an older generation', async () => {
  const old = await active();
  const oldProfile = (await loadConnections())[0];
  await invalidateBotGroup(old.id, token, old.generation);
  await completeBotGroupRevocation((await getBotGroup(old.id))!); // Local receipt retirement completed.
  const next = candidate();
  next.binding = { ...next.binding!, invite: 'e'.repeat(64), signature: 'f'.repeat(64) };
  next.fingerprint = botBindingFingerprint(next.binding);
  await prepareBotGroup(next);
  await commitBotGroupMembers(next, [profile(next)]);
  expect(await commitBotGroupMembers(old, [profile(old)])).toBe(false);
  expect(await invalidateBotGroup(old.id, token, old.generation)).toBe(false);
  expect(await beginBotGroupRevocation(old)).toBeNull();
  await forgetConnection(oldProfile, token);
  await forgetConnection(oldProfile);
  expect((await getBotGroup(next.id))?.generation).toBe(next.generation);
  expect((await loadConnections()).map(item => item.deviceId)).toEqual(['a']);
  expect(await connectionToken(oldProfile)).toBeNull();
  expect(await connectionToken((await loadConnections())[0])).toBe(token);
});

test('one group update/revoke leaves relay and same-device other-group credentials untouched', async () => {
  const first = await active(), second = await active(candidate('other', 'e'.repeat(64)));
  const relay: RemoteConnection = { id: connectionId(hubUrl, 'a'), hubUrl, deviceId: 'a', deviceName: 'Relay', pairedAt: 1 };
  await saveConnection(relay, 'f'.repeat(64));
  await invalidateBotGroup(first.id, token, first.generation);
  expect(await connectionToken(profile(first))).toBeNull();
  expect(await connectionToken(profile(second))).toBe('e'.repeat(64));
  expect(await connectionToken(relay)).toBe('f'.repeat(64));
  expect(await listBotGroupProfiles(first.id)).toHaveLength(1); // Receipt retirement evidence survives.
  await saveConnection({ ...relay, deviceName: 'Renamed' }, 'f'.repeat(64));
  expect(await listBotGroupProfiles(first.id)).toHaveLength(1);
});

test('corrupt group authority is fail-closed and cannot fall back to stale per-device secrets', async () => {
  const group = await active();
  const member = (await loadConnections())[0];
  mockSecrets.set(`remote-device-${member.id}`, JSON.stringify({ hubUrl, deviceId: member.deviceId, botGroupId: group.groupId, token }));
  mockSecrets.set(`remote-bot-group-${group.id}`, '{broken');
  await expect(connectionToken(member)).rejects.toThrow('安全记录');
  await expect(prepareBotGroup(candidate())).rejects.toThrow('安全记录');
});

test('a failed tombstone write keeps revocation retryable; confirmed tombstone still fences an index failure', async () => {
  const group = await active();
  const revoking = (await beginBotGroupRevocation(group))!;
  mockWriteSecret.mockRejectedValueOnce(new Error('keychain locked'));
  await expect(completeBotGroupRevocation(revoking)).rejects.toThrow('keychain locked');
  expect((await getBotGroup(group.id))?.status).toBe('revoking');
  mockWriteSetting.mockRejectedValueOnce(new Error('index unavailable'));
  await expect(completeBotGroupRevocation(revoking)).rejects.toThrow('index unavailable');
  expect((await getBotGroup(group.id))?.status).toBe('revoked');
  expect(await loadConnections()).toEqual([]);
  expect(await connectionToken(profile(group))).toBeNull();
  const tombstone = (await getBotGroup(group.id))!;
  expect(tombstone.retiredCredentialId).toMatch(/^[a-f0-9]{64}$/);
  expect(await completeBotGroupRevocation(tombstone)).toBe(true);
  expect(await listBotGroupProfiles(group.id)).toEqual([]);
});

test('binding observers read a complete member projection, including failed mutations', async () => {
  const group = await active(candidate(), []);
  const snapshots: RemoteConnection[][] = [];
  const reads: Promise<void>[] = [];
  const stop = onConnectionBindingsChange(() => { reads.push(loadConnections().then(list => { snapshots.push(list); })); });
  try {
    await commitBotGroupMembers(group, [profile(group, 'a'), profile(group, 'b')]);
    await Promise.all(reads);
    expect(snapshots[0].map(item => item.deviceId)).toEqual(['a', 'b']);
    mockWriteSetting.mockRejectedValueOnce(new Error('index full'));
    await expect(commitBotGroupMembers(group, [])).rejects.toThrow('index full');
    await Promise.all(reads);
    expect(snapshots.at(-1)?.map(item => item.deviceId)).toEqual(['a', 'b']);
  } finally { stop(); }
});

test('notification targets are group-scoped and disappear as soon as revocation is durable', async () => {
  const group = await active(candidate(), []);
  expect(await loadNotificationTargets()).toEqual([]);
  await commitBotGroupMembers(group, [profile(group)]);
  const relay: RemoteConnection = { id: connectionId(hubUrl, 'a'), hubUrl, deviceId: 'a', deviceName: 'Relay', pairedAt: 1 };
  await saveConnection(relay, token); // Same token bytes must still use a different namespace.
  const targets = await loadNotificationTargets();
  const bot = targets.find(item => item.hub.botToken)!;
  const pair = targets.find(item => !item.hub.botToken)!;
  expect(bot.notificationScope).not.toBe(pair.notificationScope);
  const resolved = await resolveNotificationTarget(bot.notificationScope, 'a');
  expect(resolved).toEqual({ ...bot, hub: { ...bot.hub, authorizeDispatch: expect.any(Function) } });
  // Each snapshot owns a fresh authority closure, while its public identity
  // and credentials remain exact. Neither closure survives a durable revoke.
  expect(resolved!.hub.authorizeDispatch).not.toBe(bot.hub.authorizeDispatch);
  await beginBotGroupRevocation(group);
  const dispatch = jest.fn();
  expect(await bot.hub.authorizeDispatch!(dispatch)).toBeNull();
  expect(await resolved!.hub.authorizeDispatch!(dispatch)).toBeNull();
  expect(dispatch).not.toHaveBeenCalled();
  expect(await resolveNotificationTarget(bot.notificationScope, 'a')).toBeNull();
  expect(await loadNotificationTargets()).toEqual([pair]);
});

test('a superseding read during a projection write rolls the old member snapshot back', async () => {
  const group = await active();
  let wanted = true;
  const previousWrite = mockWriteSetting.getMockImplementation()!;
  mockWriteSetting.mockImplementation(async (key: string, value: string | null) => {
    await previousWrite(key, value);
    if (key === 'remote_device_connections_v1' && value?.includes('late')) wanted = false;
  });
  expect(await commitBotGroupMembers(group, [profile(group, 'late')], () => wanted)).toBe(false);
  expect((await loadConnections()).map(item => item.deviceId)).toEqual(['a']);
});

test('legacy migration repairs an interrupted projection offline using exact original per-device credentials', async () => {
  const group = candidate();
  const legacy = profile(group);
  await saveConnection(legacy, token);
  const originalWrite = mockWriteSetting.getMockImplementation()!;
  mockWriteSetting.mockImplementation(async (key: string, value: string | null) => {
    if (key === 'remote_device_connections_v1') throw new Error('migration index unavailable');
    return originalWrite(key, value);
  });
  await expect(getBotGroup(group.id)).rejects.toThrow('migration index unavailable');
  expect(await connectionToken(legacy)).toBeNull();
  mockWriteSetting.mockImplementation(originalWrite);
  const recovered = (await getBotGroup(group.id))!;
  expect(recovered.status).toBe('active');
  expect(recovered.token).toBe(token);
  expect(await connectionToken((await loadConnections())[0])).toBe(token);
  expect((await loadConnections())[0].botGeneration).toBe(recovered.generation);
});

test('removed members remain only in the cleanup ledger across empty-group reload and revocation', async () => {
  const group = await active(candidate(), ['a', 'b']);
  await commitBotGroupMembers(group, [profile(group, 'b')]);
  await commitBotGroupMembers(group, []);
  expect(await loadConnections()).toEqual([]);
  expect(await loadNotificationTargets()).toEqual([]);
  expect((await listBotGroupProfiles(group.id, group.generation)).map(item => item.deviceId)).toEqual(['a', 'b']);
  await invalidateBotGroup(group.id, token, group.generation);
  expect((await loadBotGroups())[0].status).toBe('revoked');
  const next = candidate();
  next.binding = { ...next.binding!, invite: 'e'.repeat(64) }; next.fingerprint = botBindingFingerprint(next.binding);
  await expect(prepareBotGroup(next)).rejects.toThrow('清理失效记录');
  await completeBotGroupRevocation((await getBotGroup(group.id))!);
  expect(await listBotGroupProfiles(group.id, group.generation)).toEqual([]);
  await expect(prepareBotGroup(next)).resolves.toMatchObject({ generation: next.generation });
});

test('the shared profile-to-Hub boundary copies the durable group pin and never trusts a caller supplied identity', async () => {
  const group = await active();
  const hub = (await connectionHub((await loadConnections())[0]))!;
  expect(hub.botPin).toEqual(group.pin);
  hub.botPin!.publicKey = 'mutated caller object';
  expect((await connectionHub((await loadConnections())[0]))?.botPin).toEqual(group.pin);
  await beginBotGroupRevocation(group);
  expect(await connectionHub(profile(group))).toBeNull();
});

test('legacy credentials remain stored but are never exposed to foreground or notifications before explicit identity confirmation', async () => {
  const group = candidate();
  await saveConnection(profile(group), token);
  const legacy = (await getBotGroup(group.id))!;
  expect(legacy.pin).toBeUndefined();
  await expect(connectionHub(profile(group))).rejects.toMatchObject({ code: 'bot_identity_unavailable' });
  expect(await loadNotificationTargets()).toEqual([]);
  expect(await connectionToken(profile(group))).toBe(token);
  expect(await confirmLegacyBotGroupPin(legacy, group.pin!)).toBe(true);
  expect((await connectionHub(profile(group)))?.botPin).toEqual(group.pin);
  expect(await confirmLegacyBotGroupPin(legacy, { instanceId: 'replacement', publicKey: 'replacement' })).toBe(false);
});

test('leaving a legacy identity confirmation during the secure write cancels activation and a newer generation cannot be confirmed', async () => {
  const group = candidate();
  await saveConnection(profile(group), token);
  const legacy = (await getBotGroup(group.id))!;
  let wanted = true;
  const write = mockWriteSecret.getMockImplementation()!;
  mockWriteSecret.mockImplementationOnce(async (key: string, value: string) => { await write(key, value); wanted = false; });
  expect(await confirmLegacyBotGroupPin(legacy, group.pin!, () => wanted)).toBe(false);
  expect((await getBotGroup(group.id))?.pin).toBeUndefined();
  await beginBotGroupRevocation(legacy);
  expect(await confirmLegacyBotGroupPin(legacy, group.pin!)).toBe(false);
});
