import { sha256 } from '@noble/hashes/sha2.js';
import * as SecureStore from 'expo-secure-store';
import { randomUUID } from 'expo-crypto';
import type { BotBindingPackage, Hub } from './client';
import { notificationScopeFor } from './notification-scope';
import { getSetting, setSetting } from '../storage/database';
import { canonicalHubUrl } from './pairing';
import { rememberSideQuestionPairing } from './side-question-history';

/** Public metadata only; the actual per-station/device credential lives in the OS keychain. */
export interface RemoteConnection { id: string; hubUrl: string; deviceId: string; deviceName: string; pairedAt: number; computerId?: string; alias?: string; botGroupId?: string; botGeneration?: string }
export const connectionDisplayName = (profile: RemoteConnection): string => profile.alias ?? profile.deviceName;
export const computerGroupKey = (profile: RemoteConnection): string => profile.computerId ? `computer:${profile.computerId}` : `connection:${profile.id}`;
export function pairedComputerCount(connections: RemoteConnection[]): number { return new Set(connections.map(computerGroupKey)).size; }
const INDEX = 'remote_device_connections_v1';
const SELECTED = 'remote_device_connection_v1';
const keyName = (id: string) => `remote-device-${id}`;

// SecureStore and the SQLite index are separate persistence layers. Serialize
// local mutations so an overlapping pair/revoke cannot resurrect a revoked
// token or drop a newly paired station from the index.
let mutationTail: Promise<void> = Promise.resolve();
const bindingListeners = new Set<() => void>();
export function onConnectionBindingsChange(listener: () => void): () => void {
  bindingListeners.add(listener);
  return () => { bindingListeners.delete(listener); };
}
function mutate<T>(task: () => Promise<T>, changesBindings = false): Promise<T> {
  const run = mutationTail.then(task, task);
  mutationTail = run.then(() => undefined, () => undefined);
  if (changesBindings) void run.then(notifyBindings, notifyBindings);
  return run;
}
function notifyBindings(): void { for (const listener of bindingListeners) { try { listener(); } catch { /* Observers cannot undo durable changes. */ } } }
export function connectionId(hubUrl: string, deviceId: string): string {
  return Array.from(sha256(new TextEncoder().encode(`${hubUrl}\n${deviceId}`)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
/** Bot group credentials must never share a keychain entry with a QR pairing. */
export function botConnectionId(hubUrl: string, deviceId: string, groupId: string): string {
  return Array.from(sha256(new TextEncoder().encode(`salcara-bot-connection-v1\n${hubUrl}\n${groupId}\n${deviceId}`)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
/** A non-authenticating local receipt namespace; never store the actual credential in drafts/outbox. */
export function deliveryCredentialId(pairToken: string): string {
  return Array.from(sha256(new TextEncoder().encode(`salcara-receipt-credential-v1\n${pairToken}`)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
export interface BotHubPin { instanceId: string; publicKey: string }
/** UI-safe metadata. No invitation, phone identity or credential belongs here. */
export interface BotGroupState {
  id: string; hubUrl: string; groupId: string; generation: string;
  status: 'pending' | 'active' | 'revoking' | 'revoked'; pairedAt: number;
  fingerprint?: string; pin?: BotHubPin;
}
export interface BotGroupRecord extends BotGroupState {
  token?: string; attemptId?: string; phoneId?: string; binding?: BotBindingPackage;
  /** Non-authenticating receipt namespace retained until local retirement succeeds. */
  retiredCredentialId?: string;
}
const BOT_INDEX = 'remote_bot_groups_v1';
const botKey = (id: string) => `remote-bot-group-${id}`;
const botMembersKey = (id: string, generation: string) => `remote_bot_retirement_members_v1_${id}_${generation}`;
const hash = (value: string) => Array.from(sha256(new TextEncoder().encode(value)), byte => byte.toString(16).padStart(2, '0')).join('');
const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
export const botGroupId = (hubUrl: string, groupId: string): string => hash(`salcara-bot-group-v1\n${hubUrl}\n${groupId}`);
export const botBindingFingerprint = (binding: BotBindingPackage): string => hash(JSON.stringify([
  binding.type, binding.version, binding.hubUrl, binding.groupId, binding.invite, binding.signature,
]));
function publicBotGroup(record: BotGroupRecord): BotGroupState {
  const { id, hubUrl, groupId, generation, status, pairedAt, fingerprint, pin } = record;
  return { id, hubUrl, groupId, generation, status, pairedAt, ...(fingerprint ? { fingerprint } : {}), ...(pin ? { pin: { ...pin } } : {}) };
}
function validBotGroup(value: unknown): value is BotGroupRecord {
  if (!value || typeof value !== 'object') return false;
  const group = value as BotGroupRecord;
  try {
    if (typeof group.hubUrl !== 'string' || canonicalHubUrl(group.hubUrl) !== group.hubUrl
      || typeof group.groupId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(group.groupId)
      || group.id !== botGroupId(group.hubUrl, group.groupId) || !uuid(group.generation)
      || !['pending', 'active', 'revoking', 'revoked'].includes(group.status)
      || !Number.isSafeInteger(group.pairedAt) || group.pairedAt < 0
      || group.fingerprint !== undefined && !hex(group.fingerprint)
      || group.pin !== undefined && (!group.pin || typeof group.pin.instanceId !== 'string' || !group.pin.instanceId || group.pin.instanceId.length > 256
        || typeof group.pin.publicKey !== 'string' || !group.pin.publicKey || group.pin.publicKey.length > 2048)) return false;
    if (group.retiredCredentialId !== undefined && !hex(group.retiredCredentialId)) return false;
    if (group.status === 'revoked') return group.token === undefined && group.binding === undefined && group.phoneId === undefined && group.attemptId === undefined;
    if (!hex(group.token) || group.attemptId !== undefined && !uuid(group.attemptId) || group.phoneId !== undefined && !hex(group.phoneId)) return false;
    if (group.binding !== undefined) {
      const p = group.binding;
      if (!p || Object.keys(p).length !== 6 || p.type !== 'salcara-hub-bot-binding' || p.version !== 1
        || typeof p.hubUrl !== 'string' || canonicalHubUrl(`${p.hubUrl}/v1`) !== group.hubUrl
        || p.groupId !== group.groupId || !hex(p.invite) || !hex(p.signature)
        || botBindingFingerprint(p) !== group.fingerprint || !group.attemptId || !group.phoneId || !group.pin) return false;
    }
    return group.status !== 'pending' || Boolean(group.binding && group.attemptId && group.phoneId && group.pin);
  } catch { return false; }
}
async function readBotGroup(id: string): Promise<BotGroupRecord | null> {
  if (!hex(id)) throw new Error('Bot 组记录无效');
  const raw = await SecureStore.getItemAsync(botKey(id));
  if (raw === null) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('Bot 安全记录无法读取，请保留原绑定并重试'); }
  if (!validBotGroup(parsed) || parsed.id !== id) throw new Error('Bot 安全记录不完整，已停止使用，请保留原绑定并重试');
  return parsed;
}
type BotIndexEntry = Pick<BotGroupState, 'id' | 'hubUrl' | 'groupId'>;
async function readBotIndex(): Promise<BotIndexEntry[]> {
  const raw = await getSetting(BOT_INDEX);
  if (raw === null) return [];
  let parsed: BotIndexEntry[];
  try { parsed = JSON.parse(raw); } catch { throw new Error('Bot 组索引无法读取，请重试'); }
  if (!Array.isArray(parsed) || parsed.length > 1000 || parsed.some(item => !item || typeof item.hubUrl !== 'string'
    || typeof item.groupId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(item.groupId)
    || item.id !== botGroupId(item.hubUrl, item.groupId))) throw new Error('Bot 组索引无效，请重试');
  return parsed;
}
async function writeBotGroup(record: BotGroupRecord): Promise<void> {
  if (!validBotGroup(record)) throw new Error('Bot 安全记录无效');
  const index = await readBotIndex();
  // Discovery is persisted first. A keychain failure leaves only public metadata;
  // a crash after a successful keychain write never strands an accepted attempt.
  if (!index.some(item => item.id === record.id)) {
    await setSetting(BOT_INDEX, JSON.stringify([...index, { id: record.id, hubUrl: record.hubUrl, groupId: record.groupId }]));
  }
  const encoded = JSON.stringify(record);
  await SecureStore.setItemAsync(botKey(record.id), encoded, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  if (await SecureStore.getItemAsync(botKey(record.id)) !== encoded) throw new Error('Bot 安全记录尚未保存，请重试');
}
function sameBotGeneration(actual: BotGroupRecord | null, expected: BotGroupRecord): actual is BotGroupRecord {
  return Boolean(actual && actual.id === expected.id && actual.generation === expected.generation && actual.token === expected.token);
}
type BotDispatchIdentity = Readonly<Pick<BotGroupRecord, 'id' | 'hubUrl' | 'groupId' | 'generation' | 'status' | 'token'>> & {
  readonly pin?: Readonly<BotHubPin>;
};
function captureBotDispatchIdentity(group: BotGroupRecord): BotDispatchIdentity {
  return Object.freeze({ id: group.id, hubUrl: group.hubUrl, groupId: group.groupId, generation: group.generation,
    status: group.status, token: group.token, ...(group.pin ? { pin: Object.freeze({ ...group.pin }) } : {}) });
}
function sameBotDispatchIdentity(actual: BotGroupRecord | null, expected: BotDispatchIdentity): boolean {
  return Boolean(actual && expected.status !== 'revoked' && expected.token && expected.pin
    && actual.id === expected.id && actual.hubUrl === expected.hubUrl && actual.groupId === expected.groupId
    && actual.generation === expected.generation && actual.status === expected.status && actual.token === expected.token
    && actual.pin?.instanceId === expected.pin.instanceId && actual.pin?.publicKey === expected.pin.publicKey);
}
/** Group recovery and revocation have authority even without any projected member.
 * Capture before enqueueing: an active request cannot borrow later revoking authority. */
export function authorizeBotGroupDispatch<T>(expected: BotGroupRecord, dispatch: () => T): Promise<{ value: T } | null> {
  const identity = captureBotDispatchIdentity(expected);
  return mutate(async () => {
    if (!sameBotDispatchIdentity(await readBotGroup(identity.id), identity)) return null;
    // Launch in the same queue as revoke, but never await network I/O here.
    // The envelope prevents Promise assimilation from holding the queue open.
    return { value: dispatch() };
  });
}
function botConnectionAuthorizer(group: BotGroupRecord, profile: RemoteConnection): NonNullable<Hub['authorizeDispatch']> {
  const identity = captureBotDispatchIdentity(group);
  const member = Object.freeze({ id: profile.id, hubUrl: profile.hubUrl, deviceId: profile.deviceId,
    botGroupId: profile.botGroupId, botGeneration: profile.botGeneration });
  return <T>(dispatch: () => T) => mutate(async (): Promise<{ value: T } | null> => {
    if (identity.status !== 'active' || !sameBotDispatchIdentity(await readBotGroup(identity.id), identity)) return null;
    const saved = (await readConnectionIndex()).find(item => item.id === member.id);
    // Retirement receipts are not membership and cannot authorize dispatch.
    if (!saved || saved.hubUrl !== member.hubUrl || saved.deviceId !== member.deviceId || saved.botGroupId !== member.botGroupId
      || saved.botGeneration !== member.botGeneration || saved.botGeneration !== identity.generation) return null;
    return { value: dispatch() };
  });
}
async function migrateBotGroup(id: string): Promise<BotGroupRecord | null> {
  const current = await readBotGroup(id);
  if (current) {
    if (current.status === 'active' && !current.fingerprint && !current.attemptId) {
      // The secure migration may have committed before its public projection
      // failed. Repair offline only with every original per-device secret as
      // evidence; never attach an arbitrary old profile to a new generation.
      const legacy = (await readConnectionIndex()).filter(item => item.hubUrl === current.hubUrl && item.botGroupId === current.groupId);
      if (legacy.length && legacy.every(item => !item.botGeneration)) {
        const tokens = await Promise.all(legacy.map(readLegacyConnectionToken));
        if (tokens.every(token => token === current.token)) { await writeBotMembers(current, legacy); notifyBindings(); }
      }
    }
    return current;
  }
  const profiles = (await readConnectionIndex()).filter(item => item.botGroupId && botGroupId(item.hubUrl, item.botGroupId) === id);
  if (!profiles.length || profiles.some(item => item.botGeneration)) return null;
  const tokens = new Set<string>();
  for (const profile of profiles) { const token = await readConnectionToken(profile); if (token) tokens.add(token); }
  if (tokens.size !== 1) return null; // Ambiguous legacy credentials are never guessed.
  const first = profiles[0];
  const record: BotGroupRecord = { id, hubUrl: first.hubUrl, groupId: first.botGroupId!, generation: randomUUID(), status: 'active', pairedAt: first.pairedAt, token: [...tokens][0] };
  await writeBotGroup(record);
  await writeBotMembers(record, profiles);
  notifyBindings();
  return record;
}
export async function getBotGroup(id: string): Promise<BotGroupRecord | null> { return mutate(() => migrateBotGroup(id)); }
export async function loadBotGroups(): Promise<BotGroupState[]> {
  return mutate(async () => {
    const ids = new Set((await readBotIndex()).map(item => item.id));
    for (const item of await readConnectionIndex()) if (item.botGroupId) ids.add(botGroupId(item.hubUrl, item.botGroupId));
    const groups: BotGroupState[] = [];
    for (const id of ids) { const group = await migrateBotGroup(id); if (group) groups.push(publicBotGroup(group)); }
    return groups;
  });
}
async function readBotRetirementMembers(id: string, generation: string): Promise<RemoteConnection[]> {
  const raw = await getSetting(botMembersKey(id, generation));
  if (raw === null) return [];
  let members: RemoteConnection[];
  try { members = JSON.parse(raw); } catch { throw new Error('Bot 本地待确认记录无法读取，请保留绑定并重试'); }
  if (!Array.isArray(members) || members.some(item => !validConnection(item) || item.botGeneration !== generation
    || !item.botGroupId || botGroupId(item.hubUrl, item.botGroupId) !== id)) throw new Error('Bot 本地待确认记录无效，请保留绑定并重试');
  return members;
}
export async function listBotGroupProfiles(id: string, expectedGeneration?: string): Promise<RemoteConnection[]> {
  return mutate(async () => {
    const group = await readBotGroup(id);
    const generation = expectedGeneration ?? group?.generation;
    const members = (await readConnectionIndex()).filter(item => item.botGroupId && botGroupId(item.hubUrl, item.botGroupId) === id
      && (!generation || item.botGeneration === generation || !item.botGeneration && group?.generation === generation));
    const retired = generation ? await readBotRetirementMembers(id, generation) : [];
    return [...new Map([...retired, ...members].map(item => [item.id, item])).values()];
  });
}
export async function prepareBotGroup(candidate: BotGroupRecord): Promise<BotGroupRecord> {
  if (!validBotGroup(candidate) || candidate.status !== 'pending') throw new Error('Bot 绑定恢复材料无效');
  return mutate(async () => {
    const previous = await migrateBotGroup(candidate.id);
    if (previous) {
      if (previous.status === 'revoking') throw new Error('Bot 撤销尚未确认，请先重试撤销');
      if (previous.fingerprint === candidate.fingerprint) {
        if (previous.status === 'revoked') throw new Error('此 Bot 绑定已失效，请管理员重置原组并提供新绑定包');
        return previous;
      }
      // A different explicit administrator package may start a fresh generation,
      // but never overwrite an unresolved attempt or a still-active credential.
      if (previous.status !== 'revoked') throw new Error('此 Bot 组已有绑定或待确认请求，请先恢复或撤销原绑定');
      if ((await readConnectionIndex()).some(item => item.hubUrl === previous.hubUrl && item.botGroupId === previous.groupId)
        || (await readBotRetirementMembers(previous.id, previous.generation)).length) {
        throw new Error('旧 Bot 绑定还有本地待确认记录，请先清理失效记录再导入新绑定包');
      }
    }
    await writeBotGroup(candidate);
    return candidate;
  }, true);
}
/** Only an explicit user-confirmed legacy identity may attach a previously absent pin. */
export async function confirmLegacyBotGroupPin(expected: BotGroupRecord, pin: BotHubPin, stillCurrent: () => boolean = () => true): Promise<boolean> {
  return mutate(async () => {
    const current = await readBotGroup(expected.id);
    if (!sameBotGeneration(current, expected) || current.status !== 'active' || current.pin || !stillCurrent()) return false;
    const confirmed: BotGroupRecord = { ...current, pin: { ...pin } };
    if (!validBotGroup(confirmed)) throw new Error('服务器安全身份无效，请重新核对');
    await writeBotGroup(confirmed);
    if (!stillCurrent()) {
      // The explicit confirmation authorized trust; leaving the page cancels
      // this operation's credential dispatch. Restore the prior record when
      // storage permits, and propagate failure without sending a credential.
      await writeBotGroup(current);
      return false;
    }
    return true;
  }, true);
}
async function writeBotMembers(group: BotGroupRecord, profiles: RemoteConnection[], stillCurrent: () => boolean = () => true): Promise<boolean> {
  const all = await readConnectionIndex();
  const belongs = (item: RemoteConnection) => item.hubUrl === group.hubUrl && item.botGroupId === group.groupId;
  const old = all.filter(belongs);
  const projected: RemoteConnection[] = [];
  for (const profile of profiles) {
    const previous = old.find(item => item.id === profile.id);
    const alias = profile.alias ?? previous?.alias ?? (profile.computerId ? all.find(item => item.computerId === profile.computerId && item.alias)?.alias : undefined);
    projected.push({ ...profile, botGeneration: group.generation, pairedAt: previous?.botGeneration === group.generation ? previous.pairedAt : profile.pairedAt, ...(alias ? { alias } : {}) });
    if (profile.computerId && group.token) await rememberSideQuestionPairing(profile.id, profile.computerId, undefined, deliveryCredentialId(group.token));
  }
  if (group.token) {
    // This non-authorizing ledger remembers removed members solely so their
    // pending receipts can be retired on revoke, even after an empty-group
    // restart. It is never used for connections, commands or notifications.
    const retired = await readBotRetirementMembers(group.id, group.generation);
    const known = old.filter(item => !item.botGeneration || item.botGeneration === group.generation)
      .map(item => ({ ...item, botGeneration: group.generation }));
    await setSetting(botMembersKey(group.id, group.generation), JSON.stringify([...new Map([...retired, ...known, ...projected].map(item => [item.id, item])).values()]));
  }
  const selected = await readSelectedConnection();
  if (!stillCurrent()) return false;
  await setSetting(INDEX, JSON.stringify([...projected, ...all.filter(item => !belongs(item))]));
  if (!stillCurrent()) { await setSetting(INDEX, JSON.stringify(all)); return false; }
  if (selected && old.some(item => item.id === selected) && !projected.some(item => item.id === selected)) await writeSelectedConnection(null);
  if (!stillCurrent()) {
    await setSetting(INDEX, JSON.stringify(all));
    if (await readSelectedConnection() === null) await writeSelectedConnection(selected);
    return false;
  }
  // Legacy per-device copies are no longer authority. A failed deletion is safe:
  // every reader checks the durable group record first, including tombstones.
  for (const profile of old) await SecureStore.deleteItemAsync(keyName(profile.id)).catch(() => undefined);
  return true;
}
export async function commitBotGroupMembers(expected: BotGroupRecord, profiles: RemoteConnection[], stillCurrent: () => boolean = () => true): Promise<boolean> {
  if (profiles.length > 1000 || profiles.some(profile => !validConnection(profile) || profile.hubUrl !== expected.hubUrl || profile.botGroupId !== expected.groupId)
    || new Set(profiles.map(item => item.id)).size !== profiles.length) throw new Error('Bot 组电脑列表无效');
  return mutate(async () => {
    const current = await readBotGroup(expected.id);
    if (!sameBotGeneration(current, expected) || !['pending', 'active'].includes(current.status) || !stillCurrent()) return false;
    const active = { ...current, status: 'active' as const };
    await writeBotGroup(active);
    // An index failure leaves the authoritative token recoverable; a later GET
    // repairs the projection, including an empty group, without another bind.
    return writeBotMembers(active, profiles, stillCurrent);
  }, true);
}
export async function beginBotGroupRevocation(expected: BotGroupRecord): Promise<BotGroupRecord | null> {
  return mutate(async () => {
    const current = await readBotGroup(expected.id);
    if (!sameBotGeneration(current, expected) || current.status === 'revoked') return null;
    const revoking = { ...current, status: 'revoking' as const };
    await writeBotGroup(revoking);
    return revoking;
  }, true);
}
async function tombstoneBotGroup(current: BotGroupRecord): Promise<void> {
  await writeBotGroup({ ...publicBotGroup(current), status: 'revoked',
    retiredCredentialId: current.token ? deliveryCredentialId(current.token) : current.retiredCredentialId });
}
export async function completeBotGroupRevocation(expected: BotGroupRecord): Promise<boolean> {
  return mutate(async () => {
    const current = await readBotGroup(expected.id);
    if (!current || current.generation !== expected.generation) return false;
    if (current.status === 'revoked') {
      if (expected.status !== 'revoked') return false;
    } else {
      if (!sameBotGeneration(current, expected) || current.status !== 'revoking') return false;
      await tombstoneBotGroup(current);
    }
    await writeBotMembers({ ...current, token: undefined }, []);
    await setSetting(botMembersKey(current.id, current.generation), null);
    return true;
  }, true);
}
export async function invalidateBotGroup(id: string, expectedToken: string, expectedGeneration?: string): Promise<boolean> {
  return mutate(async () => {
    const current = await migrateBotGroup(id);
    if (!current || current.token !== expectedToken || expectedGeneration && current.generation !== expectedGeneration || current.status === 'revoking' || current.status === 'revoked') return false;
    // Keep public member metadata for local receipt retirement. It cannot grant
    // access: loadConnections and credential readers reject this tombstone.
    await tombstoneBotGroup(current);
    return true;
  }, true);
}
function validConnection(value: unknown): value is RemoteConnection {
  if (!value || typeof value !== 'object') return false;
  const profile = value as RemoteConnection;
  try {
    return typeof profile.hubUrl === 'string' && canonicalHubUrl(profile.hubUrl) === profile.hubUrl
      && typeof profile.deviceId === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(profile.deviceId)
      && (profile.computerId === undefined || typeof profile.computerId === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(profile.computerId))
      && profile.id === (profile.botGroupId ? botConnectionId(profile.hubUrl, profile.deviceId, profile.botGroupId) : connectionId(profile.hubUrl, profile.deviceId))
      && typeof profile.deviceName === 'string' && Boolean(profile.deviceName.trim()) && profile.deviceName.length <= 200 && !/[\u0000-\u001f]/.test(profile.deviceName)
      && (profile.alias === undefined || typeof profile.alias === 'string' && Boolean(profile.alias.trim()) && Array.from(profile.alias).length <= 48 && !/[\u0000-\u001f]/.test(profile.alias))
      && (profile.botGroupId === undefined || typeof profile.botGroupId === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(profile.botGroupId))
      && (profile.botGeneration === undefined || Boolean(profile.botGroupId) && uuid(profile.botGeneration))
      && typeof profile.pairedAt === 'number' && Number.isSafeInteger(profile.pairedAt) && profile.pairedAt >= 0;
  } catch { return false; }
}

export async function saveBotConnections(profiles: RemoteConnection[], token: string, stillCurrent: () => boolean = () => true): Promise<RemoteConnection[]> {
  if (!profiles.length || !/^[a-f0-9]{64}$/.test(token)
    || profiles.some(profile => !profile.botGroupId || !validConnection(profile)
      || profile.hubUrl !== profiles[0].hubUrl || profile.botGroupId !== profiles[0].botGroupId)
    || new Set(profiles.map(profile => profile.id)).size !== profiles.length) throw new Error('Hub 返回的 Bot 手机凭据无效');
  // Compatibility for already authenticated legacy imports. New invitations
  // must go through prepareBotGroup before sending any request.
  return mutate(async () => {
    if (!stillCurrent()) return readConnections();
    const first = profiles[0], id = botGroupId(first.hubUrl, first.botGroupId!);
    const previous = await readBotGroup(id);
    if (previous && previous.status !== 'active') throw new Error('Bot 组正在恢复或已撤销，请使用管理员签发的新绑定包');
    if (previous?.fingerprint) throw new Error('已有安全绑定不能通过旧版导入覆盖');
    const record: BotGroupRecord = { id, hubUrl: first.hubUrl, groupId: first.botGroupId!, generation: previous?.token === token ? previous.generation : randomUUID(), status: 'active', pairedAt: first.pairedAt, token };
    await writeBotGroup(record);
    await writeBotMembers(record, profiles);
    return readConnections();
  }, true);
}
/** Runs within the mutation queue, including migration across the keychain/index boundary. */
async function readConnectionIndex(): Promise<RemoteConnection[]> {
  const raw = await getSetting(INDEX);
  let parsed: unknown;
  try { parsed = JSON.parse(raw || '[]'); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const current = parsed.filter(validConnection);
  const legacy = parsed.filter((value): value is RemoteConnection => Boolean(value && typeof value === 'object'
    && typeof value.botGroupId === 'string' && value.botGroupId
    && value.id === connectionId(value.hubUrl, value.deviceId)
    && validConnection({ ...value, id: botConnectionId(value.hubUrl, value.deviceId, value.botGroupId) })));
  if (!legacy.length) return current;
  const selected = await readSelectedConnection();
  let nextSelected = selected;
  const previousSecrets = new Map<string, string | null>();
  try {
    for (const profile of legacy) {
      const id = botConnectionId(profile.hubUrl, profile.deviceId, profile.botGroupId!);
      if (selected === profile.id) nextSelected = id;
      if (current.some(item => item.id === id)) continue; // A newer scoped binding wins.
      const oldRaw = await SecureStore.getItemAsync(keyName(profile.id));
      let entry: { hubUrl?: string; deviceId?: string; botGroupId?: string; token?: string } = {};
      try { const value = JSON.parse(oldRaw || '{}'); if (value && typeof value === 'object') entry = value; } catch { /* Keep metadata so a lost key can be rebound. */ }
      if (entry.hubUrl === profile.hubUrl && entry.deviceId === profile.deviceId
        && (entry.botGroupId === undefined || entry.botGroupId === profile.botGroupId)
        && typeof entry.token === 'string' && /^[a-f0-9]{64}$/.test(entry.token)) {
        previousSecrets.set(id, await SecureStore.getItemAsync(keyName(id)));
        await SecureStore.setItemAsync(keyName(id), JSON.stringify({ hubUrl: profile.hubUrl, deviceId: profile.deviceId, botGroupId: profile.botGroupId, token: entry.token }), { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
      }
      current.push({ ...profile, id });
    }
    await setSetting(INDEX, JSON.stringify(current));
    if (nextSelected !== selected) await writeSelectedConnection(nextSelected);
  } catch (error) {
    // Do not strand the old index if either storage layer failed during migration.
    await setSetting(INDEX, raw).catch(() => undefined);
    if (nextSelected !== selected) await writeSelectedConnection(selected).catch(() => undefined);
    for (const [id, previous] of previousSecrets) {
      if (previous) await SecureStore.setItemAsync(keyName(id), previous, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }).catch(() => undefined);
      else await SecureStore.deleteItemAsync(keyName(id)).catch(() => undefined);
    }
    throw error;
  }
  for (const profile of legacy) {
    if (!current.some(item => item.id === profile.id)) await SecureStore.deleteItemAsync(keyName(profile.id)).catch(() => undefined);
  }
  return current;
}
async function readConnections(): Promise<RemoteConnection[]> {
  const profiles = await readConnectionIndex();
  const groups = new Map<string, BotGroupRecord | null>();
  for (const profile of profiles) {
    if (!profile.botGroupId) continue;
    const id = botGroupId(profile.hubUrl, profile.botGroupId);
    if (!groups.has(id)) groups.set(id, await readBotGroup(id));
  }
  return profiles.filter(profile => {
    if (!profile.botGroupId) return true;
    const group = groups.get(botGroupId(profile.hubUrl, profile.botGroupId));
    return !group || group.status !== 'revoked' && group.status !== 'pending'
      && (!profile.botGeneration || profile.botGeneration === group.generation);
  });
}
export async function loadConnections(): Promise<RemoteConnection[]> { return mutate(readConnections); }
export interface NotificationTarget { connectionId: string; deviceId: string; notificationScope: string; hub: Hub }
/** The one profile-to-authentication boundary, shared with foreground and notifications. */
async function readConnectionHub(profile: RemoteConnection, omitUnconfirmedIdentity = false): Promise<Hub | null> {
  if (!validConnection(profile)) return null;
  const saved = (await readConnectionIndex()).find(item => item.id === profile.id);
  if (!saved || profile.botGeneration && saved.botGeneration !== profile.botGeneration) return null;
  const token = await readConnectionToken(saved);
  if (!token) return null;
  const group = profile.botGroupId ? await readBotGroup(botGroupId(profile.hubUrl, profile.botGroupId)) : null;
  if (profile.botGroupId && !group?.pin) {
    if (omitUnconfirmedIdentity) return null;
    throw Object.assign(new Error('旧 Bot 绑定尚未确认服务器安全身份，凭据已保留，请先核对并确认身份'), { code: 'bot_identity_unavailable' });
  }
  return { url: saved.hubUrl, deviceId: saved.deviceId, pairToken: token,
    ...(saved.botGroupId ? { botToken: token, botPin: { ...group!.pin! }, authorizeDispatch: botConnectionAuthorizer(group!, saved) } : {}) };
}
export function connectionHub(profile: RemoteConnection): Promise<Hub | null> { return mutate(() => readConnectionHub(profile)); }
/** Index and keychain reads share the binding mutation queue, including re-pair/revoke. */
async function readNotificationTargets(): Promise<NotificationTarget[]> {
  const targets: NotificationTarget[] = [];
  for (const profile of await readConnections()) {
    // A legacy Bot secret without a group-specific identity cannot enroll a
    // background consumer against a shared pin possibly changed by QR pairing.
    const hub = await readConnectionHub(profile, true);
    if (!hub) continue;
    const notificationScope = notificationScopeFor(hub, profile.deviceId);
    if (notificationScope) targets.push({ connectionId: profile.id, deviceId: profile.deviceId, notificationScope, hub });
  }
  return targets;
}
export function loadNotificationTargets(): Promise<NotificationTarget[]> { return mutate(readNotificationTargets); }
export function resolveNotificationTarget(scope: string, deviceId: string): Promise<NotificationTarget | null> {
  return mutate(async () => (await readNotificationTargets()).find(target => target.notificationScope === scope && target.deviceId === deviceId) ?? null);
}
async function readSelectedConnection(): Promise<string | null> { return getSetting(SELECTED); }
async function writeSelectedConnection(id: string | null): Promise<void> { await setSetting(SELECTED, id); }
export async function selectedConnection(): Promise<string | null> { return mutate(readSelectedConnection); }
export async function selectConnection(id: string | null): Promise<void> { await mutate(() => writeSelectedConnection(id)); }
/**
 * Writes the startup selection only while the caller's connection generation
 * is still current. The guard is checked before and after the storage write;
 * if a newer selection wins while the write is in flight, the old value is
 * restored inside the same mutation queue before the newer write runs.
 */
export async function selectConnectionIf(id: string | null, guard: () => boolean): Promise<boolean> {
  return mutate(async () => {
    const previous = await readSelectedConnection();
    if (!guard()) return false;
    await writeSelectedConnection(id);
    if (guard()) return true;
    if (await readSelectedConnection() === id) await writeSelectedConnection(previous);
    return false;
  });
}
export async function connectionToken(profile: RemoteConnection): Promise<string | null> {
  if (!validConnection(profile)) return null;
  return mutate(async () => {
    return readConnectionToken(profile);
  });
}

async function readConnectionToken(profile: RemoteConnection): Promise<string | null> {
  if (profile.botGroupId) {
    const group = await readBotGroup(botGroupId(profile.hubUrl, profile.botGroupId));
    if (group) {
      const saved = (await readConnectionIndex()).find(item => item.id === profile.id);
      return group.status === 'active' && saved && saved.botGeneration === group.generation
        && (!profile.botGeneration || profile.botGeneration === group.generation) ? group.token ?? null : null;
    }
    if (profile.botGeneration) return null; // Lost authority is never a legacy credential.
  }
  return readLegacyConnectionToken(profile);
}
async function readLegacyConnectionToken(profile: RemoteConnection): Promise<string | null> {
  const raw = await SecureStore.getItemAsync(keyName(profile.id));
  try {
    const entry = JSON.parse(raw || '{}');
    return entry.hubUrl === profile.hubUrl && entry.deviceId === profile.deviceId && entry.botGroupId === profile.botGroupId
      && typeof entry.token === 'string' && /^[a-f0-9]{64}$/.test(entry.token) ? entry.token : null;
  } catch { return null; }
}
export async function saveConnection(profile: RemoteConnection, token: string, stillCurrent: () => boolean = () => true, source?: { profile: RemoteConnection; token: string }): Promise<RemoteConnection[]> {
  if (!validConnection(profile) || !/^[a-f0-9]{64}$/.test(token)) throw new Error('中转站返回的配对凭证无效');
  return mutate(async () => {
    if (!stillCurrent()) return readConnections();
    if (profile.botGroupId && await readBotGroup(botGroupId(profile.hubUrl, profile.botGroupId))) throw new Error('Bot 电脑由组绑定管理，请刷新组成员');
    if (source) {
      // Check inside the revoke mutation queue: delayed catalogs cannot
      // resurrect a computer whose source binding has been removed.
      const savedSource = (await readConnections()).find(item => item.id === source.profile.id);
      if (!savedSource || !profile.computerId || savedSource.computerId !== profile.computerId
        || source.profile.computerId !== profile.computerId || await readConnectionToken(savedSource) !== source.token || !stillCurrent()) return readConnections();
    }
    const previous = await SecureStore.getItemAsync(keyName(profile.id));
    const previousProfiles = await readConnectionIndex();
    const previousVisible = await readConnections();
    const visibleIds = new Set(previousVisible.map(item => item.id));
    const previousProfile = previousProfiles.find(item => item.id === profile.id);
    const previousAlias = previousProfile?.alias ?? (profile.computerId
      ? previousProfiles.find(item => item.computerId === profile.computerId && item.alias)?.alias : undefined);
    if (profile.computerId) {
      let old: { hubUrl?: string; deviceId?: string; token?: string } | undefined;
      try { old = JSON.parse(previous ?? '{}'); } catch { /* No verified old credential to link. */ }
      const previousCredential = previousProfile?.computerId === profile.computerId && old?.hubUrl === profile.hubUrl
        && old.deviceId === profile.deviceId && typeof old.token === 'string' && /^[a-f0-9]{64}$/.test(old.token) ? deliveryCredentialId(old.token) : undefined;
      if (!stillCurrent()) return readConnections();
      await rememberSideQuestionPairing(profile.id, profile.computerId, previousCredential, deliveryCredentialId(token));
    }
    // A later QR exchange for this same station/computer owns the credential.
    // Check inside the mutation queue, after any older storage wait, so an old
    // HTTP acknowledgement cannot overwrite a newer token already committed.
    if (!stillCurrent()) return readConnections();
    await SecureStore.setItemAsync(keyName(profile.id), JSON.stringify({ hubUrl: profile.hubUrl, deviceId: profile.deviceId, ...(profile.botGroupId ? { botGroupId: profile.botGroupId } : {}), token }), { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
    try {
      if (source && !stillCurrent()) {
        if (previous) await SecureStore.setItemAsync(keyName(profile.id), previous, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
        else await SecureStore.deleteItemAsync(keyName(profile.id));
        return readConnections();
      }
      const list = [{ ...profile, ...(profile.alias ? {} : previousAlias ? { alias: previousAlias } : {}) }, ...(await readConnectionIndex()).filter((item) => item.id !== profile.id)];
      await setSetting(INDEX, JSON.stringify(list));
      if (source && !stillCurrent()) {
        await setSetting(INDEX, JSON.stringify(previousProfiles));
        if (previous) await SecureStore.setItemAsync(keyName(profile.id), previous, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
        else await SecureStore.deleteItemAsync(keyName(profile.id));
        return previousVisible;
      }
      return list.filter(item => item.id === profile.id || visibleIds.has(item.id));
    } catch (error) {
      if (previous) await SecureStore.setItemAsync(keyName(profile.id), previous, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
      else await SecureStore.deleteItemAsync(keyName(profile.id));
      throw error;
    }
  }, true);
}
/** Store a phone-only label without changing the computer's advertised name. */
export async function renameConnection(id: string, value: string): Promise<RemoteConnection[]> {
  const alias = value.trim().replace(/\s+/g, ' ');
  if (Array.from(alias).length > 48 || /[\u0000-\u001f]/.test(alias)) throw new Error('备注名最多 48 个字符，且不能包含控制字符');
  return mutate(async () => {
    const current = await readConnectionIndex();
    const target = (await readConnections()).find((item) => item.id === id);
    if (!target) throw new Error('没有找到这台电脑的连接记录');
    const belongsToTarget = (item: RemoteConnection) => item.id === target.id || Boolean(target.computerId && item.computerId === target.computerId);
    const list = current.map((item) => {
      if (!belongsToTarget(item)) return item;
      if (alias) return { ...item, alias };
      const { alias: _alias, ...rest } = item;
      return rest;
    });
    await setSetting(INDEX, JSON.stringify(list));
    return readConnections();
  });
}
export async function forgetConnection(profile: RemoteConnection, expectedToken?: string): Promise<RemoteConnection[]> {
  return mutate(async () => {
    // An auth failure can race a fresh QR claim for the same station. Only
    // retire the credential that produced this failure; never delete the new
    // token that replaced it while the request was in flight.
    const group = profile.botGroupId ? await readBotGroup(botGroupId(profile.hubUrl, profile.botGroupId)) : null;
    if (group && profile.botGeneration && group.generation !== profile.botGeneration) return readConnections();
    if (expectedToken) {
      if (group?.token && group.token !== expectedToken) return readConnections();
      const currentToken = await readConnectionToken(profile);
      if (currentToken && currentToken !== expectedToken) return readConnections();
    }
    const list = (await readConnectionIndex()).filter((item) => item.id !== profile.id);
    // Remove the index even if the OS keychain reports a delete error. An
    // orphaned secret is not addressable on the next boot; retaining its
    // profile would make the app retry a revoked token forever.
    let secretError: unknown;
    try { await SecureStore.deleteItemAsync(keyName(profile.id)); } catch (error) { secretError = error; }
    await setSetting(INDEX, JSON.stringify(list));
    if (await readSelectedConnection() === profile.id) await writeSelectedConnection(null);
    if (secretError) throw secretError;
    return readConnections();
  }, true);
}
