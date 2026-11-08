import { sha256 } from '@noble/hashes/sha2.js';
import { getRandomBytesAsync } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

import {
  addListener,
  close as closeNative,
  connect as connectNative,
  send as sendNative,
  type DirectTransportState,
} from '../../modules/salcara-direct-transport';
import { phoneIdentity } from './phone-identity';

const MAX_QR_BYTES = 4096;
const MAX_ENDPOINTS = 8;
const AUTH_TIMEOUT_MS = 12_000;
const MAX_FRAME_BYTES = 256 * 1024;
const CREDENTIAL_PREFIX = 'salcara-direct-pair-v1-';
// Keep the index outside the per-device namespace; `index` is a valid desktop
// id and must never collide with the metadata record.
const CREDENTIAL_INDEX_KEY = 'salcara-direct-pair-index-v1';
const MAX_INDEXED_DEVICES = 64;

export interface DirectPairQr {
  mode: 'direct';
  urls: string[];
  token: string;
  deviceId: string;
  fingerprint: string;
  expiresAt: number;
  deviceName?: string;
}

export type DirectErrorCode = 'unsupported' | 'invalid_qr' | 'expired' | 'network' | 'certificate'
  | 'pairing_rejected' | 'protocol' | 'storage' | 'disconnected' | 'busy';

export class DirectConnectionError extends Error {
  constructor(readonly code: DirectErrorCode, message: string, readonly retryable = false, readonly tokenMayHaveBeenConsumed = false) {
    super(message);
    this.name = 'DirectConnectionError';
  }
}

export interface DirectConnectionState {
  status: 'idle' | 'connecting' | 'authenticating' | 'connected' | 'closed' | 'error';
  deviceId?: string;
  deviceName?: string;
  endpoint?: string;
  error?: string;
  errorCode?: DirectErrorCode;
}

/** Device management receives public pairing metadata, never the credential. */
export interface DirectPairingInfo {
  deviceId: string;
  deviceName?: string;
  endpoint: string;
  pairedAt: number;
}

export async function listDirectPairings(): Promise<DirectPairingInfo[]> {
  return mutate(async () => {
    const ids = indexedDeviceIds(await SecureStore.getItemAsync(CREDENTIAL_INDEX_KEY));
    const records = await Promise.all(ids.map(async deviceId => {
      const raw = await SecureStore.getItemAsync(credentialKey(deviceId));
      try {
        const value: unknown = JSON.parse(raw || 'null');
        return validCredential(value, deviceId)
          ? { deviceId, deviceName: value.deviceName, endpoint: value.urls[0], pairedAt: value.pairedAt }
          : null;
      } catch { return null; }
    }));
    return records.filter((record): record is NonNullable<typeof record> => record !== null);
  });
}

interface DirectCredential {
  version: 1;
  deviceId: string;
  deviceName?: string;
  phoneId: string;
  secret: string;
  fingerprint: string;
  urls: string[];
  pairedAt: number;
}

interface AuthResult { deviceId: string; deviceName?: string }
type Listener = { remove(): void };

const stateListeners = new Set<() => void>();
const messageListeners = new Set<(message: unknown) => void>();
let state: DirectConnectionState = { status: 'idle' };
let generation = 0;
let activeDeviceId: string | undefined;
let activeFingerprint: string | undefined;
let activeDeliveryScope = '';
let activeSubscriptions: Listener[] = [];
let cancelActiveAuthentication: (() => void) | undefined;
let pairingFlight: { key: string; promise: Promise<DirectConnectionState> } | null = null;
let reconnectFlight: { deviceId: string; promise: Promise<DirectConnectionState> } | null = null;
let restoreFlight: Promise<DirectConnectionState> | null = null;
let mutationTail: Promise<void> = Promise.resolve();

interface CredentialRollback {
  previousCredential: string | null;
  previousIndex: string | null;
  currentIndex: string;
}

function publish(next: DirectConnectionState): void {
  state = next;
  stateListeners.forEach(listener => { try { listener(); } catch { /* observers are decorative */ } });
}

export function getDirectConnectionState(): DirectConnectionState { return state; }

/** Stable binding identity for private drafts; a new socket still gets a new
 * generation below. Never expose the credential or use endpoint as identity. */
