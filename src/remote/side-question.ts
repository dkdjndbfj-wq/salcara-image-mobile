import { contextBytes, validContextReferences, type ContextReference } from './context-references';
import { sessionKeyAgentId } from './projection';
import { isEffort, type Effort } from './effort';
import {parseSideToolOptions,type SideToolOptions} from './side-question-tools';

export interface SideQuestionInputOptions { version: 1; model: boolean; effort: boolean; images: boolean; readOnly: true; defaultModel: string; tools?:SideToolOptions }
export interface TemporarySideQuestionInput extends SideQuestionInput { model?: string; effort?: Effort; attachments?: string[] }

export interface SideQuestionCatalog {
  sessionKey: string; revision: string; available: boolean; contextScope: 'loadedSnapshot'; contextMessages: number; contextTruncated: boolean; unavailableReason?: string;
  inputOptions?: SideQuestionInputOptions;
}
export interface SideQuestionReading { scope: string; value: SideQuestionCatalog; conversation?: SideQuestionRemoteConversation }
export interface SideQuestionRemoteTurn {
  operationId: string; question: string; selection?: ContextReference; answer: string;
  state: 'completed' | 'unconfirmed' | 'pending'; error?: string; createdAt: number;
}
export interface SideQuestionRemoteConversation extends SideQuestionCatalog {
  chainId: string; lastOperationId?: string; turns: SideQuestionRemoteTurn[]; nextCursor?: string; deleted?: boolean;
}
export interface SideQuestionInput { question: string; selection?: ContextReference; previousOperationId?: string }
/** Only local pre-dispatch admission may use this error. Network failures or
 * server error strings never prove that a request was not delivered. */
