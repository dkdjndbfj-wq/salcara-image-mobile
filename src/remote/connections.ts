import { sha256 } from '@noble/hashes/sha2.js';
import * as SecureStore from 'expo-secure-store';
import { getSetting, setSetting } from '../storage/database';
import { canonicalHubUrl } from './pairing';
import { rememberSideQuestionPairing } from './side-question-history';

/** Public metadata only; the actual per-station/device credential lives in the OS keychain. */
export interface RemoteConnection { id: string; hubUrl: string; deviceId: string; deviceName: string; pairedAt: number; computerId?: string; alias?: string; botGroupId?: string }
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
function mutate<T>(task: () => Promise<T>): Promise<T> {
  const run = mutationTail.then(task, task);
  mutationTail = run.then(() => undefined, () => undefined);
  return run;
}
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
      && typeof profile.pairedAt === 'number' && Number.isSafeInteger(profile.pairedAt) && profile.pairedAt >= 0;
  } catch { return false; }
}

export async function saveBotConnections(profiles: RemoteConnection[], token: string, stillCurrent: () => boolean = () => true): Promise<RemoteConnection[]> {
  if (!profiles.length || !/^[a-f0-9]{64}$/.test(token)
    || profiles.some(profile => !profile.botGroupId || !validConnection(profile)
      || profile.hubUrl !== profiles[0].hubUrl || profile.botGroupId !== profiles[0].botGroupId)
    || new Set(profiles.map(profile => profile.id)).size !== profiles.length) throw new Error('Hub 返回的 Bot 手机凭据无效');
  let list = await loadConnections();
  for (const profile of profiles) list = await saveConnection(profile, token, stillCurrent);
  return list;
}
/** Runs within the mutation queue, including migration across the keychain/index boundary. */
async function readConnections(): Promise<RemoteConnection[]> {
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
export async function loadConnections(): Promise<RemoteConnection[]> { return mutate(readConnections); }
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
    if (source) {
      // Check inside the revoke mutation queue: delayed catalogs cannot
      // resurrect a computer whose source binding has been removed.
      const savedSource = (await readConnections()).find(item => item.id === source.profile.id);
      if (!savedSource || !profile.computerId || savedSource.computerId !== profile.computerId
        || source.profile.computerId !== profile.computerId || await readConnectionToken(savedSource) !== source.token || !stillCurrent()) return readConnections();
    }
    const previous = await SecureStore.getItemAsync(keyName(profile.id));
    const previousProfiles = await readConnections();
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
      const list = [{ ...profile, ...(profile.alias ? {} : previousAlias ? { alias: previousAlias } : {}) }, ...(await readConnections()).filter((item) => item.id !== profile.id)];
      await setSetting(INDEX, JSON.stringify(list));
      if (source && !stillCurrent()) {
        await setSetting(INDEX, JSON.stringify(previousProfiles));
        if (previous) await SecureStore.setItemAsync(keyName(profile.id), previous, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
        else await SecureStore.deleteItemAsync(keyName(profile.id));
        return previousProfiles;
      }
      return list;
    } catch (error) {
      if (previous) await SecureStore.setItemAsync(keyName(profile.id), previous, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
      else await SecureStore.deleteItemAsync(keyName(profile.id));
      throw error;
    }
  });
}
/** Store a phone-only label without changing the computer's advertised name. */
export async function renameConnection(id: string, value: string): Promise<RemoteConnection[]> {
  const alias = value.trim().replace(/\s+/g, ' ');
  if (Array.from(alias).length > 48 || /[\u0000-\u001f]/.test(alias)) throw new Error('备注名最多 48 个字符，且不能包含控制字符');
  return mutate(async () => {
    const current = await readConnections();
    const target = current.find((item) => item.id === id);
    if (!target) throw new Error('没有找到这台电脑的连接记录');
    const belongsToTarget = (item: RemoteConnection) => item.id === target.id || Boolean(target.computerId && item.computerId === target.computerId);
    const list = current.map((item) => {
      if (!belongsToTarget(item)) return item;
      if (alias) return { ...item, alias };
      const { alias: _alias, ...rest } = item;
      return rest;
    });
    await setSetting(INDEX, JSON.stringify(list));
    return list;
  });
}
export async function forgetConnection(profile: RemoteConnection, expectedToken?: string): Promise<RemoteConnection[]> {
  return mutate(async () => {
    // An auth failure can race a fresh QR claim for the same station. Only
    // retire the credential that produced this failure; never delete the new
    // token that replaced it while the request was in flight.
    if (expectedToken) {
      const currentToken = await readConnectionToken(profile);
      if (currentToken && currentToken !== expectedToken) return readConnections();
    }
    const list = (await readConnections()).filter((item) => item.id !== profile.id);
    // Remove the index even if the OS keychain reports a delete error. An
    // orphaned secret is not addressable on the next boot; retaining its
    // profile would make the app retry a revoked token forever.
    let secretError: unknown;
    try { await SecureStore.deleteItemAsync(keyName(profile.id)); } catch (error) { secretError = error; }
    await setSetting(INDEX, JSON.stringify(list));
    if (await readSelectedConnection() === profile.id) await writeSelectedConnection(null);
    if (secretError) throw secretError;
    return list;
  });
}
