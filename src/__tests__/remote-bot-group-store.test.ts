import { HubError, setHubFetch, type DeviceStatus, type Hub } from '../remote/client';
import * as remoteClient from '../remote/client';
import {
  beginBotGroupRevocation, botBindingFingerprint, botConnectionId, botGroupId, commitBotGroupMembers,
  completeBotGroupRevocation, confirmLegacyBotGroupPin, connectionId, connectionToken, deliveryCredentialId, getBotGroup, invalidateBotGroup,
  listBotGroupProfiles, loadConnections, prepareBotGroup, saveBotConnections, saveConnection,
  type BotGroupRecord, type RemoteConnection,
} from '../remote/connections';
import type { BotGroupResult, BotGroupRevokeOptions } from '../remote/bot-group-bindings';
import * as savedConnections from '../remote/connections';
import {
  bootRemote, confirmRemoteBotIdentity, getRemoteState, importRemoteBotBinding, loadAgentProfiles, previewRemoteBotIdentity, probeSavedConnections, pushTarget, refreshDevices, refreshRemoteBotGroup, reloadSavedConnections,
  resetRemoteForTests, revokeRemoteBotGroup, revokeRemoteConnectionById, useSavedConnection, watchCredentials,
} from '../remote/store';

const mockSettings = new Map<string, string>(), mockSecrets = new Map<string, string>();
const mockWriteSetting = jest.fn(), mockReadSetting = jest.fn();
const mockRefresh = jest.fn(), mockRetry = jest.fn(), mockImport = jest.fn(), mockRevoke = jest.fn(), mockClearCache = jest.fn();
const mockPreviewIdentity = jest.fn(), mockConfirmIdentity = jest.fn();
jest.mock('../storage/database', () => ({
  getSetting: (key: string) => mockReadSetting(key), setSetting: (key: string, value: string | null) => mockWriteSetting(key, value),
}));
jest.mock('../storage/secure-keys', () => ({ getProviderKey: async () => null }));
jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'fixture', getItemAsync: async (key: string) => mockSecrets.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { mockSecrets.set(key, value); },
  deleteItemAsync: async (key: string) => { mockSecrets.delete(key); },
}));
jest.mock('expo-crypto', () => ({ randomUUID: () => require('node:crypto').randomUUID() }));
jest.mock('../remote/cache', () => ({ ...jest.requireActual('../remote/cache'), clearRemoteCache: (...args: unknown[]) => mockClearCache(...args) }));
jest.mock('../remote/bot-group-bindings', () => ({
  importBotBinding: (...args: unknown[]) => mockImport(...args), refreshBotGroup: (...args: unknown[]) => mockRefresh(...args),
  retryBotGroupBinding: (...args: unknown[]) => mockRetry(...args), revokeBotGroup: (...args: unknown[]) => mockRevoke(...args),
  previewLegacyBotIdentity: (...args: unknown[]) => mockPreviewIdentity(...args), confirmLegacyBotIdentity: (...args: unknown[]) => mockConfirmIdentity(...args),
}));

const hubUrl = 'https://bot-store.example/salcara-hub/v1';
const oldToken = 'a'.repeat(64), newToken = 'b'.repeat(64);
const groupPin = { instanceId: 'fixture-original-hub', publicKey: 'A'.repeat(43) + '=' };
const binding = { type: 'salcara-hub-bot-binding' as const, version: 1 as const, hubUrl: 'https://bot-store.example/salcara-hub', groupId: 'group', invite: 'c'.repeat(64), signature: 'd'.repeat(64) };
const device = (id: string): DeviceStatus => ({ deviceId: id, name: id, os: 'windows', tools: [], projects: [], online: true, lastSeen: 1 });
const profile = (id: string, groupId = 'group'): RemoteConnection => ({ id: botConnectionId(hubUrl, id, groupId), hubUrl,
  deviceId: id, deviceName: id, botGroupId: groupId, pairedAt: 1 });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function flush() { for (let i = 0; i < 100; i++) await Promise.resolve(); }
