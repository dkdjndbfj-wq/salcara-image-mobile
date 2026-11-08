import { getSetting, setSetting } from '../storage/database';
import { directDraftKey } from './direct-composer-drafts';

export interface DirectPendingOperation { id: string; kind: 'send' | 'steer' | 'continue' | 'start' | 'revert'; expectedTurnId?: string; draftReceipt?:{revision:number;identity:string} }
type Row = { pairing: string; deviceId: string; owner: string; operation: DirectPendingOperation };
type Table = Record<string, Row>;
const SETTING = 'direct_pending_operations_v1';
let writes: Promise<unknown> = Promise.resolve();
const serial = <T,>(fn: () => Promise<T>): Promise<T> => { const result = writes.then(fn); writes = result.catch(() => undefined); return result; };
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const valid = (value: unknown): value is DirectPendingOperation => record(value)
  && typeof value.id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value.id)
  && ['send','steer','continue','start','revert'].includes(String(value.kind))
  && (value.expectedTurnId === undefined || typeof value.expectedTurnId === 'string' && value.expectedTurnId.length > 0 && value.expectedTurnId.length <= 512 && !/[\r\n\0]/.test(value.expectedTurnId))
  && (value.draftReceipt===undefined||record(value.draftReceipt)&&Number.isSafeInteger(value.draftReceipt.revision)&&Number(value.draftReceipt.revision)>0&&Number(value.draftReceipt.revision)<Number.MAX_SAFE_INTEGER-1
    &&typeof value.draftReceipt.identity==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value.draftReceipt.identity)
    &&Object.keys(value.draftReceipt).every(key=>['revision','identity'].includes(key)))
  && Object.keys(value).every(key => ['id','kind','expectedTurnId','draftReceipt'].includes(key));
const keyFor = (pairing: string, deviceId: string, owner: string) => `${directDraftKey(pairing, deviceId, owner)}:pending`;
async function readTable(): Promise<Table> {
  const raw = await getSetting(SETTING); if (raw === null) return Object.create(null) as Table;
  let value: unknown; try { value = JSON.parse(raw); } catch { throw new Error('送达记录无法读取，原内容未覆盖'); }
  if (raw.length > 500_000 || !record(value) || Object.keys(value).length > 100) throw new Error('送达记录无效，原内容未覆盖');
  for (const [key, row] of Object.entries(value)) if (!record(row)
    || typeof row.pairing !== 'string' || !row.pairing || row.pairing.length > 4096
    || typeof row.deviceId !== 'string' || !row.deviceId || row.deviceId.length > 256
    || typeof row.owner !== 'string' || !row.owner || row.owner.length > 8192
    || key !== keyFor(row.pairing, row.deviceId, row.owner) || !valid(row.operation)
    || Object.keys(row).some(field => !['pairing','deviceId','owner','operation'].includes(field))) throw new Error('送达记录来源无效，原内容未覆盖');
  return Object.assign(Object.create(null), value) as Table;
}
const write = (table: Table) => setSetting(SETTING, JSON.stringify(table));

/** A durable dispatch marker, never an auto-retry outbox. Original content stays
 * in its composer draft. Only a matching receipt/clientId or a proven rejection
 * clears the marker; revisiting a conversation does not unlock it. */
export function createDirectPendingOperation({ pairing, deviceId, owner, isCurrent = () => true }: {
  pairing: string; deviceId: string; owner: string; isCurrent?: () => boolean;
}) {
  if (!pairing || pairing.length > 4096 || !deviceId || deviceId.length > 256 || !owner || owner.length > 8192) throw new Error('发送记录来源无效');
  const key = keyFor(pairing, deviceId, owner);
  const guard = () => { if (!isCurrent()) throw new Error('电脑、会话或 API 已变化，原送达记录已保留'); };
  return {
    key,
    read: () => serial(async () => { guard(); const table = await readTable(); guard(); return table[key]?.operation; }),
    begin: (operation: DirectPendingOperation) => {
      const snapshot = { ...operation,...(operation.draftReceipt?{draftReceipt:{...operation.draftReceipt}}:{}) };
      return serial(async () => {
        guard(); if (!valid(snapshot)) throw new Error('发送操作无效');
        const table = await readTable(); guard();
        if (table[key]) throw new Error('上次送达结果未确认，请先核对会话');
        if (Object.keys(table).length >= 100) throw new Error('未确认送达记录已满，请先核对原会话');
        table[key] = { pairing, deviceId, owner, operation: snapshot }; await write(table); guard();
      });
    },
    clear: (id: string) => serial(async () => {
      guard(); const table = await readTable(); guard(); if (table[key]?.operation.id !== id) return false;
      delete table[key]; await write(table); return true;
    }),
  };
}
export function clearDirectPendingOperationScope(pairing: string): Promise<void> {
  return serial(async () => { const table = await readTable(); for (const [key, row] of Object.entries(table)) if (row.pairing === pairing) delete table[key]; await write(table); });
}
