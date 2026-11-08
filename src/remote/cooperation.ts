import { getSetting, setSetting } from '../storage/database';
import type { SessionInfo } from './client';

export interface CooperationReading {
  ticket: string; expiresAt: number; source: SessionInfo; target: SessionInfo; scope: string;
}
export interface CooperationReceipt {
  operationId: string; sourceSessionKey: string; targetSessionKey: string; targetTitle: string;
  text: string; createdAt: number; state: 'unconfirmed' | 'sent' | 'acknowledged' | 'not_sent';
}
export const validCooperationKey = (value: unknown): value is string => typeof value === 'string' && /^(codex|claude):[A-Za-z0-9_-]{1,160}$/.test(value);
export function cooperationCandidate(session: SessionInfo, source: string): boolean {
  return validCooperationKey(source) && validCooperationKey(session.sessionKey) && session.sessionKey !== source
    && session.sessionKey.split(':')[0] === source.split(':')[0] && session.tool === source.split(':')[0]
    && session.controllable === true && !session.archived && !session.parentSessionKey && session.controlSurface !== 'desktop' && session.controlSurface !== 'read-only'
    && (session.status === 'idle' || session.status === 'failed');
}
export function parseCooperationReading(raw: unknown, source: string, target: string, scope: string): CooperationReading | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as CooperationReading;
  if (!/^[a-f0-9]{64}$/.test(value.ticket) || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now() || value.expiresAt > Date.now() + 6 * 60_000
    || !value.source || !value.target || value.source.sessionKey !== source || value.target.sessionKey !== target || !cooperationCandidate(value.target, source)
    || value.source.tool !== source.split(':')[0] || value.source.controllable !== true || value.source.archived || value.source.parentSessionKey || value.source.controlSurface !== 'cli'
    || value.target.controlSurface !== 'cli' || typeof value.source.title !== 'string' || typeof value.target.title !== 'string') return undefined;
  return { ticket: value.ticket, expiresAt: value.expiresAt, source: { ...value.source }, target: { ...value.target }, scope };
}

const setting = 'remote_cooperation_receipts_v1';
let writes: Promise<unknown> = Promise.resolve();
function validReceipt(raw: unknown): raw is CooperationReceipt {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as CooperationReceipt;
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(r.operationId) && validCooperationKey(r.sourceSessionKey) && validCooperationKey(r.targetSessionKey)
    && r.sourceSessionKey !== r.targetSessionKey && typeof r.text === 'string' && r.text.length <= 16_000 && typeof r.targetTitle === 'string' && r.targetTitle.length <= 640
    && Number.isSafeInteger(r.createdAt) && ['unconfirmed', 'sent', 'acknowledged', 'not_sent'].includes(r.state);
}
async function table(): Promise<Record<string, CooperationReceipt[]>> {
  const raw = await getSetting(setting);
  if (!raw) return {};
  if (raw.length > 8_000_000) throw new Error('跨任务回执超出存储限制');
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.entries(value).some(([key, list]) => key.length > 4096 || !Array.isArray(list) || list.length > 100 || list.some(item => !validReceipt(item)))) throw new Error('跨任务回执无法读取，请核对目标任务');
  return value as Record<string, CooperationReceipt[]>;
}
export function readCooperationReceipts(owner: string, source: string): Promise<CooperationReceipt[]> {
  return writes.then(async () => (await table())[JSON.stringify([owner, source])] ?? []);
}
export function saveCooperationReceipt(owner: string, receipt: CooperationReceipt): Promise<void> {
  const run = writes.then(async () => {
    if (!owner || owner.length > 3000 || !validReceipt(receipt)) throw new Error('跨任务回执无效，消息未发送');
    const records = await table(), key = JSON.stringify([owner, receipt.sourceSessionKey]), previous = records[key] ?? [];
    const existing = previous.find(item => item.operationId === receipt.operationId);
    if (existing && (existing.text !== receipt.text || existing.targetSessionKey !== receipt.targetSessionKey)) throw new Error('跨任务请求编号冲突');
    // Keep unconfirmed receipts even when pruning older successful display
    // records. No ticket is persisted or silently re-executed after restart.
    const next = previous.filter(item => item.operationId !== receipt.operationId);
    while (next.length >= 100) {
      const index = next.findIndex(item => item.state !== 'unconfirmed');
      if (index < 0) throw new Error('待核对消息过多，请先核对目标任务');
      next.splice(index, 1);
    }
    records[key] = [...next, { ...receipt }];
    const encoded = JSON.stringify(records);
    if (encoded.length > 8_000_000) throw new Error('跨任务回执存储已满');
    await setSetting(setting, encoded);
  });
  writes = run.catch(() => undefined); return run;
}
