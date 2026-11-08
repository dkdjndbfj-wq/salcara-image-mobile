import { randomUUID } from 'expo-crypto';
import { getSetting, setSetting } from '../storage/database';
import { copyTurnFeatures } from './agent-features';
import { createDirectComposerDraft, directDraftKey, type DirectDraftInput, type DirectSavedDraft } from './direct-composer-drafts';
import type { RemoteImage } from './attachments';

export type DirectQueueState = 'waiting' | 'attempting' | 'blocked' | 'unconfirmed';
export interface DirectQueueEntry {
  id: string;
  revision: number;
  state: DirectQueueState;
  afterTurnId?: string;
  reason?: string;
  /** Once dispatch preparation begins, editing/reordering cannot rewrite its identity. */
  attempted?: boolean;
  input: DirectDraftInput;
}
type StoredEntry = Omit<DirectQueueEntry, 'input'>;
type StoredQueue = { pairing: string; deviceId: string; owner: string; entries: StoredEntry[] };
type Table = Record<string, StoredQueue>;
export const MAX_DIRECT_QUEUE = 10;
const SETTING = 'direct_message_queues_v1';
let writes: Promise<unknown> = Promise.resolve();
const activeAttempts = new Map<string, number>();
const serial = <T,>(action: () => Promise<T>): Promise<T> => {
  const result = writes.then(action);
  writes = result.catch(() => undefined);
  return result;
};
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const validTurn = (value: unknown): boolean => value === undefined || typeof value === 'string' && value.length <= 512 && !/[\r\n\0]/.test(value);
async function readTable(): Promise<Table> {
  const text = await getSetting(SETTING);
  if (text === null) return Object.create(null) as Table;
  if (text.length > 500_000) throw new Error('本地排队记录超出限制，原内容未覆盖');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error('本地排队记录无法读取，原内容未覆盖'); }
  if (!record(parsed) || Object.keys(parsed).length > 20) throw new Error('本地排队记录无效，原内容未覆盖');
  for (const [key, queue] of Object.entries(parsed)) {
    if (!record(queue) || Object.keys(queue).some(field => !['pairing', 'deviceId', 'owner', 'entries'].includes(field))
      || typeof queue.pairing !== 'string' || !queue.pairing || queue.pairing.length > 4096
      || typeof queue.deviceId !== 'string' || !queue.deviceId || queue.deviceId.length > 256
      || typeof queue.owner !== 'string' || !queue.owner || queue.owner.length > 8192
      || key !== `${directDraftKey(queue.pairing, queue.deviceId, queue.owner)}:queue`
      || !Array.isArray(queue.entries) || queue.entries.length > MAX_DIRECT_QUEUE) throw new Error('本地排队来源无效，原内容未覆盖');
    const ids = new Set<string>();
    for (const entry of queue.entries) {
      if (!record(entry) || Object.keys(entry).some(field => !['id', 'revision', 'state', 'afterTurnId', 'reason', 'attempted'].includes(field))
        || !validId(entry.id) || ids.has(entry.id) || !Number.isSafeInteger(entry.revision) || Number(entry.revision) < 1 || Number(entry.revision) >= Number.MAX_SAFE_INTEGER - 1
        || !['waiting', 'attempting', 'blocked', 'unconfirmed'].includes(String(entry.state)) || !validTurn(entry.afterTurnId)
        || entry.reason !== undefined && (typeof entry.reason !== 'string' || entry.reason.length > 500)
        || entry.attempted !== undefined && typeof entry.attempted !== 'boolean') throw new Error('本地排队条目无效，原内容未覆盖');
      ids.add(entry.id);
    }
  }
  return Object.assign(Object.create(null), parsed) as Table;
}
const writeTable = (table: Table) => setSetting(SETTING, JSON.stringify(table));
const freezeInput = (input: DirectDraftInput): DirectDraftInput => ({
  text: input.text, options: copyTurnFeatures(input.options), model: input.model, effort: input.effort, permission: input.permission,
  images: input.images.map(image => ({ ...image })), imageCount: input.imageCount, missingImages: input.missingImages,
});
const EMPTY_INPUT: DirectDraftInput = { text: '', options: {}, model: '', effort: '', permission: '', images: [] };

