import { getRandomBytesAsync, randomUUID } from 'expo-crypto';
import {
  bindBotPhone, botBindingEndpoint, botGroupDevices, HubError, isBotStationCurrent, parseBotBindingPackage,
  revokeBotPhone, verifyBotBindingStation, type BotBindingPackage, type BotBindingPin, type DeviceStatus, type Hub, type VerifiedBotStation,
} from './client';
import {
  beginBotGroupRevocation, botBindingFingerprint, botConnectionId, botGroupId,
  commitBotGroupMembers, completeBotGroupRevocation, confirmLegacyBotGroupPin, getBotGroup, invalidateBotGroup,
  loadConnections, prepareBotGroup, type BotGroupRecord, type BotGroupState, type RemoteConnection,
} from './connections';
import { phoneIdentity } from './phone-identity';

export interface BotGroupResult { group: BotGroupState; profiles: RemoteConnection[]; devices: DeviceStatus[] }
export interface BotGroupImportOptions { onRetired?: (record: BotGroupRecord) => void | Promise<void> }
export interface LegacyBotIdentityPreview {
  id: string; generation: string; hubUrl: string; groupId: string; pin: BotBindingPin; target: VerifiedBotStation;
}
export interface BotGroupRevokeOptions {
  expectedGeneration?: string;
  onRevoking?: (record: BotGroupRecord) => void | Promise<void>;
  beforeComplete?: (record: BotGroupRecord) => void | Promise<void>;
}

// Route lifetime and binding lifetime are separate. A closed import page must
// still retain a successful bind, but a newer group read must win over an old
// membership response, even when both use the same token.
const reads = new Map<string, number>();
function nextRead(id: string): () => boolean {
  const revision = (reads.get(id) ?? 0) + 1;
  reads.set(id, revision);
  return () => reads.get(id) === revision;
}
function changed(): HubError { return new HubError('Bot 绑定已变更，请刷新后重试', 409, 'bot_binding_changed'); }
function pinnedHub(record: BotGroupRecord): Hub {
  if (!record.pin) throw new HubError('此 Bot 绑定缺少已确认的服务身份，已保留凭据并暂停连接，请联系管理员确认原组', 409, 'bot_identity_unavailable');
  return { url: record.hubUrl, botToken: record.token, botPin: { ...record.pin } };
}
function credentialsInvalid(error: unknown): error is HubError {
  return error instanceof HubError && error.status === 403 && error.code === 'bot_credentials_invalid';
}
function publicGroup(record: BotGroupRecord): BotGroupState {
  const { id, hubUrl, groupId, generation, status, pairedAt, fingerprint, pin } = record;
  return { id, hubUrl, groupId, generation, status, pairedAt, ...(fingerprint ? { fingerprint } : {}), ...(pin ? { pin: { ...pin } } : {}) };
}
function sameRecord(current: BotGroupRecord | null, expected: BotGroupRecord): current is BotGroupRecord {
  return Boolean(current && current.id === expected.id && current.generation === expected.generation
    && current.token === expected.token && current.status === expected.status);
}
async function currentRecord(expected: BotGroupRecord): Promise<BotGroupRecord> {
  const current = await getBotGroup(expected.id);
  if (!sameRecord(current, expected)) throw changed();
  return current;
}
async function usableRecord(id: string): Promise<BotGroupRecord> {
  const record = await getBotGroup(id);
  if (!record || record.status === 'revoked') throw new HubError('此 Bot 手机绑定已失效，请让管理员重置原组并提供新绑定包', 409, 'bot_binding_revoked');
  if (record.status === 'revoking') throw new HubError('Bot 撤销尚未确认，请先重试撤销', 409, 'bot_revoke_unconfirmed');
  if (!record.token) throw new HubError('Bot 安全凭据无法读取，请重试', 409, 'bot_binding_unavailable');
  pinnedHub(record);
  return record;
}
async function persistMembers(record: BotGroupRecord, devices: DeviceStatus[], stillCurrent: () => boolean): Promise<BotGroupResult> {
  const profiles: RemoteConnection[] = devices.map(device => ({
    id: botConnectionId(record.hubUrl, device.deviceId, record.groupId), hubUrl: record.hubUrl,
    deviceId: device.deviceId, deviceName: device.name, pairedAt: record.pairedAt,
    botGroupId: record.groupId, botGeneration: record.generation,
    ...(device.computerId ? { computerId: device.computerId } : {}),
  }));
  if (!stillCurrent() || !await commitBotGroupMembers(record, profiles, stillCurrent)) throw changed();
  const saved = await getBotGroup(record.id);
  if (!saved || saved.generation !== record.generation || saved.token !== record.token || saved.status !== 'active' || !stillCurrent()) throw changed();
  const connections = (await loadConnections()).filter(item => item.hubUrl === record.hubUrl && item.botGroupId === record.groupId && item.botGeneration === record.generation);
  if (!stillCurrent()) throw changed();
  return { group: publicGroup(saved), profiles: connections, devices };
}

