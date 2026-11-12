import { randomUUID } from 'expo-crypto';

import { getSetting, setSetting } from '../storage/database';
import { HubError, type ApprovalMode, type Effort, type PermissionMode } from './client';
import { copyTurnFeatures, validTurnFeatures, type TurnFeatures } from './agent-features';
import { isEffort } from './effort';
import { isApprovalMode, isPermissionMode } from './permission-mode';
import { deliveryRetryState } from './offline-policy';
import { ATTACHMENT_MIME } from './attachment-ref';
import type { RemoteImageMime } from './attachment-chunks';
import { decodeNewTask, newSessionReceiptKey } from './new-task';
import { sessionKeyAgentId } from './projection';
import { markRemoteImagesInUse } from './queued-image-files';

const SETTING = 'remote_pending_delivery_v1';
const RETIRED_SETTING = 'remote_retired_delivery_scopes_v1';
const MAX_RETIRED_SCOPES = 4096;
export interface PendingDelivery {
  scope: string; deviceId: string; sessionKey: string; surface: 'cli' | 'desktop';
  text: string; requestId: string; createdAt: number; attempted: boolean; safeRetry: boolean; uncertain?: boolean;
  firstAttemptAt?: number; lastObservedAt?: number; reviewReason?: 'expired' | 'clock-changed';
  /** Server execution identity; requestId continues to own the local draft. */
  executionId?: string;
  /** Frozen at creation. Legacy attempted UUIDs must never be upgraded into a new execution. */
  durableProtocol?: 2;
  pausedByStop?: boolean;
  /** Images already uploaded to the computer; a retry resends the same ids. */
  attachments?: string[];
  /**
   * A receipt is written before an image upload starts.  `false` means the
   * upload was interrupted and must be resumed before the command is sent;
   * records from pre-transaction builds omit the field and are treated as
   * already uploaded for compatibility.
   */
  attachmentsUploaded?: boolean;
  /** Local sources needed to resume an interrupted upload. Never sent to Hub. */
  attachmentSources?: Array<{ id: string; uri: string; mime: RemoteImageMime; width: number; height: number; digest?: string }>;
  /** Frozen with this receipt: a retry must not use a newly selected model. */
  sendOptions?: TurnFeatures & { model?: string; effort?: Effort; permissionMode?: PermissionMode; approval?: ApprovalMode; accountId?: string; control?: 'continue' | 'steer'; expectedTurnId?: string };
  /** New-task acceptance survives a local acknowledgement cleanup failure. */
  acceptedSessionKey?: string;
  /** Local input ownership is frozen before dispatch and retired after acceptance. */
  draftOwner?: DeliveryDraftOwner;
}
export type DeliveryDraftOwner = { kind: 'composer'; key: string; revision: number; identity: string }
  | { kind: 'queue'; key: string; id: string; afterTurn: string };