async function saveGroup(ids = ['a']): Promise<BotGroupRecord> {
  await saveBotConnections(ids.map(id => profile(id)), oldToken);
  return pinFixtureGroup(botGroupId(hubUrl, 'group'));
}
async function pinFixtureGroup(id: string): Promise<BotGroupRecord> {
  const group = (await getBotGroup(id))!;
  mockSecrets.set(`remote-bot-group-${id}`, JSON.stringify({ ...group, pin: groupPin }));
  return (await getBotGroup(id))!;
}
async function project(record: BotGroupRecord, ids: string[], guard = () => true): Promise<BotGroupResult> {
  const profiles = ids.map(id => ({ ...profile(id, record.groupId), botGeneration: record.generation }));
  if (!await commitBotGroupMembers(record, profiles, guard)) throw new HubError('changed', 409, 'bot_binding_changed');
  const { token: _token, binding: _binding, phoneId: _phone, attemptId: _attempt, ...group } = (await getBotGroup(record.id))!;
  return { group, profiles, devices: ids.map(device) };
}
async function activate(id = 'a') { await bootRemote([]); await useSavedConnection(profile(id).id, true); }
async function pendingGroup(token = oldToken) {
  const generation = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  return prepareBotGroup({ id: botGroupId(hubUrl, 'group'), hubUrl, groupId: 'group', generation, status: 'pending', pairedAt: 1,
    token, attemptId: generation, phoneId: 'f'.repeat(64), fingerprint: botBindingFingerprint(binding), binding,
    pin: groupPin });
}

beforeEach(() => {
  resetRemoteForTests(); mockSettings.clear(); mockSecrets.clear();
  mockReadSetting.mockReset().mockImplementation(async (key: string) => mockSettings.get(key) ?? null);
  mockWriteSetting.mockReset().mockImplementation(async (key: string, value: string | null) => { if (value === null) mockSettings.delete(key); else mockSettings.set(key, value); });
  mockClearCache.mockReset().mockResolvedValue(undefined);
  mockRefresh.mockReset(); mockRetry.mockReset(); mockImport.mockReset(); mockRevoke.mockReset();
  mockPreviewIdentity.mockReset(); mockConfirmIdentity.mockReset();
  setHubFetch(async () => { throw new Error('Unexpected real transport in local store fixture'); });
});
afterEach(() => { resetRemoteForTests(); setHubFetch(null); });

test('startup hydrates pending and empty active groups locally without replaying a bind', async () => {
  const group = await pendingGroup();
  await bootRemote([]);
  expect(getRemoteState().botGroups).toEqual([expect.objectContaining({ id: group.id, status: 'pending' })]);
  expect(getRemoteState().connections).toEqual([]);
  expect(mockImport).not.toHaveBeenCalled(); expect(mockRetry).not.toHaveBeenCalled(); expect(mockRefresh).not.toHaveBeenCalled();
  await project(group, []); resetRemoteForTests(); await bootRemote([]);
  expect(getRemoteState().botGroups?.[0].status).toBe('active');
  expect(getRemoteState().connectionId).toBeNull(); expect(watchCredentials()).toBeNull();
  expect(JSON.stringify(getRemoteState())).not.toContain(oldToken);
});

test('Bot refresh projects later members while the selected device stays exact', async () => {
  const group = await saveGroup(); await activate();
  mockRefresh.mockImplementation((id: string, guard: () => boolean) => { expect(id).toBe(group.id); return project(group, ['a', 'b'], guard); });
  await refreshDevices();
  expect(getRemoteState().connections.map(item => item.deviceId).sort()).toEqual(['a', 'b']);
  expect(getRemoteState().devices.map(item => item.deviceId)).toEqual(['a']);
  expect(getRemoteState().connectionId).toBe(profile('a').id);
  expect(watchCredentials()?.botToken).toBe(oldToken);
});

test('removing the selected member stops that route without selecting another member', async () => {
  const group = await saveGroup(['a', 'b']); await activate();
  mockRefresh.mockImplementation((_id: string, guard: () => boolean) => project(group, ['b'], guard));
  await refreshDevices();
  expect(getRemoteState().connections.map(item => item.deviceId)).toEqual(['b']);
  expect(getRemoteState().connectionId).toBeNull(); expect(watchCredentials()).toBeNull();
  expect(getRemoteState().devices).toEqual([]);
});