/** Refreshing a pending record only observes: it never consumes an invite. */
export async function refreshBotGroup(id: string, stillCurrent: () => boolean = () => true): Promise<BotGroupResult> {
  const record = await usableRecord(id);
  const latest = nextRead(id), wanted = () => latest() && stillCurrent();
  const target = await verifyBotBindingStation(record.hubUrl, record.pin, false);
  await currentRecord(record);
  if (!wanted()) throw changed();
  let devices: DeviceStatus[];
  try {
    devices = await botGroupDevices(pinnedHub(record), target, () => { if (!wanted()) throw changed(); });
  } catch (error) {
    if (error instanceof HubError && error.status === 503 && error.code === 'bot_phone_revoke_pending' && wanted()) {
      await beginBotGroupRevocation(record);
    }
    if (credentialsInvalid(error) && record.status === 'active' && wanted()) {
      // A generic 403, a proxy error, or a failed proof is not revocation.
      await verifyBotBindingStation(record.hubUrl, record.pin, false);
      if (wanted()) await invalidateBotGroup(record.id, record.token!, record.generation);
    }
    throw error;
  }
  return persistMembers(record, devices, wanted);
}

/** The user retries the exact durable attempt; no error creates a new one. */
export async function retryBotGroupBinding(id: string): Promise<BotGroupResult> {
  const record = await usableRecord(id);
  if (record.status === 'active') return refreshBotGroup(id);
  if (!record.binding || !record.pin || !record.attemptId || !record.phoneId || !record.token) {
    throw new HubError('Bot 恢复信息不完整，请重新导入原绑定包', 409, 'bot_binding_unavailable');
  }
  const latest = nextRead(id);
  const target = await verifyBotBindingStation(record.hubUrl, record.pin);
  await currentRecord(record);
  if (!latest()) throw changed();
  // A successful first POST may have lost its response. This read recovers it
  // without reusing a consumed invite or generating another credential.
  try {
    const devices = await botGroupDevices(pinnedHub(record), target, () => { if (!latest()) throw changed(); });
    return await persistMembers(record, devices, latest);
  } catch (error) {
    if (!credentialsInvalid(error)) throw error;
  }
  const verified = await verifyBotBindingStation(record.hubUrl, record.pin);
  await currentRecord(record);
  if (!latest()) throw changed();
  try {
    const result = await bindBotPhone(record.binding, record.phoneId, { attemptId: record.attemptId, phoneToken: record.token }, verified.endpoint,
      { stillCurrent: async () => latest() && sameRecord(await getBotGroup(record.id), record), pin: record.pin });
    return await persistMembers(record, result.devices, latest);
  } catch (error) {
    if (credentialsInvalid(error) && latest()) {
      await verifyBotBindingStation(record.hubUrl, record.pin, false);
      if (latest()) await invalidateBotGroup(record.id, record.token, record.generation);
    }
    throw error;
  }
}