const ATTACHMENT_ID = /^att_[a-f0-9]{32}$/;
const LOCAL_URI = /^(?:file|content):\/\//i;
const RECEIPT_FIELDS = new Set(['scope', 'deviceId', 'sessionKey', 'surface', 'text', 'requestId', 'createdAt', 'attempted', 'safeRetry', 'uncertain', 'firstAttemptAt', 'lastObservedAt', 'reviewReason', 'attachments', 'attachmentsUploaded', 'attachmentSources', 'sendOptions', 'acceptedSessionKey', 'pausedByStop', 'draftOwner', 'executionId', 'durableProtocol']);
function knownFields(value: object, fields: readonly string[]): boolean { return Object.keys(value).every(key => fields.includes(key)); }
class UnsupportedDeliverySchemaError extends Error {}
function hasUnsupportedDeliveryFields(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (!knownFields(item, [...RECEIPT_FIELDS])) return true;
  if (item.sendOptions && typeof item.sendOptions === 'object' && !Array.isArray(item.sendOptions)
    && !knownFields(item.sendOptions, ['model', 'effort', 'collaborationMode', 'skills', 'contextReferences', 'permissionMode', 'approval', 'accountId', 'control', 'expectedTurnId'])) return true;
  if (item.draftOwner && typeof item.draftOwner === 'object' && !Array.isArray(item.draftOwner)
    && !knownFields(item.draftOwner, ['kind', 'key', 'revision', 'identity', 'id', 'afterTurn'])) return true;
  if (Array.isArray(item.attachmentSources) && item.attachmentSources.some(source => source && typeof source === 'object' && !Array.isArray(source)
    && !knownFields(source, ['id', 'uri', 'mime', 'width', 'height', 'digest']))) return true;
  return false;
}
function validDraftOwner(item: Pick<PendingDelivery, 'draftOwner' | 'scope' | 'deviceId' | 'sessionKey'>): boolean {
  const owner = item.draftOwner;
  if (owner === undefined) return true;
  if (!owner || typeof owner !== 'object' || Array.isArray(owner) || owner.key !== `${item.scope}|${item.deviceId}|${item.sessionKey}` || owner.key.length > 2048) return false;
  return owner.kind === 'composer' ? knownFields(owner, ['kind', 'key', 'revision', 'identity']) && Number.isSafeInteger(owner.revision) && owner.revision > 0 && owner.revision < Number.MAX_SAFE_INTEGER - 1
      && typeof owner.identity === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(owner.identity)
    : owner.kind === 'queue' && knownFields(owner, ['kind', 'key', 'id', 'afterTurn']) && typeof owner.id === 'string' && owner.id.length > 0 && owner.id.length <= 128
      && typeof owner.afterTurn === 'string' && owner.afterTurn.length <= 512;
}
function validAcceptedReceipt(item: PendingDelivery): boolean {
  if (item.acceptedSessionKey === undefined) return true;
  if (item.draftOwner) return item.acceptedSessionKey === item.sessionKey && sessionKeyAgentId(item.sessionKey) !== undefined;
  try {
    const snapshot = decodeNewTask(item.text);
    return item.surface === 'cli' && item.sessionKey === newSessionReceiptKey(snapshot.tool, Boolean(snapshot.desktop))
      && sessionKeyAgentId(item.acceptedSessionKey) === snapshot.tool;
  } catch { return false; }
}
function validAttachmentSource(source: unknown): source is NonNullable<PendingDelivery['attachmentSources']>[number] {
  if (!source || typeof source !== 'object') return false;
  const value = source as Record<string, unknown>;
  return knownFields(value, ['id', 'uri', 'mime', 'width', 'height', 'digest']) && typeof value.id === 'string' && ATTACHMENT_ID.test(value.id) && typeof value.uri === 'string' && value.uri.length <= 4096 && LOCAL_URI.test(value.uri)
    && typeof value.mime === 'string' && ATTACHMENT_MIME.test(value.mime) && Number.isSafeInteger(value.width) && Number(value.width) > 0 && Number(value.width) <= 20_000
    && Number.isSafeInteger(value.height) && Number(value.height) > 0 && Number(value.height) <= 20_000
    && (value.digest === undefined || typeof value.digest === 'string' && /^[a-f0-9]{64}$/.test(value.digest));
}
let pending: PendingDelivery[] | null = null;
let retired: Set<string> | null = null;
let queue: Promise<unknown> = Promise.resolve();
const flights = new Map<string, Promise<void>>();
async function retiredScopes(refresh = false): Promise<Set<string>> {
  if (retired && !refresh) return retired;
  try {
    const encoded = await getSetting(RETIRED_SETTING);
    let loaded = new Set<string>();
    if (encoded !== null) {
      if (typeof encoded !== 'string' || encoded.length > 16_000_000) throw new Error('invalid retirement storage');
      const raw: unknown = JSON.parse(encoded);
      if (!Array.isArray(raw) || raw.length > MAX_RETIRED_SCOPES
        || !raw.every(scope => typeof scope === 'string' && scope.length > 0 && scope.length <= 4096)
        || new Set(raw).size !== raw.length) throw new Error('invalid retirement scopes');
      loaded = new Set(raw);
    }
    if (refresh) return loaded;
    // An older disk read cannot erase a fence published by a committed writer.
    retired ??= loaded;
    return retired;
  } catch {
    throw new Error('手机待确认记录暂时无法读取，未发送，请稍后重试');
  }
}
function requireActiveScope(scope: string, requestId?: string, createdByCall?: boolean): void {
  if (retired?.has(scope)) throw new DeliveryPendingError('此配对已解除绑定或失效，旧消息不会再次发送', false, requestId, createdByCall);
}
/** A detached snapshot of committed pairing fences, after queued writes.
 * Other outboxes may wait on this queue; delivery never waits on theirs. */