export function directDeliveryScope(): string { return activeDeliveryScope; }
export function directConnectionGeneration(): number { return generation; }

function credentialScope(record: DirectCredential): string {
  return `direct:${hex(sha256(new TextEncoder().encode(JSON.stringify([record.deviceId, record.fingerprint, record.phoneId, record.secret, record.pairedAt]))))}`;
}

export function subscribeDirectConnection(listener: () => void): () => void {
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
}

export function subscribeDirectMessages(listener: (message: unknown) => void): () => void {
  messageListeners.add(listener);
  return () => messageListeners.delete(listener);
}

function credentialKey(deviceId: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(deviceId)) throw new DirectConnectionError('invalid_qr', '直连电脑标识无效');
  return `${CREDENTIAL_PREFIX}${deviceId}`;
}

function indexedDeviceIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter((item): item is string => typeof item === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(item)))].slice(0, MAX_INDEXED_DEVICES);
  } catch { return []; }
}

function withIndexedDevice(ids: string[], deviceId: string): string[] {
  if (!ids.includes(deviceId) && ids.length >= MAX_INDEXED_DEVICES) throw new DirectConnectionError('storage', '已保存的直连电脑过多，请先解除一台电脑绑定');
  return [deviceId, ...ids.filter(id => id !== deviceId)];
}