/** No secret-bearing request is allowed until the complete attempt is durable. */
export async function importBotBinding(input: BotBindingPackage, options: BotGroupImportOptions = {}): Promise<BotGroupResult> {
  const binding = parseBotBindingPackage(JSON.stringify(input));
  const hubUrl = botBindingEndpoint(binding), id = botGroupId(hubUrl, binding.groupId);
  const fingerprint = botBindingFingerprint(binding);
  const previous = await getBotGroup(id);
  if (previous?.fingerprint === fingerprint) {
    if (previous.status === 'revoked') throw new HubError('旧绑定包已失效，请让管理员重置原组并提供新绑定包', 409, 'bot_binding_revoked');
    return retryBotGroupBinding(id);
  }
  if (previous?.status === 'revoking') throw new HubError('Bot 撤销尚未确认，请先重试撤销', 409, 'bot_revoke_unconfirmed');
  if (previous?.status === 'active') {
    try {
      // Importing another JSON is not permission to replace a working token.
      // An administrator reset is established from authenticated facts first.
      return await refreshBotGroup(id);
    } catch (error) {
      if (!credentialsInvalid(error) || (await getBotGroup(id))?.status !== 'revoked') throw error;
    }
  }
  if (previous && (await getBotGroup(id))?.status === 'revoked') await options.onRetired?.(previous);
  const { pin } = await verifyBotBindingStation(hubUrl, previous?.pin);
  const identity = await phoneIdentity();
  const bytes = await getRandomBytesAsync(32);
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) throw new Error('无法创建安全 Bot 手机凭据');
  const token = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  const attemptId = randomUUID();
  const record = await prepareBotGroup({
    id, hubUrl, groupId: binding.groupId, generation: attemptId, status: 'pending',
    pairedAt: Date.now(), fingerprint, pin, token, attemptId, phoneId: identity, binding,
  });
  return retryBotGroupBinding(record.id);
}

async function legacyRecord(id: string): Promise<BotGroupRecord> {
  const record = await getBotGroup(id);
  if (!record || record.status !== 'active' || !record.token || record.pin) throw changed();
  return record;
}

/** Anonymous only. The complete identity is compared with the administrator's page. */
export async function previewLegacyBotIdentity(id: string): Promise<LegacyBotIdentityPreview> {
  const record = await legacyRecord(id);
  const target = await verifyBotBindingStation(record.hubUrl, undefined, false);
  const current = await currentRecord(record);
  if (current.pin || !isBotStationCurrent(record.hubUrl, target)) throw changed();
  return { id: record.id, generation: record.generation, hubUrl: record.hubUrl, groupId: record.groupId,
    pin: { ...target.pin }, target: { endpoint: target.endpoint, pin: { ...target.pin } } };
}

/** User confirmation authorizes attaching a pin, never claiming a new phone slot. */
export async function confirmLegacyBotIdentity(id: string, preview: LegacyBotIdentityPreview, stillWanted: () => boolean = () => true): Promise<BotGroupResult> {
  const record = await legacyRecord(id);
  if (!stillWanted() || preview.id !== id || preview.generation !== record.generation || preview.hubUrl !== record.hubUrl
    || preview.groupId !== record.groupId || !preview.pin?.instanceId || !preview.pin?.publicKey) throw changed();
  const pin = { ...preview.pin }, latest = nextRead(id);
  const target = await verifyBotBindingStation(record.hubUrl, pin, false);
  const wanted = () => latest() && stillWanted() && isBotStationCurrent(record.hubUrl, target);
  if (!wanted() || !await confirmLegacyBotGroupPin(record, pin, wanted)) throw changed();
  const confirmed = await getBotGroup(id);
  if (!confirmed || !sameRecord(confirmed, record) || confirmed.pin?.instanceId !== pin.instanceId
    || confirmed.pin.publicKey !== pin.publicKey || !wanted()) throw changed();
  // No repeat bind, no new attempt, no changed token. The first authenticated
  // read follows durable confirmation and rechecks UI lifetime at dispatch.
  let devices: DeviceStatus[];
  try {
    devices = await botGroupDevices(pinnedHub(confirmed), target, () => { if (!wanted()) throw changed(); });
  } catch (error) {
    if (credentialsInvalid(error) && wanted()) {
      await verifyBotBindingStation(record.hubUrl, pin, false);
      if (wanted()) await invalidateBotGroup(id, confirmed.token!, confirmed.generation);
    } else if (error instanceof HubError && error.status === 503 && error.code === 'bot_phone_revoke_pending' && wanted()) {
      await beginBotGroupRevocation(confirmed);
    }
    throw error;
  }
  return persistMembers(confirmed, devices, wanted);
}