export async function retiredDeliveryScopes(): Promise<readonly string[]> {
  await queue;
  return [...await retiredScopes()];
}
async function records(refresh = false): Promise<PendingDelivery[]> {
  markRemoteImagesInUse();
  await retiredScopes();
  if (pending && !refresh) return pending;
  try {
    const encoded = await getSetting(SETTING);
    if (encoded === null) { if (refresh) return []; pending ??= []; return pending; }
    if (typeof encoded !== 'string' || encoded.length > 16_000_000) throw new Error('invalid receipt storage');
    const raw: unknown = JSON.parse(encoded);
    if (!Array.isArray(raw) || raw.length > 20) throw new Error('invalid receipt list');
    if (raw.some(hasUnsupportedDeliveryFields)) throw new UnsupportedDeliverySchemaError();
    const validated = raw.filter((item): item is PendingDelivery => Boolean(item && typeof item === 'object' && !Array.isArray(item)
      && Object.keys(item).every(key => RECEIPT_FIELDS.has(key))
      && typeof item.scope === 'string' && item.scope.length > 0 && item.scope.length <= 4096
      && typeof item.deviceId === 'string' && item.deviceId.length > 0 && item.deviceId.length <= 4096
      && typeof item.sessionKey === 'string' && item.sessionKey.length > 0 && item.sessionKey.length <= 4096
      && ['cli', 'desktop'].includes(item.surface) && typeof item.text === 'string' && item.text.length <= (/^[a-z][a-z0-9_-]*:__salcara_start_v1__:(code|desktop)$/i.test(item.sessionKey) ? 512_000 : 100_000)
      && typeof item.requestId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(item.requestId) && Number.isSafeInteger(item.createdAt) && item.createdAt >= 0
      && typeof item.attempted === 'boolean' && typeof item.safeRetry === 'boolean'
      && (item.executionId === undefined || typeof item.executionId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(item.executionId))
      && (item.durableProtocol === undefined || item.durableProtocol === 2)
      && (item.acceptedSessionKey === undefined || sessionKeyAgentId(item.acceptedSessionKey) !== undefined)
      && (item.uncertain === undefined || typeof item.uncertain === 'boolean')
      && (item.pausedByStop === undefined || item.pausedByStop === true)
      && (item.reviewReason === undefined || ['expired', 'clock-changed'].includes(item.reviewReason))
      && (item.sendOptions === undefined || item.sendOptions && typeof item.sendOptions === 'object' && !Array.isArray(item.sendOptions)
        && knownFields(item.sendOptions, ['model', 'effort', 'collaborationMode', 'skills', 'contextReferences', 'permissionMode', 'approval', 'accountId', 'control', 'expectedTurnId'])
        && (item.sendOptions.control === undefined && item.sendOptions.expectedTurnId === undefined
          || (item.sendOptions.control === 'continue' || item.sendOptions.control === 'steer') && typeof item.sendOptions.expectedTurnId === 'string'
            && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(item.sendOptions.expectedTurnId) && item.surface === 'cli' && !item.attachments?.length)
        && (item.sendOptions.control !== 'steer' || ['model', 'effort', 'collaborationMode', 'skills', 'contextReferences', 'permissionMode', 'approval'].every(field => item.sendOptions?.[field] === undefined))
        && validTurnFeatures(item.sendOptions, item.surface)
        && (item.sendOptions.model === undefined || typeof item.sendOptions.model === 'string' && item.sendOptions.model.length <= 200)
        && (item.sendOptions.accountId === undefined || typeof item.sendOptions.accountId === 'string' && item.sendOptions.accountId.length <= 256)
        && (item.sendOptions.effort === undefined || isEffort(item.sendOptions.effort))
        && (item.sendOptions.approval === undefined || isApprovalMode(item.sendOptions.approval) && item.surface === 'cli' && sessionKeyAgentId(item.sessionKey) === 'claude')
        && (item.sendOptions.permissionMode === undefined || isPermissionMode(item.sendOptions.permissionMode) && item.surface === 'cli' && sessionKeyAgentId(item.sessionKey) === 'codex'))
      && (item.firstAttemptAt === undefined || (Number.isSafeInteger(item.firstAttemptAt) && item.firstAttemptAt >= 0))
      && (item.lastObservedAt === undefined || (Number.isSafeInteger(item.lastObservedAt) && item.lastObservedAt >= 0))
      && (item.attachments === undefined || (Array.isArray(item.attachments) && item.attachments.length <= 4 && item.attachments.every((id: unknown) => typeof id === 'string' && ATTACHMENT_ID.test(id))))
      && (item.attachmentsUploaded === undefined || typeof item.attachmentsUploaded === 'boolean')
      && (item.attachmentSources === undefined || Array.isArray(item.attachmentSources) && item.attachmentSources.length <= 4
        && item.attachmentSources.every((source: unknown) => validAttachmentSource(source)
          && ((source as { digest?: unknown }).digest === undefined || typeof (source as { digest?: unknown }).digest === 'string' && /^[a-f0-9]{64}$/.test((source as { digest: string }).digest)))
        && item.attachments !== undefined && item.attachmentSources.length === item.attachments.length
        && item.attachmentSources.every((source: { id: string }, index: number) => source.id === item.attachments[index]))));
    // Corrupt, duplicate or future-incompatible receipts need review. Silently
    // discarding them would allow a fresh UUID to overwrite an uncertain task.
    if (validated.length !== raw.length || !validated.every(item => validAcceptedReceipt(item) && validDraftOwner(item))
      || new Set(validated.map(item => JSON.stringify([item.scope, item.deviceId, item.sessionKey]))).size !== validated.length
      || new Set(validated.map(item => JSON.stringify([item.scope, item.requestId]))).size !== validated.length) throw new Error('invalid receipt ownership');
    const loaded = validated.map((item) => ({ scope: item.scope, deviceId: item.deviceId, sessionKey: item.sessionKey, surface: item.surface,
        text: item.text, requestId: item.requestId, createdAt: item.createdAt, attempted: item.attempted, safeRetry: item.safeRetry,
        ...(item.executionId ? { executionId: item.executionId } : {}),
        ...(item.durableProtocol === 2 ? { durableProtocol: 2 as const } : {}),
        ...(item.sendOptions && typeof item.sendOptions === 'object' ? { sendOptions: {
          ...copyTurnFeatures(item.sendOptions),
          ...(typeof item.sendOptions.model === 'string' && item.sendOptions.model.length <= 200 ? { model: item.sendOptions.model } : {}),
          ...(typeof item.sendOptions.accountId === 'string' && item.sendOptions.accountId.length <= 256 ? { accountId: item.sendOptions.accountId } : {}),
          ...(isEffort(item.sendOptions.effort) ? { effort: item.sendOptions.effort } : {}),
          ...(isPermissionMode(item.sendOptions.permissionMode) ? { permissionMode: item.sendOptions.permissionMode } : {}),
          ...(isApprovalMode(item.sendOptions.approval) ? { approval: item.sendOptions.approval } : {}),
          ...((item.sendOptions.control === 'continue' || item.sendOptions.control === 'steer') && typeof item.sendOptions.expectedTurnId === 'string'
            ? { control: item.sendOptions.control, expectedTurnId: item.sendOptions.expectedTurnId } : {}),
        } } : {}),
        ...(item.uncertain === true ? { uncertain: true } : {}),
        ...(item.acceptedSessionKey ? { acceptedSessionKey: item.acceptedSessionKey } : {}),
        ...(item.draftOwner ? { draftOwner: { ...item.draftOwner } } : {}),
        ...(item.pausedByStop ? { pausedByStop: true as const } : {}),
        ...(item.attachments?.length ? { attachmentsUploaded: item.attachmentsUploaded !== false } : {}),
        ...(item.attachmentSources?.length ? { attachmentSources: item.attachmentSources.map((source) => ({ id: source.id, uri: source.uri, mime: source.mime, width: source.width, height: source.height,
          ...(typeof (source as { digest?: unknown }).digest === 'string' ? { digest: (source as { digest: string }).digest } : {}) })) } : {}),
        ...(['expired', 'clock-changed'].includes(item.reviewReason ?? '') ? { reviewReason: item.reviewReason } : {}),
        ...(item.firstAttemptAt !== undefined ? { firstAttemptAt: item.firstAttemptAt } : {}),
        ...(item.lastObservedAt !== undefined ? { lastObservedAt: item.lastObservedAt } : {}),
        ...(item.attachments?.length ? { attachments: [...item.attachments] } : {}) }));
    // A concurrent lookup may finish after a writer has already committed and
    // published a newer list. Its older disk snapshot cannot replace that list.
    if (refresh) return loaded;
    pending ??= loaded;
  } catch (error) {
    // Do not cache an empty list or overwrite disk after a transient SQLite
    // read failure, malformed JSON or an invalid legacy/future record.
    if (error instanceof UnsupportedDeliverySchemaError) {
      throw new Error('待确认任务记录无法读取：包含当前版本不支持的字段，原记录已保留，不会发送或清理。请更新手机端后核对原会话');
    }
    throw new Error('手机待确认记录暂时无法读取，未发送，请稍后重试');
  }
  return pending;
}
async function edit<T>(fn: (list: PendingDelivery[]) => T): Promise<T> {
  const run = queue.then(async () => {
    // Never publish a receipt (or its deletion) before the SQLite write has
    // committed. A rejected storage write must leave the durable owner intact.
    const list = (await records()).filter(item => !retired?.has(item.scope)).map(item => ({ ...item,
      ...(item.draftOwner ? { draftOwner: { ...item.draftOwner } } : {}),
      ...(item.attachments ? { attachments: [...item.attachments] } : {}),
      ...(item.attachmentSources ? { attachmentSources: item.attachmentSources.map(source => ({ ...source })) } : {}),
      ...(item.sendOptions ? { sendOptions: { ...item.sendOptions, ...copyTurnFeatures(item.sendOptions) } } : {}) }));
    const value = fn(list);
    await setSetting(SETTING, JSON.stringify(list));
    pending = list;
    return value;
  });
  queue = run.catch(() => undefined);
  return run;
}
export async function pendingDelivery(scope: string, deviceId: string, sessionKey: string): Promise<PendingDelivery | undefined> {
  await queue;
  const list = await records();
  if (retired?.has(scope) || !list.some((item) => item.scope === scope && item.deviceId === deviceId && item.sessionKey === sessionKey)) return undefined;
  return edit((list) => {
    const item = list.find((value) => value.scope === scope && value.deviceId === deviceId && value.sessionKey === sessionKey);
    if (!item) return undefined;
    observe(item);
    return { ...item, ...(item.draftOwner ? { draftOwner: { ...item.draftOwner } } : {}), ...(item.sendOptions ? { sendOptions: { ...item.sendOptions, ...copyTurnFeatures(item.sendOptions) } } : {}) };
  });
}