/** Durable FIFO metadata; each payload reuses pairing-private composer image
 * storage, so queue bytes survive restart and remain visible to its collector.
 * A queued operation is never retried after an unknown dispatch result. */
export function createDirectMessageQueue({ pairing, deviceId, owner, isCurrent = () => true }: {
  pairing: string; deviceId: string; owner: string; isCurrent?: () => boolean;
}) {
  if (!pairing || pairing.length > 4096 || !deviceId || deviceId.length > 256 || !owner || owner.length > 8192) throw new Error('排队来源无效');
  const key = `${directDraftKey(pairing, deviceId, owner)}:queue`;
  let disposed = false;
  const claimedAttempts = new Map<string, number>();
  const attemptKey = (id: string) => `${key}:${id}`;
  const guard = () => { if (disposed || !isCurrent()) throw new Error('电脑、会话或 API 已变化，原排队消息已保留'); };
  const find = (table: Table, id: string, revision: number) => {
    const entry = table[key]?.entries.find(item => item.id === id);
    if (!entry || entry.revision !== revision) throw new Error('排队消息已改变，请重新读取');
    return entry;
  };
  const payloadOwner = (id: string) => `${owner}|queue:${id}`;
  const readPayload = async (entry: StoredEntry): Promise<DirectSavedDraft> => {
    const draft = createDirectComposerDraft(pairing, deviceId, payloadOwner(entry.id));
    try {
      const value = await draft.restore();
      if (!value) throw new Error('原排队内容无法恢复，不能发送空消息');
      return value;
    } finally { draft.close(); }
  };
  const entryValue = async (entry: StoredEntry): Promise<DirectQueueEntry> => ({ ...entry, input: freezeInput(await readPayload(entry)) });
  const clearPayload = async (id: string) => {
    const draft = createDirectComposerDraft(pairing, deviceId, payloadOwner(id));
    try { await draft.restore(); await draft.save(EMPTY_INPUT); } finally { draft.close(); }
  };
  const load = () => serial(async () => {
    guard();
    const table = await readTable(); guard();
    const rows = table[key]?.entries ?? [];
    let changed = false;
    for (const entry of rows) if (entry.state === 'attempting' && activeAttempts.get(attemptKey(entry.id)) !== entry.revision) {
      entry.state = 'unconfirmed'; entry.reason = '上次送达结果未确认，请先核对会话'; entry.revision += 1; changed = true;
    }
    if (changed) { guard(); await writeTable(table); }
    const result: DirectQueueEntry[] = [];
    for (const entry of rows) {
      try { result.push(await entryValue(entry)); }
      catch (error) {
        // Keep the metadata visible for recovery/removal; no automatic send.
        result.push({ ...entry, state: entry.state === 'unconfirmed' ? 'unconfirmed' : 'blocked', reason: error instanceof Error ? error.message : '排队内容无法恢复', input: { ...EMPTY_INPUT, images: [], options: {}, missingImages: true } });
      }
      guard();
    }
    return result;
  });
  const enqueue = (value: DirectDraftInput, afterTurnId?: string) => {
    const input = freezeInput(value);
    return serial(async () => {
      guard();
      if (!input.text.trim() && !input.images.length && !input.options.contextReferences?.length) throw new Error('请先输入排队消息');
      if (!validTurn(afterTurnId) || input.missingImages || (input.imageCount ?? input.images.length) !== input.images.length) throw new Error('排队消息的回合或图片尚未确认');
      const table = await readTable(); guard();
      const queue = table[key] ?? { pairing, deviceId, owner, entries: [] };
      if (queue.entries.length >= MAX_DIRECT_QUEUE || !table[key] && Object.keys(table).length >= 20) throw new Error('排队已满，内容仍保留在输入框');
      const entry: StoredEntry = { id: randomUUID(), revision: 1, state: 'waiting', attempted: false, ...(afterTurnId ? { afterTurnId } : {}) };
      const payload = createDirectComposerDraft(pairing, deviceId, payloadOwner(entry.id));
      let saved: DirectSavedDraft;
      try { await payload.restore(); guard(); saved = await payload.save(input); guard(); }
      catch (error) { payload.close(); await clearPayload(entry.id).catch(() => undefined); throw error; }
      payload.close();
      queue.entries.push(entry); table[key] = queue;
      try { guard(); await writeTable(table); }
      catch (error) { await clearPayload(entry.id).catch(() => undefined); throw error; }
      return { ...entry, input: freezeInput(saved!) };
    });
  };
  const markAttempting = (id: string, revision: number, terminalBeforeDispatch?: string) => serial(async () => {
    guard(); const table = await readTable(); guard();
    if (!validTurn(terminalBeforeDispatch)) throw new Error('回合边界无效');
    const entry = find(table, id, revision);
    if (table[key].entries[0] !== entry || entry.state !== 'waiting') throw new Error('请先处理前一条排队消息');
    const value = await entryValue(entry); guard();
    if (value.input.missingImages || (value.input.imageCount ?? value.input.images.length) !== value.input.images.length) throw new Error('原排队图片不可用，请先恢复原图');
    entry.state = 'attempting'; entry.attempted = true; entry.reason = undefined; entry.revision += 1;
    if (terminalBeforeDispatch) entry.afterTurnId = terminalBeforeDispatch;
    await writeTable(table);
    guard();
    activeAttempts.set(attemptKey(id), entry.revision);
    claimedAttempts.set(attemptKey(id), entry.revision);
    return { ...entry, input: value.input };
  });
  const block = (id: string, revision: number, reason: string, unconfirmed = false) => serial(async () => {
    guard(); const table = await readTable(); guard();
    const entry = find(table, id, revision);
    entry.state = unconfirmed ? 'unconfirmed' : 'blocked'; entry.reason = reason.slice(0, 500); entry.revision += 1;
    try { await writeTable(table); } finally { activeAttempts.delete(attemptKey(id)); }
    return entryValue(entry);
  });
  const resume = (id: string, revision: number, afterTurnId?: string) => serial(async () => {
    guard(); const table = await readTable(); guard();
    const entry = find(table, id, revision);
    if (entry.state !== 'blocked' || !validTurn(afterTurnId)) throw new Error('送达结果未确认，不能重新发送');
    const value = await entryValue(entry); guard();
    if (value.input.missingImages) throw new Error('原排队图片不可用，请先恢复原图');
    entry.state = 'waiting'; entry.reason = undefined; entry.afterTurnId = afterTurnId; entry.revision += 1;
    await writeTable(table); return { ...entry, input: value.input };
  });
  const remove = (id: string, revision: number) => serial(async () => {
    guard(); const table = await readTable(); guard();
    const entry = find(table, id, revision);
    if (entry.state === 'attempting') throw new Error('消息正在提交，请等待送达结果');
    if (!directQueueEditable(entry)) throw new Error('消息已尝试送达，请先核对送达状态');
    table[key].entries = table[key].entries.filter(row => row !== entry);
    if (!table[key].entries.length) delete table[key];
    await writeTable(table); activeAttempts.delete(attemptKey(id));
    await clearPayload(id).catch(() => undefined);
  });
  const consume = (id: string, revision: number, nextAfterTurnId: string) => serial(async () => {
    guard(); if (!nextAfterTurnId || !validTurn(nextAfterTurnId)) throw new Error('缺少已发送消息的回合边界');
    const table = await readTable(); guard(); const entry = find(table, id, revision);
    if (entry.state !== 'attempting' && entry.state !== 'unconfirmed') throw new Error('没有可确认的送达记录');
    table[key].entries = table[key].entries.filter(row => row !== entry).map(row => ({ ...row, afterTurnId: nextAfterTurnId, revision: row.revision + 1 }));
    if (!table[key].entries.length) delete table[key];
    try { await writeTable(table); } finally { activeAttempts.delete(attemptKey(id)); }
    await clearPayload(id).catch(() => undefined);
  });
  const hydrate = (entry: DirectQueueEntry): Promise<RemoteImage[]> => serial(async () => {
    guard(); const table = await readTable(); guard(); find(table, entry.id, entry.revision);
    const payload = createDirectComposerDraft(pairing, deviceId, payloadOwner(entry.id));
    try {
      const saved = await payload.restore(); guard();
      if (!saved || saved.missingImages) throw new Error('原排队图片不可用，请先恢复原图');
      const images = await payload.hydrate(saved); guard(); return images;
    } finally { payload.close(); }
  });
  const pauseRows = (rows: StoredEntry[]) => {
    for (const row of rows) if (row.state === 'waiting') {
      row.attempted ??= false; row.state = 'blocked'; row.reason = '队列已暂停，请明确继续发送'; row.revision += 1;
    }
  };
  const pause = () => serial(async () => {
    guard(); const table = await readTable(); guard();
    if (table[key]) { pauseRows(table[key].entries); await writeTable(table); }
  });
  const editText = (id: string, revision: number, text: string) => serial(async () => {
    guard(); const table = await readTable(); guard(); const row = find(table, id, revision);
    if (!directQueueEditable(row)) throw new Error('这条消息已经尝试送达，不能修改');
    const original = await entryValue(row); guard();
    if (text.length > 100_000 || !text.trim() && !original.input.images.length && !original.input.options.contextReferences?.length) throw new Error('请输入消息内容');
    // Never overwrite the original payload before its metadata replacement commits.
    const replacement: StoredEntry = { ...row, id: randomUUID(), revision: 1, state: 'blocked', attempted: false, reason: '内容已修改，请明确继续发送' };
    const draft = createDirectComposerDraft(pairing, deviceId, payloadOwner(replacement.id));
    try {
      await draft.restore(); guard(); await draft.save({ ...original.input, text }); guard();
      table[key].entries[table[key].entries.indexOf(row)] = replacement;
      pauseRows(table[key].entries); guard(); await writeTable(table);
    } catch (error) { await clearPayload(replacement.id).catch(() => undefined); throw error; }
    finally { draft.close(); }
    await clearPayload(row.id).catch(() => undefined);
    return entryValue(replacement);
  });
  const move = (id: string, revision: number, offset: -1 | 1) => serial(async () => {
    guard(); const table = await readTable(); guard(); const row = find(table, id, revision), rows = table[key].entries;
    const index = rows.indexOf(row), adjacent = rows[index + offset];
    if (!directQueueEditable(row) || !adjacent || !directQueueEditable(adjacent)) throw new Error('只能调整尚未尝试发送的消息');
    [rows[index], rows[index + offset]] = [adjacent, row]; pauseRows(rows);
    row.revision += 1; adjacent.revision += 1; await writeTable(table);
  });
  const dispose = () => {
    disposed = true;
    for (const [attempt, revision] of claimedAttempts) if (activeAttempts.get(attempt) === revision) activeAttempts.delete(attempt);
    claimedAttempts.clear();
  };
  return { key, load, enqueue, markAttempting, block, resume, remove, consume, reconcileAccepted: consume, hydrate, pause, editText, move, dispose };
}
export function directQueueEditable(entry: Pick<DirectQueueEntry, 'state' | 'attempted'>): boolean {
  return entry.attempted !== true && (entry.state === 'waiting' || entry.state === 'blocked' && entry.attempted === false);
}
export type DirectMessageQueue = ReturnType<typeof createDirectMessageQueue>;

/** Pairing revocation already clears composer payloads; also retire its index. */
export function clearDirectMessageQueueScope(pairing: string): Promise<void> {
  return serial(async () => {
    const table = await readTable();
    for (const [key, queue] of Object.entries(table)) if (queue.pairing === pairing) {
      delete table[key];
      for (const entry of queue.entries) activeAttempts.delete(`${key}:${entry.id}`);
    }
    await writeTable(table);
  });
}
