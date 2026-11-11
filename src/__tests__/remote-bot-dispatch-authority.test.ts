import { setHubFetch } from '../remote/client';
import {
  authorizeBotGroupDispatch, beginBotGroupRevocation, botBindingFingerprint, botConnectionId, botGroupId,
  commitBotGroupMembers, completeBotGroupRevocation, confirmLegacyBotGroupPin, connectionHub, getBotGroup,
  listBotGroupProfiles, loadConnections, loadNotificationTargets, prepareBotGroup, saveBotConnections,
  type BotGroupRecord, type RemoteConnection,
} from '../remote/connections';
import { bootRemote, getRemoteState, pushTarget, resetRemoteForTests, useSavedConnection, watchCredentials } from '../remote/store';

const mockSettings = new Map<string, string>(), mockSecrets = new Map<string, string>();
const mockReadSetting = jest.fn();
jest.mock('../storage/database', () => ({
  getSetting: (key: string) => mockReadSetting(key),
  setSetting: async (key: string, value: string | null) => { if (value === null) mockSettings.delete(key); else mockSettings.set(key, value); },
}));
jest.mock('../storage/secure-keys', () => ({ getProviderKey: async () => null }));
jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'fixture',
  getItemAsync: async (key: string) => mockSecrets.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { mockSecrets.set(key, value); },
  deleteItemAsync: async (key: string) => { mockSecrets.delete(key); },
}));
jest.mock('expo-crypto', () => ({ randomUUID: () => require('node:crypto').randomUUID() }));

const hubUrl = 'https://dispatch-authority.example/salcara-hub/v1';
const token = 'a'.repeat(64), otherToken = 'b'.repeat(64);
const pin = { instanceId: 'fixture-original-hub', publicKey: 'A'.repeat(43) + '=' };
const profile = (deviceId = 'computer', groupId = 'group'): RemoteConnection => ({
  id: botConnectionId(hubUrl, deviceId, groupId), hubUrl, deviceId, deviceName: deviceId, botGroupId: groupId, pairedAt: 1,
});
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function saveGroup(groupId = 'group', credential = token): Promise<BotGroupRecord> {
  await saveBotConnections([profile('computer', groupId)], credential);
  const group = (await getBotGroup(botGroupId(hubUrl, groupId)))!;
  if (!group.pin) expect(await confirmLegacyBotGroupPin(group, pin)).toBe(true);
  return (await getBotGroup(group.id))!;
}
async function pendingGroup(): Promise<BotGroupRecord> {
  const generation = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const binding = { type: 'salcara-hub-bot-binding' as const, version: 1 as const,
    hubUrl: 'https://dispatch-authority.example/salcara-hub', groupId: 'group', invite: 'c'.repeat(64), signature: 'd'.repeat(64) };
  return prepareBotGroup({ id: botGroupId(hubUrl, 'group'), hubUrl, groupId: 'group', generation, status: 'pending', pairedAt: 1,
    token, attemptId: generation, phoneId: 'f'.repeat(64), binding, fingerprint: botBindingFingerprint(binding), pin });
}

beforeEach(() => {
  resetRemoteForTests(); mockSettings.clear(); mockSecrets.clear();
  mockReadSetting.mockReset().mockImplementation(async (key: string) => mockSettings.get(key) ?? null);
  setHubFetch(async () => { throw new Error('Unexpected transport in dispatch-authority fixture'); });
});
afterEach(() => { resetRemoteForTests(); setHubFetch(null); });

test('a durable local revocation denies an already captured device dispatch', async () => {
  const group = await saveGroup(), owner = (await connectionHub(profile()))!;
  const launch = jest.fn(() => 'sent');
  await beginBotGroupRevocation(group);
  expect(await owner.authorizeDispatch!(launch)).toBeNull();
  expect(await authorizeBotGroupDispatch(group, launch)).toBeNull();
  expect(launch).not.toHaveBeenCalled();
});