/**
 * Lists every outstanding message receipt for one active station/computer.
 * The session directory is allowed to be cold or partially loaded, so callers
 * that are about to change the station must not rely on a UI timeline to find
 * all receipts.
 */
export async function pendingDeliveriesForDevice(scope: string, deviceId: string): Promise<PendingDelivery[]> {
  await queue;
  const list = await records();
  if (retired?.has(scope) || !list.some((item) => item.scope === scope && item.deviceId === deviceId)) return [];
  return edit((list) => list.filter((item) => item.scope === scope && item.deviceId === deviceId).map((item) => {
    observe(item);
    return { ...item, ...(item.draftOwner ? { draftOwner: { ...item.draftOwner } } : {}), ...(item.sendOptions ? { sendOptions: { ...item.sendOptions, ...copyTurnFeatures(item.sendOptions) } } : {}) };
  }));
}

/** Observation cannot renew a retry deadline, and a blocked deadline remains blocked across restarts. */
function observe(item: PendingDelivery) {
  const now = Date.now();
  const policy = deliveryRetryState(item, now);
  if (policy.reason === 'expired' || policy.reason === 'clock-changed') item.reviewReason = policy.reason;
  if (Number.isSafeInteger(now) && now >= 0) item.lastObservedAt = Math.max(item.lastObservedAt ?? item.firstAttemptAt ?? item.createdAt, now);
  return policy;
}
/** Explicit user cancellation of phone retries only; never interrupts or undoes the computer's task. */
export async function cancelPendingDelivery(scope: string, deviceId: string, sessionKey: string): Promise<void> {
  await edit((list) => { const index = list.findIndex((item) => item.scope === scope && item.deviceId === deviceId && item.sessionKey === sessionKey); if (index >= 0) list.splice(index, 1); });
}

