import { sha256 } from '@noble/hashes/sha2.js';
import { getSetting, setSetting } from '../storage/database';
import { acknowledgeOperation, cancelQueuedOperation, command, HubError, prepareCommand, readOperation, validExecutionTicket, type Command, type DurableOperation, type ExecutionTicket, type Hub } from './client';

// Intent records are fences. Capacity exhaustion rejects admission; it never
// drops an unknown operation to make room for a new execution UUID.
const KEY = 'remote.durable.commands.v2';
const MAX_RECORDS = 4096;
const MAX_RESULT_BYTES = 2 * 1024 * 1024;
type RecordEntry = { scope: string; deviceId: string; intentId: string; digest: string; ticket: ExecutionTicket;
  completed?: { ok: boolean; result?: Record<string, unknown>; error?: string; code?: string }; cancelRequested?: true; bodyExpired?: boolean; completedAt?: number; savedAt: number };
const retired = new Set<string>();
let tail: Promise<unknown> = Promise.resolve();
function serial<T>(run: () => Promise<T>): Promise<T> {
  const next = tail.then(run, run); tail = next.catch(() => undefined); return next;
}
function hash(command: Command): string {
  const raw = { ...command } as Record<string, unknown>; delete raw.operationId;
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
  return Array.from(sha256(new TextEncoder().encode(JSON.stringify(canonical(raw)))), byte => byte.toString(16).padStart(2, '0')).join('');
}
async function records(): Promise<RecordEntry[]> {
  const raw = await getSetting(KEY);
  if (raw === null) return [];
  try {
    const values = JSON.parse(raw) as RecordEntry[];
    if (!Array.isArray(values) || values.length > MAX_RECORDS || !values.every(value => value && typeof value.scope === 'string'
      && typeof value.deviceId === 'string' && typeof value.intentId === 'string' && /^[a-f0-9]{64}$/.test(value.digest)
      && validExecutionTicket(value.ticket) && Number.isSafeInteger(value.savedAt)
      && (value.completed === undefined || typeof value.completed.ok === 'boolean') && (value.cancelRequested === undefined || value.cancelRequested === true))
      || new Set(values.map(value => JSON.stringify([value.scope, value.deviceId, value.intentId]))).size !== values.length) throw new Error();
    return values.map(value => value.completed && (value.completedAt ?? value.savedAt) + 7 * 86400_000 <= Date.now()
      ? { ...value, completed: undefined, bodyExpired: true } : value);
  } catch { throw new HubError('手机恢复账本无法读取，原记录已保留，未重新派发', 409, 'local_recovery_unavailable'); }
}
const matches = (row: RecordEntry, scope: string, deviceId: string, intentId: string) => row.scope === scope && row.deviceId === deviceId && row.intentId === intentId;
export function supportsDurableCommand(input: Command): boolean {
  return ['session.start', 'session.send', 'session.continue', 'session.steer'].includes(input.type)
    && (!('controlSurface' in input) || input.controlSurface !== 'desktop');
}
export async function durableExecutionId(scope: string, deviceId: string, intentId: string): Promise<string> {
  await tail; return (await records()).find(row => matches(row, scope, deviceId, intentId))?.ticket.operationId ?? intentId;
}
function completion<T>(value: NonNullable<RecordEntry['completed']>): T {
  if (!value.ok) throw new HubError(value.error || '电脑没有完成这个操作', 200, value.code);
  return (value.result ?? {}) as T;
}
/** The only dispatch path: immutable ticket must commit locally first. A
 * resumed intent is looked up before any send, including after phone restart. */