test('unknown revocation stops runtime and retains the group for a confirmed cleanup retry', async () => {
  const group = await saveGroup(); await activate();
  mockRevoke.mockImplementation(async (_id: string, options: BotGroupRevokeOptions) => {
    const revoking = (await beginBotGroupRevocation(group))!;
    await options.onRevoking?.(revoking);
    expect(watchCredentials()).toBeNull();
    throw new HubError('unknown revoke result', 503, 'hub_unreachable');
  });
  await expect(revokeRemoteConnectionById(profile('a').id)).rejects.toThrow('unknown revoke result');
  expect(getRemoteState().botGroups?.[0].status).toBe('revoking');
  expect(await connectionToken(profile('a'))).toBeNull();
  expect(await listBotGroupProfiles(group.id)).toHaveLength(1);
  expect(mockClearCache).not.toHaveBeenCalled();
  mockRevoke.mockImplementation(async (_id: string, options: BotGroupRevokeOptions) => {
    const revoking = (await getBotGroup(group.id))!;
    expect(options.expectedGeneration).toBe(group.generation);
    await options.onRevoking?.(revoking); await options.beforeComplete?.(revoking);
    await completeBotGroupRevocation(revoking);
  });
  await revokeRemoteBotGroup(group.id, group.generation);
  expect(getRemoteState().botGroups?.[0].status).toBe('revoked');
  expect(await loadConnections()).toEqual([]);
  expect(mockClearCache).toHaveBeenCalledWith(`${profile('a').id}|credential:${deliveryCredentialId(oldToken)}`, ['a']);
});

test('failed local cleanup leaves revoking members available and does not restore active credentials', async () => {
  const group = await saveGroup(); await activate();
  mockClearCache.mockRejectedValueOnce(new Error('fixture cleanup busy'));
  mockRevoke.mockImplementation(async (_id: string, options: BotGroupRevokeOptions) => {
    const revoking = (await beginBotGroupRevocation(group))!;
    await options.onRevoking?.(revoking); await options.beforeComplete?.(revoking);
    await completeBotGroupRevocation(revoking);
  });
  await expect(revokeRemoteBotGroup(group.id)).rejects.toThrow('fixture cleanup busy');
  expect((await getBotGroup(group.id))?.status).toBe('revoking');
  expect(await listBotGroupProfiles(group.id)).toHaveLength(1);
  expect(watchCredentials()).toBeNull();
});

test('empty-group revoke uses its group ID and leaves a different active relay alone', async () => {
  const group = await pendingGroup(); await project(group, []);
  const relay: RemoteConnection = { id: connectionId(hubUrl, 'relay'), hubUrl, deviceId: 'relay', deviceName: 'relay', pairedAt: 1 };
  await saveConnection(relay, newToken); await bootRemote([]); await useSavedConnection(relay.id, true);
  mockRevoke.mockImplementation(async (id: string, options: BotGroupRevokeOptions) => {
    expect(id).toBe(group.id);
    const revoking = (await beginBotGroupRevocation((await getBotGroup(id))!))!;
    await options.onRevoking?.(revoking); await options.beforeComplete?.(revoking); await completeBotGroupRevocation(revoking);
  });
  await revokeRemoteConnectionById(group.id);
  expect(getRemoteState().connectionId).toBe(relay.id);
  expect(watchCredentials()?.pairToken).toBe(newToken);
  expect(mockRevoke).toHaveBeenCalledTimes(1);
});

test('a confirmed group authentication failure clears only the captured group authority', async () => {
  const group = await saveGroup();
  await saveBotConnections([profile('a', 'other')], newToken); await activate();
  mockRefresh.mockImplementation(async () => { await invalidateBotGroup(group.id, oldToken, group.generation); throw new HubError('revoked', 403, 'bot_credentials_invalid'); });
  await refreshDevices(true);
  expect(watchCredentials()).toBeNull();
  expect(getRemoteState().connections).toEqual([expect.objectContaining({ botGroupId: 'other' })]);
  expect(getRemoteState().botGroups?.find(item => item.id === group.id)?.status).toBe('revoked');
});