export async function bindDeliveryExecution(scope: string, deviceId: string, requestId: string, executionId: string): Promise<void> {
  await edit(list => {
    requireActiveScope(scope, requestId);
    const item = list.find(row => row.scope === scope && row.deviceId === deviceId && row.requestId === requestId);
    if (!item) return;
    if (item.pausedByStop) throw new DeliveryPendingError('已暂停此消息的重发，请核对原会话', false, requestId);
    if (item.executionId && item.executionId !== executionId) throw new Error('原操作的执行编号已改变');
    item.executionId = executionId;
  });
}

export async function deliveryUsesDurableProtocol(scope: string, deviceId: string, requestId: string): Promise<boolean> {
  await queue;
  const item = (await records()).find(row => row.scope === scope && row.deviceId === deviceId && row.requestId === requestId);
  return item?.durableProtocol === 2 || Boolean(item?.executionId);
}

/** Stop never deletes an uncertain send or assumes that an in-flight write was cancelled. */
export async function pausePendingDelivery(scope: string, deviceId: string, sessionKey: string, expectedRequestId?: string): Promise<void> {
  await edit(list => { const item = list.find(row => row.scope === scope && row.deviceId === deviceId && row.sessionKey === sessionKey);
    if (expectedRequestId && item?.requestId !== expectedRequestId) throw new DeliveryPendingError('原任务的记录已改变，请核对', false, expectedRequestId);
    if (item) item.pausedByStop = true;
  });
}

/** Apply a verified old operation result to only its original local receipt. */
export async function settleQueuedDelivery(scope: string, deviceId: string, sessionKey: string, requestId: string,
  acceptedSessionKey?: string): Promise<PendingDelivery | undefined> {
  return edit(list => {
    requireActiveScope(scope, requestId, false);
    const index = list.findIndex(item => item.scope === scope && item.deviceId === deviceId && item.sessionKey === sessionKey);
    if (index < 0 || list[index].requestId !== requestId) return undefined;
    const item = list[index];
    if (acceptedSessionKey) {
      if (!validAcceptedReceipt({ ...item, acceptedSessionKey })) throw new DeliveryPendingError('原任务的完成结果归属不一致，请核对', false, requestId);
      item.acceptedSessionKey = acceptedSessionKey;
    } else list.splice(index, 1);
    return { ...item };
  });
}