export async function revokeBotGroup(id: string, options: BotGroupRevokeOptions = {}): Promise<void> {
  const record = await getBotGroup(id);
  if (!record || options.expectedGeneration && record.generation !== options.expectedGeneration) throw changed();
  if (record.status === 'revoked') {
    await options.beforeComplete?.(record);
    if (!await completeBotGroupRevocation(record)) throw changed();
    return;
  }
  if (!record.token) throw new HubError('Bot 安全凭据无法读取，请重试', 409, 'bot_binding_unavailable');
  pinnedHub(record); // Keep an unconfirmed legacy binding eligible for identity confirmation.
  const revoking = await beginBotGroupRevocation(record);
  if (!revoking) throw changed();
  nextRead(id); // All earlier member reads/import acknowledgements are retired.
  await options.onRevoking?.(revoking);
  pinnedHub(revoking);
  const target = await verifyBotBindingStation(revoking.hubUrl, revoking.pin, false);
  await currentRecord(revoking);
  try {
    await revokeBotPhone(pinnedHub(revoking), revoking.groupId, target);
  } catch (error) {
    if (!credentialsInvalid(error)) throw error;
    if (revoking.binding) {
      // A first bind may still be in flight. Unknown-token 403 alone cannot
      // retire its valid invitation: the late POST could otherwise consume
      // the phone slot after we discarded its only recovery material.
      if (!revoking.attemptId || !revoking.phoneId || !revoking.token || !revoking.pin) {
        throw new HubError('Bot 撤销恢复信息不完整，请保留绑定并重试', 409, 'bot_revoke_unconfirmed');
      }
      const verified = await verifyBotBindingStation(revoking.hubUrl, revoking.pin);
      await currentRecord(revoking);
      try {
        await bindBotPhone(revoking.binding, revoking.phoneId, { attemptId: revoking.attemptId, phoneToken: revoking.token }, verified.endpoint,
          { stillCurrent: async () => sameRecord(await getBotGroup(revoking.id), revoking), pin: revoking.pin });
      } catch (bindingError) {
        if (!credentialsInvalid(bindingError)) throw bindingError;
        await verifyBotBindingStation(revoking.hubUrl, revoking.pin, false);
      }
      // An invite-only admin revocation can reject the replay while leaving a
      // phone whose original POST just completed authorized. Always resolve
      // the token once more after either bind success or confirmed invalidity.
      const finalTarget = await verifyBotBindingStation(revoking.hubUrl, revoking.pin, false);
      await currentRecord(revoking);
      try {
        await revokeBotPhone(pinnedHub(revoking), revoking.groupId, finalTarget);
      } catch (revokeError) {
        if (!credentialsInvalid(revokeError)) throw revokeError;
        await verifyBotBindingStation(revoking.hubUrl, revoking.pin, false);
      }
    } else await verifyBotBindingStation(revoking.hubUrl, revoking.pin, false);
  }
  await currentRecord(revoking);
  await options.beforeComplete?.(revoking);
  if (!await completeBotGroupRevocation(revoking)) throw changed();
}