function mutate<T>(task: () => Promise<T>): Promise<T> {
  const run = mutationTail.then(task, task);
  mutationTail = run.then(() => undefined, () => undefined);
  return run;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function validEndpoint(raw: unknown, fingerprint: string): raw is string {
  if (typeof raw !== 'string' || raw.length > 512) return false;
  try {
    const url = new URL(raw);
    return url.protocol === 'wss:' && Boolean(url.hostname) && !url.username && !url.password
      && url.pathname === '/direct/ws' && !url.search && !url.hash
      && localOrVpnHost(url.hostname) && /^[a-f0-9]{64}$/.test(fingerprint);
  } catch { return false; }
}

/** Direct pairing accepts only the local/VPN address families advertised by
 * Bridge. This is a LAN/VPN route, not a public-host NAT traversal protocol. */
function localOrVpnHost(raw: string): boolean {
  const host = raw.toLowerCase().replace(/^\[|\]$/g, '');
  const octets = host.split('.');
  if (octets.length === 4 && octets.every(part => /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255)) {
    const [a, b] = octets.map(Number);
    return a === 10 || a === 192 && b === 168 || a === 172 && b >= 16 && b <= 31
      || a === 100 && b >= 64 && b <= 127;
  }
  // IPv6 unique-local unicast only. Loopback, link-local, multicast,
  // unspecified and globally routable addresses are intentionally excluded.
  return /^f[cd][0-9a-f]{2}:/i.test(host);
}

/** Validate the direct-mode payload locally. It can never be reinterpreted as a Hub QR. */
export function parseDirectPairQr(raw: string, now = Date.now()): DirectPairQr {
  if (typeof raw !== 'string' || raw.length > MAX_QR_BYTES) throw new DirectConnectionError('invalid_qr', '直连二维码内容无效');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new DirectConnectionError('invalid_qr', '这不是支持的 Salcara 直连二维码'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DirectConnectionError('invalid_qr', '直连二维码内容无效');
  const qr = value as Partial<DirectPairQr>;
  if (qr.mode !== 'direct') throw new DirectConnectionError('invalid_qr', '这不是 Salcara 电脑直连二维码');
  if (!Array.isArray(qr.urls) || qr.urls.length < 1 || qr.urls.length > MAX_ENDPOINTS
    || typeof qr.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(qr.fingerprint)
    || !qr.urls.every(url => validEndpoint(url, qr.fingerprint!))) {
    throw new DirectConnectionError('invalid_qr', '直连地址或电脑证书指纹无效');
  }
  const urls = [...new Set(qr.urls)];
  if (!urls.length || urls.length !== qr.urls.length) throw new DirectConnectionError('invalid_qr', '直连二维码包含重复地址');
  if (typeof qr.deviceId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(qr.deviceId)) {
    throw new DirectConnectionError('invalid_qr', '直连电脑标识无效');
  }
  if (typeof qr.token !== 'string' || !/^[a-f0-9]{32}$/.test(qr.token)) {
    throw new DirectConnectionError('invalid_qr', '直连配对码无效');
  }
  if (typeof qr.expiresAt !== 'number' || !Number.isSafeInteger(qr.expiresAt) || qr.expiresAt <= now) {
    throw new DirectConnectionError('expired', '直连配对码已过期，请在电脑上重新生成');
  }
  // The Bridge issues five-minute tokens. A far-future timestamp can indicate
  // a malformed payload; allow a few seconds for QR display and clock skew.
  if (qr.expiresAt > now + 5 * 60_000 + 10_000) throw new DirectConnectionError('invalid_qr', '直连配对码有效期异常');
  if (qr.deviceName !== undefined && (typeof qr.deviceName !== 'string' || !qr.deviceName.trim()
    || qr.deviceName.length > 200 || /[\u0000-\u001f]/.test(qr.deviceName))) {
    throw new DirectConnectionError('invalid_qr', '直连电脑名称无效');
  }
  return { mode: 'direct', urls, token: qr.token, deviceId: qr.deviceId, fingerprint: qr.fingerprint,
    expiresAt: qr.expiresAt, ...(qr.deviceName ? { deviceName: qr.deviceName } : {}) };
}

export function isDirectPairQr(raw: string): boolean {
  if (typeof raw !== 'string' || raw.length > MAX_QR_BYTES) return false;
  try {
    const value = JSON.parse(raw) as { mode?: unknown };
    return Boolean(value && typeof value === 'object' && !Array.isArray(value) && value.mode === 'direct');
  } catch { return false; }
}

function validCredential(value: unknown, deviceId: string): value is DirectCredential {
  if (!value || typeof value !== 'object') return false;
  const row = value as DirectCredential;
  return row.version === 1 && row.deviceId === deviceId
    && /^[A-Za-z0-9._-]{1,128}$/.test(row.deviceId)
    && /^[a-f0-9]{64}$/.test(row.phoneId) && /^[a-f0-9]{64}$/.test(row.secret)
    && /^[a-f0-9]{64}$/.test(row.fingerprint)
    && Array.isArray(row.urls) && row.urls.length > 0 && row.urls.length <= MAX_ENDPOINTS
    && row.urls.every(url => validEndpoint(url, row.fingerprint))
    && (row.deviceName === undefined || typeof row.deviceName === 'string' && row.deviceName.length <= 200)
    && Number.isSafeInteger(row.pairedAt) && row.pairedAt > 0;
}

async function readCredential(deviceId: string): Promise<DirectCredential | null> {
  return mutate(async () => {
    const raw = await SecureStore.getItemAsync(credentialKey(deviceId));
    if (!raw) return null;
    try {
      const value: unknown = JSON.parse(raw);
      return validCredential(value, deviceId) ? value : null;
    } catch { return null; }
  });
}

async function restoreIfCurrent(key: string, expected: string, previous: string | null): Promise<void> {
  const current = await SecureStore.getItemAsync(key);
  if (current !== expected) return;
  if (previous === null) await SecureStore.deleteItemAsync(key);
  else await SecureStore.setItemAsync(key, previous, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
}

async function saveCredential(record: DirectCredential, ownerGeneration?: number): Promise<CredentialRollback> {
  const key = credentialKey(record.deviceId);
  const serialized = JSON.stringify(record);
  return mutate(async () => {
    if (ownerGeneration !== undefined && ownerGeneration !== generation) throw new DirectConnectionError('disconnected', '直连选择已改变');
    const previous = await SecureStore.getItemAsync(key);
    const previousIndex = await SecureStore.getItemAsync(CREDENTIAL_INDEX_KEY);
    const currentIndex = JSON.stringify(withIndexedDevice(indexedDeviceIds(previousIndex), record.deviceId));
    if (ownerGeneration !== undefined && ownerGeneration !== generation) throw new DirectConnectionError('disconnected', '直连选择已改变');
    try {
      await SecureStore.setItemAsync(key, serialized, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
      await SecureStore.setItemAsync(CREDENTIAL_INDEX_KEY, currentIndex, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
    } catch (error) {
      try { await restoreIfCurrent(key, serialized, previous); } catch { /* retain the original storage error */ }
      try { await restoreIfCurrent(CREDENTIAL_INDEX_KEY, currentIndex, previousIndex); } catch { /* retain the original storage error */ }
      throw error;
    }
    if (ownerGeneration !== undefined && ownerGeneration !== generation) {
      await restoreIfCurrent(key, serialized, previous);
      await restoreIfCurrent(CREDENTIAL_INDEX_KEY, currentIndex, previousIndex);
      throw new DirectConnectionError('disconnected', '直连选择已改变');
    }
    return { previousCredential: previous, previousIndex, currentIndex };
  });
}

async function restorePreviousCredential(record: DirectCredential, previous: CredentialRollback): Promise<void> {
  const key = credentialKey(record.deviceId);
  const serialized = JSON.stringify(record);
  await mutate(async () => {
    await restoreIfCurrent(key, serialized, previous.previousCredential);
    await restoreIfCurrent(CREDENTIAL_INDEX_KEY, previous.currentIndex, previous.previousIndex);
  });
}

function removeSubscriptions(): void {
  const subscriptions = activeSubscriptions;
  activeSubscriptions = [];
  subscriptions.forEach(subscription => { try { subscription.remove(); } catch { /* already removed */ } });
}

function closeCurrentNative(): void {
  const cancel = cancelActiveAuthentication;
  cancelActiveAuthentication = undefined;
  cancel?.();
  removeSubscriptions();
  try { closeNative(); } catch { /* unsupported platform or already closed */ }
  activeDeviceId = undefined;
  activeFingerprint = undefined;
}

function mapServerError(message: string): DirectConnectionError {
  if (/证书|指纹|hostname|主机名/i.test(message)) return new DirectConnectionError('certificate', '电脑证书校验失败，直连已停止');
  if (/未配对|不匹配|配对码|过期|ticket.{0,24}(invalid|expired|used)|(?:invalid|expired|used).{0,24}ticket|unauthori[sz]ed|forbidden|pairing.{0,24}(reject|invalid|expired)/i.test(message)) {
    return new DirectConnectionError('pairing_rejected', message.slice(0, 180) || '电脑拒绝了直连配对');
  }
  return new DirectConnectionError('protocol', message.slice(0, 180) || '电脑返回了无法识别的直连错误');
}

function mapNativeError(message: string): DirectConnectionError {
  if (/不支持/i.test(message)) return new DirectConnectionError('unsupported', message);
  if (/证书|指纹|hostname|主机名/i.test(message)) return new DirectConnectionError('certificate', message || '电脑证书校验失败，直连已停止');
  return new DirectConnectionError('network', message || '电脑直连不可用', true);
}

function parseEnvelope(raw: string): Record<string, unknown> {
  if (new TextEncoder().encode(raw).byteLength > MAX_FRAME_BYTES) throw new DirectConnectionError('protocol', '直连消息超出大小限制');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new DirectConnectionError('protocol', '直连收到无效消息'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof (value as { type?: unknown }).type !== 'string') {
    throw new DirectConnectionError('protocol', '直连收到无效消息');
  }
  return value as Record<string, unknown>;
}

function authenticateEndpoint(
  endpoint: string,
  fingerprint: string,
  auth: { token?: string; phoneId: string; phoneHash: string; deviceId: string },
  ownerGeneration: number,
): Promise<AuthResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let authenticated = false;
    let authSent = false;
    let candidateError: DirectConnectionError | null = null;
    let timer: ReturnType<typeof setTimeout>;
    const subscriptions: Listener[] = [];
    const cleanup = () => {
      clearTimeout(timer);
      subscriptions.forEach(subscription => { try { subscription.remove(); } catch { /* already removed */ } });
      if (activeSubscriptions === subscriptions) activeSubscriptions = [];
      if (cancelActiveAuthentication === cancel) cancelActiveAuthentication = undefined;
    };
    const fail = (error: DirectConnectionError, retryable = error.retryable,
      tokenMayHaveBeenConsumed = error.tokenMayHaveBeenConsumed || Boolean(auth.token && authSent && error.code !== 'pairing_rejected')) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new DirectConnectionError(error.code, error.message, retryable, tokenMayHaveBeenConsumed));
    };
    const finish = (result: AuthResult) => {
      if (settled) return;
      settled = true;
      authenticated = true;
      clearTimeout(timer);
      if (cancelActiveAuthentication === cancel) cancelActiveAuthentication = undefined;
      activeSubscriptions = subscriptions;
      resolve(result);
    };
    const onState = ({ state: nativeState }: { state: DirectTransportState }) => {
      if (ownerGeneration !== generation) return;
      if (nativeState === 'connecting') publish({ status: 'connecting', deviceId: auth.deviceId, endpoint });
      if (nativeState === 'open' && !authSent) {
        authSent = true;
        publish({ status: 'authenticating', deviceId: auth.deviceId, endpoint });
        try {
          const payload = { type: 'auth', ...(auth.token ? { token: auth.token } : {}), phoneId: auth.phoneId, phoneHash: auth.phoneHash };
          sendNative(JSON.stringify(payload));
        } catch (reason) {
          fail(mapNativeError(reason instanceof Error ? reason.message : '直连认证消息发送失败'), false);
        }
      }
      if (nativeState === 'closed' && !authenticated) {
        const retryable = (candidateError?.retryable ?? true) && (!authSent || !auth.token);
        fail(candidateError ?? new DirectConnectionError('network', '电脑直连不可用', retryable), retryable);
      } else if (nativeState === 'closed' && authenticated && ownerGeneration === generation) {
        removeSubscriptions();
        generation += 1;
        publish(candidateError
          ? { status: 'error', deviceId: auth.deviceId, endpoint, error: candidateError.message, errorCode: candidateError.code }
          : { status: 'closed', deviceId: auth.deviceId, endpoint });
      }
    };
    const onMessage = ({ text }: { text: string }) => {
      if (ownerGeneration !== generation) return;
      let envelope: Record<string, unknown>;
      try { envelope = parseEnvelope(text); }
      catch (error) { fail(error instanceof DirectConnectionError ? error : new DirectConnectionError('protocol', '直连收到无效消息'), false); return; }
      if (authenticated) {
        messageListeners.forEach(listener => { try { listener(envelope); } catch { /* consumers are isolated */ } });
        return;
      }
      if (envelope.type === 'error') {
        const message = typeof envelope.error === 'string' ? envelope.error : '电脑拒绝了直连配对';
        fail(mapServerError(message), false);
        return;
      }
      if (envelope.type !== 'auth_ok' || envelope.deviceId !== auth.deviceId) {
        fail(new DirectConnectionError('protocol', '电脑直连身份响应无效'), false);
        return;
      }
      const name = typeof envelope.name === 'string' && envelope.name.trim().length <= 200 ? envelope.name.trim() : undefined;
      finish({ deviceId: auth.deviceId, ...(name ? { deviceName: name } : {}) });
    };
    const onError = ({ message }: { message: string }) => {
      if (ownerGeneration !== generation) return;
      candidateError = mapNativeError(message);
      if (authenticated) {
        const errorState = { status: 'error' as const, deviceId: auth.deviceId, endpoint,
          error: candidateError.message, errorCode: candidateError.code };
        generation += 1;
        closeCurrentNative();
        publish(errorState);
      } else {
        fail(candidateError, candidateError.retryable && (!authSent || !auth.token));
      }
    };

    const cancel = () => fail(new DirectConnectionError('disconnected', '直连已取消'));

    try {
      cancelActiveAuthentication = cancel;
      subscriptions.push(addListener('onState', onState), addListener('onMessage', onMessage), addListener('onError', onError));
      timer = setTimeout(() => fail(new DirectConnectionError('network', '电脑直连超时', !authSent), !authSent), AUTH_TIMEOUT_MS);
      activeSubscriptions = subscriptions;
      connectNative(endpoint, fingerprint);
    } catch (reason) {
      fail(mapNativeError(reason instanceof Error ? reason.message : '电脑直连无法启动'), false);
    }
  });
}