test('old authentication failure cannot stop a newer active binding in the same group', async () => {
  const group = await saveGroup(); await activate();
  const late = deferred<void>();
  mockRefresh.mockImplementation(async () => { await late.promise; await invalidateBotGroup(group.id, oldToken, group.generation); throw new HubError('revoked', 403, 'bot_credentials_invalid'); });
  const refreshing = refreshDevices(true); await flush();
  await saveBotConnections([profile('a')], newToken); await pinFixtureGroup(group.id); await reloadSavedConnections(); await useSavedConnection(profile('a').id, true);
  late.resolve(); await refreshing;
  expect(watchCredentials()?.botToken).toBe(newToken);
  expect(getRemoteState().connectionId).toBe(profile('a').id);
  expect(await connectionToken(getRemoteState().connections[0])).toBe(newToken);
  expect(mockClearCache).not.toHaveBeenCalledWith(`${profile('a').id}|credential:${deliveryCredentialId(newToken)}`, ['a']);
});

test('server revocation-pending state pauses runtime without pretending cleanup completed', async () => {
  const group = await saveGroup(); await activate();
  mockRefresh.mockImplementation(async () => { await beginBotGroupRevocation(group); throw new HubError('revoke pending', 503, 'bot_phone_revoke_pending'); });
  await expect(refreshRemoteBotGroup(group.id)).rejects.toThrow('revoke pending');
  expect(watchCredentials()).toBeNull();
  expect(getRemoteState().botGroups?.[0].status).toBe('revoking');
  expect(mockClearCache).not.toHaveBeenCalled();
});

test('import cleanup retires an old binding when an explicit new package produces a new generation', async () => {
  const group = await saveGroup(); await activate();
  mockRevoke.mockImplementation(async (_id: string, options: BotGroupRevokeOptions) => {
    const retired = (await getBotGroup(group.id))!;
    await options.beforeComplete?.(retired); await completeBotGroupRevocation(retired);
  });
  mockImport.mockImplementation(async (_input: unknown, options: { onRetired: (group: BotGroupRecord) => Promise<void> }) => {
    await invalidateBotGroup(group.id, oldToken, group.generation);
    await options.onRetired(group);
    const current = await pendingGroup(newToken);
    return project(current, ['b']);
  });
  await importRemoteBotBinding(binding);
  expect(watchCredentials()).toBeNull();
  expect(getRemoteState().connectionId).toBeNull();
  expect(getRemoteState().connections.map(item => item.deviceId)).toEqual(['b']);
  expect(mockClearCache).toHaveBeenCalledWith(`${profile('a').id}|credential:${deliveryCredentialId(oldToken)}`, ['a']);
});

test('a restarted revoked group cleans its exact receipt scope without recovering the secret', async () => {
  const group = await saveGroup();
  await invalidateBotGroup(group.id, oldToken, group.generation);
  resetRemoteForTests(); await bootRemote([]);
  expect((await getBotGroup(group.id))?.token).toBeUndefined();
  mockRevoke.mockImplementation(async (_id: string, options: BotGroupRevokeOptions) => {
    const retired = (await getBotGroup(group.id))!;
    await options.beforeComplete?.(retired); await completeBotGroupRevocation(retired);
  });
  await revokeRemoteBotGroup(group.id, group.generation);
  expect(mockClearCache).toHaveBeenCalledWith(`${profile('a').id}|credential:${deliveryCredentialId(oldToken)}`, ['a']);
  expect(await listBotGroupProfiles(group.id)).toEqual([]);
  expect(watchCredentials()).toBeNull();
});

