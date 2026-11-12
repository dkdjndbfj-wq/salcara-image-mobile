import { randomUUID } from 'expo-crypto';
import { getSetting, setSetting } from '../storage/database';
import { HubError, type Command, type Decision, type QuestionAnswers } from './client';
import { DELIVERY_RETRY_WINDOW_MS } from './offline-policy';
import { retiredDeliveryScopes, retireDeliveryScope } from './delivery';

const SETTING = 'remote_question_outbox_v1';
const MAX_ACTIVE = 20;
const MAX_RECORDS = 2048;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export type QuestionCommand = Extract<Command, { type: 'approval.respond' }> & { sessionKey: string };
export interface QuestionReceipt {
  scope: string; deviceId: string; sessionKey: string; approvalId: string;
  decision: Decision; answers?: QuestionAnswers; message?: string;
  requestId: string; createdAt: number; lastObservedAt: number; expiresAt?: number;
  attempted: boolean; blocked?: string;
  /** The first dispatch was authoritatively refused; its visible request still needs a newer head read. */
  rejectedAt?: number;
  /** Exact non-secret wire payload, including an intentionally absent API handle. */
  command?: QuestionCommand;
}
type Target = Pick<QuestionReceipt, 'scope' | 'deviceId' | 'sessionKey'>;
let queue: Promise<unknown> = Promise.resolve();
const same = (a: Target, b: Target) => a.scope === b.scope && a.deviceId === b.deviceId && a.sessionKey === b.sessionKey;
const copyAnswers = (answers: QuestionAnswers) => Object.fromEntries(Object.entries(answers).map(([key, values]) => [key, [...values]]));
const copyCommand = (command: QuestionCommand): QuestionCommand => ({ ...command, ...(command.answers ? { answers: copyAnswers(command.answers) } : {}) });
const clone = (value: QuestionReceipt): QuestionReceipt => ({ ...value,
  ...(value.answers ? { answers: copyAnswers(value.answers) } : {}), ...(value.command ? { command: copyCommand(value.command) } : {}) });