async function connectCredential(record: DirectCredential, token?: string, ownerGeneration = ++generation, tokenExpiresAt?: number): Promise<DirectConnectionState> {
  closeCurrentNative();
  activeDeviceId = record.deviceId;
  activeFingerprint = record.fingerprint;
  activeDeliveryScope = credentialScope(record);
  publish({ status: 'connecting', deviceId: record.deviceId, deviceName: record.deviceName, endpoint: record.urls[0] });
  const phoneHash = hex(sha256(new TextEncoder().encode(record.secret)));
  let lastError = new DirectConnectionError('network', '电脑直连不可用', true);
  for (const endpoint of record.urls) {
    if (ownerGeneration !== generation) throw new DirectConnectionError('disconnected', '直连选择已改变');
    if (token && tokenExpiresAt !== undefined && tokenExpiresAt <= Date.now()) throw new DirectConnectionError('expired', '直连配对码已过期，请在电脑上重新生成');
    try {
      const result = await authenticateEndpoint(endpoint, record.fingerprint, {
        ...(token ? { token } : {}), phoneId: record.phoneId, phoneHash, deviceId: record.deviceId,
      }, ownerGeneration);
      if (ownerGeneration !== generation) throw new DirectConnectionError('disconnected', '直连选择已改变', false, Boolean(token));
      // The long-lived binding was safely stored before the one-time token was
      // sent. Avoid a second keychain write after desktop acceptance: a local
      // storage hiccup here must not turn a successful pair into an orphan.
      publish({ status: 'connected', deviceId: record.deviceId, deviceName: result.deviceName ?? record.deviceName, endpoint });
      return state;
    } catch (reason) {
      const error = reason instanceof DirectConnectionError ? reason : mapNativeError(reason instanceof Error ? reason.message : '电脑直连失败');
      lastError = error;
      if (!error.retryable) break;
      try { closeNative(); } catch { /* candidate already closed */ }
    }
  }
  if (ownerGeneration === generation) {
    closeCurrentNative();
    publish({ status: 'error', deviceId: record.deviceId, deviceName: record.deviceName, error: lastError.message, errorCode: lastError.code });
  }
  throw lastError;
}