test('same-token ABA replacement cannot authorize a previous group generation', async () => {
  const group = await saveGroup(), owner = (await connectionHub(profile()))!;
  await saveGroup('group', otherToken); const replacement = await saveGroup();
  expect(replacement.token).toBe(group.token); expect(replacement.generation).not.toBe(group.generation);
  const launch = jest.fn();
  expect(await owner.authorizeDispatch!(launch)).toBeNull();
  expect(await authorizeBotGroupDispatch(group, launch)).toBeNull();
  expect(launch).not.toHaveBeenCalled();
});

test.each(['token', 'instanceId', 'publicKey'] as const)('dispatch rejects changed %s even when group generation is unchanged', async field => {
  const group = await saveGroup(), owner = (await connectionHub(profile()))!;
  const changed = field === 'token' ? { ...group, token: otherToken }
    : { ...group, pin: { ...group.pin!, [field]: field === 'instanceId' ? 'fixture-replacement-hub' : 'B'.repeat(43) + '=' } };
  mockSecrets.set(`remote-bot-group-${group.id}`, JSON.stringify(changed));
  const launch = jest.fn();
  expect(await owner.authorizeDispatch!(launch)).toBeNull();
  expect(await authorizeBotGroupDispatch(group, launch)).toBeNull();
  expect(launch).not.toHaveBeenCalled();
});

test('removed members in the retirement ledger cannot dispatch', async () => {
  const group = await saveGroup(), owner = (await connectionHub(profile()))!;
  expect(await commitBotGroupMembers(group, [])).toBe(true);
  expect(await listBotGroupProfiles(group.id)).toHaveLength(1);
  expect(await loadConnections()).toEqual([]);
  const launch = jest.fn();
  expect(await owner.authorizeDispatch!(launch)).toBeNull(); expect(launch).not.toHaveBeenCalled();
  // The empty active group can still query its group-level recovery route.
  expect(await authorizeBotGroupDispatch(group, () => 'recover')).toEqual({ value: 'recover' });
});

test('group authorization requires its exact captured pending, active or revoking status', async () => {
  const pending = await pendingGroup();
  expect(await authorizeBotGroupDispatch(pending, () => 'pending read')).toEqual({ value: 'pending read' });
  await commitBotGroupMembers(pending, []); const active = (await getBotGroup(pending.id))!;
  expect(await authorizeBotGroupDispatch(pending, () => 'stale pending')).toBeNull();
  expect(await authorizeBotGroupDispatch(active, () => 'active read')).toEqual({ value: 'active read' });
  const revoking = (await beginBotGroupRevocation(active))!;
  expect(await authorizeBotGroupDispatch(active, () => 'stale active')).toBeNull();
  expect(await authorizeBotGroupDispatch(revoking, () => 'revoke')).toEqual({ value: 'revoke' });
  await completeBotGroupRevocation(revoking); const revoked = (await getBotGroup(active.id))!;
  expect(await authorizeBotGroupDispatch(revoking, () => 'stale revoke')).toBeNull();
  expect(await authorizeBotGroupDispatch(revoked, () => 'revoked')).toBeNull();
});

test('authorizing a network promise releases the mutation queue before the network settles', async () => {
  const group = await saveGroup(), owner = (await connectionHub(profile()))!, network = deferred<string>();
  let settled = false; void network.promise.then(() => { settled = true; });
  const dispatched = await owner.authorizeDispatch!(() => network.promise);
  expect(dispatched?.value).toBe(network.promise); expect(settled).toBe(false);
  expect((await beginBotGroupRevocation(group))?.status).toBe('revoking'); expect(settled).toBe(false);
  network.resolve('finished'); expect(await dispatched!.value).toBe('finished');
});

