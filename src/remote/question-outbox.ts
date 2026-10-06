import { randomUUID } from 'expo-crypto';
import { getSetting, setSetting } from '../storage/database';
import { HubError, type Decision, type QuestionAnswers } from './client';
import { DELIVERY_RETRY_WINDOW_MS } from './offline-policy';

const SETTING = 'remote_question_outbox_v1';
const MAX_ACTIVE = 20;
const MAX_RECORDS = 2048;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export interface QuestionReceipt {
  scope: string; deviceId: string; sessionKey: string; approvalId: string;
  decision: Decision; answers?: QuestionAnswers; message?: string;
  requestId: string; createdAt: number; lastObservedAt: number; expiresAt?: number;
  attempted: boolean; blocked?: string;
}
type Target = Pick<QuestionReceipt, 'scope' | 'deviceId' | 'sessionKey'>;
let queue: Promise<unknown> = Promise.resolve();
const same = (a: Target, b: Target) => a.scope === b.scope && a.deviceId === b.deviceId && a.sessionKey === b.sessionKey;
const clone = (value: QuestionReceipt): QuestionReceipt => ({ ...value,
  ...(value.answers ? { answers: Object.fromEntries(Object.entries(value.answers).map(([key, answers]) => [key, [...answers]])) } : {}) });
function validAnswers(value: unknown): value is QuestionAnswers {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length <= 64 && JSON.stringify(value).length <= 65536
    && Object.entries(value).every(([key, values]) => key.length <= 256 && Array.isArray(values) && values.length <= 64
      && values.every(answer => typeof answer === 'string' && answer.length <= 4000));
}
async function read(): Promise<QuestionReceipt[]> {
  const raw = await getSetting(SETTING);
  if (!raw) return [];
  if (raw.length > 4 * 1024 * 1024) throw new Error('回答记录过大，请在电脑核对');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('回答记录损坏，请在电脑核对'); }
  if (!Array.isArray(parsed)) throw new Error('回答记录损坏，请在电脑核对');
  const valid = (value: any): value is QuestionReceipt => value && typeof value === 'object'
    && ['scope', 'deviceId', 'sessionKey', 'approvalId'].every(key => typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= 2048)
    && UUID.test(value.requestId) && ['allow', 'allow_session', 'deny'].includes(value.decision)
    && Number.isSafeInteger(value.createdAt) && value.createdAt >= 0 && Number.isSafeInteger(value.lastObservedAt) && value.lastObservedAt >= value.createdAt
    && (value.expiresAt === undefined || Number.isSafeInteger(value.expiresAt) && value.expiresAt > 0)
    && typeof value.attempted === 'boolean' && (value.answers === undefined || validAnswers(value.answers))
    && (value.message === undefined || typeof value.message === 'string' && value.message.length <= 4000)
    && (value.blocked === undefined || typeof value.blocked === 'string' && value.blocked.length <= 128);
  if (parsed.length > MAX_RECORDS || !parsed.every(valid)) throw new Error('回答记录损坏，请在电脑核对');
  return parsed.map(clone);
}
function edit<T>(fn: (records: QuestionReceipt[]) => T): Promise<T> {
  const run = queue.then(async () => {
    const records = await read();
    let result: T;
    try { result = fn(records); } catch (error) {
      // Expiry/clock observations remain terminal even when the operation fails.
      await setSetting(SETTING, JSON.stringify(records)); throw error;
    }
    await setSetting(SETTING, JSON.stringify(records)); return result;
  });
  queue = run.catch(() => undefined);
  return run;
}
function observe(record: QuestionReceipt) {
  const now = Date.now();
  if (now < record.lastObservedAt) record.blocked = 'question_clock_changed';
  if (now >= Math.min(record.expiresAt ?? Infinity, record.createdAt + DELIVERY_RETRY_WINDOW_MS)) record.blocked = 'question_expired';
  record.lastObservedAt = Math.max(record.lastObservedAt, now);
}
/** Save before dispatch. Restarts must never manufacture a second answer UUID. */
export function prepareQuestionReceipt(input: Target & Pick<QuestionReceipt, 'approvalId' | 'decision' | 'answers' | 'message' | 'expiresAt'>): Promise<QuestionReceipt> {
  if (input.answers !== undefined && !validAnswers(input.answers)) return Promise.reject(new Error('回答内容无效'));
  return edit(records => {
    // Old unreachable pairings must not exhaust the active delivery slots.
    // Keep their UUID tombstones, but drop frozen text only once retries are terminal.
    for (const value of records) {
      observe(value);
      if (value.blocked === 'question_expired') { delete value.answers; delete value.message; }
    }
    let record = records.find(value => same(value, input) && value.approvalId === input.approvalId);
    if (record?.blocked) throw new HubError('请在电脑核对回答', 200, record.blocked);
    if (record && (record.decision !== input.decision || JSON.stringify(record.answers) !== JSON.stringify(input.answers) || record.message !== input.message)) {
      throw new HubError('原回答正在确认，请先核对', 200, 'question_answer_pending');
    }
    if (!record) {
      if (records.length >= MAX_RECORDS || records.filter(value => !value.blocked).length >= MAX_ACTIVE) throw new Error('请先核对待确认的回答');
      record = clone({ ...input, requestId: randomUUID(), createdAt: Date.now(), lastObservedAt: Date.now(), attempted: false });
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
  return edit(records => {
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
/** Fresh authoritative snapshots retire resolved/withdrawn requests, never an older cached list. */
export function reconcileQuestionReceipts(target: Target, pendingIds: string[], snapshotStartedAt = Infinity): Promise<void> {
  return edit(records => { for (let index = records.length - 1; index >= 0; index--) if (same(records[index], target)
    && records[index].createdAt < snapshotStartedAt && !pendingIds.includes(records[index].approvalId)) records.splice(index, 1); });
}
export function resetQuestionOutboxForTests() { queue = Promise.resolve(); }