/** Authenticate over the QR's pinned WSS endpoint. This function never calls a Hub API. */
export function pairDirectQr(input: DirectPairQr): Promise<DirectConnectionState> {
  const qr = parseDirectPairQr(JSON.stringify(input));
  const key = `${qr.deviceId}\u0000${qr.token}`;
  if (pairingFlight?.key === key) return pairingFlight.promise;
  if (state.status === 'connected' && activeDeviceId === qr.deviceId && activeFingerprint === qr.fingerprint) return Promise.resolve(state);
  const ownerGeneration = ++generation;
  closeCurrentNative();
  publish({ status: 'connecting', deviceId: qr.deviceId, deviceName: qr.deviceName, endpoint: qr.urls[0] });
  const promise = (async () => {
    try {
      const phoneId = await phoneIdentity();
      const random = await getRandomBytesAsync(32);
      if (ownerGeneration !== generation) throw new DirectConnectionError('disconnected', '直连选择已改变');
      if (qr.expiresAt <= Date.now()) throw new DirectConnectionError('expired', '直连配对码已过期，请在电脑上重新生成');
      if (!(random instanceof Uint8Array) || random.length !== 32) throw new DirectConnectionError('storage', '无法创建安全直连凭据');
      const record: DirectCredential = { version: 1, deviceId: qr.deviceId, deviceName: qr.deviceName,
        phoneId, secret: hex(random), fingerprint: qr.fingerprint, urls: qr.urls, pairedAt: Date.now() };
      // Persist the recoverable binding before sending the one-time QR token.
      // If the desktop accepts the token but the reply is lost, reconnect can
      // authenticate with the same phone hash instead of requiring manual revoke.
      const previous = await saveCredential(record, ownerGeneration);
      try {
        return await connectCredential(record, qr.token, ownerGeneration, qr.expiresAt);
      } catch (error) {
        const mapped = error instanceof DirectConnectionError ? error : mapNativeError(error instanceof Error ? error.message : '电脑直连失败');
        if (!mapped.tokenMayHaveBeenConsumed) {
          try { await restorePreviousCredential(record, previous); }
          catch { throw new DirectConnectionError('storage', '无法恢复之前保存的直连配对'); }
        }
        throw mapped;
      }
    } catch (reason) {
      const error = reason instanceof DirectConnectionError ? reason
        : new DirectConnectionError('storage', reason instanceof Error ? reason.message : '无法保存直连凭据');
      if (ownerGeneration === generation && state.status !== 'error') publish({ status: 'error', deviceId: qr.deviceId, deviceName: qr.deviceName, error: error.message, errorCode: error.code });
      throw error;
    }
  })();
  pairingFlight = { key, promise };
  void promise.finally(() => { if (pairingFlight?.promise === promise) pairingFlight = null; }).catch(() => undefined);
  return promise;
}