export class SideQuestionNotDispatchedError extends Error {
  constructor(message = '这次侧问尚未发送，请重新确认来源后发送') { super(message); this.name = 'SideQuestionNotDispatchedError'; }
}
export function sameSideQuestionSelection(a?: ContextReference, b?: ContextReference): boolean {
  if (!a || !b) return a === b;
  return Object.keys({ ...a, ...b }).every(key => a[key as keyof ContextReference] === b[key as keyof ContextReference]);
}
export interface SideQuestionResult {
  sessionKey: string; operationId: string; state: 'completed' | 'unconfirmed'; answer: string;
  contextScope: 'loadedSnapshot'; contextMessages: number; contextTruncated: boolean; usage?: { inputTokens: number; outputTokens: number }; error?: string;
  createdAt?: number; conversation?: SideQuestionRemoteConversation;
}
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const safeNumber = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\s\p{Cc}\p{Cf}]/u.test(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const plainText = (value: unknown, max: number): value is string => typeof value === 'string' && contextBytes(value) <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
export function validSideQuestionInput(sessionKey: string, input: SideQuestionInput): boolean {
  return typeof input.question === 'string' && input.question === input.question.trim() && Boolean(input.question) && [...input.question].length <= 4000
    && !/[\p{Cc}\p{Cf}]/u.test(input.question.replace(/[\n\t]/g, ''))
    && (input.previousOperationId === undefined || uuid(input.previousOperationId) && input.selection === undefined)
    && (input.selection === undefined || input.selection.kind === 'message' && input.selection.sessionKey === sessionKey && validContextReferences([input.selection]));
}
export function parseSideQuestionCatalog(value: unknown, sessionKey: string): SideQuestionCatalog | undefined {
  const raw = record(value);
  if (!raw || !sessionKeyAgentId(sessionKey) || raw.sessionKey !== sessionKey || raw.contextScope !== 'loadedSnapshot' || !safeNumber(raw.contextMessages) || raw.contextMessages > 80
    || typeof raw.contextTruncated !== 'boolean' || typeof raw.available !== 'boolean' || typeof raw.revision !== 'string' || raw.revision.length > 256
    || raw.available && (!id(raw.revision) || raw.contextMessages === 0) || raw.unavailableReason !== undefined && !plainText(raw.unavailableReason, 4096)) return;
  const options = record(raw.inputOptions);
  if (raw.inputOptions !== undefined && (!options || options.version !== 1 || options.readOnly !== true || typeof options.model !== 'boolean' || typeof options.effort !== 'boolean' || typeof options.images !== 'boolean' || !plainText(options.defaultModel, 200) || !options.defaultModel.trim())) return;
  return { sessionKey, revision: raw.revision, available: raw.available, contextScope: 'loadedSnapshot', contextMessages: raw.contextMessages, contextTruncated: raw.contextTruncated,
    ...(options ? { inputOptions: {version:1,model:options.model as boolean,effort:options.effort as boolean,images:options.images as boolean,readOnly:true,defaultModel:options.defaultModel as string,...(parseSideToolOptions(options.tools)?{tools:parseSideToolOptions(options.tools)}:{})} as SideQuestionInputOptions } : {}),
    ...(raw.unavailableReason ? { unavailableReason: raw.unavailableReason as string } : {}) };
}
export function validTemporarySideQuestionInput(reading: SideQuestionReading, input: TemporarySideQuestionInput): boolean {
  const options = reading.value.inputOptions;
  return validSideQuestionInput(reading.value.sessionKey, input)
    && (input.model === undefined || options?.model === true && plainText(input.model, 200) && Boolean(input.model.trim()) && input.model === input.model.trim())
    && (input.effort === undefined || options?.effort === true && isEffort(input.effort) && Boolean(input.model))
    && (input.attachments === undefined || options?.images === true && Array.isArray(input.attachments) && input.attachments.length <= 4 && input.attachments.every(value => typeof value === 'string' && /^att_[a-f0-9]{32}$/.test(value)));
}
export function parseSideQuestionResult(value: unknown, reading: SideQuestionReading, operationId: string): SideQuestionResult | undefined {
  const raw = record(value), catalog = reading.value;
  if (!raw || raw.sessionKey !== catalog.sessionKey || raw.operationId !== operationId || raw.state !== 'completed' && raw.state !== 'unconfirmed'
    || raw.contextScope !== 'loadedSnapshot' || raw.contextMessages !== catalog.contextMessages || raw.contextTruncated !== catalog.contextTruncated
    || !plainText(raw.answer, 16 * 1024) || raw.state === 'completed' && !raw.answer.trim() || raw.error !== undefined && !plainText(raw.error, 4096)) return;
  const usage = raw.usage == null ? undefined : record(raw.usage);
  if (raw.usage != null && (!usage || !safeNumber(usage.inputTokens) || !safeNumber(usage.outputTokens))) return;
  return { sessionKey: catalog.sessionKey, operationId, state: raw.state, answer: raw.answer, contextScope: 'loadedSnapshot', contextMessages: catalog.contextMessages,
    contextTruncated: catalog.contextTruncated, ...(usage ? { usage: { inputTokens: usage.inputTokens as number, outputTokens: usage.outputTokens as number } } : {}), ...(raw.error ? { error: raw.error as string } : {}) };
}

/** A restored transcript is data. Only the current transport scope and the
 * freshly returned revision may authorize a subsequent model request. */
export function parseSideQuestionConversation(value: unknown, sessionKey: string, chainId: string): SideQuestionRemoteConversation | undefined {
  const raw = record(value), catalog = parseSideQuestionCatalog(value, sessionKey);
  if (!raw || !catalog || !uuid(chainId) || raw.chainId !== chainId || !Array.isArray(raw.turns) || raw.turns.length > 50
    || raw.lastOperationId !== undefined && !uuid(raw.lastOperationId)
    || raw.nextCursor !== undefined && (typeof raw.nextCursor !== 'string' || !/^\d{1,20}$/.test(raw.nextCursor))
    || raw.deleted !== undefined && typeof raw.deleted !== 'boolean' || raw.deleted === true && catalog.available) return;
  const turns: SideQuestionRemoteTurn[] = [], ids = new Set<string>();
  for (const entry of raw.turns) {
    const turn = record(entry);
    if (!turn || !uuid(turn.operationId) || ids.has(turn.operationId) || !safeNumber(turn.createdAt)
      || !['completed', 'unconfirmed', 'pending'].includes(String(turn.state)) || !plainText(turn.answer, 16 * 1024)
      || turn.state === 'completed' && !turn.answer.trim() || turn.error !== undefined && !plainText(turn.error, 4096)
      || !validSideQuestionInput(sessionKey, { question: turn.question as string, ...(turn.selection !== undefined ? { selection: turn.selection as ContextReference } : {}) })) return;
    ids.add(turn.operationId);
    turns.push({ operationId: turn.operationId, question: turn.question as string, answer: turn.answer, state: turn.state as SideQuestionRemoteTurn['state'], createdAt: turn.createdAt,
      ...(turn.selection !== undefined ? { selection: { ...turn.selection as ContextReference } } : {}), ...(turn.error ? { error: turn.error as string } : {}) });
  }
  return { ...catalog, chainId, turns, ...(raw.lastOperationId ? { lastOperationId: raw.lastOperationId as string } : {}),
    ...(raw.nextCursor !== undefined ? { nextCursor: raw.nextCursor as string } : {}), ...(raw.deleted !== undefined ? { deleted: raw.deleted as boolean } : {}) };
}
