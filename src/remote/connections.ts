import { sha256 } from '@noble/hashes/sha2.js';
import * as SecureStore from 'expo-secure-store';
import { getSetting, setSetting } from '../storage/database';
import { canonicalHubUrl } from './pairing';

/** Public metadata only; the actual per-station/device credential lives in the OS keychain. */
export interface RemoteConnection { id: string; hubUrl: string; deviceId: string; deviceName: string; pairedAt: number; computerId?: string }
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
      && profile.id === connectionId(profile.hubUrl, profile.deviceId)
      && typeof profile.deviceName === 'string' && Boolean(profile.deviceName.trim()) && profile.deviceName.length <= 200 && !/[\u0000-\u001f]/.test(profile.deviceName)
      && typeof profile.pairedAt === 'number' && Number.isSafeInteger(profile.pairedAt) && profile.pairedAt >= 0;
  } catch { return false; }
}
export async function loadConnections(): Promise<RemoteConnection[]> {
  const raw = await getSetting(INDEX);
  try { const list: unknown = JSON.parse(raw || '[]'); return Array.isArray(list) ? list.filter(validConnection) : []; } catch { return []; }
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
  const raw = await SecureStore.getItemAsync(keyName(profile.id));
  try {
    const entry = JSON.parse(raw || '{}');
    return entry.hubUrl === profile.hubUrl && entry.deviceId === profile.deviceId && typeof entry.token === 'string' && /^[a-f0-9]{64}$/.test(entry.token) ? entry.token : null;
  } catch { return null; }
}
export async function saveConnection(profile: RemoteConnection, token: string): Promise<RemoteConnection[]> {
  if (!validConnection(profile) || !/^[a-f0-9]{64}$/.test(token)) throw new Error('中转站返回的配对凭证无效');
  return mutate(async () => {
    const previous = await SecureStore.getItemAsync(keyName(profile.id));
    await SecureStore.setItemAsync(keyName(profile.id), JSON.stringify({ hubUrl: profile.hubUrl, deviceId: profile.deviceId, token }), { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
    try {
      const list = [profile, ...(await loadConnections()).filter((item) => item.id !== profile.id)];
      await setSetting(INDEX, JSON.stringify(list));
      return list;
    } catch (error) {
      if (previous) await SecureStore.setItemAsync(keyName(profile.id), previous, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
      else await SecureStore.deleteItemAsync(keyName(profile.id));
      throw error;
    }
  });
}
export async function forgetConnection(profile: RemoteConnection, expectedToken?: string): Promise<RemoteConnection[]> {
  return mutate(async () => {
    // An auth failure can race a fresh QR claim for the same station. Only
    // retire the credential that produced this failure; never delete the new
    // token that replaced it while the request was in flight.
    if (expectedToken) {
      const currentToken = await readConnectionToken(profile);
      if (currentToken && currentToken !== expectedToken) return loadConnections();
    }
    const list = (await loadConnections()).filter((item) => item.id !== profile.id);
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