/** Reconnect only to the stored direct WSS URLs; failure never selects a Hub. */
export async function reconnectDirect(deviceId: string): Promise<DirectConnectionState> {
  if (reconnectFlight?.deviceId === deviceId) return reconnectFlight.promise;
  if (reconnectFlight) {
    generation += 1;
    closeCurrentNative();
  }
  const ownerGeneration = ++generation;
  closeCurrentNative();
  publish({ status: 'connecting', deviceId });
  const promise = (async () => {
    let record: DirectCredential | null;
    try { record = await readCredential(deviceId); }
    catch (error) {
      const mapped = new DirectConnectionError('storage', error instanceof Error ? error.message : '读取直连凭据失败');
      if (ownerGeneration === generation) publish({ status: 'error', deviceId, error: mapped.message, errorCode: mapped.code });
      throw mapped;
    }
    if (ownerGeneration !== generation) throw new DirectConnectionError('disconnected', '直连选择已改变');
    if (!record) {
      const error = new DirectConnectionError('pairing_rejected', '没有这台电脑的直连凭据，请重新扫描二维码');
      if (ownerGeneration === generation) publish({ status: 'error', deviceId, error: error.message, errorCode: error.code });
      throw error;
    }
    try { return await connectCredential(record, undefined, ownerGeneration); }
    catch (error) {
      const mapped = error instanceof DirectConnectionError ? error : mapNativeError(error instanceof Error ? error.message : '电脑直连失败');
      if (mapped.code === 'pairing_rejected') await forgetDirectPairing(deviceId);
      throw mapped;
    }
  })();
  reconnectFlight = { deviceId, promise };
  void promise.finally(() => { if (reconnectFlight?.promise === promise) reconnectFlight = null; }).catch(() => undefined);
  return promise;
}