export async function executeDurableCommand<T>(input: {
  owner: Hub; scope: string; deviceId: string; intentId: string; command: Command; signal?: AbortSignal; receiptOnly?: boolean;
  active: () => boolean; bound: (executionId: string) => Promise<void>;
}): Promise<T> {
  const frozen = JSON.parse(JSON.stringify(input.command)) as Command;
  const digest = hash(frozen);
  const check = () => { if (retired.has(input.scope) || !input.active() || input.signal?.aborted) throw new HubError('连接已切换，未继续派发', 499, 'aborted'); };
  const entry = await serial(async () => {
    check(); const list = await records();
    const found = list.find(row => matches(row, input.scope, input.deviceId, input.intentId));
    if (found) {
      if (found.digest !== digest) throw new HubError('原操作内容已改变，未重新派发', 409, 'request_id_conflict');
      return found;
    }
    if (input.receiptOnly) throw new HubError('没有此操作的本地执行票据，请核对原会话', 409, 'command_delivery_uncertain');
    if (list.length >= MAX_RECORDS) throw new HubError('手机恢复账本已满，未派发新操作', 507, 'recovery_capacity');
    const ticket = await prepareCommand(input.owner, input.deviceId, input.intentId, frozen, input.signal);
    check();
    const created: RecordEntry = { scope: input.scope, deviceId: input.deviceId, intentId: input.intentId, digest, ticket, savedAt: Date.now() };
    await setSetting(KEY, JSON.stringify([...list, created]));
    return created;
  });
  check();
  await input.bound(entry.ticket.operationId);
  check();
  if (entry.bodyExpired) throw new HubError('手机保存的原操作结果已过期，请核对原会话', 409, 'execution_ticket_expired');
  if (entry.completed) {
    void acknowledgeOperation(input.owner, input.deviceId, entry.ticket).catch(() => undefined);
    return completion<T>(entry.completed);
  }
  const status = await readOperation(input.owner, input.deviceId, entry.ticket, input.signal);
  let result: NonNullable<RecordEntry['completed']>;
  if (status.state === 'completed' || status.state === 'cancelled' || status.state === 'not_dispatched') result = { ok: status.ok, ...(status.result ? { result: status.result } : {}), ...(status.error ? { error: status.error } : {}), ...(status.code ? { code: status.code } : {}) };
  else {
    check();
    if (entry.cancelRequested) throw new HubError('撤回结果待核对，原任务不会重新派发', 409, 'operation_cancel_unavailable');
    if (status.state === 'uncertain') throw new HubError('电脑已接收，但执行结果尚待核对；不会重复执行', 409, 'command_delivery_uncertain');
    if (status.state === 'expired') throw new HubError('原操作恢复内容已过期，请核对电脑原会话', 409, 'execution_ticket_expired');
    if (status.state === 'pending' || status.state === 'queued') throw new HubError('服务器已保存，正在等待电脑确认', 409, 'command_receipt_pending');
    if (input.receiptOnly) throw new HubError('原操作尚未派发', 409, 'command_delivery_uncertain');
    if (Date.now() >= entry.ticket.dispatchNotAfter) throw new HubError('原操作的执行期限已过，不会重新派发', 409, 'execution_ticket_expired');
    await input.bound(entry.ticket.operationId);
    check();
    const finalCommand = { ...frozen, operationId: entry.ticket.operationId } as Command;
    try {
      // A cancellation may have committed while the status read or local
      // binding awaited. Serialize the final fence check with its journal,
      // but do not hold that lock while waiting for the HTTP response.
      const dispatch = await serial(async () => {
        check(); const latest = (await records()).find(row => matches(row, input.scope, input.deviceId, input.intentId)); check();
        if (!latest || latest.ticket.ticket !== entry.ticket.ticket || latest.cancelRequested) {
          throw new HubError('撤回结果待核对，原任务不会重新派发', 409, 'operation_cancel_unavailable');
        }
        return { reply: command(input.owner, input.deviceId, finalCommand, entry.ticket.operationId, input.signal, { executionTicket: entry.ticket.ticket }) };
      });
      result = { ok: true, result: await dispatch.reply };
    } catch (error) {
      // Only a completed execution failure can be acknowledged. Transport,
      // policy and ambiguous errors leave the original identity recoverable.
      if (!(error instanceof HubError) || error.status !== 200) throw error;
      const settled: DurableOperation = await readOperation(input.owner, input.deviceId, entry.ticket, input.signal);
      if (settled.state !== 'completed') throw error;
      result = { ok: settled.ok, result: settled.result, error: settled.error, code: settled.code };
    }
  }
  const encoded = JSON.stringify(result);
  if (new TextEncoder().encode(encoded).length > MAX_RESULT_BYTES) throw new HubError('结果超出手机恢复空间，服务器副本尚未确认，请从电脑核对', 507, 'recovery_capacity');
  await serial(async () => {
    if (retired.has(input.scope)) throw new HubError('原配对已解除，结果不会写入新配对', 409, 'command_delivery_uncertain');
    const list = await records(); const index = list.findIndex(row => matches(row, input.scope, input.deviceId, input.intentId));
    if (index < 0 || list[index].ticket.ticket !== entry.ticket.ticket) throw new Error('原操作恢复记录已改变');
    list[index] = { ...list[index], completed: result, completedAt: Date.now() };
    const body = JSON.stringify(list);
    if (new TextEncoder().encode(body).length > 16 * 1024 * 1024) throw new HubError('手机恢复空间已满，服务器结果尚未确认', 507, 'recovery_capacity');
    await setSetting(KEY, body);
  });
  // ACK loss is harmless: the locally committed result remains readable and
  // the next lookup retries this ACK, without another execution.
  void acknowledgeOperation(input.owner, input.deviceId, entry.ticket).catch(() => undefined);
  return completion<T>(result);
}

export function retireDurableCommandScope(scope: string): Promise<void> {
  retired.add(scope);
  return serial(async () => {
    const list = (await records()).map(row => row.scope === scope ? { ...row, completed: undefined, bodyExpired: true } : row);
    await setSetting(KEY, list.length ? JSON.stringify(list) : null);
  });
}

