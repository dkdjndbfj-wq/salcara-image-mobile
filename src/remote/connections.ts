import { sha256 } from '@noble/hashes/sha2.js';
import * as SecureStore from 'expo-secure-store';
import { getSetting, setSetting } from '../storage/database';
import { canonicalHubUrl } from './pairing';

/** Public metadata only; the actual per-station/device credential lives in the OS keychain. */
export interface RemoteConnection { id: string; hubUrl: string; deviceId: string; deviceName: string; pairedAt: number }
const INDEX = 'remote_device_connections_v1';
const SELECTED = 'remote_device_connection_v1';
const keyName = (id: string) => `remote-device-${id}`;
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
      && profile.id === connectionId(profile.hubUrl, profile.deviceId)
      && typeof profile.deviceName === 'string' && Boolean(profile.deviceName.trim()) && profile.deviceName.length <= 200 && !/[\u0000-\u001f]/.test(profile.deviceName)
      && typeof profile.pairedAt === 'number' && Number.isSafeInteger(profile.pairedAt) && profile.pairedAt >= 0;
  } catch { return false; }
}
export async function loadConnections(): Promise<RemoteConnection[]> {
  const raw = await getSetting(INDEX);
  try { const list: unknown = JSON.parse(raw || '[]'); return Array.isArray(list) ? list.filter(validConnection) : []; } catch { return []; }
}
export async function selectedConnection(): Promise<string | null> { return getSetting(SELECTED); }
export async function selectConnection(id: string | null): Promise<void> { await setSetting(SELECTED, id); }
export async function connectionToken(profile: RemoteConnection): Promise<string | null> {
  if (!validConnection(profile)) return null;
  const raw = await SecureStore.getItemAsync(keyName(profile.id));
  try {
    const entry = JSON.parse(raw || '{}');
    return entry.hubUrl === profile.hubUrl && entry.deviceId === profile.deviceId && typeof entry.token === 'string' && /^[a-f0-9]{64}$/.test(entry.token) ? entry.token : null;
  } catch { return null; }
}
export async function saveConnection(profile: RemoteConnection, token: string): Promise<RemoteConnection[]> {
  if (!validConnection(profile) || !/^[a-f0-9]{64}$/.test(token)) throw new Error('中转站返回的配对凭证无效');
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
}
export async function forgetConnection(profile: RemoteConnection): Promise<RemoteConnection[]> {
  const list = (await loadConnections()).filter((item) => item.id !== profile.id);
  await SecureStore.deleteItemAsync(keyName(profile.id));
  await setSetting(INDEX, JSON.stringify(list));
  if (await selectedConnection() === profile.id) await selectConnection(null);
  return list;
}