/** Restore only the remembered peer identity after a cold app start. This does
 * not open a socket or contact a network; the user must explicitly reconnect. */
export async function restoreDirectPairing(): Promise<DirectConnectionState> {
  if (restoreFlight) return restoreFlight;
  const ownerGeneration = generation;
  const promise = (async () => {
    const ids = await mutate(async () => indexedDeviceIds(await SecureStore.getItemAsync(CREDENTIAL_INDEX_KEY)));
    for (const deviceId of ids) {
      if (ownerGeneration !== generation) throw new DirectConnectionError('disconnected', '直连选择已改变');
      const record = await readCredential(deviceId);
      if (!record) continue;
      if (ownerGeneration !== generation || state.status === 'connected' || state.status === 'connecting' || state.status === 'authenticating') return state;
      activeDeviceId = deviceId;
      activeFingerprint = record.fingerprint;
      activeDeliveryScope = credentialScope(record);
      const next = { status: 'closed' as const, deviceId, deviceName: record.deviceName, endpoint: record.urls[0] };
      publish(next);
      return next;
    }
    return state;
  })();
  restoreFlight = promise;
  void promise.finally(() => { if (restoreFlight === promise) restoreFlight = null; }).catch(() => undefined);
  return promise;
}

/** Sends a protocol frame on the authenticated direct socket; it has no Hub fallback. */
export function sendDirectPayload(payload: unknown): void {
  if (state.status !== 'connected') throw new DirectConnectionError('disconnected', '电脑直连尚未就绪');
  let text: string;
  try { text = JSON.stringify(payload); } catch { throw new DirectConnectionError('protocol', '直连消息无法编码'); }
  if (!text || new TextEncoder().encode(text).byteLength > MAX_FRAME_BYTES) throw new DirectConnectionError('protocol', '直连消息超出大小限制');
  try { sendNative(text); } catch (error) { throw mapNativeError(error instanceof Error ? error.message : '直连发送失败'); }
}