export function pruneDurableCommandBodies(): Promise<void> {
  return serial(async () => {
    const original = await getSetting(KEY);
    if (original === null) return;
    const encoded = JSON.stringify(await records());
    if (encoded !== original) await setSetting(KEY, encoded);
  });
}

type QueueOwner = { owner: Hub; scope: string; deviceId: string; intentId: string; active: () => boolean };
const queueGuard = (input: QueueOwner) => { if (retired.has(input.scope) || !input.active()) throw new HubError('连接已切换，请回原任务核对', 409, 'request_scope_changed'); };
export type DurableQueueResolution = { state: 'cancelled' | 'completed' | 'not_dispatched'; completion: NonNullable<RecordEntry['completed']> };
export async function durableQueueAction(input: QueueOwner): Promise<'withdraw' | 'reconcile' | undefined> {
  await tail; queueGuard(input);
  const entry = (await records()).find(row => matches(row, input.scope, input.deviceId, input.intentId)); queueGuard(input);
  if (!entry) return;
  if (entry.cancelRequested || entry.completed?.code === 'operation_cancelled') return 'reconcile';
  const result = await readOperation(input.owner, input.deviceId, entry.ticket); queueGuard(input);
  return result.state === 'queued' ? 'withdraw' : result.state === 'cancelled' ? 'reconcile' : undefined;
}
const notDispatchedCodes = new Set(['offline_queue_unavailable', 'offline_queue_registration_failed', 'offline_dispatch_expired']);
function queueResolution(status: DurableOperation): DurableQueueResolution | undefined {
  const completion = { ok: status.ok, ...(status.result ? { result: status.result } : {}),
    ...(status.error ? { error: status.error } : {}), ...(status.code ? { code: status.code } : {}) };
  if (status.state === 'cancelled') return { state: 'cancelled', completion };
  if (status.state === 'not_dispatched' || status.state === 'expired' && !status.ok && status.code === 'offline_dispatch_expired') return { state: 'not_dispatched', completion };
  if (status.state === 'completed') return { state: 'completed', completion };
}
export async function withdrawDurableQueue(input: QueueOwner): Promise<DurableQueueResolution> {
  const entry = await serial(async () => {
    queueGuard(input); const list = await records(); queueGuard(input);
    const found = list.find(row => matches(row, input.scope, input.deviceId, input.intentId));
    if (!found) throw new HubError('没有原任务的执行票据，请核对原会话', 409, 'operation_not_queued');
    found.cancelRequested = true;
    await setSetting(KEY, JSON.stringify(list)); return found;
  });
  queueGuard(input);
  // A persisted result is already authoritative, including a real task
  // completion that won the claim/cancel race. Never turn it into cancelled.
  let resolved: DurableQueueResolution | undefined = entry.completed ? {
    state: entry.completed.code === 'operation_cancelled' ? 'cancelled'
      : !entry.completed.ok && notDispatchedCodes.has(entry.completed.code ?? '') ? 'not_dispatched' : 'completed',
    completion: entry.completed,
  } : undefined;
  if (!resolved) {
    const status = await readOperation(input.owner, input.deviceId, entry.ticket); queueGuard(input);
    resolved = queueResolution(status);
    if (!resolved) {
      if (status.state !== 'queued') throw new HubError(status.state === 'prepared' ? '没有可撤回的待发任务，请核对原任务'
        : '任务已开始发送或结果待确认，请查看原会话；不会重新派发', 409,
      status.state === 'prepared' ? 'operation_not_queued' : 'operation_not_cancellable');
      try {
        await cancelQueuedOperation(input.owner, input.deviceId, entry.ticket); queueGuard(input);
        resolved = { state: 'cancelled', completion: { ok: false, code: 'operation_cancelled', error: '已撤回，未发送到电脑' } };
      } catch (error) {
        queueGuard(input);
        // The commit may have succeeded before the reply was lost, or claim
        // may have won. Only read the same ticket; never submit the task here.
        const current = await readOperation(input.owner, input.deviceId, entry.ticket).catch(() => undefined); queueGuard(input);
        resolved = current ? queueResolution(current) : undefined;
        if (!resolved) throw error;
      }
    }
  }
  if (!resolved) throw new HubError('原撤回结果尚未确认', 409, 'operation_cancel_unavailable');
  const outcome = resolved;
  if (new TextEncoder().encode(JSON.stringify(outcome.completion)).length > MAX_RESULT_BYTES) throw new HubError('原任务结果超出本机恢复空间，请在电脑核对', 507, 'recovery_capacity');
  await serial(async () => {
    queueGuard(input); const list = await records(); queueGuard(input);
    const found = list.find(row => matches(row, input.scope, input.deviceId, input.intentId));
    if (!found || found.ticket.ticket !== entry.ticket.ticket) throw new Error('原撤回记录已变化，请核对');
    found.completed = outcome.completion; found.completedAt ??= Date.now();
    await setSetting(KEY, JSON.stringify(list));
  });
  return outcome;
}