test('a revocation queued before dispatch validation wins without launching a request', async () => {
  const group = await saveGroup(), owner = (await connectionHub(profile()))!;
  const entered = deferred<void>(), release = deferred<void>(); let blocked = false;
  mockReadSetting.mockImplementation(async (key: string) => {
    if (key === 'remote_device_connections_v1' && !blocked) { blocked = true; entered.resolve(); await release.promise; }
    return mockSettings.get(key) ?? null;
  });
  const reading = loadConnections(); await entered.promise;
  const revoking = beginBotGroupRevocation(group), launch = jest.fn(), dispatching = owner.authorizeDispatch!(launch);
  release.resolve(); await reading; await revoking;
  expect(await dispatching).toBeNull(); expect(launch).not.toHaveBeenCalled();
});

test('the group gate snapshots caller-owned records before entering the queue', async () => {
  const group = await saveGroup();
  const revoking = beginBotGroupRevocation(group), launch = jest.fn();
  const dispatching = authorizeBotGroupDispatch(group, launch);
  group.status = 'revoking';
  await revoking; expect(await dispatching).toBeNull(); expect(launch).not.toHaveBeenCalled();
});

test('notification targets stay independent of foreground selection and other group revocation', async () => {
  const a = await saveGroup('a'); await saveGroup('b');
  const targets = await loadNotificationTargets(), targetA = targets.find(item => item.connectionId === profile('computer', 'a').id)!,
    targetB = targets.find(item => item.connectionId === profile('computer', 'b').id)!;
  await bootRemote([]); await useSavedConnection(targetA.connectionId, true);
  const foregroundA = watchCredentials()!, activeA = foregroundA.captureDispatchGuard!();
  expect(activeA()).toBe(true); expect(targetA.hub.captureDispatchGuard).toBeUndefined();
  await useSavedConnection(targetB.connectionId, true);
  expect(activeA()).toBe(false);
  expect(await targetA.hub.authorizeDispatch!(() => 'a background')).toEqual({ value: 'a background' });
  await beginBotGroupRevocation(a);
  expect(await targetA.hub.authorizeDispatch!(() => 'revoked a')).toBeNull();
  expect(await targetB.hub.authorizeDispatch!(() => 'b background')).toEqual({ value: 'b background' });
  expect(watchCredentials()?.captureDispatchGuard!()()).toBe(true);
});

test('a cancelled selection invalidates started work but new work on the retained runtime is valid', async () => {
  await saveGroup('a'); await saveGroup('b'); await bootRemote([]);
  await useSavedConnection(profile('computer', 'a').id, true);
  const retained = watchCredentials()!, started = retained.captureDispatchGuard!();
  const stillWanted = jest.fn().mockReturnValueOnce(true).mockReturnValue(false);
  await useSavedConnection(profile('computer', 'b').id, true, { stillWanted });
  expect(getRemoteState().connectionId).toBe(profile('computer', 'a').id); expect(started()).toBe(false);
  expect(retained.captureDispatchGuard!()()).toBe(true);
  expect(watchCredentials()?.captureDispatchGuard).toBe(retained.captureDispatchGuard);
  expect(await retained.authorizeDispatch!(() => 'retained')).toEqual({ value: 'retained' });
});

test('watch and push snapshots retain dispatch authority without sharing mutable pins or background owner guards', async () => {
  await saveGroup(); const background = (await loadNotificationTargets())[0].hub;
  await bootRemote([]); await useSavedConnection(profile().id, true);
  const watched = watchCredentials()!, pushed = pushTarget()!.hub;
  expect(watched.authorizeDispatch).toBeDefined(); expect(pushed.authorizeDispatch).toBe(watched.authorizeDispatch);
  expect(pushed.captureDispatchGuard).toBe(watched.captureDispatchGuard);
  expect(background.captureDispatchGuard).toBeUndefined();
  watched.botPin!.instanceId = 'changed-copy'; pushed.botPin!.publicKey = 'changed-copy';
  expect(watchCredentials()?.botPin).toEqual(pin); expect(background.botPin).toEqual(pin);
});
