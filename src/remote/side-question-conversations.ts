import { randomUUID } from 'expo-crypto';
import { sha256 } from '@noble/hashes/sha2.js';
import { getSetting, setSetting } from '../storage/database';
import { copyContextReferences, validContextReferences, type ContextReference } from './context-references';
import { SideQuestionNotDispatchedError, sameSideQuestionSelection, validSideQuestionInput, type SideQuestionInput, type SideQuestionResult, type SideQuestionRemoteConversation } from './side-question';

export interface SideQuestionExchange {
  operationId: string; question: string; selection?: ContextReference; answer: string; createdAt: number;
}
export interface SideQuestionConversation {
  id: string; sessionKey: string; createdAt: number; updatedAt: number; draft: string;
  selection?: ContextReference; exchanges: SideQuestionExchange[];
  opened?: boolean; openAttempted?: boolean; deletedOnComputer?: boolean; deleteOperationId?: string; lastOperationId?: string; lastOperationCreatedAt?: number;
  unread?: boolean;
  pending?: { operationId: string; input: SideQuestionInput; state: 'sending' | 'unconfirmed' };
  error?: string;
}
export interface SideQuestionConversations {
  version: 1; scope: string; expanded: boolean; activeId?: string; conversations: SideQuestionConversation[];
}
const queues = new Map<string, Promise<unknown>>(), listeners = new Map<string, Set<() => void>>();
const snapshots = new Map<string, SideQuestionConversations>();
const flights = new Map<string, Promise<void>>();
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value);
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const storageKey = (scope: string) => `remote_side_questions_v1_${Array.from(sha256(new TextEncoder().encode(scope)), byte => byte.toString(16).padStart(2, '0')).join('')}`;
const indexKey = (owner: string) => storageKey(`history-owner:${owner}`);
const viewKey = (scope: string) => storageKey(`history-view:${scope}`);
const blank = (scope: string): SideQuestionConversations => ({ version: 1, scope, expanded: false, conversations: [] });
const issue = () => new Error('侧问记录无法读取，原记录仍保留，请检查应用存储');
function validExchange(value: unknown, sessionKey: string): value is SideQuestionExchange {
  return object(value) && uuid(value.operationId) && Number.isSafeInteger(value.createdAt) && typeof value.question === 'string' && typeof value.answer === 'string'
    && value.answer.length <= 16 * 1024 && Boolean(value.answer.trim())
    && validSideQuestionInput(sessionKey, { question: value.question, ...(value.selection ? { selection: value.selection as ContextReference } : {}) });
}
function decode(raw: string | null, scope: string): SideQuestionConversations {
  if (raw === null) return blank(scope);
  let value: unknown; try { value = JSON.parse(raw); } catch { throw issue(); }
  if (!object(value) || value.version !== 1 || value.scope !== scope || typeof value.expanded !== 'boolean' || !Array.isArray(value.conversations)
    || value.activeId !== undefined && !uuid(value.activeId)) throw issue();
  const ids = new Set<string>();
  for (const conversation of value.conversations) {
    if (!object(conversation) || !uuid(conversation.id) || ids.has(conversation.id) || typeof conversation.sessionKey !== 'string'
      || !Number.isSafeInteger(conversation.createdAt) || !Number.isSafeInteger(conversation.updatedAt) || typeof conversation.draft !== 'string' || conversation.draft.length > 8000
      || conversation.opened !== undefined && typeof conversation.opened !== 'boolean' || conversation.deletedOnComputer !== undefined && typeof conversation.deletedOnComputer !== 'boolean'
      || conversation.openAttempted !== undefined && typeof conversation.openAttempted !== 'boolean'
      || conversation.unread !== undefined && typeof conversation.unread !== 'boolean'
      || conversation.deleteOperationId !== undefined && !uuid(conversation.deleteOperationId) || conversation.lastOperationId !== undefined && !uuid(conversation.lastOperationId)
      || conversation.lastOperationCreatedAt !== undefined && !Number.isSafeInteger(conversation.lastOperationCreatedAt)
      || !Array.isArray(conversation.exchanges) || !conversation.exchanges.every(exchange => validExchange(exchange, conversation.sessionKey as string))
      || conversation.selection !== undefined && (!validContextReferences([conversation.selection as ContextReference]) || (conversation.selection as ContextReference).kind !== 'message' || (conversation.selection as ContextReference & { sessionKey: string }).sessionKey !== conversation.sessionKey)
      || conversation.error !== undefined && typeof conversation.error !== 'string') throw issue();
    ids.add(conversation.id);
    if (conversation.pending !== undefined) {
      const pending = conversation.pending;
      if (!object(pending) || !uuid(pending.operationId) || !object(pending.input) || !['sending', 'unconfirmed'].includes(String(pending.state))
        || !validSideQuestionInput(conversation.sessionKey, pending.input as unknown as SideQuestionInput)) throw issue();
      // Reading saved state never replays a model request. A request may have
      // completed on the computer while this app was stopped.
      pending.state = 'unconfirmed';
    }
  }
  if (value.activeId !== undefined && !ids.has(value.activeId as string)) throw issue();
  return value as unknown as SideQuestionConversations;
}
function enqueue<T>(scope: string, work: () => Promise<T>): Promise<T> {
  const promise = (queues.get(scope) ?? Promise.resolve()).then(work);
  queues.set(scope, promise.catch(() => undefined)); return promise;
}
function emit(scope: string, value: SideQuestionConversations) {
  snapshots.set(scope, value); listeners.get(scope)?.forEach(listener => listener());
}
async function current(scope: string): Promise<SideQuestionConversations> {
  if (!scope || scope.length > 8192) throw issue();
  return snapshots.get(scope) ?? decode(await getSetting(storageKey(scope)), scope);
}
export function loadSideQuestionConversations(scope: string): Promise<SideQuestionConversations> {
  return enqueue(scope, async () => { const value = await current(scope); emit(scope, value); return copy(value); });
}
export async function rememberSideQuestionViewScope(owner: string, scope: string, stillCurrent: () => boolean = () => true): Promise<void> {
  if (!owner || owner.length > 8192 || !scope || scope.length > 8192) throw issue();
  await enqueue(viewKey(owner), async () => { if (stillCurrent()) await setSetting(viewKey(owner), JSON.stringify({ owner, scope })); });
}
export async function restoreSideQuestionViewScope(owner: string): Promise<string | undefined> {
  const raw = await getSetting(viewKey(owner)); if (raw === null) return;
  let value: unknown; try { value = JSON.parse(raw); } catch { throw issue(); }
  if (!object(value) || value.owner !== owner || typeof value.scope !== 'string' || !value.scope || value.scope.length > 8192) throw issue();
  return value.scope;
}
/** The index can restore local history without live agent profiles. It carries
 * no revision, grant, request, model credential or authority to send. */
