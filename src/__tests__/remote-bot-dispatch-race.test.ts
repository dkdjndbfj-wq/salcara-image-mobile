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
jest.mock('expo-crypto', () => ({ randomUUID: () => require('node:crypto').randomUUID(), getRandomBytes: (size: number) => new Uint8Array(require('node:crypto').randomBytes(size)) }));
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

import { botStationFixture } from './fixtures/bot-station';
test('REVIEW: a locally revoking group must not dispatch an earlier request after anonymous discovery resumes', async () => {
  const fixture=botStationFixture(hubUrl);
  const saved=await saveGroup();
  mockSecrets.set(`remote-bot-group-${saved.id}`,JSON.stringify({...saved,pin:fixture.pin}));
  const group=(await getBotGroup(saved.id))!;
  await activate();
  const reached=deferred<void>(), release=deferred<void>();
  let blockPing=true, authenticated=0;
  const reply=(body:unknown)=>({ok:true,status:200,text:async()=>JSON.stringify(body)});
  setHubFetch(fixture.wrap(async(url,init)=>{
    if(url.endsWith('/ping')){
      if(blockPing){blockPing=false;reached.resolve();await release.promise;}
      return reply(fixture.discovery);
    }
    if(url.endsWith('/app/commands')){
      authenticated++;
      return reply({ok:true,result:{agents:[],apis:[]}});
    }
    throw new Error('Unexpected synthetic route '+url);
  }),true);
  const reading=loadAgentProfiles('a');
  await reached.promise;
  mockRevoke.mockImplementation(async (_id:string,options:BotGroupRevokeOptions)=>{
    const revoking=(await beginBotGroupRevocation(group))!;
    await options.onRevoking?.(revoking);
    // A failed outgoing revoke did not reach the Hub; its phone token still
    // authorizes requests, but the phone promises to pause ordinary operations.
    throw new HubError('revoke network failure',0,'hub_unreachable');
  });
  await expect(revokeRemoteBotGroup(group.id,group.generation)).rejects.toMatchObject({code:'hub_unreachable'});
  expect(await getBotGroup(group.id)).toMatchObject({status:'revoking'});
  expect(watchCredentials()).toBeNull();
  release.resolve();
  await reading;
  console.log(JSON.stringify({case:'request-after-local-revoking',authenticatedAfterPause:authenticated}));
  expect(authenticated).toBe(0);
});

test.each(['revoking', 'switch', 'unchanged'] as const)('the real API-setting store path dispatches only while its Bot owner is %s', async transition => {
  const { setAgentApi } = require('../remote/store') as typeof import('../remote/store');
  const fixture = botStationFixture(hubUrl), saved = await saveGroup(['a', 'b']);
  mockSecrets.set(`remote-bot-group-${saved.id}`, JSON.stringify({ ...saved, pin: fixture.pin }));
  const group = (await getBotGroup(saved.id))!;
  await activate();
  const reached = deferred<void>(), release = deferred<void>();
  let blockPing = true;
  const writes: unknown[] = [];
  const reply = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
  setHubFetch(fixture.wrap(async (url, init) => {
    if (url.endsWith('/ping')) {
      if (blockPing) { blockPing = false; reached.resolve(); await release.promise; }
      return reply(fixture.discovery);
    }
    if (url.endsWith('/app/commands')) {
      expect(init.headers).toMatchObject({ 'X-Salcara-Bot-Token': group.token });
      writes.push(JSON.parse(String(init.body)).command);
      return reply({ ok: true, result: { agents: [], apis: [] } });
    }
    throw new Error(`Unexpected synthetic route ${url}`);
  }), true);
  // This is the actual settings mutation entry, but its HTTP endpoint only
  // records the command. No provider key or real Agent is contacted.
  const writing = setAgentApi('a', 'claude', '');
  const outcome = writing.then(() => ({ ok: true }), error => ({ ok: false, error }));
  await reached.promise;
  if (transition === 'revoking') {
    mockRevoke.mockImplementation(async (_id: string, options: BotGroupRevokeOptions) => {
      const revoking = (await beginBotGroupRevocation(group))!;
      await options.onRevoking?.(revoking);
      throw new HubError('revoke network failure', 0, 'hub_unreachable');
    });
    await expect(revokeRemoteBotGroup(group.id, group.generation)).rejects.toMatchObject({ code: 'hub_unreachable' });
  } else if (transition === 'switch') await useSavedConnection(profile('b').id, true);
  release.resolve();
  expect(await outcome).toMatchObject({ ok: transition === 'unchanged' });
  expect(writes).toEqual(transition === 'unchanged' ? [{ type: 'agents.api.set', agent: 'claude', accountId: '' }] : []);
});