function validAnswers(value: unknown): value is QuestionAnswers {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length <= 64 && JSON.stringify(value).length <= 65536
    && Object.entries(value).every(([key, values]) => key.length <= 256 && Array.isArray(values) && values.length <= 64
      && values.every(answer => typeof answer === 'string' && answer.length <= 4000));
}
export function questionCommandMatches(command: unknown, receipt: Pick<QuestionReceipt, 'approvalId' | 'sessionKey' | 'decision' | 'answers' | 'message'>): command is QuestionCommand {
  if (!command || typeof command !== 'object' || Array.isArray(command)) return false;
  const value = command as Record<string, unknown>;
  return Object.keys(value).every(key => ['type', 'approvalId', 'sessionKey', 'decision', 'message', 'answers', 'accountId', 'operationId', 'controlSurface'].includes(key))
    && value.type === 'approval.respond' && value.controlSurface === 'cli'
    && value.approvalId === receipt.approvalId && value.sessionKey === receipt.sessionKey && value.decision === receipt.decision
    && value.message === (receipt.message?.trim() || undefined)
    && (value.operationId === undefined || typeof value.operationId === 'string' && UUID.test(value.operationId))
    && (value.answers === undefined || validAnswers(value.answers)) && JSON.stringify(value.answers) === JSON.stringify(receipt.answers)
    && (value.accountId === undefined || typeof value.accountId === 'string' && value.accountId.length > 0 && value.accountId.length <= 256 && !/[\u0000-\u001f]/.test(value.accountId));
}
async function read(): Promise<QuestionReceipt[]> {
  let raw: unknown;
  try { raw = await getSetting(SETTING); } catch { throw new Error('回答记录暂时无法读取，请稍后重试'); }
  if (raw === null) return [];
  if (typeof raw !== 'string' || !raw) throw new Error('回答记录损坏，请在电脑核对');
  if (raw.length > 4 * 1024 * 1024) throw new Error('回答记录过大，请在电脑核对');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('回答记录损坏，请在电脑核对'); }
  if (!Array.isArray(parsed)) throw new Error('回答记录损坏，请在电脑核对');
  const valid = (value: any): value is QuestionReceipt => value && typeof value === 'object' && !Array.isArray(value)
    && ['scope', 'deviceId', 'sessionKey', 'approvalId'].every(key => typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= 2048)
    && typeof value.requestId === 'string' && UUID.test(value.requestId) && ['allow', 'allow_session', 'deny'].includes(value.decision)
    && Number.isSafeInteger(value.createdAt) && value.createdAt >= 0 && Number.isSafeInteger(value.lastObservedAt) && value.lastObservedAt >= value.createdAt
    && (value.expiresAt === undefined || Number.isSafeInteger(value.expiresAt) && value.expiresAt > 0)
    && typeof value.attempted === 'boolean' && (value.answers === undefined || validAnswers(value.answers))
    && (value.rejectedAt === undefined || Number.isSafeInteger(value.rejectedAt) && value.rejectedAt >= value.createdAt)
    && (value.message === undefined || typeof value.message === 'string' && value.message.length <= 4000)
    && (value.blocked === undefined || typeof value.blocked === 'string' && value.blocked.length <= 128)
    && (value.command === undefined || questionCommandMatches(value.command, value) && (value.command.operationId === undefined || value.command.operationId === value.requestId));
  if (parsed.length > MAX_RECORDS || !parsed.every(valid)
    || new Set(parsed.map(value => JSON.stringify([value.scope, value.deviceId, value.sessionKey, value.approvalId]))).size !== parsed.length
    || new Set(parsed.map(value => JSON.stringify([value.scope, value.requestId]))).size !== parsed.length) throw new Error('回答记录损坏，请在电脑核对');
  return parsed.map(clone);
}
function edit<T>(fn: (records: QuestionReceipt[], retired: ReadonlySet<string>) => T): Promise<T> {
  const run = queue.then(async () => {
    // Validate the complete disk snapshot before filtering any retired scope.
    // A malformed unknown receipt must never be washed away by cleanup.
    let records = await read();
    let retired = new Set(await retiredDeliveryScopes());
    for (;;) {
      records = records.filter(record => !retired.has(record.scope));
      let result!: T, failure: unknown, rejected = false;
      try { result = fn(records, retired); } catch (error) { failure = error; rejected = true; }
      // Expiry/clock observations remain terminal even when the operation
      // fails. No result is published before this local copy has committed.
      await setSetting(SETTING, JSON.stringify(records));
      const after = new Set(await retiredDeliveryScopes());
      if ([...after].some(scope => !retired.has(scope))) {
        // A fence can commit while this outbox's write is in flight. Filter
        // again before publishing; late prepare/mark must never authorize a
        // network mutation for that pairing. The edit callbacks are local.
        retired = after;
        continue;
      }
      if (rejected) throw failure;
      return result;
    }
  });
  queue = run.catch(() => undefined);
  return run;
}
function requireActiveScope(scope: string, retired: ReadonlySet<string>): void {
  if (retired.has(scope)) throw new HubError('此配对已解除绑定或失效，旧回答不会再次发送', 200, 'question_scope_retired');
}
function observe(record: QuestionReceipt) {
  const now = Date.now();
  if (now < record.lastObservedAt) record.blocked = 'question_clock_changed';
  if (now >= Math.min(record.expiresAt ?? Infinity, record.createdAt + DELIVERY_RETRY_WINDOW_MS)) record.blocked = 'question_expired';
  record.lastObservedAt = Math.max(record.lastObservedAt, now);
}
/** Save before dispatch. Restarts must never manufacture a second answer UUID. */
export function prepareQuestionReceipt(input: Target & Pick<QuestionReceipt, 'approvalId' | 'decision' | 'answers' | 'message' | 'expiresAt' | 'command'>): Promise<QuestionReceipt> {
  if (input.answers !== undefined && !validAnswers(input.answers)) return Promise.reject(new Error('回答内容无效'));
  if (input.command !== undefined && !questionCommandMatches(input.command, input)) return Promise.reject(new Error('回答的原请求记录不一致'));
  // The caller may keep editing UI objects while SQLite waits.
  input = { ...input, ...(input.answers ? { answers: copyAnswers(input.answers) } : {}), ...(input.command ? { command: copyCommand(input.command) } : {}) };
  return edit((records, retired) => {
    requireActiveScope(input.scope, retired);
    // Old unreachable pairings must not exhaust the active delivery slots.
    // Keep their UUID tombstones, but drop frozen text only once retries are terminal.
    for (const value of records) {
      observe(value);
      if (value.blocked === 'question_expired') { delete value.answers; delete value.message; delete value.command; }
    }
    let record = records.find(value => same(value, input) && value.approvalId === input.approvalId);
    if (record?.blocked) throw new HubError('请在电脑核对回答', 200, record.blocked);
    if (record && (record.decision !== input.decision || JSON.stringify(record.answers) !== JSON.stringify(input.answers) || record.message !== input.message)) {
      throw new HubError('原回答正在确认，请先核对', 200, 'question_answer_pending');
    }
    if (record && input.command) {
      if (!record.command && record.attempted) throw new HubError('旧回答缺少来源记录，未重新发送', 200, 'question_source_unconfirmed');
      const candidate = record.command?.operationId && input.command.operationId === undefined ? { ...input.command, operationId: record.command.operationId } : input.command;
      if (record.command && JSON.stringify(record.command) !== JSON.stringify(candidate)) throw new HubError('原回答正在确认，请先核对', 200, 'question_answer_pending');
      record.command ??= copyCommand(input.command);
    }
    if (!record) {
      if (records.length >= MAX_RECORDS || records.filter(value => !value.blocked).length >= MAX_ACTIVE) throw new Error('请先核对待确认的回答');
      const requestId = randomUUID();
      record = clone({ ...input, ...(input.command ? { command: { ...input.command, operationId: requestId } } : {}), requestId, createdAt: Date.now(), lastObservedAt: Date.now(), attempted: false });
      records.push(record);
    }
    observe(record);
    if (record.blocked) throw new HubError('请在电脑核对回答', 200, record.blocked);
    return clone(record);
  });
}
export function pendingQuestionReceipts(target: Target): Promise<QuestionReceipt[]> {
  return edit(records => records.filter(value => same(value, target)).map(value => { observe(value); return clone(value); }));
}
/** Station handover guard: the approval UI may not have loaded every thread. */
export function pendingQuestionReceiptsForDevice(scope: string, deviceId: string): Promise<QuestionReceipt[]> {
  return edit(records => records.filter(value => value.scope === scope && value.deviceId === deviceId).map(value => { observe(value); return clone(value); }));
}
/** Journal attempted=true before any network side effect, including retries. */
export function markQuestionAttempt(receipt: QuestionReceipt): Promise<void> {
  return edit((records, retired) => {
    requireActiveScope(receipt.scope, retired);
    const record = records.find(value => same(value, receipt) && value.requestId === receipt.requestId);
    if (!record) throw new HubError('回答等待已结束', 200, 'question_receipt_missing');
    observe(record);
    if (record.blocked) throw new HubError('请在电脑核对回答', 200, record.blocked);
    record.attempted = true;
  });
}
export function finishQuestionReceipt(receipt: QuestionReceipt): Promise<void> {
  return edit(records => { const index = records.findIndex(value => same(value, receipt) && value.requestId === receipt.requestId); if (index >= 0) records.splice(index, 1); });
}
export function blockQuestionReceipt(receipt: QuestionReceipt, code: string): Promise<void> {
  return edit(records => { const record = records.find(value => same(value, receipt) && value.requestId === receipt.requestId); if (record) record.blocked = code.slice(0, 128); });
}
/** A refusal proves only that this new dispatch was not accepted. It does not
 * prove that a stale card is still pending or expose an earlier actor/decision.
 * A restored/uncertain attempt must never be relabelled as this definite case. */