export async function rememberSideQuestionHistoryScope(owner: string, scope: string): Promise<void> {
  if (!owner || owner.length > 8192 || !scope || scope.length > 8192) throw issue();
  await setSetting(indexKey(owner), JSON.stringify({ version: 1, owner, scope }));
}
export async function restoreSideQuestionHistoryScope(owner: string): Promise<string | undefined> {
  if (!owner || owner.length > 8192) return;
  const stored = await getSetting(indexKey(owner)); if (stored === null) return;
  let value: unknown; try { value = JSON.parse(stored); } catch { throw issue(); }
  if (!object(value) || value.version !== 1 || value.owner !== owner || typeof value.scope !== 'string' || !value.scope || value.scope.length > 8192) throw issue();
  return value.scope;
}
export function sideQuestionConversationsSnapshot(scope: string): SideQuestionConversations | undefined { return snapshots.get(scope); }
export function subscribeSideQuestionConversations(scope: string, listener: () => void): () => void {
  const set = listeners.get(scope) ?? new Set<() => void>(); set.add(listener); listeners.set(scope, set);
  return () => { set.delete(listener); if (!set.size) listeners.delete(scope); };
}
function edit(scope: string, update: (value: SideQuestionConversations) => void): Promise<SideQuestionConversations> {
  return enqueue(scope, async () => {
    const value = copy(await current(scope)); update(value);
    // No TTL, count eviction, or overwrite of a corrupt record. Storage failure
    // leaves the previous durable state intact and prevents a new send.
    await setSetting(storageKey(scope), JSON.stringify(value)); emit(scope, value); return copy(value);
  });
}
export function createSideQuestionConversation(scope: string, sessionKey: string, selection?: ContextReference): Promise<SideQuestionConversations> {
  if (selection && (!validContextReferences([selection]) || selection.kind !== 'message' || selection.sessionKey !== sessionKey)) return Promise.reject(issue());
  return edit(scope, value => {
    const id = randomUUID(), now = Date.now();
    value.conversations.push({ id, sessionKey, createdAt: now, updatedAt: now, draft: '', exchanges: [], ...(selection ? { selection: copyContextReferences([selection])![0] } : {}) });
    value.activeId = id; value.expanded = true;
  });
}
export function updateSideQuestionPresentation(scope: string, patch: { expanded?: boolean; activeId?: string }): Promise<SideQuestionConversations> {
  return edit(scope, value => {
    if (patch.expanded !== undefined) value.expanded = patch.expanded;
    if (patch.activeId !== undefined && value.conversations.some(item => item.id === patch.activeId)) value.activeId = patch.activeId;
    if (value.expanded) { const row = value.conversations.find(item => item.id === value.activeId); if (row) row.unread = false; }
  });
}
export function updateSideQuestionDraft(scope: string, id: string, draft: string): Promise<SideQuestionConversations> {
  return edit(scope, value => { const row = value.conversations.find(item => item.id === id); if (row && draft.length <= 8000) { row.draft = draft; row.updatedAt = Date.now(); } });
}
export function markSideQuestionOpening(scope: string, id: string): Promise<SideQuestionConversations> {
  return edit(scope, value => { const row = value.conversations.find(item => item.id === id); if (row) row.openAttempted = true; });
}
export function deleteLocalSideQuestionConversation(scope: string, id: string): Promise<SideQuestionConversations> {
  return edit(scope, value => {
    value.conversations = value.conversations.filter(item => item.id !== id);
    if (value.activeId === id) value.activeId = value.conversations[value.conversations.length - 1]?.id;
    if (!value.conversations.length) value.expanded = false;
  });
}
export function reconcileSideQuestionConversation(scope: string, id: string, remote: SideQuestionRemoteConversation, historyOnly = false): Promise<SideQuestionConversations> {
  return edit(scope, value => {
    const row = value.conversations.find(item => item.id === id); if (!row) return;
    if (remote.chainId !== id || remote.sessionKey !== row.sessionKey) throw issue();
    const exchanges: SideQuestionExchange[] = remote.turns.filter(turn => turn.state === 'completed').map(turn => ({ operationId: turn.operationId, question: turn.question,
      answer: turn.answer, createdAt: turn.createdAt, ...(turn.selection ? { selection: turn.selection } : {}) }));
    if (exchanges.some(exchange => !validExchange(exchange, row.sessionKey))) throw issue();
    const knownOperations = new Set(row.exchanges.map(turn => turn.operationId));
    // A paginated/read-limited server response cannot erase older local history.
    for (const exchange of exchanges) {
      const existing = row.exchanges.find(item => item.operationId === exchange.operationId);
      if (existing && (existing.question !== exchange.question || existing.answer !== exchange.answer || !sameSideQuestionSelection(existing.selection, exchange.selection))) throw new Error('侧问历史校验不一致，已保留本地记录');
      if (!existing) row.exchanges.push(copy(exchange));
    }
    row.exchanges.sort((a, b) => a.createdAt - b.createdAt);
    row.opened = true; row.deletedOnComputer = remote.deleted === true;
    const remoteHead = remote.turns.find(turn => turn.operationId === remote.lastOperationId);
    const localHeadTime = row.lastOperationCreatedAt ?? row.exchanges.find(turn => turn.operationId === row.lastOperationId)?.createdAt ?? 0;
    const advances = remoteHead && (remoteHead.createdAt > localHeadTime || remoteHead.createdAt === localHeadTime && !knownOperations.has(remoteHead.operationId));
    if (!historyOnly && (!row.lastOperationId || row.lastOperationId === remote.lastOperationId || advances)) {
      row.lastOperationId = remote.lastOperationId;
      row.lastOperationCreatedAt = remoteHead?.createdAt ?? row.lastOperationCreatedAt;
    }
    if (historyOnly) return; // A historical page is not a new send head.
    const pending = remote.turns.find(turn => turn.state !== 'completed');
    if (pending && !row.pending) row.pending = { operationId: pending.operationId, input: { question: pending.question, ...(pending.selection ? { selection: pending.selection } : {}) }, state: 'unconfirmed' };
    if (row.pending && row.exchanges.some(item => item.operationId === row.pending!.operationId)) {
      if (row.draft.trim() === row.pending.input.question) row.draft = '';
      delete row.pending; delete row.error;
    } else if (row.pending) {
      if (!flights.has(`${scope}|${id}`)) row.pending.state = 'unconfirmed';
      row.error = pending?.operationId === row.pending.operationId ? '电脑仍在确认上次侧问，请刷新结果' : '上次结果尚未确认，请勿重复发送';
    }
  });
}
export function submitSideQuestionConversation(scope: string, id: string, input: SideQuestionInput,
  ask: (operationId: string) => Promise<SideQuestionResult>, isViewing?: () => boolean): Promise<void> {
  const key = `${scope}|${id}`, active = flights.get(key); if (active) return active;
  const operationId = randomUUID();
  const flight = (async () => {
    await edit(scope, value => {
      const row = value.conversations.find(item => item.id === id); if (!row) throw new Error('侧问已删除');
      if (row.pending) throw new Error('上次侧问结果未确认，请先刷新结果');
      if (row.deleteOperationId || row.deletedOnComputer) throw new Error('侧问已删除或正在确认删除');
      if (!validSideQuestionInput(row.sessionKey, input)) throw new Error('问题最多 4000 字，请检查所选内容');
      row.pending = { operationId, input: copy(input), state: 'sending' }; delete row.error;
    });
    try {
      const result = await ask(operationId);
      await edit(scope, value => {
        const row = value.conversations.find(item => item.id === id);
        if (!row || row.pending?.operationId !== operationId) return; // An explicit delete is final.
        if (result.operationId !== operationId || result.sessionKey !== row.sessionKey) throw new Error('侧问回执身份不一致');
        if (result.state !== 'completed') {
          row.pending.state = 'unconfirmed'; row.error = result.error || '结果尚未确认，请刷新结果';
          if (result.conversation?.lastOperationId === operationId) { row.lastOperationId = operationId; row.lastOperationCreatedAt = result.createdAt; }
          return;
        }
        row.exchanges.push({ operationId, question: input.question, ...(input.selection ? { selection: copy(input.selection) } : {}), answer: result.answer, createdAt: result.createdAt ?? Date.now() });
        if (row.draft.trim() === input.question) row.draft = '';
        delete row.pending; delete row.error; row.lastOperationId = operationId; row.lastOperationCreatedAt = result.createdAt ?? Date.now(); row.updatedAt = Date.now(); row.unread = !isViewing?.();
      });
    } catch (reason) {
      const markUnconfirmed = (value: SideQuestionConversations) => {
        const row = value.conversations.find(item => item.id === id); if (!row || row.pending?.operationId !== operationId) return;
        if (reason instanceof SideQuestionNotDispatchedError) { delete row.pending; row.error = `${reason.message}（本次未发送，草稿已保留）`; return; }
        row.pending.state = 'unconfirmed'; row.error = reason instanceof Error ? reason.message : '结果尚未确认，请刷新结果';
      };
      try { await edit(scope, markUnconfirmed); } catch (storageError) {
        // The durable pre-send receipt remains recoverable after restart. Let
        // the user retry a read once storage works instead of leaving a spinner.
        const cached = snapshots.get(scope); if (cached) { const value = copy(cached); markUnconfirmed(value); emit(scope, value); }
        throw storageError;
      }
    }
  })();
  flights.set(key, flight); void flight.finally(() => { if (flights.get(key) === flight) flights.delete(key); }).catch(() => undefined); return flight;
}
export async function deleteSideQuestionConversation(scope: string, id: string, remove: (operationId: string) => Promise<void>): Promise<void> {
  const state = await edit(scope, value => {
    const row = value.conversations.find(item => item.id === id); if (row) row.deleteOperationId ??= randomUUID();
  });
  const row = state.conversations.find(item => item.id === id); if (!row) return;
  if ((row.opened || row.openAttempted) && !row.deletedOnComputer) await remove(row.deleteOperationId!);
  await deleteLocalSideQuestionConversation(scope, id);
}
export function resetSideQuestionConversationsForTests(): void { queues.clear(); snapshots.clear(); listeners.clear(); flights.clear(); }