test('revoking one group cannot stop another group even when a legacy fixture reuses its token', async () => {
  const group = await saveGroup();
  await saveBotConnections([profile('a', 'other')], oldToken);
  await pinFixtureGroup(botGroupId(hubUrl, 'other'));
  await bootRemote([]); await useSavedConnection(profile('a', 'other').id, true);
  mockRevoke.mockImplementation(async (_id: string, options: BotGroupRevokeOptions) => {
    const revoking = (await beginBotGroupRevocation(group))!;
    await options.onRevoking?.(revoking); await options.beforeComplete?.(revoking); await completeBotGroupRevocation(revoking);
  });
  await revokeRemoteBotGroup(group.id, group.generation);
  expect(watchCredentials()?.botToken).toBe(oldToken);
  expect(getRemoteState().connectionId).toBe(profile('a', 'other').id);
});

test('an old result cannot stop or retire a newer generation that reuses the same token', async () => {
  const group = await saveGroup(); await activate();
  const late = deferred<void>();
  mockRefresh.mockImplementation(async () => { await late.promise; throw new HubError('old reply', 403, 'bot_credentials_invalid'); });
  const refreshing = refreshDevices(true); await flush();
  await invalidateBotGroup(group.id, oldToken, group.generation);
  await completeBotGroupRevocation((await getBotGroup(group.id))!);
  const next = await pendingGroup(oldToken); await project(next, ['a']);
  await reloadSavedConnections(); await useSavedConnection(profile('a').id, true);
  late.resolve(); await refreshing;
  expect(watchCredentials()?.botToken).toBe(oldToken);
  expect(getRemoteState().connectionId).toBe(profile('a').id);
  expect(getRemoteState().connections[0].botGeneration).toBe(next.generation);
  expect(mockClearCache).not.toHaveBeenCalled();
  expect(mockSettings.has('remote_retired_delivery_scopes_v1')).toBe(false);
});

test('an earlier connection reload cannot publish over a newer membership snapshot', async () => {
  const group = await saveGroup(); await bootRemote([]);
  const previous = await loadConnections(), late = deferred<RemoteConnection[]>();
  const reader = jest.spyOn(savedConnections, 'loadConnections').mockImplementationOnce(() => late.promise);
  try {
    const oldReload = reloadSavedConnections(); await flush();
    await project(group, ['a', 'b']);
    await reloadSavedConnections();
    late.resolve(previous); await oldReload;
    expect(getRemoteState().connections.map(item => item.deviceId).sort()).toEqual(['a', 'b']);
  } finally { reader.mockRestore(); }
});

test('revoking an empty group after restart still retires a removed member receipt scope', async () => {
  const group = await saveGroup();
  await project(group, []);
  resetRemoteForTests(); await bootRemote([]);
  expect(getRemoteState().connections).toEqual([]);
  mockRevoke.mockImplementation(async (_id: string, options: BotGroupRevokeOptions) => {
    const revoking = (await beginBotGroupRevocation((await getBotGroup(group.id))!))!;
    await options.onRevoking?.(revoking); await options.beforeComplete?.(revoking); await completeBotGroupRevocation(revoking);
  });
  await revokeRemoteBotGroup(group.id, group.generation);
  expect(mockClearCache).toHaveBeenCalledWith(`${profile('a').id}|credential:${deliveryCredentialId(oldToken)}`, ['a']);
  expect(await listBotGroupProfiles(group.id, group.generation)).toEqual([]);
  expect(getRemoteState().connections).toEqual([]);
});

test('legacy Bot credentials without a durable pin stay saved and never enter ordinary device requests', async () => {
  await saveBotConnections([profile('a')], oldToken); await bootRemote([]);
  const requests = jest.spyOn(remoteClient, 'devices').mockResolvedValue([device('a')]);
  try {
    await expect(useSavedConnection(profile('a').id, true)).rejects.toMatchObject({ code: 'bot_identity_unavailable' });
    expect(getRemoteState()).toMatchObject({ connection: 'error', connectionProblem: 'identity' });
    expect(getRemoteState().connectionError).toContain('重新确认安全绑定信息');
    expect(await probeSavedConnections()).toEqual({ [profile('a').id]: 'identity' });
    expect(requests).not.toHaveBeenCalled();
    expect(await connectionToken(profile('a'))).toBe(oldToken);
    expect(getRemoteState().connections).toHaveLength(1);
    expect(watchCredentials()).toBeNull(); expect(pushTarget()).toBeNull();
  } finally { requests.mockRestore(); }
});