/** An old acknowledgement can never clear a subsequent virtual-key owner. */
export async function acknowledgeAcceptedDelivery(scope: string, deviceId: string, sessionKey: string, requestId: string, acceptedSessionKey: string): Promise<void> {
  await edit(list => {
    requireActiveScope(scope, requestId, false);
    const index = list.findIndex(item => item.scope === scope && item.deviceId === deviceId && item.sessionKey === sessionKey);
    if (index < 0 || list[index].requestId !== requestId || list[index].acceptedSessionKey !== acceptedSessionKey) throw new Error('原任务的确认记录已改变');
    list.splice(index, 1);
  });
}

/** Only confirmed permanent pairing revocation retires a scope. Cache clearing
 * and temporary connection failures must preserve its unknown deliveries. */
export function retireDeliveryScope(exactScope: string): Promise<void> {
  if (typeof exactScope !== 'string' || exactScope.length === 0 || exactScope.length > 4096) return Promise.reject(new Error('配对范围无效'));
  const run = queue.then(async () => {
    // Re-read both durable stores even with a warm cache. A failed/unknown read
    // cannot authorize overwriting another pairing's outstanding deliveries.
    const scopes = await retiredScopes(true);
    const list = await records(true);
    const next = new Set([...scopes, ...(retired ?? []), exactScope]);
    const encoded = JSON.stringify([...next]);
    if (next.size > MAX_RETIRED_SCOPES || encoded.length > 16_000_000) throw new Error('配对退役记录过多，未清理待确认消息');
    if (!scopes.has(exactScope) || next.size !== scopes.size) {
      await setSetting(RETIRED_SETTING, encoded);
    }
    // Publish the fence only after its commit. If the subsequent receipt write
    // fails, this fence still blocks late callbacks and survives a restart;
    // calling retirement again retries that exact scope's cleanup.
    retired = next;
    const remaining = list.filter(item => item.scope !== exactScope);
    if (remaining.length !== list.length) await setSetting(SETTING, JSON.stringify(remaining));
    pending = remaining;
  });
  queue = run.catch(() => undefined);
  return run;
}

export class DeliveryPendingError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly requestId?: string, readonly receiptCreatedByCall?: boolean) {
    super(message); this.name = 'DeliveryPendingError';
  }
}

