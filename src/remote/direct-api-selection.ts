import { getSetting, setSetting } from '../storage/database';
import { directDraftKey } from './direct-composer-drafts';
import { parseAgentStatus, type AgentStatus } from './projection';

export interface DirectApiSelection { id: string; agentId: string; accountId: string; sessionKey?: string }
type Row = { pairing: string; deviceId: string; family: string; selection: DirectApiSelection };
const SETTING = 'direct_api_selections_v1';
let writes: Promise<unknown> = Promise.resolve();
const serial = <T,>(fn: () => Promise<T>): Promise<T> => { const result = writes.then(fn); writes = result.catch(() => undefined); return result; };
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const agentId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
const valid = (value: unknown): value is DirectApiSelection => record(value)
  && typeof value.id === 'string' && /^[a-f0-9-]{36}$/i.test(value.id) && agentId(value.agentId)
  && typeof value.accountId === 'string' && (value.accountId === '' || /^api_[a-f0-9]{8,64}$/.test(value.accountId))
  && (value.sessionKey === undefined || typeof value.sessionKey === 'string' && value.sessionKey.length > 0 && value.sessionKey.length <= 512 && !/[\r\n\0]/.test(value.sessionKey))
  && Object.keys(value).every(key => ['id', 'agentId', 'accountId', 'sessionKey'].includes(key));
const keyFor = (pairing: string, deviceId: string, family: string) => `${directDraftKey(pairing, deviceId, family)}:api`;
async function readTable(): Promise<Record<string, Row>> {
  const raw = await getSetting(SETTING);
  if (raw === null) return Object.create(null);
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('API 切换记录无法读取，请先核对电脑'); }
  if (raw.length > 500_000 || !record(value) || Object.keys(value).length > 100) throw new Error('API 切换记录无效');
  for (const [key, row] of Object.entries(value)) if (!record(row)
    || typeof row.pairing !== 'string' || !row.pairing || row.pairing.length > 4096
    || typeof row.deviceId !== 'string' || !row.deviceId || row.deviceId.length > 256
    || !agentId(row.family) || !valid(row.selection) || key !== keyFor(row.pairing, row.deviceId, row.family)
    || Object.keys(row).some(field => !['pairing', 'deviceId', 'family', 'selection'].includes(field))) throw new Error('API 切换记录来源无效');
  return Object.assign(Object.create(null), value);
}

/** Stores only opaque account handles. A missing reply never becomes an automatic retry. */
export function createDirectApiSelectionStore(pairing: string, deviceId: string, family: string, isCurrent: () => boolean) {
  const key = keyFor(pairing, deviceId, family);
  const guard = () => { if (!isCurrent()) throw new Error('直连来源已变化，API 切换记录已保留'); };
  return {
    key,
    read: () => serial(async () => { guard(); const table = await readTable(); guard(); return table[key]?.selection; }),
    begin: (selection: DirectApiSelection) => serial(async () => {
      guard(); if (!valid(selection)) throw new Error('API 切换请求无效');
      const table = await readTable(); guard();
      if (table[key]) throw new Error('上次 API 切换结果待核对');
      if (Object.keys(table).length >= 100) throw new Error('请先核对已有的 API 切换记录');
      table[key] = { pairing, deviceId, family, selection: { ...selection } };
      await setSetting(SETTING, JSON.stringify(table)); guard();
    }),
    clear: (id: string) => serial(async () => {
      guard(); const table = await readTable(); guard();
      if (table[key]?.selection.id !== id) return false;
      delete table[key]; await setSetting(SETTING, JSON.stringify(table)); return true;
    }),
  };
}

export function clearDirectApiSelectionScope(pairing: string) {
  return serial(async () => {
    const table = await readTable();
    for (const [key, row] of Object.entries(table)) if (row.pairing === pairing) delete table[key];
    await setSetting(SETTING, JSON.stringify(table));
  });
}

/** Built-in parser fallbacks must never count as a computer acknowledgement. */
export function verifiedDirectApiStatus(raw: unknown, selection: DirectApiSelection): AgentStatus | undefined {
  if (!record(raw) || !Array.isArray(raw.agents)) return undefined;
  const item = raw.agents.find(value => record(value) && value.id === selection.agentId);
  if (!record(item) || !record(item.api) || item.api.pending !== false) return undefined;
  const api = item.api;
  if (selection.accountId
    ? api.source !== 'phone' || api.accountId !== selection.accountId || api.configured !== true
    : api.source !== 'computer' && api.source !== 'tool') return undefined;
  const parsed = parseAgentStatus(raw);
  return parsed.agents.some(profile => profile.id === selection.agentId && profile.available) ? parsed : undefined;
}