test('watch and push snapshots carry independent copies of the durable Bot identity', async () => {
  await saveGroup(); await activate();
  const watched = watchCredentials()!, pushed = pushTarget()!;
  expect(watched.botPin).toEqual(groupPin); expect(pushed.hub.botPin).toEqual(groupPin);
  watched.botPin!.publicKey = 'consumer-mutated-key';
  pushed.hub.botPin!.instanceId = 'consumer-mutated-instance';
  expect(watchCredentials()?.botPin).toEqual(groupPin);
  expect((await getBotGroup(botGroupId(hubUrl, 'group')))?.pin).toEqual(groupPin);
});

test('a later global QR identity cannot replace the captured Bot pin at ordinary dispatch boundaries', async () => {
  const group = await saveGroup(); await activate();
  const acceptedByLaterQr = { instanceId: 'another-hub', publicKey: 'B'.repeat(43) + '=' };
  const captured: Hub[] = [], sent: Hub[] = [];
  // The client boundary represents a fresh global QR acceptance. It sends a
  // secret only when the request-owned pin agrees, never by replacing it.
  const checkIdentity = (owner: Hub) => {
    captured.push(owner);
    if (owner.botPin?.instanceId !== acceptedByLaterQr.instanceId || owner.botPin?.publicKey !== acceptedByLaterQr.publicKey) {
      throw new HubError('identity changed', 409, 'hub_identity_changed');
    }
    sent.push(owner);
  };
  const devices = jest.spyOn(remoteClient, 'devices').mockImplementation(async owner => { checkIdentity(owner); return [device('a')]; });
  const commands = jest.spyOn(remoteClient, 'command').mockImplementation(async owner => { checkIdentity(owner); throw new Error('Fixture must reject before sending'); });
  try {
    expect(await probeSavedConnections()).toEqual({ [profile('a').id]: 'identity' });
    await expect(loadAgentProfiles('a')).rejects.toThrow();
    expect(captured.length).toBeGreaterThanOrEqual(2);
    expect(captured.every(owner => owner.botToken === oldToken && owner.botPin?.instanceId === groupPin.instanceId && owner.botPin?.publicKey === groupPin.publicKey)).toBe(true);
    expect(sent).toEqual([]);
    expect((await getBotGroup(group.id))?.pin).toEqual(groupPin);
    expect(await connectionToken(profile('a'))).toBe(oldToken);
  } finally { devices.mockRestore(); commands.mockRestore(); }
});

test('explicit identity confirmation reloads the original group without rebinding or selecting it', async () => {
  await saveBotConnections([profile('a')], oldToken);
  const group = (await getBotGroup(botGroupId(hubUrl, 'group')))!;
  const relay: RemoteConnection = { id: connectionId(hubUrl, 'relay'), hubUrl, deviceId: 'relay', deviceName: 'relay', pairedAt: 1 };
  await saveConnection(relay, newToken); await bootRemote([]); await useSavedConnection(relay.id, true);
  const preview = { id: group.id, generation: group.generation, groupId: group.groupId, hubUrl, pin: groupPin, target: { endpoint: hubUrl, pin: groupPin } };
  mockPreviewIdentity.mockResolvedValue(preview);
  expect(await previewRemoteBotIdentity(group.id)).toEqual(preview);
  expect((await getBotGroup(group.id))?.pin).toBeUndefined();
  mockConfirmIdentity.mockImplementation(async (_id: string, accepted: typeof preview, wanted: () => boolean) => {
    expect(accepted).toEqual(preview);
    expect(await confirmLegacyBotGroupPin(group, accepted.pin, wanted)).toBe(true);
    return project((await getBotGroup(group.id))!, ['a']);
  });
  await confirmRemoteBotIdentity(group.id, preview, () => true);
  expect(getRemoteState().botGroups?.find(item => item.id === group.id)?.pin).toEqual(groupPin);
  expect(getRemoteState().connectionId).toBe(relay.id);
  expect(watchCredentials()?.pairToken).toBe(newToken);
  expect(mockImport).not.toHaveBeenCalled(); expect(mockRetry).not.toHaveBeenCalled();
});