/** Persist the same receipt before dispatch. A dropped response never becomes a brand-new command. */
export function deliverMessage(input: Pick<PendingDelivery, 'scope' | 'deviceId' | 'sessionKey' | 'surface' | 'text' | 'attachments' | 'sendOptions' | 'draftOwner'> & {
  durableProtocol?: 2;
  attachmentSources?: PendingDelivery['attachmentSources'];
  /** Runs after the durable receipt is written but before the task command. */
  prepare?: (receipt: PendingDelivery) => Promise<void>;
  /** A distinct queued submission cannot retry an older same-text receipt. */
  requireNewReceipt?: boolean;
  /** Retry only this exact durable operation; a stale retry cannot create one. */
  expectedRequestId?: string;
  idempotent: boolean; perform: (receipt: PendingDelivery) => Promise<void | { sessionKey: string; retain?: true }>;
}): Promise<void> {
  input = { ...input, ...(input.draftOwner ? { draftOwner: { ...input.draftOwner } } : {}), ...(input.sendOptions ? { sendOptions: { ...input.sendOptions, ...copyTurnFeatures(input.sendOptions) } } : {}) };
  if (!validDraftOwner(input)) return Promise.reject(new Error('消息草稿归属无效，未发送'));
  const flightKey = JSON.stringify([input.scope, input.deviceId, input.sessionKey]);
  const existingFlight = flights.get(flightKey);
  if (existingFlight) return Promise.reject(new DeliveryPendingError('这条消息正在确认送达，请稍候', false));
  const flight = (async () => {
    let previouslyPossible = false;
    const prepared = await edit((list) => {
      requireActiveScope(input.scope);
      let item = list.find((value) => value.scope === input.scope && value.deviceId === input.deviceId && value.sessionKey === input.sessionKey);
      if (input.expectedRequestId !== undefined && (!item || item.requestId !== input.expectedRequestId)) throw new DeliveryPendingError('原消息的送达记录已改变，请重新核对原会话', false);
      if (item && input.requireNewReceipt) throw new DeliveryPendingError('上一条消息尚未确认，请先核对原消息', false);
      if (item && (item.text !== input.text || item.surface !== input.surface)) throw new DeliveryPendingError('上一条消息尚未确认，请先重试原消息，避免重复或乱序发布任务', false);
      const createdByCall = !item;
      if (!item) {
        if (list.length >= 20) throw new DeliveryPendingError('待确认消息过多，请先处理已有消息', false);
        item = { scope: input.scope, deviceId: input.deviceId, sessionKey: input.sessionKey, surface: input.surface,
          text: input.text, requestId: randomUUID(), createdAt: Date.now(), attempted: false, safeRetry: input.idempotent,
          ...(input.durableProtocol === 2 ? { durableProtocol: 2 as const } : {}),
          ...(input.draftOwner ? { draftOwner: { ...input.draftOwner } } : {}),
          ...(input.attachments?.length ? { attachments: [...input.attachments] } : {}),
          // Callers that provide `prepare` opt into the upload-before-dispatch
          // transaction.  Older integrations pass already-uploaded IDs and
          // remain compatible with the pre-transaction receipt format.
          ...(input.attachments?.length && input.prepare ? { attachmentsUploaded: false } : {}),
          ...(input.attachmentSources?.length ? { attachmentSources: input.attachmentSources.map((source) => ({ ...source })) } : {}),
          ...(input.sendOptions ? { sendOptions: { ...input.sendOptions, ...copyTurnFeatures(input.sendOptions) } } : {}) };
        list.push(item);
      }
      // A user may reselect the original images after a failed upload. Keep
      // the replacement local sources in the same receipt before retrying so
      // a process death during that retry is still recoverable.
      if (input.attachmentSources?.length && item.attachments?.length === input.attachmentSources.length) {
        item.attachmentSources = input.attachmentSources.map((source) => ({ ...source }));
      }
      const policy = observe(item);
      // A durable accepted result is local reconciliation, not a redispatch.
      if (!item.acceptedSessionKey && !policy.retryable) return { blocked: policy.message, requestId: item.requestId, createdByCall };
      if (!item.acceptedSessionKey && item.attempted && !input.idempotent) return { blocked: '本站已不支持安全重试，请先核对原会话；不会自动重复发送', requestId: item.requestId, createdByCall };
      previouslyPossible = item.attempted;
      const now = Date.now();
      item.firstAttemptAt = item.firstAttemptAt ?? (item.attempted ? item.createdAt : now);
      item.lastObservedAt = now;
      item.attempted = true;
      item.safeRetry = item.safeRetry && input.idempotent;
      return { receipt: { ...item }, createdByCall };
    });
    if (!prepared.receipt) throw new DeliveryPendingError(prepared.blocked!, false, prepared.requestId, prepared.createdByCall);
    let receipt = prepared.receipt;
    const pendingError = (message: string, retryable: boolean) => new DeliveryPendingError(message, retryable, receipt.requestId, prepared.createdByCall);
    let acknowledged = false;
    try {
      await queue;
      await retiredScopes();
      requireActiveScope(receipt.scope, receipt.requestId, prepared.createdByCall);
      // Another sender may have observed acceptance after this retry read
      // its initial snapshot. Existing-task acceptance is local cleanup only.
      if (receipt.draftOwner && receipt.acceptedSessionKey === receipt.sessionKey) return;
      if (receipt.attachments?.length && receipt.attachmentsUploaded === false) {
        if (!input.prepare) throw new DeliveryPendingError('图片上传状态未确认，请重新选择原图片', false);
        await input.prepare(receipt);
        await edit((list) => {
          requireActiveScope(receipt.scope, receipt.requestId, prepared.createdByCall);
          const item = list.find((value) => value.requestId === receipt.requestId && value.scope === receipt.scope);
          if (item) item.attachmentsUploaded = true;
        });
        receipt = { ...receipt, attachmentsUploaded: true };
      }
      await queue;
      await retiredScopes();
      requireActiveScope(receipt.scope, receipt.requestId, prepared.createdByCall);
      const current = (await records()).find(item => item.scope === receipt.scope && item.requestId === receipt.requestId);
      if (!current || current.pausedByStop && !current.acceptedSessionKey) throw pendingError('已暂停此消息的重发，请先核对原会话', false);
      if (current.acceptedSessionKey) {
        receipt = { ...receipt, acceptedSessionKey: current.acceptedSessionKey };
        if (receipt.draftOwner && receipt.acceptedSessionKey === receipt.sessionKey) return;
      }
      const outcome = await input.perform(receipt);
      acknowledged = true;
      if (outcome) {
        if (sessionKeyAgentId(outcome.sessionKey) === undefined) throw pendingError('电脑的任务标识无法确认，请先核对原任务', false);
        await edit(list => {
          requireActiveScope(receipt.scope, receipt.requestId, prepared.createdByCall);
          const item = list.find(value => value.requestId === receipt.requestId && value.scope === receipt.scope);
          if (!item) throw pendingError('原任务的记录已改变，请先核对原任务', false);
          if (!validAcceptedReceipt({ ...item, acceptedSessionKey: outcome.sessionKey })) throw pendingError('电脑的任务归属无法确认，请先核对原任务', false);
          item.acceptedSessionKey = outcome.sessionKey;
        });
        // A new-task composer must consume its exact old draft revision
        // before its accepted receipt can be retired. Navigation/scope loss
        // is not proof of that local acknowledgement.
        if (outcome.retain) return;
      }
      await edit((list) => {
        requireActiveScope(receipt.scope, receipt.requestId, prepared.createdByCall);
        const index = list.findIndex((item) => item.requestId === receipt.requestId && item.scope === receipt.scope); if (index >= 0) list.splice(index, 1);
      });
    } catch (error) {
      await queue;
      await retiredScopes();
      requireActiveScope(receipt.scope, receipt.requestId, prepared.createdByCall);
      if (acknowledged) {
        // The computer accepted this exact operation. A failed local cleanup
        // is not evidence that it did not execute; keep its durable receipt.
        throw pendingError('消息已送达，手机确认记录未能清理，请先核对原会话', false);
      }
      if ((await records()).some(item => item.scope === receipt.scope && item.requestId === receipt.requestId && item.pausedByStop)) {
        throw pendingError('已暂停此消息的重发，请先核对原会话', false);
      }
      // Uploads happen after the durable receipt and before dispatch.  Any
      // failure in this phase must retain the receipt (and its exact IDs) so a
      // later retry can resume the upload; dropping it would leave orphaned
      // bytes on the computer or, worse, encourage a brand-new duplicate task.
      if (receipt.attachments?.length && receipt.attachmentsUploaded === false) {
        await edit((list) => {
          const item = list.find((value) => value.requestId === receipt.requestId && value.scope === receipt.scope);
          if (item) { item.attachmentsUploaded = false; observe(item); }
        });
        if (error instanceof DeliveryPendingError) throw pendingError(error.message, error.retryable);
        throw pendingError('图片上传未完成，请重试原消息', false);
      }
      const durable = (await records()).find(item => item.scope === receipt.scope && item.requestId === receipt.requestId)?.executionId;
      if (durable && !(error instanceof HubError && error.status === 200)) {
        const retained = await edit(list => {
          const item = list.find(row => row.scope === receipt.scope && row.requestId === receipt.requestId);
          if (!item) return receipt;
          if (error instanceof HubError && error.code === 'execution_ticket_expired') item.reviewReason = 'expired';
          observe(item); return { ...item };
        });
        const policy = deliveryRetryState(retained);
        throw pendingError(error instanceof Error ? error.message : policy.message, policy.retryable);
      }
      const uncertain = error instanceof HubError && ['command_delivery_uncertain', 'request_id_conflict', 'execution_ticket_expired', 'storage_epoch_mismatch', 'local_recovery_unavailable'].includes(error.code ?? '');
      const transient = error instanceof HubError && (error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500 || (error.status === 409 && (!error.code || error.code === 'computer_offline' || error.code === 'command_receipt_pending')));
      if (uncertain || transient) {
        const retained = await edit((list) => {
          const item = list.find((value) => value.requestId === receipt.requestId && value.scope === receipt.scope);
          if (!item) return receipt;
          if (uncertain) item.uncertain = true;
          // Hub's explicit code means no receipt existed and no dispatch occurred.
          // It cannot erase an earlier lost acknowledgement or an old migrated attempt.
          if (!previouslyPossible && error instanceof HubError && error.status === 409 && error.code === 'computer_offline') {
            item.attempted = false;
            delete item.firstAttemptAt;
          }
          observe(item);
          return { ...item };
        });
        const policy = deliveryRetryState(retained);
        throw pendingError(policy.message, policy.retryable);
      }
      if (previouslyPossible) {
        // A new authorization/capability error cannot prove that an earlier
        // request did not already execute. Preserve its text and receipt.
        await edit((list) => {
          const item = list.find((value) => value.requestId === receipt.requestId && value.scope === receipt.scope);
          if (item) { item.uncertain = true; observe(item); }
        });
        throw pendingError('原消息曾等待确认，当前连接无法确认送达。文字仍在手机，请先核对原会话；不会自动重发', false);
      }
      // Definitive authorization/capability failure did not run the task. Keep its text, not a misleading pending receipt.
      await edit((list) => { const index = list.findIndex((item) => item.requestId === receipt.requestId && item.scope === receipt.scope); if (index >= 0) list.splice(index, 1); });
      throw error;
    }
  })();
  flights.set(flightKey, flight);
  void flight.finally(() => { if (flights.get(flightKey) === flight) flights.delete(flightKey); }).catch(() => undefined);
  return flight;
}

/** Test reset never erases on-device records; restart tests can exercise restoration. */
export function resetDeliveryForTests() { pending = null; retired = null; queue = Promise.resolve(); flights.clear(); }