export function markQuestionRejected(receipt: QuestionReceipt): Promise<boolean> {
  if (receipt.attempted || receipt.blocked) return Promise.resolve(false);
  return edit(records => {
    const record = records.find(value => same(value, receipt) && value.requestId === receipt.requestId);
    if (!record || !record.attempted || record.blocked || record.rejectedAt !== undefined) return false;
    record.rejectedAt = Math.max(Date.now(), record.createdAt, record.lastObservedAt);
    record.blocked = 'approval_rejected';
    return true;
  });
}
/** Fresh authoritative snapshots retire resolved/withdrawn requests, never an older cached list. */
export function reconcileQuestionReceipts(target: Target, pendingIds: string[], snapshotStartedAt = Infinity): Promise<void> {
  return edit(records => { for (let index = records.length - 1; index >= 0; index--) if (same(records[index], target)
    && (records[index].rejectedAt !== undefined ? records[index].rejectedAt! < snapshotStartedAt
      : records[index].createdAt < snapshotStartedAt && !pendingIds.includes(records[index].approvalId))) records.splice(index, 1); });
}
/** Permanent pairing revocation shares the durable delivery fence. Finish the
 * question queue cleanup too, so earlier slow writes cannot restore answers. */
export async function retireQuestionScope(exactScope: string): Promise<void> {
  await retireDeliveryScope(exactScope);
  await edit(records => {
    for (let index = records.length - 1; index >= 0; index--) if (records[index].scope === exactScope) records.splice(index, 1);
  });
}
export function resetQuestionOutboxForTests() { queue = Promise.resolve(); }