/** Close the local socket but retain the independently stored direct credential. */
export function disconnectDirect(): void {
  const peer = {
    ...(state.deviceId || activeDeviceId ? { deviceId: state.deviceId ?? activeDeviceId } : {}),
    ...(state.deviceName ? { deviceName: state.deviceName } : {}),
    ...(state.endpoint ? { endpoint: state.endpoint } : {}),
  };
  generation += 1;
  closeCurrentNative();
  publish({ status: 'closed', ...peer });
}

/** Forget this phone's direct credential. The desktop can still revoke its side independently. */
export async function forgetDirectPairing(deviceId: string): Promise<void> {
  const key = credentialKey(deviceId);
  let removedScope='';
  if (activeDeviceId === deviceId || state.deviceId === deviceId) disconnectDirect();
  await mutate(async () => {
    const previousCredential = await SecureStore.getItemAsync(key);
    if(previousCredential){try{const previous:unknown=JSON.parse(previousCredential);if(validCredential(previous,deviceId))removedScope=credentialScope(previous);}catch{/* An invalid credential has no proven draft scope. */}}
    const previousIndex = await SecureStore.getItemAsync(CREDENTIAL_INDEX_KEY);
    const next = indexedDeviceIds(previousIndex).filter(id => id !== deviceId);
    const nextIndex = next.length ? JSON.stringify(next) : null;
    try {
      await SecureStore.deleteItemAsync(key);
      if (nextIndex) await SecureStore.setItemAsync(CREDENTIAL_INDEX_KEY, nextIndex, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
      else await SecureStore.deleteItemAsync(CREDENTIAL_INDEX_KEY);
    } catch (error) {
      // Keep the credential/index pair recoverable if either keychain write
      // fails. All writes are serialized through `mutate`, so this rollback
      // cannot overwrite another direct-pairing operation.
      try {
        const currentCredential = await SecureStore.getItemAsync(key);
        if (currentCredential === null && previousCredential !== null) await SecureStore.setItemAsync(key, previousCredential, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
        const currentIndex = await SecureStore.getItemAsync(CREDENTIAL_INDEX_KEY);
        const expectedIndex = nextIndex;
        if (currentIndex === expectedIndex) {
          if (previousIndex === null) await SecureStore.deleteItemAsync(CREDENTIAL_INDEX_KEY);
          else await SecureStore.setItemAsync(CREDENTIAL_INDEX_KEY, previousIndex, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
        }
      } catch { /* retain the original storage error */ }
      throw error;
    }
  });
  if ((activeDeviceId === deviceId || state.deviceId === deviceId)&&(!removedScope||activeDeliveryScope===removedScope)) {
    activeDeviceId = undefined;
    activeFingerprint = undefined;
    activeDeliveryScope = '';
    publish({ status: 'idle' });
  }
  if(removedScope){
    const cleanup = await Promise.allSettled([
      (require('./drafts') as typeof import('./drafts')).clearRemoteQueuedScope(removedScope),
      (require('./direct-message-queue') as typeof import('./direct-message-queue')).clearDirectMessageQueueScope(removedScope),
      (require('./direct-pending-operation') as typeof import('./direct-pending-operation')).clearDirectPendingOperationScope(removedScope),
      (require('./direct-api-selection') as typeof import('./direct-api-selection')).clearDirectApiSelectionScope(removedScope),
    ]);
    if(cleanup.some(result => result.status === 'rejected'))throw new Error('电脑已解除绑定，但本地草稿清理失败；已删除的绑定不会恢复');
  }
}

/** Test-only reset; production callers should use disconnectDirect(). */
export function resetDirectPairingForTests(): void {
  generation += 1;
  activeDeliveryScope = '';
  closeCurrentNative();
  pairingFlight = null;
  reconnectFlight = null;
  restoreFlight = null;
  mutationTail = Promise.resolve();
  publish({ status: 'idle' });
  messageListeners.clear();
  stateListeners.clear();
}
