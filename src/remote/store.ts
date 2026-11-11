import {missingSessionReadCode} from './missing-session-error';
import {latestEditableTurn,parseSessionRevertResult,type SessionRevertRequest} from './session-revert';
import type {SentUserMessage} from './sent-message-revision';
import { executionRetryAt } from './execution-retry';
import { cooperationCandidate, parseCooperationReading, readCooperationReceipts, saveCooperationReceipt, type CooperationReading, type CooperationReceipt } from './cooperation';
import { durableExecutionId, executeDurableCommand, pruneDurableCommandBodies, supportsDurableCommand } from './durable-commands';
import { bindDeliveryExecution, deliveryUsesDurableProtocol } from './delivery';
import { commitDurableEvents, loadDurableEvents, pruneDurableEvents } from './durable-events';
import { collectAttachmentCache } from './attachment-cache-policy';
import { acknowledgeSessionEvents } from './client';
import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { parseBrowserNavigation, type BrowserNavigation } from './browser-navigation';
import { parseComputerActivity, type ComputerActivity } from './computer-activity';

import type { ProviderProfile } from '../domain';
import { getSetting, setSetting } from '../storage/database';
import { connectionFailure, connectionProblem, type ConnectionProblem } from './connection-errors';
import { readPreferredAgent, rememberPreferredAgent, type AgentPreferenceScope } from './agent-preferences';
import {
  command, confirmPair, confirmQrPair, devices as fetchDevices, discoverStation, discoverSavedStation, hubUrlFor, HubError, isExecutionPolicyError, isPairingAuthenticationError, ping, revokePair, sessionEventsPage, parseFeatureChange, verifyHubAlias, confirmPairingHubIdentity,
  type AgentId, type AgentProfile, type ApprovalMode, type AttachmentRef, type Command, type Decision, type DeviceStatus, type Effort, type Hub, type HubEvent, type Project, type ClaudeDesktopScope, type WorkspaceMode,
  type RemoteApiOption, type SessionInfo, type ToolId, type ToolKind, type Usage, type PermissionMode,
  type RemoteQuestion, type QuestionAnswers, type ModelCapability, type ModelCatalog,
  type MessageOrigin, type AgentCapabilities, type InterruptResult,
} from './client';
import { messageContextReferences } from './conversation-metadata';
import { hasDiffAnnotations, hasResponseAnnotations, validateContextPrompt, type ContextReference } from './context-references';
import { diffReviewProblem } from './diff-review';
import { copyTurnFeatures, validTurnFeatures, type AgentFeatures, type TurnFeatures, type SkillReference } from './agent-features';
import { AgentFeatureCache, type AgentFeatureScope } from './agent-feature-cache';
import { contextCompactionBusy, parseSessionContext, type SessionContext } from './session-context';
import { parseManagedSession, parseNativeSessionActions, parseNativeSessionActionResult, validSessionName, type NativeSessionActionsReading, type NativeSessionActionResult, type SessionAction } from './session-actions';
import { parseSessionWorkflows, parseSessionWorkflowResult, validWorkflowInput, type SessionWorkflowsReading, type SessionWorkflowResult, type WorkflowInput, type GoalAction } from './session-workflows';
import { SideQuestionNotDispatchedError, parseSideQuestionConversation, sameSideQuestionSelection, validSideQuestionInput, type SideQuestionReading, type SideQuestionInput, type SideQuestionResult } from './side-question';
import { parseSideQuestionCatalog, parseSideQuestionResult, validTemporarySideQuestionInput, type TemporarySideQuestionInput } from './side-question';
import {parseSideToolState,type SideToolRequest,type SideToolState} from './side-question-tools';
import { rememberSideQuestionHistoryScope, restoreSideQuestionHistoryScope } from './side-question-conversations';
import { rememberSideQuestionPairing, sideQuestionHistoryScopes } from './side-question-history';
import { boundedClientId, messageOrigin, messageSkills } from './conversation-metadata';
import { approvalDecisions, normalizeApprovalOptions } from './approvals';
import type { ApprovalOptions } from './client';
import { claudeSessionAdmissionBlocked, CONTINUE_PROMPT, turnControlTarget, validTurnId } from './turn-control';
import { claudeApiAdmissionReady } from './api-admission';
import { eligibleApiStations, officialRemoteApi, remoteApiProblem } from './api-eligibility';
import { clearRemoteCache, loadCachedSessions, loadCachedThread, resetRemoteCacheForTests, saveCachedSessions, saveCachedThread } from './cache';
import { deletePairToken, getPairToken, savePairToken } from './pair-storage';
import { connectionId, connectionToken, deliveryCredentialId, forgetConnection, loadConnections, renameConnection as renameSavedConnection, saveConnection, selectConnection, selectConnectionIf, selectedConnection, type RemoteConnection } from './connections';
import { measureConnection } from './connection-diagnostics';
import { canonicalHubUrl, readPairQr, type PairQr } from './pairing';
import { phoneIdentity } from './phone-identity';
import { parseConnectionSync } from './connection-sync';
import { agentApiFamily, agentSupports, builtinAgent, validAgentId, sessionKeyAgentId, parseAgentStatus, resolveAgentExecution, desktopLiveFor, desktopApprovalFor, type AgentStatus } from './projection';
import { acknowledgeAcceptedDelivery, cancelPendingDelivery, pausePendingDelivery, deliverMessage, DeliveryPendingError, pendingDelivery, pendingDeliveriesForDevice, retireDeliveryScope, retiredDeliveryScopes, resetDeliveryForTests, type DeliveryDraftOwner, type PendingDelivery } from './delivery';
import { pendingQuestionReceiptsForDevice, questionCommandMatches, retireQuestionScope, type QuestionCommand } from './question-outbox';
import { ATTACHMENT_CHUNK, type RemoteImage } from './attachment-chunks';
import { randomUUID } from 'expo-crypto';
import * as FileSystem from 'expo-file-system/legacy';
import { sha256 } from '@noble/hashes/sha2.js';
import { CODEX_EFFORTS, isEffort } from './effort';
import { isApprovalMode, isPermissionMode } from './permission-mode';
import { ATTACHMENT_ID, ATTACHMENT_MIME, attachmentContentKey, attachmentRef, attachmentRefs, localImageUri, type LocalAttachment } from './attachment-ref';
import { cachedAttachment, parseAttachmentPage, resetAttachmentCacheForTests } from './attachment-cache';
import { decodeNewTask, encodeNewTask, newSessionReceiptKey, type NewTaskSnapshot } from './new-task';
export { newSessionReceiptKey } from './new-task';

// ——— timeline ———

export type TimelineItem = { turnId?: string } & (
  | { kind: 'message'; id: string; role: 'user' | 'assistant'; text: string; final: boolean; streamState?: 'terminal-unconfirmed' | 'incomplete'; ts: number; seq?: number; orderSeq?: number; local?: boolean; images?: string[]; attachments?: LocalAttachment[]; parentId?: string; clientId?: string; messagePhase?: 'commentary' | 'final_answer'; messageOrigin?: MessageOrigin; skills?: SkillReference[]; contextReferences?: ContextReference[] }
  | { kind: 'reasoning'; id: string; text: string; final: boolean; ts: number; seq?: number; orderSeq?: number; parentId?: string }
  | { kind: 'tool'; id: string; tool: ToolKind; title: string; detail?: string; status: 'running' | 'done' | 'failed' | 'interrupted'; output?: string; outputFinal?: boolean; planKind?: 'proposal' | 'tasks'; diff?: string; exitCode?: number; startedAt?: number; durationMs?: number; ts: number; seq?: number; orderSeq?: number; parentId?: string; childSessionKeys?: string[]; attachments?: LocalAttachment[]; browser?: BrowserNavigation; computer?: ComputerActivity }
  | { kind: 'approval'; id: string; approval: ApprovalKind; title: string; detail?: string; diff?: string; cwd?: string; state: 'pending' | Decision; by?: 'phone' | 'desktop' | 'timeout'; ts: number; seq?: number; orderSeq?: number; questions?: RemoteQuestion[]; questionMode?: string; expiresAt?: number; approvalTransport?: 'codex-hook-v1'; approvalOptions?: ApprovalOptions; parentId?: string }
  | { kind: 'turn'; id: string; status: 'started' | 'completed' | 'failed' | 'interrupted'; error?: string; errorCode?: string; retryAt?: number; usage?: Usage; durationMs?: number; ts: number; seq?: number; orderSeq?: number; turnId?: string; parentId?: string }
  | { kind: 'notice'; id: string; level: 'info' | 'warn' | 'error'; text: string; errorCode?: string; retryAt?: number; retrying?: boolean; noticeKind?: 'context_compaction'; progress?: boolean; ts: number; seq?: number; orderSeq?: number; parentId?: string });
export type ApprovalKind = 'command' | 'file_change' | 'tool' | 'permission' | 'question';

/** An attachment reference plus an optional URI already materialized on phone. */
export type { LocalAttachment } from './attachment-ref';

function withAttachmentUris(refs: AttachmentRef[], previous?: LocalAttachment[]): LocalAttachment[] {
  const old = new Map((previous ?? []).map((item) => [attachmentContentKey(item), item.uri]));
  return refs.map((ref) => ({ ...ref, ...(old.get(attachmentContentKey(ref)) ? { uri: old.get(attachmentContentKey(ref))! } : {}) }));
}

export interface Timeline { items: TimelineItem[]; session?: SessionInfo; /** Local sticky read expectation, never a native capability or verified SessionInfo. Cleared with this credential generation. */ readSurface?: 'desktop'; /** Last accepted session.updated cursor, when the Bridge supplies one. */ sessionSeq?: number; loading: boolean; /** Shown from the on-device cache, not yet confirmed by the computer. */ cachedAt?: number; error?: string; readErrorCode?: 'session_not_found' | 'deleted'; snapshotAt?: number; snapshotStartedAt?: number; nextCursor?: string; loadingEarlier?: boolean; earlierError?: string; historyLease?: string; historyExpanded?: boolean }
// A sequenced notification is only an invalidation hint; its payload is not
// admitted as current usage without a fresh source-bound context read.
export interface Timeline { contextSignal?: number; workflowSignal?: number }
export interface Timeline { revertedTurns?: string[]; revertedItems?: string[]; revertOperations?:string[]; revertSignal?: number }
export const EMPTY_TIMELINE: Timeline = { items: [], loading: false };
let localPromptSequence = 0;
const SESSION_PAGE_SIZE = 10;
const INITIAL_MESSAGE_COUNT = 2;
const OLDER_HISTORY_PAGE_SIZE = 10;
// Older Bridges still interpret limit as events; keep their bounded behavior.
// Current Bridges count actual messages and retain their associated tool events.
const HISTORY_EVENT_BUDGET = 400;
const HISTORY_GAP_PREFIX = '[salcara:history-gap:v1]';
const historyGap = (event: HubEvent) => event.type === 'notice' && event.text.startsWith(HISTORY_GAP_PREFIX);

// Avoid loading the queue-file manager on ordinary text/picker sends. Besides
// keeping the hot path light, this also makes the ownership boundary explicit:
// only our private content-addressed queue URI can request a handoff. A user
// supplied file URI is never treated as a managed queue file by pattern alone.
const MANAGED_QUEUE_URI = /(?:^|\/)remote-images-v2\/[a-f0-9]{64}\/queue-[a-f0-9]{64}\.(?:jpg|png|webp)$/i;
async function handoffQueuedSubmissionImages(scope: string, images: RemoteImage[]): Promise<RemoteImage[]> {
  if (!images.some(image => typeof image.uri === 'string' && MANAGED_QUEUE_URI.test(image.uri))) return images;
  // Keep this require lazy for ordinary sends; it is the same local module,
  // not a remote plugin or a user-controlled path.
  const { handoffQueuedImages } = require('./queued-image-files') as typeof import('./queued-image-files');
  return handoffQueuedImages(scope, images);
}

function eventSeq(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

type MessageIdentity = { role: 'user' | 'assistant'; parentId?: string; messageOrigin?: MessageOrigin; clientId?: string };
function sameMessageContext(previous: MessageIdentity, current: MessageIdentity): boolean {
  return previous.role === 'user' && current.role === 'user' && previous.parentId === current.parentId
    && JSON.stringify(messageOrigin(previous.messageOrigin)) === JSON.stringify(messageOrigin(current.messageOrigin))
    && (!previous.clientId || !current.clientId || previous.clientId === current.clientId);
}

/**
 * A live response can arrive after a snapshot, and a reconnect can replay an
 * older version of the same record.  Never let that replay move a completed
 * item backwards.  This is deliberately monotonic for the fields that have a
 * lifecycle while still allowing a newer terminal event to replace a partial
 * stream.
 */
function mergeTimelineItem(existing: TimelineItem, incoming: TimelineItem): TimelineItem {
  if (existing.kind !== incoming.kind || existing.id !== incoming.id) return incoming;
  if (existing.seq !== undefined && incoming.seq !== undefined && incoming.seq < existing.seq) return existing;

  // Legacy Bridges do not provide `seq`.  Their timestamp is still useful for
  // terminal duplicates: an older replay must not replace a later terminal
  // result.  Lifecycle upgrades (partial → final, running → done/failed) are
  // deliberately allowed even when clocks are slightly skewed.
  const legacyOlder = existing.seq === undefined && incoming.seq === undefined && incoming.ts < existing.ts;

  if (existing.kind === 'message' && incoming.kind === 'message') {
    if (existing.final && !incoming.final) return existing;
    if (legacyOlder && existing.final === incoming.final) return existing;
    if (!existing.final && !incoming.final && incoming.text.length < existing.text.length) return existing;
  }
  if (existing.kind === 'reasoning' && incoming.kind === 'reasoning') {
    if (existing.final && !incoming.final) return existing;
    if (legacyOlder && existing.final === incoming.final) return existing;
    if (!existing.final && !incoming.final && incoming.text.length < existing.text.length) return existing;
  }
  if (existing.kind === 'tool' && incoming.kind === 'tool') {
    const existingTerminal = existing.status !== 'running';
    // A subagent interruption is an authoritative terminal event. A delayed
    // launch/result snapshot must not make the child look completed again.
    if (existing.tool === 'subagent' && existing.status === 'interrupted' && incoming.status !== 'interrupted') return existing;
    if (existingTerminal && incoming.status === 'running') return existing;
    if (legacyOlder && existingTerminal && incoming.status !== 'running') return existing;
    // A partial duplicate should not erase output/diff produced by the
    // terminal record.  The incoming terminal record may still replace it.
    if (existingTerminal && incoming.status === existing.status && !incoming.outputFinal && !incoming.output && existing.output) return {
      ...incoming,
      output: existing.output,
      outputFinal: incoming.outputFinal ?? existing.outputFinal,
      diff: incoming.diff ?? existing.diff,
      exitCode: incoming.exitCode ?? existing.exitCode,
      startedAt: incoming.startedAt ?? existing.startedAt,
      durationMs: incoming.durationMs ?? existing.durationMs,
      ts: existing.seq === undefined && incoming.seq === undefined ? existing.ts : incoming.ts,
      attachments: incoming.attachments ?? existing.attachments,
      browser: incoming.browser ?? existing.browser,
      childSessionKeys: incoming.childSessionKeys ?? existing.childSessionKeys,
      seq: incoming.seq ?? existing.seq,
      orderSeq: existing.orderSeq ?? incoming.orderSeq ?? incoming.seq,
    };
  }
  if (existing.kind === 'approval' && incoming.kind === 'approval') {
    if (existing.state !== 'pending' && incoming.state === 'pending') return existing;
    if (legacyOlder && existing.state !== 'pending' && incoming.state !== 'pending') return existing;
  }
  if (existing.kind === 'turn' && incoming.kind === 'turn') {
    const existingTerminal = existing.status !== 'started';
    if (existingTerminal && incoming.status === 'started') return existing;
    if (legacyOlder && existingTerminal && incoming.status !== 'started') return existing;
  }

  // Event payloads from older Bridges omit optional fields.  Do not turn an
  // already populated field into `undefined` when such a duplicate arrives.
  const defined = Object.fromEntries(Object.entries(incoming).filter(([, value]) => value !== undefined)) as Partial<TimelineItem>;
  // `seq` is the last update cursor, not the item's insertion position. A
  // streamed assistant message can receive many newer seq values while tools
  // that appeared later are already in the timeline. Preserve the first
  // accepted cursor separately so a text delta never jumps across later work.
  // Legacy events have no cursor. Keep the first accepted timestamp as their
  // insertion anchor when a running tool later receives its terminal payload;
  // otherwise the same command can jump below the turn boundary merely
  // because its completion arrived with a newer wall-clock timestamp.
  return { ...existing, ...defined, ts: existing.seq === undefined && incoming.seq === undefined ? existing.ts : incoming.ts,
    seq: incoming.seq ?? existing.seq, orderSeq: existing.orderSeq ?? incoming.orderSeq ?? incoming.seq,
    // Reset metadata belongs to this exact error observation. A later event
    // without a reset time must not inherit an old scheduled retry.
    ...((existing.kind === 'turn' && incoming.kind === 'turn') || (existing.kind === 'notice' && incoming.kind === 'notice')
      ? { retryAt: executionRetryAt(incoming.errorCode, incoming.retryAt) } : {}),
    ...(existing.kind === 'message' && incoming.kind === 'message' ? { streamState: incoming.final ? undefined : incoming.streamState ?? existing.streamState,
      contextReferences: messageContextReferences(incoming.contextReferences ?? (sameMessageContext(existing, incoming) ? existing.contextReferences : undefined), incoming.role), skills: messageSkills(incoming.skills
        ?? (sameMessageContext(existing, incoming) ? existing.skills : undefined), incoming.role) } : {}) } as TimelineItem;
}

/** Stable chronological order: Hub sequence first, timestamp for local/cache-only rows. */
function sortTimelineItems(items: TimelineItem[]): TimelineItem[] {
  return items.map((item, index) => ({ item, index })).sort((left, right) => {
    const a = left.item, b = right.item;
    const aOrder = a.orderSeq ?? a.seq;
    const bOrder = b.orderSeq ?? b.seq;
    if (aOrder !== undefined && bOrder !== undefined && aOrder !== bOrder) return aOrder - bOrder;
    // Optimistic phone rows have no Hub cursor. Keep them after all cursor
    // events until the computer echo replaces them; otherwise a skewed phone
    // clock can make a later server event appear above an earlier prompt.
    const aLocal = a.kind === 'message' && a.local === true;
    const bLocal = b.kind === 'message' && b.local === true;
    if (aLocal !== bLocal && (a.seq !== undefined || b.seq !== undefined)) return aLocal ? 1 : -1;
    // A legacy page may omit seq while a newer live event has it.  There is
    // no honest numeric comparison for that pair: using the two devices'
    // clocks can put a later answer above an earlier prompt.  Preserve the
    // server/merge arrival order instead; pages and live events are already
    // delivered in protocol order, and the index is stable across updates.
    if ((a.seq === undefined) !== (b.seq === undefined)) return left.index - right.index;
    if (a.ts !== b.ts) return a.ts - b.ts;
    return left.index - right.index;
  }).map(({ item }) => item);
}

function upsert(items: TimelineItem[], item: TimelineItem): TimelineItem[] {
  const index = items.findIndex((existing) => existing.kind === item.kind && existing.id === item.id);
  const incoming = item.orderSeq === undefined && item.seq !== undefined ? { ...item, orderSeq: item.seq } : item;
  if (index < 0) return sortTimelineItems([...items, incoming]);
  const next = items.slice();
  const existing = next[index].orderSeq === undefined && next[index].seq !== undefined ? { ...next[index], orderSeq: next[index].seq } : next[index];
  const merged = mergeTimelineItem(existing, incoming);
  // Content version and insertion position are independent. A fresh snapshot
  // often contains only the final update cursor; a stale partial can prove
  // an earlier insertion without being allowed to downgrade that final text.
  const oldOrder = existing.orderSeq ?? existing.seq;
  const newOrder = incoming.orderSeq ?? incoming.seq;
  const orderSeq = oldOrder === undefined ? newOrder : newOrder === undefined ? oldOrder : Math.min(oldOrder, newOrder);
  next[index] = orderSeq === undefined ? merged : { ...merged, orderSeq };
  return sortTimelineItems(next);
}

/** Old caches collapsed both boundaries into a record ordered at turn start. */
function upgradeTurnBoundary(item: TimelineItem): TimelineItem {
  if (item.kind !== 'turn') return item;
  const coalesced = item.turnId && item.id === `turn:${item.turnId}`;
  const id = coalesced ? `turn:${item.turnId}:${item.status === 'started' ? 'started' : 'terminal'}` : item.id;
  if (!coalesced && (!item.parentId || !id.startsWith('turn:'))) return item;
  return { ...item, id: item.parentId ? childTurnBoundaryId(item.parentId, id) : id, ...(coalesced ? { orderSeq: item.seq } : {}) };
}

function childTurnBoundaryId(parentId: string, id: string): string {
  return `child-turn:${JSON.stringify([parentId, id])}`;
}

/** A fresh child event can repair an old cache that discarded its parent ID.
 * Only an identical Hub cursor establishes identity; timestamp collisions do not.
 */
function isUnscopedChildBoundary(item: TimelineItem, child: TimelineItem): boolean {
  return item.kind === 'turn' && !item.parentId && child.kind === 'turn' && Boolean(child.parentId)
    && item.seq !== undefined && item.seq === child.seq && item.status === child.status && item.turnId === child.turnId;
}

/** Blank image prompts need matching attachment IDs; equal empty text is not an echo. */
function messageEchoMatches(local: { text: string; clientId?: string; attachments?: readonly { id: string }[] },
  echo: { text: string; clientId?: string; attachments?: readonly { id: string }[] }): boolean {
  if (echo.clientId) return local.clientId === echo.clientId;
  const localText = local.text.trim(), echoText = echo.text.trim();
  if (localText) return localText === echoText;
  // Older Codex projection represents image input as one [图片] line per image.
  // It is only a display fallback; matching attachment IDs are still required.
  if (echoText && !/^(?:\[图片\]\s*)+$/.test(echoText)) return false;
  return Boolean(local.attachments?.length && local.attachments.length === echo.attachments?.length
    && local.attachments.every((ref, index) => ref.id === echo.attachments![index].id));
}

/** Folds one hub event into a session timeline: streamed items replace by id, approvals move pending → resolved. */
export function applyEvent(timeline: Timeline, event: HubEvent): Timeline {
  if(event.type==='session.reverted') {
    const reverted=event;
    if(timeline.revertOperations?.includes(event.operationId))return timeline;
    if(!validTurnId(event.turnId)||!event.id||event.parentId)return timeline;
    const start=timeline.items.findIndex(item=>item.turnId===reverted.turnId||item.id===reverted.id);
    const removed=new Set(timeline.revertedItems??[]);
    let inRemoved=false;
    const items=timeline.items.filter((item,index)=>{
      if(index===start)inRemoved=true;
      if(inRemoved&&index>start&&!item.parentId&&item.turnId&&item.turnId!==event.turnId)inRemoved=false;
      const remove=item.turnId===reverted.turnId||item.id===reverted.id||inRemoved;
      if(remove)removed.add(item.id);return !remove;
    });
    removed.add(event.id);
    return {...timeline,items,revertedTurns:[...new Set([...(timeline.revertedTurns??[]),event.turnId])],revertedItems:[...removed],revertOperations:[...(timeline.revertOperations??[]),event.operationId],revertSignal:(timeline.revertSignal??0)+1,nextCursor:undefined,historyExpanded:false};
  }
  if(event.turnId&&timeline.revertedTurns?.includes(event.turnId)||'id' in event&&event.id&&timeline.revertedItems?.includes(event.id))return timeline;
  if (event.type === 'message' || event.type === 'reasoning') {
    // session.open history can omit these zero values and lacks the complete
    // live-event envelope. Normalize before echo matching or timeline merging.
    if (Object.hasOwn(event, 'text') && typeof event.text !== 'string'
      || Object.hasOwn(event, 'final') && typeof event.final !== 'boolean') return timeline;
    event = { ...event, text: event.text ?? '', final: event.final ?? false };
  }
  const ts = event.ts ?? Date.now();
  const seq = eventSeq(event.seq);
  const turnId = validTurnId(event.turnId) ? event.turnId : undefined;
  switch (event.type) {
    case 'workflows.changed':
      return seq !== undefined && seq > (timeline.workflowSignal ?? 0) ? { ...timeline, workflowSignal: seq } : timeline;
    case 'context.updated':
      return seq !== undefined && seq > (timeline.contextSignal ?? 0) ? { ...timeline, contextSignal: seq } : timeline;
    case 'session.updated':
      if (seq !== undefined && timeline.sessionSeq !== undefined && seq < timeline.sessionSeq) return timeline;
      if (timeline.session && event.session.updatedAt < timeline.session.updatedAt) return timeline;
      return { ...timeline, session: event.session, ...(seq !== undefined ? { sessionSeq: seq } : {}) };
    case 'message': {
      let items = timeline.items;
      const existing = items.find((item): item is Extract<TimelineItem, { kind: 'message' }> => item.kind === 'message' && item.id === event.id);
      // Replays can omit metadata. Recover identity from this exact message,
      // before matching an optimistic receipt (never infer it from the text).
      const origin = messageOrigin(event.messageOrigin) ?? messageOrigin(existing?.messageOrigin);
      const parentId = event.parentId ?? existing?.parentId;
      const clientId = boundedClientId(event.clientId);
      // The echo of a follow-up we sent replaces its optimistic bubble.
      // A delegation is not our phone prompt, even if the text is identical.
      const optimistic = event.role === 'user' && !parentId && !origin
        ? items.find((item): item is Extract<TimelineItem, { kind: 'message' }> => item.kind === 'message' && item.local === true
          && Boolean(event.clientId || !existing) && messageEchoMatches(item, event))
        : undefined;
      // Remove only the single optimistic row that this echo can represent.
      // Removing every equal-text row loses two intentionally repeated prompts
      // and can also detach their different image references.
      if (optimistic) items = items.filter((item) => item !== optimistic);
      const refs = attachmentRefs(event.attachments);
      const mergedRefs = refs.length ? withAttachmentUris(refs, optimistic?.attachments ?? existing?.attachments) : optimistic?.attachments;
      // A legacy equal-text echo may replace a bubble, but cannot establish
      // which selected skill belongs to it. Only the receipt UUID can do that.
      const contextReferences = event.contextReferences !== undefined ? messageContextReferences(event.contextReferences, event.role) ?? []
        : clientId && optimistic?.clientId === clientId && sameMessageContext(optimistic, { role: event.role, parentId, messageOrigin: origin, clientId })
          ? messageContextReferences(optimistic.contextReferences, event.role) : undefined;
      const skills = event.role !== 'user' ? undefined : event.skills !== undefined ? messageSkills(event.skills) ?? []
        : clientId && optimistic?.clientId === clientId && sameMessageContext(optimistic, { role: event.role, parentId, messageOrigin: origin, clientId })
          ? messageSkills(optimistic.skills) : undefined;
      return { ...timeline, items: upsert(items, { kind: 'message', id: event.id, role: event.role, text: event.text, final: event.final, streamState: undefined, ts, seq, turnId, parentId, clientId, messagePhase: event.messagePhase === 'commentary' || event.messagePhase === 'final_answer' ? event.messagePhase : undefined, messageOrigin: origin, skills, contextReferences,
        ...(mergedRefs?.length ? { attachments: mergedRefs, images: mergedRefs.map((item) => item.uri).filter((uri): uri is string => Boolean(uri)) } : optimistic?.images?.length ? { images: optimistic.images } : {}) }) };
    }
    case 'reasoning': {
      return { ...timeline, items: upsert(timeline.items, { kind: 'reasoning', id: event.id, text: event.text, final: event.final, ts, seq, turnId, parentId: event.parentId }) };
    }
    case 'tool': {
      const existing = timeline.items.find((item): item is Extract<TimelineItem, { kind: 'tool' }> => item.kind === 'tool' && item.id === event.id);
      const refs = attachmentRefs(event.attachments);
      const attachments = refs.length ? withAttachmentUris(refs, existing?.attachments) : existing?.attachments;
      const startedAt = event.status === 'running' ? existing?.startedAt ?? (existing?.status === 'running' ? existing.ts : ts) : existing?.startedAt;
      const reportedDuration = typeof event.durationMs === 'number' && Number.isSafeInteger(event.durationMs) && event.durationMs >= 0 ? event.durationMs : undefined;
      const durationMs = reportedDuration ?? (event.status !== 'running' && existing?.status === 'running' && startedAt !== undefined && ts >= startedAt
        ? existing.durationMs ?? ts - startedAt : existing?.durationMs);
      const browser = event.status === 'done' ? parseBrowserNavigation(event.browser) : undefined;
      const computer = parseComputerActivity(event.computer);
      return { ...timeline, items: upsert(timeline.items, { kind: 'tool', id: event.id, tool: event.kind, ...(event.kind === 'plan' && (event.planKind === 'proposal' || event.planKind === 'tasks') ? { planKind: event.planKind } : {}), title: event.title, detail: event.detail, status: event.status, output: event.outputFinal === true ? event.output ?? '' : event.output, outputFinal: event.outputFinal === true ? true : undefined, diff: event.diff, exitCode: event.exitCode, startedAt, durationMs, ts, seq, turnId, parentId: event.parentId, childSessionKeys: event.childSessionKeys,
        ...(browser ? { browser } : {}), ...(computer ? {computer} : {}), ...(attachments?.length ? { attachments } : {}) }) };
    }
    case 'approval.request': {
      const existing = timeline.items.find((item) => item.kind === 'approval' && item.id === event.approvalId);
      if (existing?.kind === 'approval' && existing.state !== 'pending') return timeline;
      return { ...timeline, items: upsert(timeline.items, { kind: 'approval', id: event.approvalId, approval: event.kind, title: event.title, detail: event.detail, diff: event.diff, cwd: event.cwd, state: event.expiresAt && event.expiresAt <= Date.now() ? 'deny' : 'pending', by: event.expiresAt && event.expiresAt <= Date.now() ? 'timeout' : undefined, ts, seq, questions: event.questions, questionMode: event.questionMode, expiresAt: event.expiresAt, turnId: event.turnId, parentId: event.parentId, approvalOptions: normalizeApprovalOptions(event.approvalOptions), ...(event.approvalTransport === 'codex-hook-v1' ? { approvalTransport: event.approvalTransport } : {}) }) };
    }
    case 'approval.resolved': {
      const existing = timeline.items.find((item) => item.kind === 'approval' && item.id === event.approvalId);
      const base = existing?.kind === 'approval' ? existing : { kind: 'approval' as const, id: event.approvalId, approval: 'tool' as const, title: '操作', ts };
      return { ...timeline, items: upsert(timeline.items, { ...base, state: event.decision, by: event.by, ts, seq }) };
    }
    case 'turn': {
      const stableTurn = typeof event.turnId === 'string' && event.turnId.trim() ? event.turnId.trim() : undefined;
      const parentId = typeof event.parentId === 'string' && event.parentId ? event.parentId : undefined;
      // Legacy Bridges have no turn identity.  Preserve their historical
      // de-duplication of repeated terminal records at the end of a page.
      const last = timeline.items[timeline.items.length - 1];
      if (!stableTurn && last?.kind === 'turn' && last.status === event.status && last.parentId === parentId) return timeline;
      // Keep a start boundary for elapsed time and a terminal boundary at the
      // real completion cursor. A failed/completed turn must never inherit
      // the start cursor and jump ahead of its prompt and response.
      const baseId = stableTurn ? `turn:${stableTurn}:${event.status === 'started' ? 'started' : 'terminal'}` : `turn:${event.status}:${seq ?? ts}`;
      const id = parentId ? childTurnBoundaryId(parentId, baseId) : baseId;
      const boundary: Extract<TimelineItem, { kind: 'turn' }> = { kind: 'turn', id, turnId: stableTurn, parentId, status: event.status, error: event.error, errorCode: event.errorCode, retryAt: executionRetryAt(event.errorCode, event.retryAt), usage: event.usage, durationMs: typeof event.durationMs === 'number' && Number.isSafeInteger(event.durationMs) && event.durationMs >= 0 ? event.durationMs : undefined, ts, seq };
      const items = timeline.items.map(item => {
        const upgraded = upgradeTurnBoundary(item);
        if (upgraded.kind !== 'message' || upgraded.role !== 'assistant' || upgraded.final) return upgraded;
        if (event.status === 'started') return upgraded.streamState === 'terminal-unconfirmed' && (!stableTurn || upgraded.turnId !== stableTurn)
          ? { ...upgraded, streamState: 'incomplete' as const } : upgraded;
        if (!stableTurn || upgraded.turnId !== stableTurn || upgraded.parentId !== parentId) return upgraded;
        return { ...upgraded, streamState: 'terminal-unconfirmed' as const };
      }).filter(item => !isUnscopedChildBoundary(item, boundary));
      if (stableTurn && event.status === 'started') {
        const terminalId = `turn:${stableTurn}:terminal`;
        const terminal = items.find(item => item.kind === 'turn' && item.id === (parentId ? childTurnBoundaryId(parentId, terminalId) : terminalId));
        if (terminal && ((seq !== undefined && terminal.seq !== undefined && seq > terminal.seq) || (seq === undefined && ts > terminal.ts))) return timeline;
      }
      return { ...timeline, items: upsert(items, boundary) };
    }
    case 'notice': {
      const text = historyGap(event) ? '离线期间的临时进度缓存不完整，恢复时读取最近的会话记录；完整历史仍在原电脑。' : event.text;
      const nativeId = typeof event.id === 'string' && event.id.length > 0 && event.id.length <= 512 ? event.id : undefined;
      const id = nativeId ? `notice:item:${nativeId}` : `notice:${ts}:${text}`;
      if (!nativeId && timeline.items.some((item) => item.id === id)) return timeline;
      return { ...timeline, items: upsert(timeline.items, { kind: 'notice', id, level: event.level, text, errorCode: event.errorCode, retryAt: executionRetryAt(event.errorCode, event.retryAt), retrying: typeof event.retrying === 'boolean' ? event.retrying : undefined, noticeKind: event.noticeKind === 'context_compaction' ? event.noticeKind : undefined, progress: event.noticeKind === 'context_compaction' ? event.progress === true : event.progress === true || undefined, ts, seq, parentId: event.parentId }) };
    }
    default:
      return timeline;
  }
}

/** Only progress from a pre-snapshot recovery page must avoid downgrading that snapshot. */
export function applyRecoveredEvent(timeline: Timeline, event: HubEvent): Timeline {
  // upsert already protects terminal content. Still pass replay through it
  // so an earlier cursor can repair insertion order after a final snapshot.
  return applyEvent(timeline, event);
}

/** Read turn ownership before removing any anchors. Older projections omit
 * turnId on some output rows, including pages that begin with an answer and
 * end at its native terminal boundary. A new user/start is always a barrier;
 * timestamps and receipt-arrival order never authorize removing an unknown row. */
function filterRevertedHistory(current: Timeline, history: HubEvent[]): { events: HubEvent[]; revertedItems?: string[] } {
  const turns = new Set(current.revertedTurns), removed = new Set(current.revertedItems);
  const removedUsers = new Map<string, string>();
  // The native projection can append durable tombstones at the end of each
  // page. Learn them before replay, including receipts already seen live.
  for (const event of history) if (event.type === 'session.reverted' && !event.parentId && validTurnId(event.turnId) && event.id) {
    turns.add(event.turnId); removed.add(event.id); removedUsers.set(event.id, event.turnId);
  }
  if (!turns.size && !removed.size) return { events: history, revertedItems: current.revertedItems };
  const contexts: Array<string | undefined> = [], bounded: boolean[] = [];
  let turn: string | undefined, boundary = false;
  for (const event of history) {
    if (!event.parentId && event.type !== 'session.reverted') {
      if (validTurnId(event.turnId)) { turn = event.turnId; boundary = true; }
      else if (event.type === 'message' && event.role === 'user' && removedUsers.has(event.id)) { turn = removedUsers.get(event.id); boundary = true; }
      else if (event.type === 'message' && event.role === 'user' || event.type === 'turn' && event.status === 'started') { turn = undefined; boundary = true; }
    }
    contexts.push(turn); bounded.push(boundary);
  }
  let terminal: string | undefined;
  for (let index = history.length - 1; index >= 0; index--) {
    const event = history[index];
    if (!event.parentId && event.type !== 'session.reverted') {
      if (event.type === 'turn' && event.status !== 'started' && validTurnId(event.turnId)) terminal = event.turnId;
      else if (event.type === 'message' && event.role === 'user' || event.type === 'turn' && event.status === 'started' || validTurnId(event.turnId)) terminal = undefined;
    }
    if (!bounded[index] && terminal) contexts[index] = terminal;
  }
  const events = history.filter((event, index) => {
    if (event.type === 'session.reverted' || event.type === 'session.updated') return true;
    const id = 'id' in event ? event.id : 'approvalId' in event ? event.approvalId : undefined;
    const revoked = Boolean(id && removed.has(id) || event.turnId && turns.has(event.turnId) || contexts[index] && turns.has(contexts[index]!));
    if (revoked && id) removed.add(id);
    return !revoked;
  });
  return { events, revertedItems: [...removed] };
}

/** A bounded computer snapshot is not proof that older, already displayed history was deleted. */
export function mergeHistory(current: Timeline, session: SessionInfo | undefined, history: HubEvent[], concurrentApprovals = new Set<string>()): Timeline {
  const preferredSession = current.session && session && current.session.updatedAt > session.updatedAt ? current.session : session ?? current.session;
  const knownMessages = new Map(current.items.filter((item): item is Extract<TimelineItem, { kind: 'message' }> => item.kind === 'message' && !item.local).map(item => [item.id, item]));
  const filtered = filterRevertedHistory(current, history);
  let next: Timeline = { items: [], session: preferredSession, loading: false, revertedTurns:current.revertedTurns, revertedItems:filtered.revertedItems,revertOperations:current.revertOperations,revertSignal:current.revertSignal };
  for (const event of filtered.events) {
    const known = event.type === 'message' ? knownMessages.get(event.id) : undefined;
    const replay = event.type === 'message' && known ? { ...event,
      messageOrigin: messageOrigin(event.messageOrigin) ?? messageOrigin(known.messageOrigin),
      parentId: event.parentId ?? known.parentId,
      contextReferences: event.contextReferences !== undefined ? messageContextReferences(event.contextReferences, event.role) ?? [] : sameMessageContext(known, event) ? messageContextReferences(known.contextReferences, event.role) : undefined,
    } : event;
    next = applyEvent(next, replay.type === 'message' && known && replay.skills === undefined && sameMessageContext(known, replay)
      ? { ...replay, skills: messageSkills(known.skills) } : replay);
  }
  const knownItems = new Set(next.items.map(item => `${item.kind}:${item.id}`));
  const confirmed = next.items.filter((item): item is Extract<TimelineItem, { kind: 'message' }> => item.kind === 'message' && item.role === 'user' && !item.local && !item.parentId && !messageOrigin(item.messageOrigin));
  const replacedOptimistic = new Set<string>();
  for (const originalItem of current.items) {
    if(originalItem.turnId&&next.revertedTurns?.includes(originalItem.turnId)||next.revertedItems?.includes(originalItem.id))continue;
    const item = upgradeTurnBoundary(originalItem);
    if (item.kind === 'turn' && !item.parentId && next.items.some(child => isUnscopedChildBoundary(item, child))) continue;
    const known = knownItems.has(`${item.kind}:${item.id}`);
    // A live question/decision received during the read is newer than an absent
    // or older snapshot. Preserve its identity even if computer clocks differ.
    if (item.kind === 'approval' && concurrentApprovals.has(item.id)) { next = { ...next, items: upsert(next.items, item) }; continue; }
    if (item.kind === 'approval' && known) { next = { ...next, items: upsert(next.items, item) }; continue; }
    // A stale request absent from the fresh snapshot is not a currently actionable approval.
    if (item.kind === 'approval' && item.state === 'pending') continue;
    // The optimistic bubble is replaced by the real message once the computer has it.
    // Only one matching optimistic row is removed. Repeated prompts are valid
    // conversation content; broad text-set filtering used to delete both.
    if (item.kind === 'message' && item.local) {
      const echo = confirmed.find((candidate) => (candidate.clientId || !knownMessages.has(candidate.id)) && messageEchoMatches(item, candidate));
      const echoKey = echo ? (echo.clientId ? `client:${echo.clientId}` : echo.text.trim() ? `text:${echo.text.trim()}` : `image:${echo.id}`) : '';
      if (echo && !replacedOptimistic.has(echoKey)) {
        replacedOptimistic.add(echoKey);
        if (boundedClientId(echo.clientId) && echo.clientId === item.clientId && sameMessageContext(item, echo) && echo.contextReferences === undefined) {
          const refs = messageContextReferences(item.contextReferences);
          if (refs) next = { ...next, items: next.items.map(candidate => candidate.id === echo.id && candidate.kind === 'message' ? { ...candidate, contextReferences: refs } : candidate) };
        }
        if (boundedClientId(echo.clientId) && echo.clientId === item.clientId && sameMessageContext(item, echo) && echo.skills === undefined) {
          const skills = messageSkills(item.skills);
          if (skills) next = { ...next, items: next.items.map(candidate => candidate.id === echo.id && candidate.kind === 'message' ? { ...candidate, skills } : candidate) };
        }
        continue;
      }
    }
    // A final answer does not replace other assistant messages in its turn:
    // bounded snapshots may omit earlier commentary or separate text blocks.
    // Let upsert reconcile only the same message ID and preserve newer finals.
    next = { ...next, items: upsert(next.items, item) };
  }
  return { ...next, items: sortTimelineItems(next.items), session: preferredSession ?? next.session };
}

// ——— state ———

export type Probe = 'checking' | 'ok' | 'no';
export type Connection = 'idle' | 'connecting' | 'open' | 'retrying' | 'error';
export interface PendingApproval { approvalId: string; deviceId: string; sessionKey: string; tool: ToolId; title: string; ts: number }
export interface NativeDirectory { list: SessionInfo[]; loading: boolean; loaded: boolean; error?: string; errorPage?: 'head' | 'more'; nextCursor?: string }
export interface DeviceSessions { list: SessionInfo[]; loading: boolean; loaded: boolean; error?: string; errorPage?: 'head' | 'more'; native?: NativeDirectory; readOnly?: Partial<Record<import('./client').ClaudeDesktopScope, NativeDirectory & { nextCursor?: string; identity: string }>>; directorySurface?: 'desktop' | 'all'; pages?: Partial<Record<AgentId, { nextCursor?: string; loading: boolean; error?: string; errorPage?: 'head' | 'more' }>> }
export interface DeviceAgents { list: AgentProfile[]; apis: RemoteApiOption[]; loading: boolean; loaded: boolean; error?: string; autoAll?: boolean }

export interface RemoteState {
  /** 'loading' until the saved choice is read. */
  phase: 'loading' | 'setup' | 'pairing' | 'ready';
  serviceId: string | null;
  connections: RemoteConnection[];
  connectionId: string | null;
  /** Only set after a successful public plugin discovery. QR scans must match exactly. */
  selectedHubUrl: string | null;
  probes: Record<string, Probe>;
  connection: Connection;
  connectionError?: string;
  connectionProblem?: ConnectionProblem;
  connectionSync?: { connectionId: string; loading: boolean; failed: { hubUrl: string; message: string }[]; error?: string; checkedAt?: number };
  devices: DeviceStatus[];
  devicesLoaded: boolean;
  sessions: Record<string, DeviceSessions>;
  agents: Record<string, DeviceAgents>;
  timelines: Record<string, Timeline>;
  approvals: Record<string, PendingApproval>;
  signingIn: string | null;
  /** A session to jump to when the remote screen opens (from an approval toast). */
  focus: { deviceId: string; sessionKey: string; connectionId?: string; agentId?: AgentId; surface?: 'cli' | 'desktop' | 'read-only'; sessionScope?: ClaudeDesktopScope } | { home: true } | null;
}

const SETTING = 'remote_service';
const initial: RemoteState = { phase: 'loading', serviceId: null, connections: [], connectionId: null, selectedHubUrl: null, probes: {}, connection: 'idle', devices: [], devicesLoaded: false, sessions: {}, agents: {}, timelines: {}, approvals: {}, signingIn: null, focus: null };
let state: RemoteState = initial;
let hub: Hub | null = null;
let lastSeq = 0;
let booted = false;
let screenOpen = false;
let connectionGeneration = 0;
let remoteContentRecoveryFlight: { owner: Hub; generation: number; scope: string; promise: Promise<RemoteContentRecoveryResult> } | null = null;
// Pairing requests are separate from station-selection generations. A camera
// can report the same QR more than once, and users can scan a second computer
// before the first claim has returned. Deduplicate the same one-time ticket
// and make an older, different scan unable to select a stale result.
let pairingGeneration = 0;
const pairingOwners = new Map<string, number>();
const pairingFlights = new Map<string, Promise<void>>();
let connectionSyncFlight: { owner: Hub; promise: Promise<void> } | undefined;
let probeGeneration = 0;
let hubCapabilities = new Set<string>();
const sessionCursors = new Map<string, number>();
const sessionEpochs = new Map<string, string>();
const sessionSyncTails = new Map<string, Promise<void>>();
const sessionApprovalSnapshots = new Map<string, number>();
interface IncompleteTurnRepair { successfulReads: number; failures: number; retryAt: number; stableSince: number; fingerprint: string }
const incompleteTurnRepairs = new Map<string, IncompleteTurnRepair>();
const MAX_INCOMPLETE_TURN_REPAIRS = 3;
const INCOMPLETE_TURN_REPAIR_DELAYS = [1_000, 5_000, 15_000];
const INCOMPLETE_TURN_GRACE_MS = 60_000;
const sessionRequests = new Map<string, number>();
const snapshotFlights = new Map<string, { owner: Hub; surface: 'desktop' | 'history'; promise: Promise<void> }>();
const directoryPreloads = new Map<string, AbortController>();
const agentRequests = new Map<string, number>();
const apiChanges = new Map<string, number>();
const contextSourceGenerations = new Map<string, number>();
// Directory reads may overlap, but an older reply must never overwrite the
// newer device list or online state.
let devicesRevision = 0;
const apiMutationOwners = new Map<Hub, Set<string>>();
// A station handover changes the Hub object. Keep a device-wide lock as well
// as the legacy per-Hub map so a key change cannot race a handover at the
// exact moment the active Hub object is replaced.
const apiMutationDevices = new Set<string>();
const apiReadDevices = new Map<string, number>();

function apiMutationKey(owner: Hub, deviceId: string): string {
  // Device IDs are only unique inside a station. Prefer the physical
  // computer identity when it is available, otherwise include the Hub origin
  // so two different computers with the same legacy device ID do not block
  // one another.
  const profile = state.connections.find(item => item.deviceId === deviceId && item.hubUrl === owner.url);
  return profile?.computerId ? `computer:${profile.computerId}` : `hub:${owner.url}\u0000${deviceId}`;
}
function apiMutationBusy(owner: Hub, deviceId: string): boolean {
  const key = apiMutationKey(owner, deviceId);
  return apiMutationDevices.has(key) || Boolean(apiMutationOwners.get(owner)?.has(key)) || (apiReadDevices.get(key) ?? 0) > 0;
}
function apiWriteBusy(owner: Hub, deviceId: string): boolean {
  const key = apiMutationKey(owner, deviceId);
  return apiMutationDevices.has(key) || Boolean(apiMutationOwners.get(owner)?.has(key));
}
interface ApiMutationLock { owner: Hub; key: string; mutations: Set<string> }
function beginApiMutation(owner: Hub, deviceId: string, message: string): ApiMutationLock {
  const key = apiMutationKey(owner, deviceId);
  if (apiMutationBusy(owner, deviceId)) throw new Error(message);
  const mutations = apiMutationOwners.get(owner) ?? new Set<string>();
  mutations.add(key); apiMutationOwners.set(owner, mutations);
  apiMutationDevices.add(key);
  return { owner, key, mutations };
}
function endApiMutation(lock: ApiMutationLock): void {
  lock.mutations.delete(lock.key); if (!lock.mutations.size) apiMutationOwners.delete(lock.owner);
  apiMutationDevices.delete(lock.key);
}
interface ApiReadLock { key: string }
function beginApiRead(owner: Hub, deviceId: string, message: string): ApiReadLock {
  const key = apiMutationKey(owner, deviceId);
  // A write lock is the only thing that must be excluded here.  Multiple
  // sends may observe the same API concurrently, but a station/API mutation
  // must never start in the middle of one of them.
  if (apiWriteBusy(owner, deviceId)) throw new Error(message);
  apiReadDevices.set(key, (apiReadDevices.get(key) ?? 0) + 1);
  return { key };
}
function endApiRead(lock: ApiReadLock): void {
  const count = (apiReadDevices.get(lock.key) ?? 1) - 1;
  if (count > 0) apiReadDevices.set(lock.key, count); else apiReadDevices.delete(lock.key);
}

// A station handover is a two-Hub operation. Keep only non-secret intent on
// disk so an app restart can recognize the committed target if the A reply was
// lost after the desktop had already switched to B.
const HANDOVER_SETTING = 'remote_station_handover_v1';
const HANDOVER_TTL_MS = 24 * 60 * 60 * 1000;
interface PendingStationHandover {
  operationId: string; fromConnectionId: string; targetConnectionId: string; deviceId: string; createdAt: number;
  agent?: AgentId; accountId?: string; model?: string; sessionKey?: string; sourceOnly?: boolean;
}
function validHandover(value: unknown): value is PendingStationHandover {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<PendingStationHandover>;
  return typeof item.operationId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(item.operationId)
    && typeof item.fromConnectionId === 'string' && /^[a-f0-9]{64}$/.test(item.fromConnectionId)
    && typeof item.targetConnectionId === 'string' && /^[a-f0-9]{64}$/.test(item.targetConnectionId)
    && typeof item.deviceId === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(item.deviceId)
    && typeof item.createdAt === 'number' && Number.isSafeInteger(item.createdAt) && item.createdAt >= 0
    && (item.agent === undefined || validAgentId(item.agent))
    && (item.sourceOnly === undefined || typeof item.sourceOnly === 'boolean')
    && (!item.sourceOnly || Boolean(item.agent && item.accountId && !item.model && !item.sessionKey))
    && (item.accountId === undefined || typeof item.accountId === 'string' && item.accountId.length <= 256 && !/[\r\n\u0000]/.test(item.accountId))
    && (item.model === undefined || typeof item.model === 'string' && item.model.length <= 200 && !/[\r\n\u0000]/.test(item.model))
    && (item.sessionKey === undefined || typeof item.sessionKey === 'string' && item.sessionKey.length <= 512 && !/[\r\n\u0000]/.test(item.sessionKey));
}
async function loadPendingHandover(): Promise<PendingStationHandover | null> {
  const raw = await getSetting(HANDOVER_SETTING).catch(() => null);
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!validHandover(value)) { await setSetting(HANDOVER_SETTING, null).catch(() => undefined); return null; }
    if (Date.now() - value.createdAt > HANDOVER_TTL_MS) { await setSetting(HANDOVER_SETTING, null).catch(() => undefined); return null; }
    return { ...value };
  } catch {
    await setSetting(HANDOVER_SETTING, null).catch(() => undefined);
    return null;
  }
}
async function savePendingHandover(value: PendingStationHandover, expectedGeneration = connectionGeneration): Promise<void> {
  if (expectedGeneration !== connectionGeneration) throw new Error('连接已切换，请刷新确认');
  await setSetting(HANDOVER_SETTING, JSON.stringify(value));
  // A sign-out or another station choice can happen while the settings write
  // is suspended. Do not leave a stale journal that could auto-switch a
  // computer after the user explicitly left this connection.
  if (expectedGeneration !== connectionGeneration) {
    const current = await loadPendingHandover();
    if (current?.operationId === value.operationId) await setSetting(HANDOVER_SETTING, null).catch(() => undefined);
    throw new Error('连接已切换，请刷新确认');
  }
}
async function discardPendingHandover(): Promise<void> { await setSetting(HANDOVER_SETTING, null).catch(() => undefined); }
async function clearPendingHandover(operationId?: string): Promise<void> {
  // An omitted operation ID means that the caller has no handover ownership;
  // never erase another in-flight journal as a side effect of switching views.
  if (!operationId) return;
  const current = await loadPendingHandover();
  if (current?.operationId === operationId) await setSetting(HANDOVER_SETTING, null).catch(() => undefined);
}

let handoverRecoveryFlight: Promise<boolean> | null = null;
// Station handover, recovery and revoke all mutate the same phone↔computer
// ownership. Serialize those operations so a foreground recovery cannot move
// the phone to B while a user-initiated A→C switch or revoke is still in
// flight. Account-only API changes keep their existing fail-fast lock.
let stationChangeTail: Promise<void> = Promise.resolve();
function serializeStationChange<T>(task: () => Promise<T>): Promise<T> {
  const run = stationChangeTail.then(task, task);
  stationChangeTail = run.then(() => undefined, () => undefined);
  return run;
}
function sameHandoverPayload(intent: PendingStationHandover, agent?: AgentId, accountId?: string, model?: string, sessionKey?: string): boolean {
  return (intent.agent ?? '') === (agent ?? '') && (intent.accountId ?? '') === (accountId ?? '')
    && (intent.model ?? '') === (model?.trim() ?? '') && (intent.sessionKey ?? '') === (sessionKey ?? '');
}
function handoverPayloadHash(target: RemoteConnection, agent?: AgentId, accountId?: string, model?: string, sessionKey?: string, sourceOnly = false): string {
  const data = [target.hubUrl, target.deviceId, target.computerId ?? '', agent ?? '', accountId ?? '', model?.trim() ?? '', sessionKey ?? ''].join('\u0000') + (sourceOnly ? '\u0000source-only-v1' : '');
  return Array.from(sha256(new TextEncoder().encode(data)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
function optionalHandoverReplyMatches(result: unknown, operationId: string, payloadHash: string): boolean {
  if (!result || typeof result !== 'object') return true; // old Bridge reply
  const value = result as Record<string, unknown>;
  if (value.switched !== undefined && value.switched !== true) return false;
  if (value.operationId !== undefined && value.operationId !== operationId) return false;
  if (value.payloadHash !== undefined && value.payloadHash !== payloadHash) return false;
  return true;
}
const listeners = new Set<() => void>();
const alertListeners = new Set<(approval: PendingApproval) => void>();

function set(patch: Partial<RemoteState> | ((current: RemoteState) => Partial<RemoteState>)) {
  const previous = state;
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  try { persistChanges(previous, state); } catch { /* the cache is optional */ }
  listeners.forEach((listener) => listener());
}

/** Keep confirmed CLI threads and session lists on the device (see cache.ts). */
function remoteCacheScope(): string | null {
  return state.connectionId && hub?.pairToken ? `${state.connectionId}|credential:${deliveryCredentialId(hub.pairToken)}` : null;
}
function persistChanges(previous: RemoteState, next: RemoteState) {
  const scope = remoteCacheScope();
  if (!scope || previous.connectionId !== next.connectionId) return;
  if (previous.timelines !== next.timelines) {
    for (const [key, timeline] of Object.entries(next.timelines)) {
      if (timeline === previous.timelines[key] || !timeline.snapshotAt || timeline.loading || !timeline.items.length) continue;
      const sessionKey = key.slice(key.indexOf('|') + 1);
      if (isReadOnlyDesktopSession(sessionKey) || timeline.readSurface === 'desktop' || timeline.historyLease || timeline.session?.controlSurface === 'desktop' || timeline.session?.controlSurface === 'read-only') continue;
      // Approvals and unsent local echoes are live state; never restore them from disk.
      saveCachedThread(scope, key, { items: timeline.items.filter((item) => item.kind !== 'approval' && !(item.kind === 'message' && item.local)), session: timeline.session,revertedTurns:timeline.revertedTurns,revertedItems:timeline.revertedItems,revertOperations:timeline.revertOperations });
    }
  }
  if (previous.sessions !== next.sessions) {
    for (const [deviceId, entry] of Object.entries(next.sessions)) {
      if (entry && entry !== previous.sessions[deviceId] && entry.loaded && !entry.error) saveCachedSessions(scope, deviceId, entry.list);
    }
  }
}

/** Show the last confirmed copy of a thread at once; the computer's snapshot replaces it when it arrives. */
export async function hydrateCachedThread(deviceId: string, sessionKey: string): Promise<void> {
  const scope = remoteCacheScope(), owner = hub;
  const key = timelineKey(deviceId, sessionKey);
  if (!scope || isReadOnlyDesktopSession(sessionKey) || isNativeSession(deviceId, sessionKey) || state.timelines[key]?.historyLease || state.timelines[key]?.items.length) return;
  const cached = await loadCachedThread(scope, key);
  const durable = await loadDurableEvents(scope, deviceId, sessionKey);
  if (durable && owner === hub && remoteCacheScope() === scope && !isNativeSession(deviceId, sessionKey)) {
    for (const event of durable.events) handleEvent(event, true);
  }
  if (!cached || owner !== hub || remoteCacheScope() !== scope || isNativeSession(deviceId, sessionKey) || state.timelines[key]?.historyLease) return;
  set((current) => {
    const existing = current.timelines[key];
    if (existing?.items.length || existing?.snapshotAt || existing?.historyLease || existing?.session?.controlSurface === 'desktop') return {};
    return { timelines: { ...current.timelines, [key]: { ...(existing ?? EMPTY_TIMELINE), items: sortTimelineItems((cached.items as TimelineItem[]).map(upgradeTurnBoundary)), session: existing?.session ?? cached.session, cachedAt: cached.savedAt,revertedTurns:cached.revertedTurns,revertedItems:cached.revertedItems,revertOperations:cached.revertOperations } } };
  });
}

/** Recent tasks for the saved computer, readable before (or without) a connection. */
export async function hydrateCachedSessions(deviceId: string): Promise<void> {
  const scope = remoteCacheScope(), owner = hub;
  if (!scope || state.sessions[deviceId]?.list.length) return;
  const list = await loadCachedSessions(scope, deviceId);
  if (!list?.length || owner !== hub || remoteCacheScope() !== scope) return;
  set((current) => current.sessions[deviceId]?.list.length ? {} : { sessions: { ...current.sessions, [deviceId]: { ...(current.sessions[deviceId] ?? { loading: false, loaded: false }), list } } });
}

export const timelineKey = (deviceId: string, sessionKey: string) => `${deviceId}|${sessionKey}`;
/** Adapter request IDs need only be unique inside their own conversation. */
export const approvalStateKey = (deviceId: string, sessionKey: string, approvalId: string) => JSON.stringify([deviceId, sessionKey, approvalId]);

export function useRemote(): RemoteState {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => state, () => state);
}
export function usePendingApprovalCount(): number {
  const approvals = useRemote().approvals;
  return Object.keys(approvals).length;
}
export function getRemoteState() { return state; }

/** Diagnostics cannot switch routes or survive a pairing/selection change. */
export async function diagnoseRemoteConnection(deviceId: string, signal?: AbortSignal) {
  const owner = hub, generation = connectionGeneration, pairing = pairingGeneration, selected = state.connectionId;
  if (!owner || !deviceId || owner.deviceId && owner.deviceId !== deviceId || !owner.pairToken && !owner.botToken) throw new HubError('请先连接已配对的电脑', 403, 'diagnostic_pairing_invalid');
  const controller = new AbortController(), abort = () => controller.abort();
  const current = () => owner === hub && generation === connectionGeneration && pairing === pairingGeneration && selected === state.connectionId;
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const unsubscribe = onRemoteChange(() => { if (!current()) abort(); });
  try {
    const result = await measureConnection(owner, deviceId, controller.signal);
    if (!current()) throw new HubError('连接已切换，请重新检测', 409, 'diagnostic_connection_changed');
    if (controller.signal.aborted) throw new HubError('检测已取消', 499, 'aborted');
    return result;
  } finally { unsubscribe(); signal?.removeEventListener('abort', abort); }
}
/** Refresh the non-secret connection index after an external import flow. */
export async function reloadSavedConnections(): Promise<RemoteConnection[]> {
  const connections = await loadConnections();
  set({ connections });
  return connections;
}
/** Capture this before an import; a later user selection must own activation. */
export function remoteConnectionRevision(): number { return connectionGeneration; }

export function setRemoteScreenOpen(open: boolean) {
  screenOpen = open;
  if (!open) stopStream();
  if (open && hub?.pairToken) {
    void recoverPendingHandoverOnce();
    void refreshDevices(true);
  }
}
export function setRemoteFocus(focus: RemoteState['focus']) { set({ focus }); }
/** Foreground alerts for approvals that arrive while the remote screen is closed. */
const eventListeners = new Set<(event: HubEvent) => void>();
/** Live (non-replayed) events, e.g. for task-finished notifications. Listeners must not throw. */
export function onRemoteEvent(listener: (event: HubEvent) => void): () => void {
  eventListeners.add(listener);
  return () => { eventListeners.delete(listener); };
}
export function isRemoteScreenOpen(): boolean { return screenOpen; }
/** Credential snapshot for scoped workspace requests and supported native watchers; never persisted. */
export function watchCredentials(): { url: string; key?: string; pairToken?: string; botToken?: string } | null {
  return hub?.pairToken ? { url: hub.url, key: hub.key, pairToken: hub.pairToken, ...(hub.botToken ? { botToken: hub.botToken } : {}) } : null;
}
export function sessionCursor(deviceId: string, sessionKey: string): number { return sessionCursors.get(timelineKey(deviceId, sessionKey)) ?? 0; }

function advanceSessionCursor(key: string, seq: number): void {
  if (Number.isSafeInteger(seq) && seq >= 0) sessionCursors.set(key, Math.max(sessionCursors.get(key) ?? 0, seq));
}

export function onApprovalAlert(listener: (approval: PendingApproval) => void): () => void {
  alertListeners.add(listener);
  return () => { alertListeners.delete(listener); };
}

function handleEvent(event: HubEvent, recovered = false, nativeReceipt = false) {
  if ((event as { type: string }).type === 'features.changed') return;
  // Native Claude history has an account-stamped command channel only. An old
  // Hub event must not recreate a cleared namespace or turn it into a worker.
  if (event.sessionKey.startsWith('claude-desktop:')) return;
  if (typeof event.seq === 'number') lastSeq = Math.max(lastSeq, event.seq);
  if (!eventMatchesSession(event, event.sessionKey)) return;
  const key = timelineKey(event.deviceId, event.sessionKey);
  const timeline = state.timelines[key];
  const selectedNative = timeline?.readSurface === 'desktop' || timeline?.session?.controlSurface === 'desktop';
  // The Hub's event channel is fed by CLI adapters only. Native conversations
  // are read through exact authorized command snapshots; a claimed desktop
  // SessionInfo in this stream is not evidence of a native event source.
  // Keep the expectation after a failed read/expired lease: neither may expose
  // an unrelated CLI buffer under the same thread UUID.
  if (nativeReceipt) {
    // Only an acknowledgement created by our desktop approval command may
    // update that approval locally. Never grant other Hub events this bypass.
    if (!selectedNative || event.type !== 'approval.resolved' || event.by !== 'phone') return;
  } else if (selectedNative || event.type === 'session.updated' && (event.session.controlSurface === 'desktop' || event.session.controlSurface === 'read-only')) return;
  let newApproval = false;
  set((current) => {
    const previousTimeline = current.timelines[key] ?? EMPTY_TIMELINE;
    const nextTimeline = (recovered ? applyRecoveredEvent : applyEvent)(previousTimeline, event);
    const patch: Partial<RemoteState> = { timelines: { ...current.timelines, [key]: nextTimeline } };
    if (event.type === 'session.updated' && nextTimeline !== previousTimeline) {
      const entry = current.sessions[event.deviceId] ?? { list: [], loading: false, loaded: false };
      const list = [event.session, ...entry.list.filter((item) => item.sessionKey !== event.session.sessionKey)].sort((a, b) => b.updatedAt - a.updatedAt);
      // Native directory metadata belongs to its own authorized snapshot.
      // A CLI update with the same UUID must not overwrite its cwd or status.
      patch.sessions = { ...current.sessions, [event.deviceId]: { ...entry, list } };
    }
    if (event.type === 'approval.request') {
      const item = patch.timelines![key].items.find((entry) => entry.kind === 'approval' && entry.id === event.approvalId);
      const approvals = { ...current.approvals };
      const approvalKey = approvalStateKey(event.deviceId, event.sessionKey, event.approvalId);
      if (item?.kind === 'approval' && item.state === 'pending' && (!item.expiresAt || item.expiresAt > Date.now())) {
        newApproval = !approvals[approvalKey];
        approvals[approvalKey] = { approvalId: event.approvalId, deviceId: event.deviceId, sessionKey: event.sessionKey, tool: event.tool, title: event.title, ts: event.ts };
      } else delete approvals[approvalKey];
      patch.approvals = approvals;
    }
    if (event.type === 'approval.resolved' && current.approvals[approvalStateKey(event.deviceId, event.sessionKey, event.approvalId)]) {
      const approvals = { ...current.approvals };
      delete approvals[approvalStateKey(event.deviceId, event.sessionKey, event.approvalId)];
      patch.approvals = approvals;
    }
    return patch;
  });
  if (!recovered) eventListeners.forEach((listener) => { try { listener(event); } catch { /* decorative */ } });
  // Replayed history is not news.
  if (event.type === 'approval.request' && newApproval && !recovered && !screenOpen && Date.now() - event.ts < 120_000 && AppState.currentState === 'active') {
    const approval = state.approvals[approvalStateKey(event.deviceId, event.sessionKey, event.approvalId)];
    if (approval) alertListeners.forEach((listener) => listener(approval));
  }
}

function handleDevice(device: DeviceStatus) {
  set((current) => {
    const exists = current.devices.some((item) => item.deviceId === device.deviceId);
    return { devices: exists ? current.devices.map((item) => item.deviceId === device.deviceId ? device : item) : [...current.devices, device] };
  });
}

// Pairing is persistent; an HTTP connection is not. No default SSE, watchdog or background polling.
function startDemandConnection() { if (screenOpen && hub?.pairToken) void refreshDevices(true); }
function stopStream() {
  for (const controller of directoryPreloads.values()) controller.abort();
  directoryPreloads.clear();
  // There is no permanent phone stream to close.
}

function resetConnection(patch: Partial<RemoteState>, active?: { owner: Hub; capabilities: string[] }) {
  agentFeatureCache.clear();
  contextSourceGenerations.clear(); contextCompactFlights.clear(); nativeActionFlights.clear(); nativeActionUnconfirmed.clear(); workflowFlights.clear(); workflowUnconfirmed.clear(); sideQuestionFlights.clear(); sideQuestionHeads.clear(); sideQuestionUnconfirmed.clear();
  stopStream(); connectionGeneration += 1; hub = active?.owner ?? null; lastSeq = 0;
  hubCapabilities = new Set(active?.capabilities ?? []); sessionCursors.clear(); sessionEpochs.clear(); sessionApprovalSnapshots.clear(); incompleteTurnRepairs.clear(); sessionRequests.clear(); snapshotFlights.clear(); modelCache.clear(); modelRequests.clear(); apiChanges.clear();
  set({ ...initial, phase: 'setup', connections: state.connections, probes: state.probes, ...patch });
}

/** First step: explicitly choose a station and verify its plugin. No model API key is read. */
export async function connectStation(stationUrl: string, stillWanted: () => boolean = () => true): Promise<void> {
  // Invalidate an in-flight login/QR request as soon as the user chooses a
  // different station. The old request may finish after discovery and must
  // not overwrite this selection.
  const generation = ++connectionGeneration;
  const previousConnectionId = state.connectionId;
  const previousServiceId = state.serviceId;
  let selectionAttempted = false;
  let serviceAttempted = false;
  let committed = false;
  set({ signingIn: 'station' });
  try {
    const discovery = await discoverStation(stationUrl);
    if (generation !== connectionGeneration) throw new Error('连接选择已改变，请重试');
    // Discovery is read-only. Leaving the setup page must not discard the
    // currently paired computer or its cached conversations when it finishes.
    if (!stillWanted()) return;
    const selected = state.connections.find(item => item.id === state.connectionId);
    const saved = state.connections.filter(item => item.hubUrl === discovery.url);
    const sameStation = saved.find(item => item.id === selected?.id) ?? (saved.length === 1 ? saved[0] : undefined);
    const aliasCandidate = selected ?? (state.connections.length === 1 ? state.connections[0] : undefined);
    const reusable = sameStation ?? (aliasCandidate && await verifyHubAlias(aliasCandidate.hubUrl, discovery.url) ? aliasCandidate : undefined);
    if (generation !== connectionGeneration) throw new Error('连接选择已改变，请重试');
    if (!stillWanted()) return;
    if (reusable) {
      committed = true;
      await useSavedConnection(reusable.id, true, { stillWanted });
      return;
    }
    selectionAttempted = true;
    await selectConnection(null);
    if (generation !== connectionGeneration) throw new Error('连接选择已改变，请重试');
    if (!stillWanted()) return;
    serviceAttempted = true;
    await setSetting(SETTING, null);
    if (generation !== connectionGeneration) throw new Error('连接选择已改变，请重试');
    if (!stillWanted()) return;
    committed = true;
    resetConnection({ phase: 'pairing', selectedHubUrl: discovery.url, signingIn: null });
    hub = { url: discovery.url };
    hubCapabilities = new Set(discovery.capabilities);
  } finally {
    // Cancellation during a SQLite await must also retain the saved startup
    // choice. Never restore over a different connection that has since won.
    if (!committed && generation === connectionGeneration) {
      try {
        if (selectionAttempted) await selectConnection(previousConnectionId);
        if (serviceAttempted && generation === connectionGeneration) await setSetting(SETTING, previousServiceId);
      } finally { if (generation === connectionGeneration && state.signingIn === 'station') set({ signingIn: null }); }
    }
  }
}

export async function useSavedConnection(id: string, deferNetwork = false, options: { skipHandover?: boolean; handoverOperationId?: string; stillWanted?: () => boolean; requireOnline?: boolean } = {}): Promise<void> {
  const profile = state.connections.find((item) => item.id === id);
  if (!profile) throw new Error('没有找到这台电脑的连接记录');
  const stillWanted = options.stillWanted ?? (() => true);
  if (!stillWanted()) return;
  const currentProfile = state.connections.find((item) => item.id === state.connectionId);
  const currentOwner = hub;
  // Selecting another station record for the same physical computer is a
  // server handover, not merely a phone-side view change. Ask the currently
  // active Hub to atomically switch the desktop first; otherwise the phone
  // could show B while the computer remains attached to A.
  if (!options.skipHandover && !deferNetwork && !profile.botGroupId && !currentProfile?.botGroupId && currentOwner?.pairToken && currentProfile && currentProfile.id !== profile.id
    && currentProfile.deviceId === profile.deviceId && (!currentProfile.computerId || !profile.computerId)) {
    // Legacy records do not carry the physical-computer identity. Never move
    // the phone between two station records that expose the same device ID
    // without that proof; re-pair after updating the computer instead.
    throw new Error('无法确认这是同一台电脑，请更新电脑端后重新扫码');
  }
  if (!options.skipHandover && !deferNetwork && !profile.botGroupId && !currentProfile?.botGroupId && currentOwner?.pairToken && currentProfile && currentProfile.id !== profile.id
    && currentProfile.computerId && profile.computerId && currentProfile.computerId === profile.computerId) {
    // Keep one lock implementation for station-only and API+station changes.
    // The helper journals the operation and reuses the same exact receipt path.
    await switchRemoteStation(currentProfile.deviceId, profile.id, undefined, undefined, undefined, undefined, { stillWanted });
    return;
  }
  // Reserve ownership before any await. Keep the current page intact until the
  // selected credential is ready, so leaving the picker can cancel activation.
  let generation = ++connectionGeneration;
  set({ signingIn: id });
  const current = () => generation === connectionGeneration && stillWanted();
  const requireOnline = options.requireOnline === true && !deferNetwork;
  let pairedRequestIssued = false;
  try {
    const discovery = deferNetwork ? null : await discoverSavedStation(profile.hubUrl);
    if (!current()) return;
    const token = await connectionToken(profile);
    if (!current()) return;
    if (!token) {
      if (requireOnline) throw new Error('这条连接的配对已失效，请重新扫码');
      if (options.handoverOperationId) throw new Error('目标中转站的手机配对已失效，请重新扫码');
      if (!await selectConnectionIf(null, current)) return;
      resetConnection({ phase: 'pairing', selectedHubUrl: profile.hubUrl, signingIn: null, connection: 'idle', connectionId: null });
      generation = connectionGeneration;
      hub = { url: profile.hubUrl };
      return;
    }
    const activeOwner: Hub = { url: profile.hubUrl, pairToken: token, ...(profile.botGroupId ? { botToken: token } : {}), deviceId: profile.deviceId };
    // An available Hub does not imply that this exact computer is reachable.
    // Authenticate and verify the target before replacing the old connection.
    pairedRequestIssued = requireOnline;
    const confirmedDevices = requireOnline ? await fetchDevices(activeOwner) : undefined;
    if (!current()) return;
    if (confirmedDevices && !confirmedDevices.some(item => item.deviceId === profile.deviceId && item.online)) {
      throw new Error('这台电脑当前离线，请选择可用的连接');
    }
    await clearPendingHandover(options.handoverOperationId);
    if (!current() || !await selectConnectionIf(profile.id, current)) return;
    resetConnection({ phase: 'ready', connectionId: profile.id, selectedHubUrl: profile.hubUrl, signingIn: null,
      connection: confirmedDevices ? 'open' : deferNetwork ? 'idle' : 'connecting',
      ...(confirmedDevices ? { devices: confirmedDevices, devicesLoaded: true } : {}) }, { owner: activeOwner, capabilities: discovery?.capabilities ?? [] });
    generation = connectionGeneration;
    if (confirmedDevices) void syncRemoteConnections();
    else if (!deferNetwork) {
      // The desktop acknowledges on A before reconnecting B. Give that
      // bounded reconnect a short grace period; no permanent phone stream or
      // polling loop is created.
      for (let attempt = 0; attempt < 6; attempt += 1) {
        if (generation !== connectionGeneration || activeOwner !== hub) return;
        await refreshDevices(true);
        if (generation !== connectionGeneration || activeOwner !== hub) return;
        if (state.devices.some((item) => item.deviceId === profile.deviceId && item.online)) break;
        if (attempt < 5) await new Promise<void>(resolve => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
  } catch (error) {
    if (!current()) return;
    // Preserve the confirmed A-side owner when a handover's target is unavailable.
    if (!requireOnline && !options.handoverOperationId) resetConnection({ phase: 'ready', connectionId: profile.id, selectedHubUrl: profile.hubUrl,
      signingIn: null, devicesLoaded: true, connection: 'error', ...connectionFailure(error, pairedRequestIssued) });
    throw error;
  } finally {
    if (generation === connectionGeneration && state.signingIn === id) set({ signingIn: null });
  }
}

/** Scanner validation and confirmation are separate: merely scanning never sends a ticket. */
export function parseRemoteQr(raw: string): PairQr {
  if (!state.selectedHubUrl || state.phase !== 'pairing') throw new Error('请先输入电脑端显示的连接地址并检查远程服务');
  return readPairQr(raw, state.selectedHubUrl);
}

/** Direct scanner: validate locally; do not send any credential merely on scan. */
export function parseScannedRemoteQr(raw: string): PairQr { return readPairQr(raw, null); }

function pairingKey(qr: PairQr): string { return `${qr.hubUrl}\u0000${qr.deviceId}\u0000${qr.ticket}`; }

/** The QR supplies the station. Discover it anonymously after user confirmation,
 * then claim the single-use ticket. An existing pairing is retained on failure. */
async function pairScannedRemoteQrImpl(validated: PairQr, stillWanted: () => boolean, attempt: number): Promise<void> {
  const generation = connectionGeneration;
  const discovery = await discoverStation(validated.hubUrl);
  if (validated.computerId && !discovery.capabilities.includes('pair.single-phone.v1')) throw new Error('请先更新中转站远程服务后重新扫码');
  if (generation !== connectionGeneration || attempt !== pairingGeneration || !stillWanted()) throw new Error('连接选择已改变，请重新扫码');
  // Recheck expiry after the network check, before transmitting the ticket.
  const identity = validated.computerId ? await phoneIdentity() : undefined;
  if (generation !== connectionGeneration || attempt !== pairingGeneration || !stillWanted()) throw new Error('连接选择已改变，请重新扫码');
  const result = await confirmQrPair(readPairQr(JSON.stringify(validated), discovery.url), identity);
  // A different scan may have superseded this one while the one-time ticket
  // was in flight. Keep the credential durable, but never select the stale
  // computer or replace the active in-memory connection.
  const profile: RemoteConnection = { id: connectionId(validated.hubUrl, validated.deviceId), hubUrl: validated.hubUrl,
    deviceId: validated.deviceId, deviceName: result.device.name, pairedAt: Date.now(), ...(validated.computerId ? { computerId: validated.computerId } : {}) };
  const connections = await saveConnection(profile, result.token, () => pairingOwners.get(profile.id) === attempt);
  if (generation !== connectionGeneration || attempt !== pairingGeneration || !stillWanted()) { set({ connections }); return; }
  await confirmPairingHubIdentity(profile.hubUrl, () => generation === connectionGeneration && attempt === pairingGeneration && stillWanted());
  if (generation !== connectionGeneration || attempt !== pairingGeneration || !stillWanted()) { set({ connections }); return; }
  if (!await selectConnectionIf(profile.id, () => generation === connectionGeneration && attempt === pairingGeneration && stillWanted())) { set({ connections }); return; }
  resetConnection({ phase: 'ready', connections, connectionId: profile.id, selectedHubUrl: profile.hubUrl,
    devices: [result.device], devicesLoaded: true, connection: 'open', connectionError: undefined, connectionProblem: undefined }, {
    owner: { url: profile.hubUrl, pairToken: result.token, deviceId: profile.deviceId }, capabilities: discovery.capabilities,
  });
  void syncRemoteConnections(true);
}

/**
 * Claiming is idempotent within the process for one QR ticket. Camera
 * callbacks often deliver the same frame several times; a second HTTP claim
 * would otherwise consume the ticket error and could surface a false failure
 * after the first claim already succeeded. A different ticket supersedes the
 * older attempt at every await boundary.
 */
function enqueuePairing(qr: PairQr, task: (attempt: number) => Promise<void>): Promise<void> {
  const key = pairingKey(qr), profileId = connectionId(qr.hubUrl, qr.deviceId);
  const existing = pairingFlights.get(key);
  if (existing) return existing;
  const attempt = ++pairingGeneration;
  pairingOwners.set(profileId, attempt);
  const flight = task(attempt);
  pairingFlights.set(key, flight);
  void flight.finally(() => {
    if (pairingFlights.get(key) === flight) pairingFlights.delete(key);
    if (pairingOwners.get(profileId) === attempt) pairingOwners.delete(profileId);
  }).catch(() => undefined);
  return flight;
}

export function pairScannedRemoteQr(qr: PairQr, stillWanted: () => boolean = () => true): Promise<void> {
  const validated = readPairQr(JSON.stringify(qr), null);
  return enqueuePairing(validated, attempt => pairScannedRemoteQrImpl(validated, stillWanted, attempt));
}

async function pairRemoteQrImpl(validated: PairQr, attempt: number): Promise<void> {
  const generation = connectionGeneration;
  const result = await confirmQrPair(validated, validated.computerId ? await phoneIdentity() : undefined);
  if (generation !== connectionGeneration || attempt !== pairingGeneration) throw new Error('连接选择已改变，请重新扫码');
  const profile: RemoteConnection = {
    id: connectionId(validated.hubUrl, validated.deviceId), hubUrl: validated.hubUrl,
    deviceId: validated.deviceId, deviceName: result.device.name, pairedAt: Date.now(), ...(validated.computerId ? { computerId: validated.computerId } : {}),
  };
  const connections = await saveConnection(profile, result.token, () => pairingOwners.get(profile.id) === attempt);
  if (generation !== connectionGeneration || attempt !== pairingGeneration) { set({ connections }); return; }
  await confirmPairingHubIdentity(profile.hubUrl, () => generation === connectionGeneration && attempt === pairingGeneration);
  if (generation !== connectionGeneration || attempt !== pairingGeneration) { set({ connections }); return; }
  if (!await selectConnectionIf(profile.id, () => generation === connectionGeneration && attempt === pairingGeneration)) { set({ connections }); return; }
  hub = { url: profile.hubUrl, pairToken: result.token, deviceId: profile.deviceId };
  lastSeq = 0;
  set({ phase: 'ready', connections, connectionId: profile.id, devices: [result.device], devicesLoaded: true, connection: 'open', connectionError: undefined, connectionProblem: undefined });
  void syncRemoteConnections(true);
}

export function pairRemoteQr(qr: PairQr): Promise<void> {
  if (!state.selectedHubUrl || state.phase !== 'pairing') throw new Error('请先连接中转站');
  const validated = readPairQr(JSON.stringify(qr), state.selectedHubUrl);
  return enqueuePairing(validated, attempt => pairRemoteQrImpl(validated, attempt));
}

export function revokeRemoteConnection(): Promise<void> {
  const id = state.connectionId;
  if (!id) return Promise.reject(new Error('请先恢复这台电脑的连接'));
  return revokeRemoteConnectionById(id);
}

/** Update a phone-only computer label; the Bridge's advertised name is unchanged. */
export async function renameRemoteConnection(id: string, alias: string): Promise<void> {
  const connections = await renameSavedConnection(id, alias);
  set({ connections });
}

export type SavedConnectionHealth = 'online' | 'offline' | 'unreachable' | 'reauth' | 'denied' | 'enrollment' | 'identity' | 'unsupported' | 'unavailable' | 'timeout';
/** Read every saved computer without changing the selected route or its UI state. */
export async function probeSavedConnections(): Promise<Record<string, SavedConnectionHealth>> {
  const profiles = state.connections;
  const health: Record<string, SavedConnectionHealth> = {};
  let next = 0;
  const worker = async () => {
    while (next < profiles.length) {
      const profile = profiles[next++];
      try {
        const token = await connectionToken(profile);
        if (!token) { health[profile.id] = 'reauth'; continue; }
        const devices = await fetchDevices({ url: profile.hubUrl, pairToken: token, ...(profile.botGroupId ? { botToken: token } : {}), deviceId: profile.deviceId });
        const device = devices.find(item => item.deviceId === profile.deviceId);
        health[profile.id] = device?.online ? 'online' : 'offline';
      } catch (error) {
        const problem = connectionProblem(error);
        health[profile.id] = problem === 'pairing' ? 'reauth' : problem === 'permission' ? 'denied' : problem === 'network' ? 'unreachable' : problem;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, profiles.length) }, () => worker()));
  return health;
}

/** Revoke a saved computer directly, without switching the currently open computer. */
export function revokeRemoteConnectionById(id: string): Promise<void> {
  return serializeStationChange(() => revokeRemoteConnectionImpl(id));
}

async function retirePairingReceipts(exactScope: string): Promise<void> {
  await retireDeliveryScope(exactScope);
  const { retireThreadTitleScope } = require('./thread-titles') as typeof import('./thread-titles');
  // The durable delivery fence also hides retired aliases during hydration.
  // Optional display metadata must not prevent other outboxes from retiring.
  await retireThreadTitleScope(exactScope).catch(() => undefined);
  await retireQuestionScope(exactScope);
}

async function revokeRemoteConnectionImpl(id: string): Promise<void> {
  const profile = state.connections.find((item) => item.id === id);
  if (!profile) throw new Error('没有找到这台电脑的连接记录');
  const generation = connectionGeneration;
  const selectedId = state.connectionId;
  const selectedOwner = hub;
  let related = state.connections.filter(item => item.id === profile.id || (profile.botGroupId
    ? item.botGroupId === profile.botGroupId && item.hubUrl === profile.hubUrl
    : !item.botGroupId && profile.computerId && item.computerId === profile.computerId));
  const selectedOwnerMatches = selectedOwner?.url === profile.hubUrl && selectedOwner.deviceId === profile.deviceId;
  const wasActiveTarget = profile.id === selectedId && selectedOwnerMatches && Boolean(selectedOwner?.pairToken);
  const targetToken = profile.id === selectedId && selectedOwnerMatches && selectedOwner?.pairToken
    ? selectedOwner.pairToken : await connectionToken(profile);
  if (!targetToken) throw new Error('这台电脑的配对凭证不可用，请重新扫码绑定后再解除');
  if (profile.botGroupId) {
    // A rebind may already have replaced one member's credential. Revoke only
    // the captured group credential, never a newer phone binding in that group.
    const sameCredential = await Promise.all(related.map(async item => item.id === profile.id || await connectionToken(item) === targetToken));
    related = related.filter((_item, index) => sameCredential[index]);
  }
  const owner: Hub = profile.id === selectedId && selectedOwnerMatches && selectedOwner?.pairToken
    ? selectedOwner : { url: profile.hubUrl, pairToken: targetToken, botToken: profile.botGroupId ? targetToken : undefined, deviceId: profile.deviceId };
  const mutation = beginApiMutation(owner, profile.deviceId, 'API 或中转站正在切换，请稍候');
  try {
  // A physical computer may have several station-specific identities. Revoke
  // all of this phone's known channels, not just the currently selected one.
  // Keep the exact credentials used by this revoke. A fresh QR claim can
  // replace one of these SecureStore entries while the network request is in
  // flight; later cleanup must not remove that replacement.
  const expectedTokens = new Map<string, string | null>();
  const revoked = await Promise.allSettled(related.map(async item => {
    const token = item.id === profile.id ? targetToken : await connectionToken(item);
    expectedTokens.set(item.id, token);
    if (!token) return item;
    try { await revokePair({ url: item.hubUrl, deviceId: item.deviceId, pairToken: token, botToken: item.botGroupId ? token : undefined }); }
    catch (error) { if (!isPairingAuthenticationError(error)) throw error; }
    return item;
  }));
  // A successful revoke permanently invalidates the captured old credential,
  // even if another station failed or a fresh QR replaced the active owner.
  // Finish every confirmed scope's durable retirement before reporting either
  // condition; the ownership fence below still protects cache and UI cleanup.
  const retiredResults = await Promise.allSettled(revoked.map(async result => {
    if (result.status !== 'fulfilled' || !result.value) return;
    const item = result.value;
    const expectedToken = expectedTokens.get(item.id);
    if (expectedToken) await retirePairingReceipts(`${item.id}|credential:${deliveryCredentialId(expectedToken)}`);
    await retirePairingReceipts(item.id);
  }));
  if (retiredResults.some(result => result.status === 'rejected')) throw new Error('已撤销的配对仍有本地待确认记录未清理，请重试');
  const revokeFailures = revoked.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  const persistenceFailure = revokeFailures.find(result => result.reason instanceof HubError && result.reason.code === 'pair_revoke_persistence_failed');
  if (persistenceFailure) throw persistenceFailure.reason;
  if (revokeFailures.length) throw new Error('部分中转站暂时未能解除绑定，请网络恢复后重试');
  // If a replacement QR became active while revoking the selected computer,
  // leave that newer pairing untouched and let the caller retry explicitly.
  if (wasActiveTarget && (generation !== connectionGeneration || selectedOwner !== hub)) throw new Error('连接已改变，请刷新后再解除绑定');
  let connections = state.connections;
  for (const item of related) {
    const expectedToken = expectedTokens.get(item.id);
    const currentToken = await connectionToken(item);
    // A new QR claim can replace a credential during the network revoke. Keep
    // its new local profile and credential, even though the old token retired.
    if (expectedToken ? Boolean(currentToken && currentToken !== expectedToken) : Boolean(currentToken)) {
      connections = await loadConnections();
      continue;
    }
    if (expectedToken) await clearRemoteCache(`${item.id}|credential:${deliveryCredentialId(expectedToken)}`, [item.deviceId]);
    // Retire the pre-credential cache too; never migrate unverified contents.
    await clearRemoteCache(item.id, [item.deviceId]);
    try { connections = await forgetConnection(item, expectedToken ?? undefined); }
    catch {
      // The server revoke has already succeeded. A failing OS keychain delete
      // must not leave the revoked token in active memory or strand cleanup of
      // other stations. Only a successfully persisted index removal is enough
      // to continue; otherwise keep the records available for a safe retry.
      const remaining = await loadConnections();
      if (remaining.some(connection => connection.id === item.id)) throw new Error('解除绑定已生效，本地记录未清理，请重试');
      connections = remaining;
    }
  }
  const currentProfile = state.connections.find(item => item.id === state.connectionId);
  const currentExpected = currentProfile ? expectedTokens.get(currentProfile.id) : undefined;
  const activeCredentialRevoked = Boolean(currentProfile && currentExpected && hub?.pairToken === currentExpected);
  const selectedProfileWasRemoved = Boolean(selectedId && state.connectionId === selectedId && !connections.some(item => item.id === selectedId));
  if (activeCredentialRevoked || selectedProfileWasRemoved) {
    await discardPendingHandover();
    // The cleanup write above may have yielded to a fresh QR claim. Do not
    // reset its active in-memory state or overwrite its newly saved profile.
    if (generation !== connectionGeneration || wasActiveTarget && selectedOwner !== hub) {
      set({ connections: await loadConnections() });
      return;
    }
    resetConnection({ phase: 'pairing', connectionId: null, selectedHubUrl: currentProfile?.hubUrl ?? profile.hubUrl,
      devices: [], devicesLoaded: true, connection: 'idle', connectionError: undefined, connectionProblem: undefined, sessions: {}, agents: {}, timelines: {}, approvals: {}, focus: null, connections });
    return;
  }
  set({ connections: await loadConnections() });
  } finally { endApiMutation(mutation); }
}

/** Reads the saved relay once and connects; call whenever the service list changes. */
export async function bootRemote(providers: ProviderProfile[]): Promise<void> {
  const generation = connectionGeneration;
  if (!booted) {
    booted = true;
    // Run before restoring any remote state. Runtime collectors cannot know
    // every preview or debounced writer that still holds a prior image URI.
    const { collectRemoteImagesAtStartup } = require('./queued-image-files') as typeof import('./queued-image-files');
    await collectRemoteImagesAtStartup().catch(() => undefined);
    await maintainRemoteRecovery();
    if (generation !== connectionGeneration) return;
    const connections = await loadConnections().catch(() => []);
    if (generation !== connectionGeneration) return;
    const selected = await selectedConnection().catch(() => null);
    if (generation !== connectionGeneration) return;
    set({ connections });
    if (selected && connections.some((item) => item.id === selected)) {
      await useSavedConnection(selected, true).catch(() => undefined);
      // If the process died after the desktop committed B but before this
      // phone persisted its selected connection, reconcile the non-secret
      // handover journal opportunistically.  Offline B simply leaves A active
      // and will be retried on the next foreground/startup check.
      await recoverPendingHandoverOnce();
      return;
    }
    const saved = await getSetting(SETTING).catch(() => null);
    if (generation !== connectionGeneration) return;
    set({ serviceId: saved, phase: saved ? 'ready' : 'setup' });
  }
  if (state.connectionId || state.selectedHubUrl) return;
  const service = providers.find((item) => item.id === state.serviceId);
  if (state.serviceId && !service && providers.length) { await signOutRemote(); return; }
  if (!service || hub) return;
  const owner = hub;
  const current = () => generation === connectionGeneration && hub === owner && state.serviceId === service.id
    && !state.connectionId && !state.selectedHubUrl;
  // Legacy pair tokens were issued only for this exact origin's default Hub.
  const url = hubUrlFor(service.baseUrl) ? canonicalHubUrl(new URL(service.baseUrl).origin) : null;
  if (!url) return;
  const pairToken = await getPairToken(service.id).catch(() => null);
  if (!current()) return;
  hub = { url, pairToken: pairToken ?? undefined };
  set({ phase: pairToken ? 'ready' : 'pairing' });
  if (pairToken) startDemandConnection();
}

/** Returning to the remote screen performs one short check, never opens a permanent stream. */
export function setRemoteForeground(active: boolean) {
  if (active) { void maintainRemoteRecovery(); if (!recoveryMaintenanceTimer) recoveryMaintenanceTimer = setInterval(() => { void maintainRemoteRecovery(); }, 5 * 60_000); }
  else if (recoveryMaintenanceTimer) { clearInterval(recoveryMaintenanceTimer); recoveryMaintenanceTimer = undefined; }
  if (!active) stopStream();
  if (!hub?.pairToken) return;
  if (active && screenOpen) {
    void recoverPendingHandoverOnce();
    startDemandConnection();
  }
}

let recoveryMaintenanceTimer: ReturnType<typeof setInterval> | undefined;
let recoveryMaintenance: Promise<unknown> | undefined;
async function maintainRemoteRecovery(): Promise<void> {
  if (recoveryMaintenance) { await recoveryMaintenance; return; }
  const run = Promise.allSettled([pruneDurableCommandBodies(), pruneDurableEvents(), collectAttachmentCache()]);
  recoveryMaintenance = run;
  try { await run; } finally { if (recoveryMaintenance === run) recoveryMaintenance = undefined; }
}

export async function probeServices(providers: ProviderProfile[]): Promise<void> {
  const generation = ++probeGeneration;
  const byHub = new Map<string, string[]>();
  for (const service of providers) {
    const url = hubUrlFor(service.baseUrl);
    if (!url) { if (generation === probeGeneration) set((current) => ({ probes: { ...current.probes, [service.id]: 'no' } })); continue; }
    byHub.set(url, [...(byHub.get(url) ?? []), service.id]);
  }
  if (generation !== probeGeneration) return;
  set((current) => {
    const probes = { ...current.probes };
    for (const ids of byHub.values()) for (const id of ids) if (probes[id] !== 'ok') probes[id] = 'checking';
    return { probes };
  });
  await Promise.all([...byHub].map(async ([url, ids]) => {
    const result: Probe = (await ping(url)) ? 'ok' : 'no';
    if (generation !== probeGeneration) return;
    set((current) => ({ probes: { ...current.probes, ...Object.fromEntries(ids.map((id) => [id, result])) } }));
  }));
}

export async function signInRemote(service: ProviderProfile): Promise<void> {
  const url = hubUrlFor(service.baseUrl);
  if (!url) throw new Error('这个 API 地址不对');
  // A new station login supersedes any QR confirmation or previous login that
  // is still waiting on the network. Existing state is kept until this login
  // proves the target, but stale completions are rejected by this generation.
  const generation = ++connectionGeneration;
  set({ signingIn: service.id });
  try {
    // Legacy account selections migrate without reading or sending model credentials.
    const discovery = await discoverStation(service.baseUrl);
    if (generation !== connectionGeneration) throw new Error('连接选择已改变，请重试');
    const pairToken = discovery.url === canonicalHubUrl(new URL(service.baseUrl).origin) ? await getPairToken(service.id).catch(() => null) : null;
    if (generation !== connectionGeneration) throw new Error('连接选择已改变，请重试');
    const next: Hub = { url: discovery.url, pairToken: pairToken ?? undefined };
    let paired = Boolean(pairToken);
    if (paired) {
      try { await fetchDevices(next); }
      catch (error) {
        // A transient outage must not erase an existing one-to-one pairing.
        if (generation !== connectionGeneration) throw new Error('连接选择已改变，请重试');
        if (isPairingAuthenticationError(error)) {
          paired = false;
          await deletePairToken(service.id, pairToken ?? undefined).catch(() => undefined);
          next.pairToken = undefined;
        }
      }
    }
    if (generation !== connectionGeneration) throw new Error('连接选择已改变，请重试');
    stopStream(); connectionGeneration += 1;
    const committedGeneration = connectionGeneration;
    hub = next;
    hubCapabilities = new Set(discovery.capabilities);
    lastSeq = 0;
    await setSetting(SETTING, service.id);
    if (committedGeneration !== connectionGeneration) throw new Error('连接选择已改变，请重试');
    await selectConnection(null);
    if (committedGeneration !== connectionGeneration) throw new Error('连接选择已改变，请重试');
    set({ ...initial, connections: state.connections, phase: paired ? 'ready' : 'pairing', serviceId: service.id, probes: state.probes, signingIn: null });
    if (committedGeneration === connectionGeneration && paired) startDemandConnection();
  } finally {
    if (generation === connectionGeneration && state.signingIn === service.id) set({ signingIn: null });
  }
}

export async function signOutRemote(): Promise<void> {
  const generation = ++connectionGeneration;
  const serviceId = state.serviceId;
  stopStream();
  await discardPendingHandover();
  const oldPairToken = serviceId ? await getPairToken(serviceId).catch(() => null) : null;
  if (generation !== connectionGeneration) return;
  if (serviceId) await deletePairToken(serviceId, oldPairToken ?? undefined).catch(() => undefined);
  if (generation !== connectionGeneration) return;
  hub = null;
  lastSeq = 0;
  await setSetting(SETTING, null).catch(() => undefined);
  if (generation !== connectionGeneration) return;
  await selectConnection(null).catch(() => undefined);
  if (generation !== connectionGeneration) return;
  set({ ...initial, phase: 'setup', probes: state.probes, connections: state.connections });
}

export async function pairRemote(code: string): Promise<void> {
  if (!hub || !state.serviceId) throw new Error('请先选择中转站');
  const owner = hub;
  const serviceId = state.serviceId;
  const generation = connectionGeneration;
  const result = await confirmPair(owner, code);
  if (generation !== connectionGeneration || owner !== hub || serviceId !== state.serviceId) throw new Error('连接选择已改变，请重试');
  await savePairToken(serviceId, result.token);
  if (generation !== connectionGeneration || owner !== hub || serviceId !== state.serviceId) {
    await deletePairToken(serviceId, result.token).catch(() => undefined);
    throw new Error('连接选择已改变，请重试');
  }
  hub = { ...owner, pairToken: result.token };
  lastSeq = 0;
  set({ phase: 'ready', devices: [result.device], devicesLoaded: true, connection: 'open', connectionError: undefined, connectionProblem: undefined });
}

/** Synchronize other relays belonging to the selected physical computer. A
 * failed relay never invalidates the successful QR or changes the selection.
 * Re-entering/refreshing the home screen retries partial failures; callers may
 * explicitly force a retry from the device/API management page. */
export function syncRemoteConnections(force = false): Promise<void> {
  const owner = hub;
  const source = state.connections.find(item => item.id === state.connectionId);
  if (!owner?.pairToken || owner.botToken || !source?.computerId || !hubCapabilities.has('pair.connections.v1')) return Promise.resolve();
  if (!state.devices.find(item => item.deviceId === source.deviceId)?.capabilities?.includes('pair.connections.v1')) return Promise.resolve();
  if (connectionSyncFlight?.owner === owner) return connectionSyncFlight.promise;
  if (!force && state.connectionSync?.connectionId === source.id && Date.now() - (state.connectionSync.checkedAt ?? 0) < 30_000) return Promise.resolve();
  const generation = connectionGeneration, token = owner.pairToken;
  const current = () => hub === owner && generation === connectionGeneration && state.connectionId === source.id;
  const run = async () => {
    set({ connectionSync: { connectionId: source.id, loading: true, failed: [] } });
    try {
      let raw: unknown;
      // The QR acknowledgement may precede the Bridge's pair.status event.
      for (let attempt = 0; ; attempt++) {
        try { raw = await command(owner, source.deviceId, { type: 'remote.connections.sync' }); break; }
        catch (error) {
          if (!current() || attempt >= 2 || !(error instanceof HubError) || !error.message.includes('绑定尚未确认')) throw error;
          await new Promise<void>(resolve => setTimeout(resolve, 500 * (attempt + 1)));
        }
      }
      if (!current()) return;
      const result = parseConnectionSync(raw, source.computerId!);
      const failed: { hubUrl: string; message: string }[] = [];
      for (const entry of result.connections) {
        if (!current()) return;
        if (entry.retained) {
          const existing = state.connections.find(item => item.hubUrl === entry.hubUrl && item.deviceId === entry.deviceId && item.computerId === source.computerId);
          try {
            const savedToken = existing ? await connectionToken(existing) : null;
            if (!savedToken) throw new Error('missing credential');
            const devices = await fetchDevices({ url: entry.hubUrl, deviceId: entry.deviceId, pairToken: savedToken });
            if (!devices.some(item => item.deviceId === entry.deviceId)) throw new Error('wrong device');
          } catch { failed.push({ hubUrl: entry.hubUrl, message: '本站已保留绑定，当前手机保存的连接凭据暂不可用' }); }
          continue;
        }
        if (!entry.token) { failed.push({ hubUrl: entry.hubUrl, message: entry.error! }); continue; }
        const id = connectionId(entry.hubUrl, entry.deviceId);
        // The source QR token remains authoritative for its own station.
        if (id === source.id) continue;
        try {
          const connections = await saveConnection({ id, hubUrl: entry.hubUrl, deviceId: entry.deviceId, deviceName: entry.deviceName,
            computerId: source.computerId, pairedAt: state.connections.find(item => item.id === id)?.pairedAt ?? Date.now() }, entry.token, current, { profile: source, token });
          if (!current()) return;
          set({ connections });
        } catch { failed.push({ hubUrl: entry.hubUrl, message: '手机未保存该中转站连接，请重试同步' }); }
      }
      if (current()) set({ connectionSync: { connectionId: source.id, loading: false, failed, checkedAt: Date.now() } });
    } catch (error) {
      if (current()) set({ connectionSync: { connectionId: source.id, loading: false, failed: [], checkedAt: Date.now(), error: (error as Error).message } });
    }
  };
  const promise = run();
  connectionSyncFlight = { owner, promise };
  void promise.finally(() => { if (connectionSyncFlight?.promise === promise) connectionSyncFlight = undefined; });
  return promise;
}

export async function refreshDevices(quiet = false): Promise<void> {
  if (!hub || !hub.pairToken) return;
  const owner = hub;
  const generation = connectionGeneration;
  const revision = ++devicesRevision;
  const current = () => owner === hub && generation === connectionGeneration && revision === devicesRevision;
  let pairedDevicesRequestIssued = false;
  try {
    if (!hubCapabilities.size) {
      const discovery = await discoverSavedStation(owner.url);
      if (!current()) return;
      hubCapabilities = new Set(discovery.capabilities);
    }
    pairedDevicesRequestIssued = true;
    const list = await fetchDevices(owner);
    if (!current()) return;
    set({ devices: list, devicesLoaded: true, connection: 'open', connectionError: undefined, connectionProblem: undefined });
    if (list.some(item => item.deviceId === owner.deviceId && item.online)) void syncRemoteConnections();
  } catch (error) {
    if (!current()) return;
    if (pairedDevicesRequestIssued && isPairingAuthenticationError(error)) {
      stopStream();
      const cacheScope = remoteCacheScope();
      const deliveryScope = remoteDeliveryScope();
      const profile = state.connections.find((item) => item.id === state.connectionId
        && item.hubUrl === owner.url && item.deviceId === owner.deviceId);
      // Retire a multi-station profile, not just the in-memory Hub. Otherwise
      // bootRemote() reads the revoked SecureStore token again after restart.
      // Bot credentials authorize one group. Retire all saved members using
      // this exact Hub/group/token; other groups and relay pairings survive.
      const related = profile ? state.connections.filter(item => item.id === profile.id
        || Boolean(profile.botGroupId && item.hubUrl === profile.hubUrl && item.botGroupId === profile.botGroupId)) : [];
      const revokedHub = { ...owner, pairToken: undefined, botToken: undefined };
      hub = revokedHub;
      connectionGeneration += 1;
      let deliveryCleanupFailed = false;
      try {
        await retirePairingReceipts(deliveryScope);
      } catch {
        // The credential is already invalid. Keep its profile index available
        // for retry if durable retirement or cleanup could not complete.
        deliveryCleanupFailed = true;
      }
      if (cacheScope) await clearRemoteCache(cacheScope, [owner.deviceId!]).catch(() => undefined);
      let connections = state.connections;
      if (profile && !deliveryCleanupFailed) {
        for (const item of related) {
          // A concurrent successful rebind can replace any group member.
          // Finish old-credential cleanup without deleting the replacement.
          if (await connectionToken(item) !== owner.pairToken) continue;
          const scope = `${item.id}|credential:${deliveryCredentialId(owner.pairToken!)}`;
          try {
            await retirePairingReceipts(scope);
            await retirePairingReceipts(item.id);
            await clearRemoteCache(scope, [item.deviceId]).catch(() => undefined);
            connections = await forgetConnection(item, owner.pairToken);
            if (await connectionToken(item) === null) await clearRemoteCache(item.id, [item.deviceId]).catch(() => undefined);
          } catch {
            connections = await loadConnections().catch(() => connections);
          }
        }
      } else if (!profile && state.serviceId && !deliveryCleanupFailed) {
        await deletePairToken(state.serviceId, owner.pairToken).catch(() => undefined);
      }
      if (hub !== revokedHub) return;
      await discardPendingHandover();
      if (hub !== revokedHub) return;
      set({ phase: 'pairing', serviceId: profile ? null : state.serviceId, connections,
        connectionId: null, selectedHubUrl: owner.url, devices: [], devicesLoaded: true, sessions: {}, agents: {}, timelines: {}, approvals: {}, focus: null,
        connection: 'error', ...connectionFailure(error) });
      if (!quiet) throw error;
      return;
    }
    set({ devicesLoaded: true, ...connectionFailure(error, pairedDevicesRequestIssued), connection: 'error' });
    if (!quiet) throw error;
  }
}

function need(): Hub {
  if (!hub?.pairToken) throw new Error('请先扫码配对电脑');
  return hub;
}

function sessionAgentId(key: string): AgentId {
  const id = sessionKeyAgentId(key);
  if (!id) throw new Error('会话身份无效');
  return id;
}
function agentProfile(deviceId: string, id: AgentId): AgentProfile | undefined {
  return state.agents[deviceId]?.list.find(profile => profile.id === id);
}
function requireAgentCapability(deviceId: string, id: AgentId, capability: keyof AgentCapabilities): void {
  if (!validAgentId(id) || !agentSupports(agentProfile(deviceId, id), id, capability)) throw new HubError('这个 Agent 暂不支持此操作', 200, 'agent_capability_unavailable');
}
function requireExecution(deviceId: string, id: AgentId, tool: ToolId, desktop = false) {
  const execution = resolveAgentExecution(agentProfile(deviceId, id), id);
  if (!execution || execution.tool !== tool || execution.controlSurface !== 'cli' || Boolean(execution.entrypoint) !== desktop) {
    throw new HubError('这个 Agent 暂不支持此操作', 200, 'agent_capability_unavailable');
  }
  return execution;
}
function sessionExecutionAgent(deviceId: string, sessionKey: string): AgentId {
  const tool = sessionAgentId(sessionKey);
  const info = state.timelines[timelineKey(deviceId, sessionKey)]?.session
    ?? state.sessions[deviceId]?.list.find(session => session.sessionKey === sessionKey);
  return tool === 'claude' && info?.client === 'Claude Desktop' ? 'claude-desktop' : tool;
}
function requireSessionExecution(deviceId: string, sessionKey: string, allowArchived = false): void {
  const info = state.timelines[timelineKey(deviceId, sessionKey)]?.session ?? state.sessions[deviceId]?.list.find(session => session.sessionKey === sessionKey);
  if (!allowArchived && info?.archived) throw new HubError('对话已归档', 409, 'session_archived');
  const id = sessionExecutionAgent(deviceId, sessionKey);
  requireExecution(deviceId, id, sessionAgentId(sessionKey), id === 'claude-desktop');
}
function requireClaudeApiAdmission(deviceId: string, id: AgentId, accountId?: string): void {
  const profile = agentProfile(deviceId, id);
  if (resolveAgentExecution(profile, id)?.tool !== 'claude') return;
  if (!claudeApiAdmissionReady(profile, id)) throw new HubError('Claude 远程仅支持 API，请先选择有效的 API', 200, 'claude_api_required');
  if (profile?.api.accountId !== accountId) throw new HubError('API 已改变，请先核对原任务', 200, 'request_scope_changed');
}
function requireModelDirectory(deviceId: string, id: AgentId): void {
  const profile = agentProfile(deviceId, id);
  if (!validAgentId(id) || !agentSupports(profile, id, 'list') && !agentSupports(profile, id, 'read')) throw new HubError('这个 Agent 暂不支持模型目录', 200, 'agent_capability_unavailable');
}
function selectedAgentAccount(deviceId: string, id: AgentId): string | undefined {
  const exact = agentProfile(deviceId, id);
  // Family sharing never chooses a different adapter. Compatibility applies
  // only to a shipped alias whose legacy status omitted its own profile.
  return exact ? exact.api.accountId : builtinAgent(id)
    ? state.agents[deviceId]?.list.find(profile => agentApiFamily(profile) === agentApiFamily(id))?.api.accountId : undefined;
}
function requireTurnCapabilities(deviceId: string, id: AgentId, options: TurnFeatures & { model?: string; effort?: Effort; permissionMode?: PermissionMode; approval?: ApprovalMode }, images = 0, receiptRecovery = false, starting = false): void {
  requireAgentCapability(deviceId, id, 'send');
  if (options.contextReferences?.length && !agentProfile(deviceId, id)?.capabilities?.contextReferences) throw new Error('电脑暂不支持结构化引用，请更新 Bridge');
  if (hasResponseAnnotations(options.contextReferences) && !agentProfile(deviceId, id)?.capabilities?.contextAnnotations) throw new Error('电脑暂不支持文字选区注释，请更新 Bridge');
  if (hasDiffAnnotations(options.contextReferences) && (!agentProfile(deviceId, id)?.capabilities?.contextDiffAnnotations || !hubSupportsDiffAnnotations())) throw new Error('电脑或中转站暂不支持差异行批注，请更新 Bridge 和 Hub');
  if (options.approval !== undefined && !receiptRecovery && (id === 'claude' || id === 'claude-desktop' || !starting)) {
    const profile = agentProfile(deviceId, id);
    const legacyStart = starting && options.approval !== 'auto_all';
    if (resolveAgentExecution(profile, id)?.tool !== 'claude' || !isApprovalMode(options.approval)
      || !legacyStart && !profile?.capabilities?.approvalModes?.includes(options.approval)) {
      throw new HubError('电脑暂不支持这个 Claude 审批模式，请刷新电脑连接', 200, 'permission_mode_unavailable');
    }
    if (options.approval === 'auto_all' && state.agents[deviceId]?.autoAll !== true) {
      throw new HubError('请先在电脑允许全部自动', 200, 'permission_mode_forbidden');
    }
  }
  if (!validTurnFeatures(options) || (options.collaborationMode !== undefined || options.skills !== undefined) && !agentProfile(deviceId, id)?.capabilities?.features) throw new Error('当前 Agent 不支持工作模式或技能选项');
  if (options.permissionMode !== undefined) {
    if (id !== 'codex' || !isPermissionMode(options.permissionMode) || !agentProfile(deviceId, id)?.capabilities?.permissionModes?.includes(options.permissionMode)) {
      throw new HubError('电脑暂不支持这个批准模式，请刷新电脑连接', 200, 'permission_mode_unavailable');
    }
    if (options.permissionMode === 'full_access' && state.agents[deviceId]?.autoAll !== true) {
      throw new HubError('请先在电脑允许完全访问权限', 200, 'permission_mode_forbidden');
    }
  }
  if (options.model?.trim() || options.effort) {
    const createOnly = starting && !options.effort && agentProfile(deviceId, id)?.capabilities?.startModelOverride === true;
    if (!createOnly) requireAgentCapability(deviceId, id, 'modelOverride');
  }
  if (images) { requireAgentCapability(deviceId, id, 'attachments'); requireAgentCapability(deviceId, id, 'imageInput'); }
}
function requireApiSelection(deviceId: string, id: AgentId, model?: string, key?: string): void {
  if (!validAgentId(id) || !builtinAgent(id) && !agentProfile(deviceId, id)) throw new Error('电脑没有这个 Agent');
  if (model?.trim()) requireAgentCapability(deviceId, id, 'modelOverride');
  if (key && sessionAgentId(key) !== (id === 'claude-desktop' ? 'claude' : id)) throw new Error('Agent 与会话归属不一致');
}
function eventMatchesSession(event: HubEvent, key: string): boolean {
  let id: string;
  try { id = sessionAgentId(key); } catch { return false; }
  const tool = id === 'claude-desktop' ? 'claude' : id;
  if (event.sessionKey !== key || event.tool !== tool && (event.tool || !builtinAgent(id))) return false;
  return event.type !== 'session.updated' || Boolean(event.session && validSessionTool(event.session, key));
}
function validSessionTool(info: SessionInfo, key: string): boolean {
  const id = sessionAgentId(key), tool = id === 'claude-desktop' ? 'claude' : id;
  return info.sessionKey === key && (info.tool === tool || !info.tool && builtinAgent(id))
    && (builtinAgent(id) || info.controlSurface === undefined || info.controlSurface === 'cli');
}
function invalidateFamilyModels(deviceId: string, family: string, extra: AgentProfile[] = []): void {
  const tools = new Set<string>([family]);
  for (const profile of [...(state.agents[deviceId]?.list ?? []), ...extra]) if (agentApiFamily(profile) === family) { tools.add(profile.tool); tools.add(profile.id); }
  agentFeatureCache.invalidate(deviceId, tools);
  for (const tool of tools) {
    const key = `${deviceId}|${tool}`;
    contextSourceGenerations.set(key, (contextSourceGenerations.get(key) ?? 0) + 1);
    modelCache.delete(key); modelRequests.set(key, (modelRequests.get(key) ?? 0) + 1);
  }
  if (tools.has('codex')) for (const key of new Set([...modelCache.keys(), ...modelRequests.keys()])) {
    if (key.startsWith(`${deviceId}|codex|desktop|`)) { modelCache.delete(key); modelRequests.set(key, (modelRequests.get(key) ?? 0) + 1); }
  }
}

export function remoteDeliveryScope(): string {
  const station = state.connectionId ?? state.selectedHubUrl ?? state.serviceId ?? '';
  return hub?.pairToken ? `${station}|credential:${deliveryCredentialId(hub.pairToken)}` : station;
}

export interface RemoteContentRecoveryResult { deviceId: string; deviceName: string; total: number; synced: number; failed: number; directoryFailed: number }
export type RemoteContentRecoveryStage = 'checking' | 'directory' | 'content';
export type RemoteContentRecoveryProgress = (stage: RemoteContentRecoveryStage, done: number, total: number) => void;

/**
 * Settings recovery is read-only: refresh the selected computer, then merge
 * fresh directory/snapshot/event data through the existing cache-safe paths.
 * Scope and generation checks ensure a late request from station A cannot
 * publish or continue work after the user switches to station B.
 */
export function recoverRemoteContent(onProgress?: RemoteContentRecoveryProgress): Promise<RemoteContentRecoveryResult> {
  const owner = need(), generation = connectionGeneration, scope = remoteDeliveryScope();
  const selectedConnectionId = state.connectionId, deviceId = owner.deviceId;
  if (!selectedConnectionId || !deviceId || state.phase !== 'ready') return Promise.reject(new Error('请先连接一台电脑'));
  const current = () => owner === hub && generation === connectionGeneration && state.connectionId === selectedConnectionId
    && remoteDeliveryScope() === scope && state.phase === 'ready';
  if (remoteContentRecoveryFlight?.owner === owner && remoteContentRecoveryFlight.generation === generation
    && remoteContentRecoveryFlight.scope === scope) return remoteContentRecoveryFlight.promise;
  const assertCurrent = () => { if (!current()) throw new Error('连接已切换，同步已停止'); };
  const run = async (): Promise<RemoteContentRecoveryResult> => {
    onProgress?.('checking', 0, 0);
    await refreshDevices();
    assertCurrent();
    const device = state.devices.find(item => item.deviceId === deviceId);
    if (!device?.online) throw new Error('电脑当前离线，请等电脑上线后再同步');

    onProgress?.('directory', 0, 0);
    await loadAgentProfiles(deviceId);
    assertCurrent();
    const profiles = state.agents[deviceId]?.list ?? [];
    const directories: Array<() => Promise<void>> = profiles.filter(profile => profile.id !== 'claude-desktop'
      && profile.available && profile.capabilities?.list === true).slice(0, 8)
      .map(profile => () => loadSessions(deviceId, profile.id, { preservePages: true }));
    const nativeCodex = profiles.find(profile => profile.id === 'codex')?.desktopLive;
    if (nativeCodex?.capabilities?.list && nativeCodex.expiresAt > Date.now()) directories.push(() => loadNativeSessions(deviceId, false, { preservePages: true }));
    const desktopHistory = profiles.find(profile => profile.id === 'claude-desktop')?.desktopHistory;
    if (desktopHistory?.available) for (const scope of desktopHistory.scopes) directories.push(() => loadClaudeDesktopHistory(deviceId, scope, false, { preservePages: true }));
    let directoryFailed = 0;
    const directoryResults = await Promise.allSettled(directories.map(read => read()));
    assertCurrent();
    directoryFailed = directoryResults.filter(result => result.status === 'rejected').length;

    const entry = state.sessions[deviceId];
    const sessions = [...new Map([...(entry?.list ?? []), ...(entry?.native?.list ?? []),
      ...Object.values(entry?.readOnly ?? {}).flatMap(directory => directory?.list ?? [])]
      .filter(item => !item.parentSessionKey).map(item => [item.sessionKey, item])).values()]
      .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, SESSION_PAGE_SIZE);
    onProgress?.('content', 0, sessions.length);
    let next = 0, synced = 0, failed = 0;
    const worker = async () => {
      while (current()) {
        const index = next++;
        if (index >= sessions.length) return;
        try {
          await syncSessionEvents(deviceId, sessions[index].sessionKey);
          assertCurrent();
          synced += 1;
        } catch (error) {
          assertCurrent();
          failed += 1;
        } finally {
          onProgress?.('content', synced + failed, sessions.length);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(2, sessions.length) }, () => worker()));
    assertCurrent();
    return { deviceId, deviceName: device.name, total: sessions.length, synced, failed, directoryFailed };
  };
  const flight = { owner, generation, scope, promise: Promise.resolve(null as unknown as RemoteContentRecoveryResult) };
  flight.promise = run().finally(() => { if (remoteContentRecoveryFlight === flight) remoteContentRecoveryFlight = null; });
  remoteContentRecoveryFlight = flight;
  return flight.promise;
}
async function settleAcceptedRemoteMessage(receipt: PendingDelivery, createdByCall = false): Promise<void> {
  if (!receipt.draftOwner || receipt.acceptedSessionKey !== receipt.sessionKey) return;
  try {
    const draft = receipt.draftOwner;
    if (draft.kind === 'composer') {
      const { consumeAcceptedComposerDraft } = require('./composer-drafts') as typeof import('./composer-drafts');
      await consumeAcceptedComposerDraft(draft.key, receipt.scope, draft.revision, draft.identity);
    } else {
      const { consumeAcceptedQueuedDraft } = require('./drafts') as typeof import('./drafts');
      await consumeAcceptedQueuedDraft(draft.key, receipt.scope, draft.id, draft.afterTurn);
    }
    await acknowledgeAcceptedDelivery(receipt.scope, receipt.deviceId, receipt.sessionKey, receipt.requestId, receipt.sessionKey);
  } catch (error) {
    const current = await pendingDelivery(receipt.scope, receipt.deviceId, receipt.sessionKey);
    if (!current || current.requestId !== receipt.requestId) return; // Another local reconciler already completed it.
    throw new DeliveryPendingError('消息已送达，手机草稿确认尚未完成，原消息不会再次发送', true, receipt.requestId, createdByCall);
  }
}
export async function getPendingRemoteMessage(deviceId: string, sessionKey: string, options?: { settleAccepted?: boolean }) {
  const receipt = await pendingDelivery(remoteDeliveryScope(), deviceId, sessionKey);
  if (options?.settleAccepted && receipt?.draftOwner && receipt.acceptedSessionKey === sessionKey) {
    try { await settleAcceptedRemoteMessage(receipt); return undefined; } catch { return receipt; }
  }
  return receipt;
}
export async function cancelPendingRemoteMessage(deviceId: string, sessionKey: string, scope = remoteDeliveryScope()) {
  const receipt = await pendingDelivery(scope, deviceId, sessionKey);
  if (receipt?.draftOwner && receipt.acceptedSessionKey === sessionKey) { await settleAcceptedRemoteMessage(receipt); return; }
  return cancelPendingDelivery(scope, deviceId, sessionKey);
}
export function pausePendingRemoteMessage(deviceId: string, sessionKey: string, scope = remoteDeliveryScope()) { return pausePendingDelivery(scope, deviceId, sessionKey); }

/**
 * Returns whether any outgoing message or approval answer for this computer is
 * still awaiting a delivery receipt on the active station. A station handover
 * must be all-or-nothing: switching first would move the phone to B while a
 * retry token remains scoped to A. The durable outboxes are checked even when
 * the corresponding session directory is not loaded yet.
 */
async function hasPendingDeliveryForDevice(deviceId: string): Promise<boolean> {
  const scope = remoteDeliveryScope();
  if ((await pendingDeliveriesForDevice(scope, deviceId)).some(item => !item.acceptedSessionKey)) return true;
  if ((await pendingQuestionReceiptsForDevice(scope, deviceId)).length > 0) return true;

  // Keep the state walk as a compatibility fallback for older outbox records
  // that predate the device-wide listing helpers.
  const sessionKeys = new Set<string>();
  const prefix = `${deviceId}|`;
  for (const key of Object.keys(state.timelines)) {
    if (key.startsWith(prefix)) sessionKeys.add(key.slice(prefix.length));
  }
  const entry = state.sessions[deviceId];
  for (const session of entry?.list ?? []) sessionKeys.add(session.sessionKey);
  for (const session of entry?.native?.list ?? []) sessionKeys.add(session.sessionKey);
  for (const directory of Object.values(entry?.readOnly ?? {})) {
    for (const session of directory?.list ?? []) sessionKeys.add(session.sessionKey);
  }
  for (const approval of Object.values(state.approvals)) {
    if (approval.deviceId === deviceId) sessionKeys.add(approval.sessionKey);
  }
  for (const sessionKey of sessionKeys) {
    const pending = await pendingDelivery(scope, deviceId, sessionKey);
    if (pending && !pending.acceptedSessionKey) return true;
  }
  return false;
}

async function targetComputerOnline(profile: RemoteConnection): Promise<boolean> {
  const token = await connectionToken(profile);
  if (!token) return false;
  try {
    const list = await fetchDevices({ url: profile.hubUrl, pairToken: token, deviceId: profile.deviceId });
    return list.some((item) => item.deviceId === profile.deviceId && item.online);
  } catch { return false; }
}

async function handoverPayloadApplied(profile: RemoteConnection, intent: PendingStationHandover): Promise<boolean> {
  const token = await connectionToken(profile);
  if (!token) return false;
  try {
    const expectedHash = handoverPayloadHash(profile, intent.agent, intent.accountId, intent.model, intent.sessionKey, intent.sourceOnly);
    const receipt = await command<unknown>({ url: profile.hubUrl, pairToken: token, deviceId: profile.deviceId }, profile.deviceId,
      { type: 'remote.station.receipt', operationId: intent.operationId });
    if (!receipt || typeof receipt !== 'object') return false;
    const committed = receipt as Record<string, unknown>;
    if (committed.committed !== true || committed.operationId !== intent.operationId || committed.payloadHash !== expectedHash
      || committed.deviceId !== profile.deviceId || typeof committed.hubUrl !== 'string'
      || stationOriginKey(committed.hubUrl) !== stationOriginKey(profile.hubUrl)) return false;
    if (!intent.agent || (!intent.accountId && !intent.model)) return true;
    const result = await command<unknown>({ url: profile.hubUrl, pairToken: token, deviceId: profile.deviceId }, profile.deviceId, { type: 'agents.status' });
    const parsed = parseAgentStatus(result, undefined);
    const family = agentApiFamily(intent.agent);
    const agent = parsed.agents.find((item) => item.id === intent.agent)
      ?? (builtinAgent(intent.agent) ? parsed.agents.find((item) => agentApiFamily(item) === family) : undefined);
    if (!agent) return false;
    if (intent.accountId && agent.api.accountId !== intent.accountId) return false;
    if (intent.model && agent.api.model !== intent.model) return false;
    return true;
  } catch { return false; }
}

function ambiguousHandoverError(error: unknown): boolean {
  // `command()` normalizes transport failures to HubError.  An arbitrary
  // programming/runtime error is not evidence that the Bridge committed B;
  // probing B in that case could move the phone away from a still-active A.
  if (!(error instanceof HubError)) return false;
  return error.status === 0 || error.status >= 500 || error.code === 'command_delivery_uncertain';
}

/**
 * If the old Hub reply was lost after the Bridge committed B, the target
 * station is the only safe recovery signal: its device credential is unique
 * to this computer. Never switch merely because B is paired; it must report
 * this device online, which means the Bridge has actually reconnected there.
 */
async function recoverPendingHandover(intent: PendingStationHandover, expectedGeneration = connectionGeneration, expectedOwner = hub, stillWanted: () => boolean = () => true): Promise<boolean> {
  if (!stillWanted() || expectedGeneration !== connectionGeneration || expectedOwner !== hub) return false;
  const current = state.connections.find((item) => item.id === state.connectionId);
  const target = state.connections.find((item) => item.id === intent.targetConnectionId);
  if (!target || !current || current.id !== intent.fromConnectionId || current.deviceId !== intent.deviceId) return false;
  if (target.computerId && current.computerId && target.computerId !== current.computerId) return false;
  if (!(await targetComputerOnline(target))) return false;
  if (!stillWanted() || expectedGeneration !== connectionGeneration || expectedOwner !== hub) return false;
  if (!(await handoverPayloadApplied(target, intent))) return false;
  if (!stillWanted() || expectedGeneration !== connectionGeneration || expectedOwner !== hub) return false;
  try {
    await useSavedConnection(target.id, false, { skipHandover: true, handoverOperationId: intent.operationId, stillWanted });
    if (!stillWanted() || state.connectionId !== target.id) return false;
    await clearPendingHandover(intent.operationId);
    return true;
  } catch { return false; }
}

/** Same handover UUID and payload, delivered through B's bounded standby lane. */
async function requestStandbyHandover(target: RemoteConnection, intent: PendingStationHandover, expectedGeneration: number, expectedOwner: Hub, stillWanted: () => boolean = () => true): Promise<void> {
  const current = () => stillWanted() && expectedGeneration === connectionGeneration && expectedOwner === hub && state.connectionId === intent.fromConnectionId;
  if (!current()) throw new Error('连接选择已取消，请重新选择');
  const discovery = await discoverSavedStation(target.hubUrl);
  if (!current()) throw new Error('连接已切换，请刷新确认');
  if (!discovery.capabilities.includes('station.standby.v1') || !discovery.capabilities.includes('commands.idempotency.v1')) {
    throw new HubError('目标中转站暂不支持备用切换，请先更新远程服务', 200, 'station_standby_unsupported');
  }
  const token = await connectionToken(target);
  if (!token || !current()) throw new Error('目标配对或连接已变化，请重新确认');
  const reply = await command<unknown>({ url: discovery.url, pairToken: token, deviceId: target.deviceId }, target.deviceId, {
    type: 'remote.station.switch', targetHubUrl: target.hubUrl, targetDeviceId: target.deviceId, targetComputerId: target.computerId!,
    ...(intent.agent ? { agent: intent.agent } : {}), ...(intent.accountId ? { accountId: intent.accountId } : {}),
    ...(intent.model ? { model: intent.model } : {}), ...(intent.sessionKey ? { sessionKey: intent.sessionKey } : {}), operationId: intent.operationId,
    ...(intent.sourceOnly ? { sourceOnly: true } : {}),
  }, intent.operationId, undefined, { transportOnlyHandover: discovery.capabilities.includes('station.guard.v1') && discovery.capabilities.includes('station.handover.v2') });
  if (!current()) throw new Error('连接已切换，请刷新确认');
  // Unlike legacy A replies, standby must prove exactly what was committed.
  if (!reply || typeof reply !== 'object' || !optionalHandoverReplyMatches(reply, intent.operationId, handoverPayloadHash(target, intent.agent, intent.accountId, intent.model, intent.sessionKey, intent.sourceOnly))
    || (reply as Record<string, unknown>).operationId !== intent.operationId || (reply as Record<string, unknown>).switched !== true
    || (reply as Record<string, unknown>).payloadHash !== handoverPayloadHash(target, intent.agent, intent.accountId, intent.model, intent.sessionKey, intent.sourceOnly)) {
    throw new HubError('备用切换回执不匹配，请刷新确认', 409, 'handover_receipt_mismatch');
  }
}

/** Reconcile a handover journal on foreground/screen entry as well as boot. */
async function recoverPendingHandoverOnce(): Promise<boolean> {
  if (handoverRecoveryFlight) return handoverRecoveryFlight;
  const expectedGeneration = connectionGeneration;
  const expectedOwner = hub;
  const flight = serializeStationChange(async () => {
    const intent = await loadPendingHandover();
    if (!intent) return false;
    if (expectedGeneration !== connectionGeneration || expectedOwner !== hub) return false;
    const deviceId = state.connections.find(item => item.id === state.connectionId)?.deviceId;
    if (!expectedOwner || !deviceId || apiMutationBusy(expectedOwner, deviceId)) return false;
    const mutation = beginApiMutation(expectedOwner, deviceId, 'API 或中转站正在切换，请稍候');
    try {
    if (state.connectionId === intent.targetConnectionId) {
      const target = state.connections.find((item) => item.id === intent.targetConnectionId);
      if (target && await handoverPayloadApplied(target, intent)) {
        if (expectedGeneration !== connectionGeneration || expectedOwner !== hub) return false;
        await clearPendingHandover(intent.operationId);
        return true;
      }
      return false;
    }
    return await recoverPendingHandover(intent, expectedGeneration, expectedOwner);
    } finally { endApiMutation(mutation); }
  });
  handoverRecoveryFlight = flight;
  try { return await flight; }
  finally { if (handoverRecoveryFlight === flight) handoverRecoveryFlight = null; }
}

async function runCommand<T = Record<string, unknown>>(owner: Hub, deviceId: string, input: Command, requestId?: string, signal?: AbortSignal, quiet = false, options?: { receiptOnly?: boolean }): Promise<T> {
  try {
    const scope = remoteDeliveryScope(), generation = connectionGeneration, pairing = pairingGeneration;
    const durable = requestId && supportsDurableCommand(input) && (await deliveryUsesDurableProtocol(scope, deviceId, requestId)
      || await durableExecutionId(scope, deviceId, requestId) !== requestId);
    const result = requestId && durable
      ? await executeDurableCommand<T>({ owner, scope, deviceId, intentId: requestId, command: input, signal, receiptOnly: options?.receiptOnly,
        active: () => owner === hub && remoteDeliveryScope() === scope && generation === connectionGeneration && pairing === pairingGeneration,
        bound: async executionId => {
          await bindDeliveryExecution(scope, deviceId, requestId, executionId);
          if (owner !== hub || remoteDeliveryScope() !== scope) return;
          set(current => ({ timelines: Object.fromEntries(Object.entries(current.timelines).map(([key, timeline]) => [key,
            key.startsWith(`${deviceId}|`) ? { ...timeline, items: timeline.items.map(item => item.kind === 'message' && item.local && item.clientId === requestId
              ? { ...item, clientId: executionId } : item) } : timeline])) }));
        } }) : await command<T>(owner, deviceId, input, requestId, signal, options);
    if (!quiet && owner === hub) set((current) => ({ connection: 'open', connectionError: undefined, connectionProblem: undefined,
      ...(!requestId ? { devices: current.devices.map((device) => device.deviceId === deviceId ? { ...device, online: true } : device) } : {}) }));
    return result;
  } catch (error) {
    if (!quiet && owner === hub && !isExecutionPolicyError(error) && error instanceof HubError && (error.status === 0 || error.status >= 500 || error.status === 401 || error.status === 403 || error.status === 409)) {
      set({ connection: 'error', ...connectionFailure(error) });
    }
    throw error;
  }
}

async function retryCapability(owner: Hub, force = false): Promise<boolean> {
  if (!hubCapabilities.size || force) {
    const discovery = await discoverSavedStation(owner.url);
    if (owner !== hub) throw new Error('连接已切换');
    hubCapabilities = new Set(discovery.capabilities);
  }
  return hubCapabilities.has('commands.idempotency.v1');
}

/** Serialize reads for one device/thread while allowing unrelated threads to sync in parallel. */
export function syncSessionEvents(deviceId: string, sessionKey: string, waitSeconds = 0, signal?: AbortSignal): Promise<void> {
  const key = timelineKey(deviceId, sessionKey);
  const previous = sessionSyncTails.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(() => syncSessionEventsCore(deviceId, sessionKey, waitSeconds, signal));
  sessionSyncTails.set(key, current);
  void current.finally(() => { if (sessionSyncTails.get(key) === current) sessionSyncTails.delete(key); }).catch(() => undefined);
  return current;
}

/** A bounded short request resumes only this session's cursor, without keeping an SSE subscription. */
async function syncSessionEventsCore(deviceId: string, sessionKey: string, waitSeconds = 0, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  // Desktop execution is observed through the actual host, not CLI-only Hub
  // emitters. The existing foreground demand window schedules these reads.
  if (isNativeSession(deviceId, sessionKey) || isReadOnlyDesktopSession(sessionKey)) {
    if (state.timelines[timelineKey(deviceId, sessionKey)]?.loading) return;
    await openSession(deviceId, sessionKey, { background: true, signal });
    return;
  }
  const owner = need(), generation = connectionGeneration, pairing = pairingGeneration;
  const key = timelineKey(deviceId, sessionKey);
  requireAgentCapability(deviceId, sessionAgentId(sessionKey), 'read');
  const revisionKey = `sync:${key}`;
  const snapshotKey = `open:${key}`;
  const revision = (sessionRequests.get(revisionKey) ?? 0) + 1;
  sessionRequests.set(revisionKey, revision);
  let snapshotRevision = sessionRequests.get(snapshotKey) ?? 0;
  let approvalSnapshotThrough = sessionApprovalSnapshots.get(key) ?? 0;
  const currentRequest = () => owner === hub && generation === connectionGeneration && pairing === pairingGeneration && sessionRequests.get(revisionKey) === revision
    && (sessionRequests.get(snapshotKey) ?? 0) === snapshotRevision;
  try {
    if (!hubCapabilities.size) {
      const discovery = await discoverSavedStation(owner.url);
      if (!currentRequest()) return;
      hubCapabilities = new Set(discovery.capabilities);
    }
    const durable = hubCapabilities.has('events.durable.v1'), scope = remoteDeliveryScope();
    if (durable && !sessionEpochs.has(key)) {
      const saved = await loadDurableEvents(scope, deviceId, sessionKey);
      if (signal?.aborted || !currentRequest()) return;
      sessionCursors.set(key, saved?.through ?? 0);
      sessionEpochs.set(key, saved?.epoch ?? '');
      for (const event of saved?.events ?? []) handleEvent(event, true);
    }
    if (!durable && (!sessionCursors.has(key) || state.devices.some((device) => device.deviceId === deviceId && device.online === false))) {
      // Establish the cursor BEFORE the authoritative snapshot; later events are not skipped.
      // A known-offline computer is checked by the same read-only recovery,
      // not by adding a permanent presence ping or a model task.
      const flight = snapshotFlights.get(key);
      if (flight?.owner === owner) await flight.promise;
      else await openSession(deviceId, sessionKey, { signal });
      snapshotRevision = sessionRequests.get(snapshotKey) ?? 0;
      if (signal?.aborted || !currentRequest()) return;
      approvalSnapshotThrough = sessionApprovalSnapshots.get(key) ?? 0;
    }
    // A busy session can produce more than three pages while the phone was
    // offline.  Continue while the Hub makes cursor progress; the hard cap is
    // only a malformed-server guard, and the cursor is intentionally retained
    // so the next demand/foreground sync resumes without skipping anything.
    const MAX_INCREMENTAL_PAGES = 16;
    for (let page = 0; page < MAX_INCREMENTAL_PAGES; page += 1) {
      if (signal?.aborted) return;
      const after = sessionCursors.get(key) ?? 0;
      requireAgentCapability(deviceId, sessionAgentId(sessionKey), 'read');
      const result = await sessionEventsPage(owner, deviceId, sessionKey, after, page === 0 && hubSupportsWait() ? waitSeconds : 0, 100, signal,
        () => requireAgentCapability(deviceId, sessionAgentId(sessionKey), 'read'));
      if (signal?.aborted || !currentRequest()) return;
      if (durable) {
        if (!result.storageEpoch) throw new HubError('服务器持久事件缺少存储世代', 502, 'invalid_event_epoch');
        const oldEpoch = sessionEpochs.get(key);
        if (oldEpoch && oldEpoch !== result.storageEpoch) {
          // A restored server cannot reuse the old cursor. Preserve visible
          // content, but replay from zero before acknowledging its new epoch.
          sessionCursors.set(key, 0); sessionEpochs.set(key, result.storageEpoch);
          sessionApprovalSnapshots.delete(key); approvalSnapshotThrough = 0;
          set(current => { const timeline = current.timelines[key]; return timeline ? { timelines: { ...current.timelines,
            [key]: { ...timeline, sessionSeq: undefined, items: timeline.items.map(item => ({ ...item, seq: undefined, orderSeq: undefined })) } } } : {}; });
          continue;
        }
        sessionEpochs.set(key, result.storageEpoch);
      }
      consumeFeatureChanges(owner, generation, pairing, deviceId, result.featureChanges);
      if (signal?.aborted || !currentRequest()) return;
      requireAgentCapability(deviceId, sessionAgentId(sessionKey), 'read');
      const gap = result.events.find((event) => event.deviceId === deviceId && event.sessionKey === sessionKey
        && (typeof event.seq !== 'number' || event.seq > after) && historyGap(event));
      if (result.resetRequired || gap) {
        // The Hub buffer has a gap: reload the authoritative thread, then
        // consume every retained page, including ones outside its recent slice.
        const retainedOnly = durable && state.devices.some(device => device.deviceId === deviceId && device.online === false);
        if (!retainedOnly) snapshotRevision += 1;
        // A gap page is still the source of the unread frontier. The
        // authoritative snapshot may report a station/session head beyond
        // this page (especially while the ring is being rebuilt); do not let
        // that head skip the page we are about to replay.
        const recoveryAfter = after;
        const sequenceReset = result.resetRequired && result.lastSeq < after;
        if (retainedOnly) {
          if (sequenceReset) throw new HubError('服务器恢复水位已改变，等待电脑上线核对原会话', 409, 'event_snapshot_required');
          const missing: HubEvent = { type: 'notice', id: `retention-gap:${result.storageEpoch}:${after}`, deviceId, sessionKey,
            tool: sessionAgentId(sessionKey), ts: Date.now(), level: 'info', text: '部分较早内容已超出服务器保留期，电脑上线后可补读；以下是仍可恢复的内容' };
          handleEvent(missing, true);
          result.durableEvents = [missing, ...(result.durableEvents ?? [])];
        } else await openSession(deviceId, sessionKey, { signal, resetEventSequence: sequenceReset });
        if (signal?.aborted || !currentRequest()) return;
        approvalSnapshotThrough = sessionApprovalSnapshots.get(key) ?? 0;
        if (sequenceReset) {
          // A relay restored without its durable sequence reservation can
          // start below our cursor. Only an explicit reset plus a successful
          // computer snapshot permits rebasing. Read the retained stream from
          // zero: the parser deliberately never rewinds an ordinary page.
          sessionCursors.set(key, 0);
          continue;
        }
        if (result.scannedEventCount > 0 && (sessionCursors.get(key) ?? 0) > recoveryAfter) sessionCursors.set(key, recoveryAfter);
        // The local registry in session.open is authoritative for pending
        // approvals. Preserve progress from this page, but never resurrect an
        // old request just because a transient Hub buffer still contains it.
        for (const event of result.events) {
          if (event.deviceId !== deviceId || event.sessionKey !== sessionKey || historyGap(event)
            || event.type === 'session.updated' || (typeof event.seq === 'number' && event.seq <= after)) continue;
          if (event.type === 'approval.request' && (typeof event.seq !== 'number' || event.seq <= approvalSnapshotThrough)) continue;
          handleEvent(event, true);
        }
        if (gap) handleEvent(gap);
        // nextSeq is the last event actually in this page; lastSeq may point
        // beyond it. Continuing from lastSeq silently discards unread progress.
        // `events` contains only records this client can render. A newer
        // Bridge may return well-formed records with an unknown status that
        // the parser intentionally skips. The page cursor still represents
        // those scanned records, so advance/break on cursor progress rather
        // than on the number of rendered items; otherwise one future record
        // would be replayed forever and block later messages.
        if (durable && result.scannedEventCount > 0) {
          await commitDurableEvents(scope, deviceId, sessionKey, result);
          if (!currentRequest()) return;
          await acknowledgeSessionEvents(owner, deviceId, sessionKey, result.nextSeq, result.storageEpoch!);
        }
        if (result.scannedEventCount > 0 && result.nextSeq > after) advanceSessionCursor(key, result.nextSeq);
        if (!result.hasMore || result.nextSeq <= after || result.scannedEventCount === 0) break;
        continue;
      }
      for (const event of result.events) {
        if (event.deviceId !== deviceId || event.sessionKey !== sessionKey || (typeof event.seq === 'number' && event.seq <= after)) continue;
        const predatesSnapshot = approvalSnapshotThrough > 0 && (typeof event.seq !== 'number' || event.seq <= approvalSnapshotThrough);
        if (event.type === 'session.updated' && predatesSnapshot) continue;
        if (event.type === 'approval.request' && approvalSnapshotThrough > 0
          && (typeof event.seq !== 'number' || event.seq <= approvalSnapshotThrough)) continue;
        handleEvent(event, predatesSnapshot);
      }
      if (durable && result.scannedEventCount > 0) {
        await commitDurableEvents(scope, deviceId, sessionKey, result);
        if (!currentRequest()) return;
        await acknowledgeSessionEvents(owner, deviceId, sessionKey, result.nextSeq, result.storageEpoch!);
      }
      if (result.scannedEventCount > 0 && result.nextSeq > after) advanceSessionCursor(key, result.nextSeq);
      if (!result.hasMore || result.nextSeq <= after || result.scannedEventCount === 0) break;
    }
    if (!state.devices.some(device => device.deviceId === deviceId && device.online === false)) await reconcileIncompleteAssistantTurn(deviceId, sessionKey, signal);
    set({ connection: 'open', connectionError: undefined, connectionProblem: undefined });
  } catch (error) {
    // A desktop lease/history error is local to this thread. It must not
    // falsely turn a healthy phone -> Hub -> computer link into "offline".
    // Read admission/rate limits also prove neither a lost connection nor a
    // recovery from an earlier failure. Preserve link state and the cursor;
    // still reject so useLiveSync backs off instead of spinning on HTTP 429.
    if (!signal?.aborted && currentRequest() && error instanceof HubError && error.status !== 200 && error.status !== 429) set({ connection: 'error', ...connectionFailure(error) });
    throw error;
  }
}

/**
 * If a turn has ended while an assistant message is still explicitly partial,
 * silently refresh the authoritative computer transcript. This covers a lost
 * final stream event without turning a brief network gap into a visible error.
 */
export function resetIncompleteTurnRecovery(deviceId: string, sessionKey: string): void {
  const prefix = `${timelineKey(deviceId, sessionKey)}\u0000`;
  for (const key of incompleteTurnRepairs.keys()) if (key.startsWith(prefix)) incompleteTurnRepairs.delete(key);
}

async function reconcileIncompleteAssistantTurn(deviceId: string, sessionKey: string, signal?: AbortSignal): Promise<void> {
  const key = timelineKey(deviceId, sessionKey);
  const prefix = `${key}\u0000`;
  const timeline = state.timelines[key];
  if (AppState.currentState === 'background' || AppState.currentState === 'inactive' || timeline?.session?.status === 'running') {
    resetIncompleteTurnRecovery(deviceId, sessionKey);
    return;
  }
  const turnIds = [...new Set((timeline?.items ?? []).filter((item): item is Extract<TimelineItem, { kind: 'message' }> =>
    item.kind === 'message' && item.role === 'assistant' && item.streamState === 'terminal-unconfirmed' && Boolean(item.turnId)).map(item => item.turnId!))];
  const active = new Set(turnIds.map(turnId => `${prefix}${turnId}`));
  for (const repairKey of incompleteTurnRepairs.keys()) {
    if (repairKey.startsWith(prefix) && !active.has(repairKey)) incompleteTurnRepairs.delete(repairKey);
  }
  for (const turnId of turnIds) {
    if (signal?.aborted) return;
    const repairKey = `${prefix}${turnId}`;
    const originalPartials = new Set((state.timelines[key]?.items ?? []).filter(item => item.kind === 'message'
      && item.role === 'assistant' && item.turnId === turnId && item.streamState === 'terminal-unconfirmed').map(item => item.id));
    const partials = () => (state.timelines[key]?.items ?? []).filter((item): item is Extract<TimelineItem, { kind: 'message' }> =>
      item.kind === 'message' && item.role === 'assistant' && item.turnId === turnId && !item.final
      && (item.streamState === 'terminal-unconfirmed' || originalPartials.has(item.id)));
    const signature = () => JSON.stringify(partials().map(item => [item.id, item.text]));
    const fingerprint = signature(), saved = incompleteTurnRepairs.get(repairKey);
    const repair: IncompleteTurnRepair = saved?.fingerprint === fingerprint ? saved
      : { successfulReads: 0, failures: 0, retryAt: 0, stableSince: Date.now(), fingerprint };
    if (Date.now() < repair.retryAt) continue;
    incompleteTurnRepairs.set(repairKey, repair);
    const owner = hub, generation = connectionGeneration, startedAt = Date.now();
    const current = () => !signal?.aborted && owner === hub && generation === connectionGeneration
      && incompleteTurnRepairs.get(repairKey) === repair && AppState.currentState !== 'background' && AppState.currentState !== 'inactive';
    try {
      await openSession(deviceId, sessionKey, { background: true, signal, silent: true });
    } catch {
      if (current()) {
        const failures = Math.min(3, repair.failures + 1);
        incompleteTurnRepairs.set(repairKey, { ...repair, successfulReads: 0, stableSince: Date.now(), failures,
          retryAt: Date.now() + Math.min(60_000, 15_000 * 2 ** (failures - 1)) });
      }
      continue;
    }
    // A cancelled/superseded read can resolve without publishing a snapshot.
    // Only a fresh, successful computer read is evidence of missing content.
    if (!current() || (state.timelines[key]?.snapshotStartedAt ?? -1) < startedAt) continue;
    if (!partials().length || state.timelines[key]?.session?.status === 'running') { incompleteTurnRepairs.delete(repairKey); continue; }
    // A longer transcript fragment can supersede the shorter local row and
    // omit its local repair marker. It still belongs to this terminal turn.
    if (partials().some(item => item.streamState !== 'terminal-unconfirmed')) set(current => ({ timelines: { ...current.timelines,
      [key]: { ...current.timelines[key], items: current.timelines[key].items.map(item => item.kind === 'message'
        && originalPartials.has(item.id) && item.turnId === turnId && !item.final ? { ...item, streamState: 'terminal-unconfirmed' as const } : item) } } }));
    const nextFingerprint = signature(), unchanged = nextFingerprint === repair.fingerprint;
    const successfulReads = unchanged ? Math.min(MAX_INCOMPLETE_TURN_REPAIRS, repair.successfulReads + 1) : 1;
    const stableSince = unchanged && repair.successfulReads > 0 ? repair.stableSince : Date.now();
    if (successfulReads >= MAX_INCOMPLETE_TURN_REPAIRS && Date.now() - stableSince >= INCOMPLETE_TURN_GRACE_MS) {
      set(current => ({ timelines: { ...current.timelines, [key]: { ...current.timelines[key], items: current.timelines[key].items.map(item =>
        item.kind === 'message' && item.role === 'assistant' && item.turnId === turnId && item.streamState === 'terminal-unconfirmed'
          ? { ...item, streamState: 'incomplete' as const } : item) } } }));
      incompleteTurnRepairs.delete(repairKey);
    } else incompleteTurnRepairs.set(repairKey, { successfulReads, failures: 0, stableSince, fingerprint: nextFingerprint,
      retryAt: Date.now() + INCOMPLETE_TURN_REPAIR_DELAYS[successfulReads - 1] });
  }
}

/** Every status source must revoke cached history from a previous desktop identity. */
function publishAgentStatus(deviceId: string, parsed: AgentStatus): void {
  const before = state.agents[deviceId]?.list ?? [];
  for (const profile of [...before, ...parsed.agents]) {
    const old = before.find(item => item.id === profile.id), next = parsed.agents.find(item => item.id === profile.id);
    if (JSON.stringify([old?.apiFamily, old?.api, old?.capabilities]) !== JSON.stringify([next?.apiFamily, next?.api, next?.capabilities])) {
      invalidateFamilyModels(deviceId, agentApiFamily(profile), parsed.agents);
    }
  }
  set(previous => {
    const identity = parsed.agents.find(item => item.id === 'claude-desktop')?.desktopHistory?.identity;
    const entry = previous.sessions[deviceId];
    const readOnly = Object.fromEntries(Object.entries(entry?.readOnly ?? {}).filter(([, directory]) => Boolean(identity) && directory?.identity === identity));
    const timelines = Object.fromEntries(Object.entries(previous.timelines).filter(([key, timeline]) => !key.startsWith(`${deviceId}|claude-desktop:`)
      || Boolean(identity) && timeline.historyLease === identity));
    return { agents: { ...previous.agents, [deviceId]: { list: parsed.agents, apis: parsed.apis, autoAll: parsed.autoAll, loading: false, loaded: true } },
      ...(entry?.readOnly ? { sessions: { ...previous.sessions, [deviceId]: { ...entry, readOnly } } } : {}), timelines };
  });
}

/** Reads which agents are installed and which API remote tasks will use. Never applies keys or restarts tools. */
export async function loadAgentProfiles(deviceId: string): Promise<void> {
  const owner = need();
  const revision = (agentRequests.get(deviceId) ?? 0) + 1;
  agentRequests.set(deviceId, revision);
  const current = () => owner === hub && agentRequests.get(deviceId) === revision;
  const entry = state.agents[deviceId] ?? { list: [], apis: [], loading: false, loaded: false };
  set((previous) => ({ agents: { ...previous.agents, [deviceId]: { ...entry, loading: true, error: undefined } } }));
  try {
    const result = await runCommand<unknown>(owner, deviceId, { type: 'agents.status' });
    if (!current()) return;
    const parsed = parseAgentStatus(result, state.devices.find((item) => item.deviceId === deviceId));
    publishAgentStatus(deviceId, parsed);
  } catch (error) {
    if (!current()) return;
    const message = error instanceof HubError && error.status === 409 ? '电脑不在线' : '没有读到 Agent 信息，请更新电脑端 Salcara Bridge 或重试';
    set((previous) => ({ agents: { ...previous.agents, [deviceId]: { ...entry, loading: false, loaded: true, error: message } } }));
    throw new Error(message);
  }
}

function stationOriginKey(value: string): string {
  // Compare the same canonical Hub endpoint that pairing and connection
  // storage accept. String trimming alone could treat /salcara-hub/v1/v1 as
  // the same station, or let an untrusted API status match another path.
  try { return canonicalHubUrl(value); } catch { return ''; }
}

/**
 * A key is allowed to move the phone between stations only when the desktop
 * explicitly returned a single, already-paired public station match.  If the
 * API and Hub origins are unrelated, they remain intentionally decoupled and
 * the key is changed on the current station.
 */
function stationForApi(deviceId: string, accountId: string): RemoteConnection | undefined {
  if (!accountId) return undefined;
  // New stations require an explicit, fresh capability-backed destination
  // choice. Never bypass disabled API cards using a legacy origin hint.
  if (hubCapabilities.has('station.guard.v1')) return undefined;
  const option = state.agents[deviceId]?.apis.find((item) => item.id === accountId);
  // Official accounts have no API-origin-derived home station. Never move the
  // connection just because the desktop happened to return one candidate.
  if (officialRemoteApi(option) || option?.remoteEligibility?.supported) return undefined;
  const candidate = option?.station;
  if (!candidate) return undefined;
  const current = state.connections.find((item) => item.id === state.connectionId);
  if (!current || current.botGroupId || !current.computerId) return undefined;
  const matches = state.connections.filter((item) => !item.botGroupId && item.deviceId === candidate.deviceId
    && stationOriginKey(item.hubUrl) === stationOriginKey(candidate.hubUrl)
    && item.computerId === current.computerId);
  return matches.length === 1 && matches[0].id !== current.id ? matches[0] : undefined;
}

export function apiStationChoices(deviceId: string, accountId: string): RemoteConnection[] {
  const option = state.agents[deviceId]?.apis.find(item => item.id === accountId);
  const current = state.connections.find(item => item.id === state.connectionId && item.deviceId === deviceId);
  return current?.botGroupId ? [] : eligibleApiStations(option, current, state.connections.filter(item => !item.botGroupId));
}

export function apiRemoteProblem(deviceId: string, agent: AgentId, accountId: string): string {
  const current = state.agents[deviceId]?.list.find(item => item.id === agent)?.api;
  // Clearing a phone override selects the computer's applied credential,
  // which is not the override described by this status card. Its eligibility
  // is verified by Bridge; the old key cannot veto restoring that default.
  if (!accountId && current?.source === 'phone') return '';
  const effective = accountId || current?.accountId;
  return remoteApiProblem(state.agents[deviceId]?.apis.find(item => item.id === effective), hubCapabilities.has('station.guard.v1'));
}

/**
 * Chooses the API the computer uses for this agent's remote tasks. An empty
 * accountId follows the computer again. The desktop tool itself is not changed.
 */
export async function setAgentApi(deviceId: string, agent: AgentId, accountId: string, model?: string, sessionKey?: string, targetConnectionId?: string): Promise<AgentProfile | undefined> {
  const owner = need();
  requireApiSelection(deviceId, agent, model, sessionKey);
  const targetStation = targetConnectionId ? apiStationChoices(deviceId, accountId).find(item => item.id === targetConnectionId) : stationForApi(deviceId, accountId);
  if (targetConnectionId && !targetStation) throw new Error('目标中转站能力未确认或不属于这台电脑，请刷新');
  if (targetStation) {
    // The station command performs API + Hub changes as one desktop-side
    // transaction. Do not issue a separate agents.api.set first.
    await switchRemoteStation(deviceId, targetStation.id, agent, accountId, model, sessionKey);
    // A Hub may assign a different deviceId to the same physical computer.
    // After the handover all reads must use B's credential-scoped device ID;
    // reusing A's ID makes command() reject the request even though the
    // desktop already committed the API + station transaction.
    const activeDeviceId = targetStation.deviceId;
    const activeOwner = hub, activeGeneration = connectionGeneration;
    const stillAtTarget = () => Boolean(activeOwner) && hub === activeOwner && connectionGeneration === activeGeneration
      && state.connectionId === targetStation.id && activeOwner!.deviceId === activeDeviceId;
    if (!stillAtTarget()) throw new Error('API 或连接已切换，请刷新确认');
    await loadAgentProfiles(activeDeviceId);
    if (!stillAtTarget()) throw new Error('API 或连接已切换，请刷新确认');
    return state.agents[activeDeviceId]?.list.find((item) => item.id === agent);
  }
  const availability = apiRemoteProblem(deviceId, agent, accountId);
  if (availability) throw new Error(availability);
  const mutation = beginApiMutation(owner, deviceId, 'API 正在切换，请稍候');
  try {
  if (await hasPendingDeliveryForDevice(deviceId)) throw new Error('先核对待确认消息，再换 API');
  if (owner !== hub) throw new Error('连接已切换，请刷新确认');
  requireApiSelection(deviceId, agent, model, sessionKey);
  const currentAvailability = apiRemoteProblem(deviceId, agent, accountId);
  if (currentAvailability) throw new Error(currentAvailability);
  const profile = state.agents[deviceId]?.list.find((item) => item.id === agent);
  const family = profile ? agentApiFamily(profile) : agentApiFamily(agent);
  if (!builtinAgent(agent) && !profile) throw new Error('电脑没有这个 Agent');
  // Replies contain all Agent cards, so mutations of different families on one
  // computer must share a revision too.
  const changeKey = apiMutationKey(owner, deviceId);
  const change = (apiChanges.get(changeKey) ?? 0) + 1;
  apiChanges.set(changeKey, change);
  invalidateFamilyModels(deviceId, family);
  agentRequests.set(deviceId, (agentRequests.get(deviceId) ?? 0) + 1);
  const result = await runCommand<unknown>(owner, deviceId, { type: 'agents.api.set', agent, accountId, model: model?.trim() || undefined, ...(sessionKey ? { sessionKey } : {}) });
  if (owner !== hub || apiChanges.get(changeKey) !== change) throw new Error('API 或连接已切换，请刷新确认');
  agentRequests.set(deviceId, (agentRequests.get(deviceId) ?? 0) + 1);
  invalidateFamilyModels(deviceId, family);
  const parsed = parseAgentStatus(result, state.devices.find((item) => item.deviceId === deviceId));
  publishAgentStatus(deviceId, parsed);
  return parsed.agents.find((item) => item.id === agent);
  } finally { endApiMutation(mutation); }
}

/**
 * Atomically hands this physical computer from the currently selected Hub to
 * another saved Hub for the same computer.  The phone sends only the target's
 * public station/device metadata and the opaque API handle; the desktop looks
 * up its own device secret and vault entry, verifies the target pair, commits
 * the API + station together, acknowledges on A, then reconnects on B.
 */
export function switchRemoteStation(deviceId: string, targetConnectionId: string, agent?: AgentId, accountId?: string, model?: string, sessionKey?: string, options: { stillWanted?: () => boolean } = {}): Promise<void> {
  const generation = connectionGeneration, owner = hub;
  return serializeStationChange(() => {
    if (options.stillWanted?.() === false) return Promise.resolve();
    if (generation !== connectionGeneration || owner !== hub) throw new Error('连接已切换，请刷新确认');
    return switchRemoteStationImpl(deviceId, targetConnectionId, agent, accountId, model, sessionKey, options.stillWanted);
  });
}

async function switchRemoteStationImpl(deviceId: string, targetConnectionId: string, agent?: AgentId, accountId?: string, model?: string, sessionKey?: string, stillWanted: () => boolean = () => true): Promise<void> {
  const owner = need();
  if (agent) requireApiSelection(deviceId, agent, model, sessionKey);
  const operationGeneration = connectionGeneration;
  const current = state.connections.find(item => item.id === state.connectionId);
  const target = state.connections.find(item => item.id === targetConnectionId);
  if (!current || !owner.pairToken || owner.deviceId !== deviceId) throw new Error('请先连接当前电脑');
  if (!target || target.id === current.id || target.botGroupId || current.botGroupId || !target.computerId || !current.computerId || target.computerId !== current.computerId) {
    throw new Error('目标中转站不是同一台已配对电脑，请先在两边完成配对');
  }
  const mutation = beginApiMutation(owner, deviceId, 'API 或中转站正在切换，请稍候');
  try {
    if (await hasPendingDeliveryForDevice(deviceId)) throw new Error('先核对待确认消息，再切换中转站');
    if (!stillWanted()) return;
    if (operationGeneration !== connectionGeneration || owner !== hub || state.connectionId !== current.id) throw new Error('连接已切换，请刷新确认');
    if (!(await connectionToken(target))) throw new Error('目标中转站的手机配对已失效，请重新扫码');
    if (!stillWanted()) return;
    if (operationGeneration !== connectionGeneration || owner !== hub || state.connectionId !== current.id) throw new Error('连接已切换，请刷新确认');
    const previous = await loadPendingHandover();
    if (!stillWanted()) return;
    let sourceOnly = false;
    if (!agent && !accountId && !model && !sessionKey) {
      if (previous && previous.fromConnectionId === current.id && previous.targetConnectionId === target.id && previous.deviceId === deviceId) {
        // The previous journal owns its exact source/hash; do not derive a
        // newer card choice for the same UUID after an ambiguous reply.
        agent = previous.agent; accountId = previous.accountId; sourceOnly = previous.sourceOnly === true;
      } else {
        const preferred = await readPreferredAgent({ kind: 'remote', connectionId: current.id, deviceId }).catch(() => null);
        if (!stillWanted()) return;
        if (!state.agents[deviceId]?.loaded) await loadAgentProfiles(deviceId).catch(() => undefined);
        if (!stillWanted()) return;
        if (operationGeneration !== connectionGeneration || owner !== hub) throw new Error('连接已切换，请刷新确认');
        const selected = state.agents[deviceId]?.list.find(item => item.id === preferred);
        // A deferred connection intentionally clears the in-memory device
        // directory.  Do not infer support for the source-only preservation
        // flag from a stale cache (or from an agent status response): refresh
        // the paired computer's signed capability advertisement first.  If
        // the computer is temporarily offline, fail closed and keep the
        // legacy station-only path rather than sending a flag an older Bridge
        // could silently ignore.
        if (!state.devices.some(item => item.deviceId === deviceId)) {
          await refreshDevices(true).catch(() => undefined);
        }
        if (!stillWanted()) return;
        // An older Bridge ignores the flag and would apply the API with an
        // empty model. Never send preservation intent without its capability.
        const supportsSourceOnly = state.devices.find(item => item.deviceId === deviceId)?.capabilities?.includes('station.source-only.v1');
        if (supportsSourceOnly && selected?.available && selected.api.configured && !selected.api.pending && selected.api.accountId) {
          agent = selected.id; accountId = selected.api.accountId; sourceOnly = true;
        }
        // No proven current source: legacy open mode may still switch stations;
        // restricted mode rejects missing metadata, never inventing an API.
      }
    }
    if (previous && (previous.fromConnectionId !== current.id || previous.targetConnectionId !== target.id || previous.deviceId !== deviceId
      || !sameHandoverPayload(previous, agent, accountId, model, sessionKey) || (previous.sourceOnly === true) !== sourceOnly)) {
      throw new Error('上一次中转站切换仍在确认，请先恢复或重试原目标');
    }
    const operationId = previous?.operationId ?? randomUUID();
    const targetStillEligible = () => !agent || sourceOnly || !hubCapabilities.has('station.guard.v1')
      || Boolean(accountId && apiStationChoices(deviceId, accountId).some(item => item.id === target.id));
    // Retries keep their immutable receipt even if the live catalog changed;
    // a new mutation must recheck after every asynchronous prerequisite.
    if (!previous && !targetStillEligible()) throw new Error('目标中转站能力已变化，请刷新后重试');
    await savePendingHandover({ operationId, fromConnectionId: current.id, targetConnectionId: target.id, deviceId,
      createdAt: previous?.createdAt ?? Date.now(), ...(agent ? { agent } : {}), ...(accountId ? { accountId } : {}),
      ...(model?.trim() ? { model: model.trim() } : {}), ...(sessionKey ? { sessionKey } : {}), ...(sourceOnly ? { sourceOnly: true } : {}) }, operationGeneration);
    if (!stillWanted()) {
      // A newly journaled operation has not been sent yet. A previous uncertain
      // dispatch keeps its receipt so cancellation cannot erase recovery proof.
      if (!previous) await clearPendingHandover(operationId);
      return;
    }
    // The journal write is an await boundary. If the user selected another
    // station or signed out while it was in flight, do not send the old
    // station a command with a credential that is no longer active. Keep the
    // intent on disk so the next foreground check can decide whether it is
    // recoverable.
    if (operationGeneration !== connectionGeneration || owner !== hub || state.connectionId !== current.id) {
      throw new Error('连接已切换，请刷新确认');
    }
    if (!previous && !targetStillEligible()) {
      await clearPendingHandover(operationId);
      throw new Error('目标中转站能力已变化，请刷新后重试');
    }
    if (agent && !sourceOnly) requireApiSelection(deviceId, agent, model, sessionKey);
    try {
      const reply = await command<unknown>(owner, deviceId, {
        type: 'remote.station.switch', targetHubUrl: target.hubUrl, targetDeviceId: target.deviceId,
        targetComputerId: target.computerId, ...(agent ? { agent } : {}), ...(accountId ? { accountId } : {}),
        ...(model?.trim() ? { model: model.trim() } : {}), ...(sessionKey ? { sessionKey } : {}), ...(sourceOnly ? { sourceOnly: true } : {}), operationId,
      }, hubSupportsIdempotency() ? operationId : undefined, undefined, { transportOnlyHandover: hubCapabilities.has('station.guard.v1') && hubCapabilities.has('station.handover.v2') });
      if (!optionalHandoverReplyMatches(reply, operationId, handoverPayloadHash(target, agent, accountId, model, sessionKey, sourceOnly))) {
        throw new HubError('中转站切换回执不匹配，请重试', 409, 'handover_receipt_mismatch');
      }
    } catch (error) {
      if (!stillWanted()) return;
      const intent: PendingStationHandover = { operationId, fromConnectionId: current.id, targetConnectionId: target.id, deviceId,
        createdAt: previous?.createdAt ?? Date.now(), ...(agent ? { agent } : {}), ...(accountId ? { accountId } : {}),
        ...(model?.trim() ? { model: model.trim() } : {}), ...(sessionKey ? { sessionKey } : {}), ...(sourceOnly ? { sourceOnly: true } : {}) };
      if (ambiguousHandoverError(error) && await recoverPendingHandover(intent, operationGeneration, owner, stillWanted)) return;
      if (!stillWanted()) return;
      if (ambiguousHandoverError(error) || error instanceof HubError && error.code === 'computer_offline') {
        try {
          await requestStandbyHandover(target, intent, operationGeneration, owner, stillWanted);
          if (!stillWanted()) return;
          await useSavedConnection(target.id, false, { skipHandover: true, handoverOperationId: operationId, stillWanted });
          if (!stillWanted() || state.connectionId !== target.id) return;
          await clearPendingHandover(operationId);
          return;
        } catch (standbyError) {
          if (!stillWanted()) return;
          if (ambiguousHandoverError(standbyError) && await recoverPendingHandover(intent, operationGeneration, owner, stillWanted)) return;
          if (!stillWanted()) return;
          // A freshly created operation cannot have committed when A proves
          // it never dispatched and B explicitly refuses before execution.
          // Leaving its journal would prevent every different destination
          // until expiry. Older journals and any uncertain A dispatch still
          // own their original UUID: a later refusal cannot erase that proof.
          const primaryNotDispatched = !previous && error instanceof HubError && error.status === 409 && error.code === 'computer_offline';
          const standbyNotExecuted = standbyError instanceof HubError && !ambiguousHandoverError(standbyError) && (standbyError.status === 401 || standbyError.status === 403
            || standbyError.status === 200 && ['source_station_denied', 'station_guard_unsupported', 'station_policy_unavailable', 'station_standby_unsupported', 'remote_execution_disabled'].includes(standbyError.code ?? ''));
          if (primaryNotDispatched && standbyNotExecuted) await clearPendingHandover(operationId);
          throw standbyError;
        }
      }
      // A fresh terminal refusal owns no earlier dispatch. A retry of an old
      // journal may instead hit a newly revoked policy before receipt lookup;
      // that refusal cannot prove what happened to its original request.
      if (!previous && !ambiguousHandoverError(error) && error instanceof HubError
        && (error.status === 200 || error.status === 401 || error.status === 403 || error.code === 'request_id_conflict')) await clearPendingHandover(operationId);
      throw error;
    }
    if (!stillWanted()) return;
    if (owner !== hub) throw new Error('连接已切换，请重新选择目标中转站');
    // The desktop commits after replying on A. Switch the phone only after that
    // acknowledgement, never before; otherwise a dropped request could leave
    // the phone unable to retry on the original station.
    await useSavedConnection(target.id, false, { skipHandover: true, handoverOperationId: operationId, stillWanted });
    if (!stillWanted() || state.connectionId !== target.id) return;
    await clearPendingHandover(operationId);
  } finally { endApiMutation(mutation); }
}

function currentAgentPreferenceScope(): AgentPreferenceScope | null {
  if (!hub?.deviceId) return null;
  return { kind: 'remote', connectionId: state.connectionId ?? JSON.stringify([hub.url, hub.deviceId]), deviceId: hub.deviceId };
}
export async function lastAgent(): Promise<AgentId> {
  return await readPreferredAgent(currentAgentPreferenceScope()).catch(() => null) ?? 'codex';
}
export async function rememberAgent(agent: AgentId): Promise<void> { await rememberPreferredAgent(currentAgentPreferenceScope(), agent).catch(() => undefined); }

/** Explicit no-folder starts require the forwarding/receipt schema on the station too. */
export function hubSupportsProjectless(): boolean { return hubCapabilities.has('session.projectless.v1'); }
export function hubSupportsExplorer(): boolean { return hubCapabilities.has('workspace.explorer.v1'); }
/** True when the station can hold an empty events read open (live updates without a permanent stream). */
export function hubSupportsWait(): boolean { return hubCapabilities.has('events.wait.v1'); }
/** The active station can persist a bounded command receipt for an A→B handover. */
export function hubSupportsIdempotency(): boolean { return hubCapabilities.has('commands.idempotency.v1'); }
export function hubSupportsSteer(): boolean { return hubSupportsIdempotency() && hubCapabilities.has('session.steer.v1'); }
/** The Hub can push task news to this phone while the app is closed (Firebase). */
export function hubSupportsPush(): boolean { return hubCapabilities.has('push.fcm.v1'); }
/** The paired connection push registration is for: its Hub credentials and computer. */
export function pushTarget(): { hub: Hub; deviceId: string } | null {
  // Legacy code pairing has no device in the connection: it pairs exactly one computer.
  const deviceId = hub?.deviceId ?? (state.devices.length === 1 ? state.devices[0].deviceId : undefined);
  return hub?.pairToken && deviceId ? { hub, deviceId } : null;
}
/** Plain subscription to store changes (outside React). */
export function onRemoteChange(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }

const sessionMatchesAgent = (session: SessionInfo, agent: AgentId) => agent === 'codex' ? session.tool === 'codex'
  : agent === 'claude' || agent === 'claude-desktop' ? session.tool === 'claude' && /Claude Desktop/i.test(session.client ?? '') === (agent === 'claude-desktop')
  : session.tool === agent && session.sessionKey.startsWith(`${agent}:`);
function safePageCursor(value: unknown): string | undefined {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 4096) throw new Error('电脑返回的读取位置无效');
  return value;
}
const readOnlyDesktopKey = /^claude-desktop:local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function isReadOnlyDesktopSession(key: string): boolean { return readOnlyDesktopKey.test(key); }
function claudeHistoryIdentity(deviceId: string): string {
  const history = state.agents[deviceId]?.list.find(item => item.id === 'claude-desktop')?.desktopHistory;
  if (!history?.available) throw new Error('桌面历史不可用，请刷新');
  return history.identity;
}
function claudeHistoryScope(deviceId: string, sessionKey: string, identity: string): import('./client').ClaudeDesktopScope {
  const timeline = state.timelines[timelineKey(deviceId, sessionKey)];
  const row = (timeline?.historyLease === identity ? timeline.session : undefined) ?? Object.values(state.sessions[deviceId]?.readOnly ?? {})
    .filter(entry => entry?.identity === identity).flatMap(entry => entry?.list ?? []).find(item => item.sessionKey === sessionKey);
  if (row?.sessionScope !== 'desktop-chat' && row?.sessionScope !== 'desktop-cowork') throw new Error('请从桌面会话列表打开');
  return row.sessionScope;
}
function validClaudeHistorySession(session: SessionInfo, key: string, scope: import('./client').ClaudeDesktopScope): boolean {
  return session.sessionKey === key && session.tool === 'claude' && session.client === 'Claude Desktop'
    && session.sessionScope === scope && session.controlSurface === 'read-only' && session.controllable === false;
}
/** A cold native ID must resolve its category from current desktop metadata, never from a guessed CLI list. */
async function resolveClaudeHistoryScope(owner: Hub, deviceId: string, sessionKey: string, identity: string, signal?: AbortSignal): Promise<import('./client').ClaudeDesktopScope> {
  try { return claudeHistoryScope(deviceId, sessionKey, identity); } catch { /* No current metadata cached. */ }
  const result = await runCommand<{ session?: SessionInfo; historyIdentity?: string }>(owner, deviceId,
    { type: 'session.describe', sessionKey, controlSurface: 'read-only', historyIdentity: identity }, undefined, signal);
  if (owner !== hub || claudeHistoryIdentity(deviceId) !== identity || result.historyIdentity !== identity) throw new Error('桌面账号已变更，请刷新');
  const scope = result.session?.sessionScope;
  const scopes = state.agents[deviceId]?.list.find(item => item.id === 'claude-desktop')?.desktopHistory?.scopes ?? [];
  if (!result.session || scope !== 'desktop-chat' && scope !== 'desktop-cowork' || !scopes.includes(scope)
    || !validClaudeHistorySession(result.session, sessionKey, scope)) throw new Error('桌面会话身份不一致，已取消读取');
  return scope;
}
/** Native Claude Chat/Cowork has its own read-only directory and account identity. */
export async function loadClaudeDesktopHistory(deviceId: string, scope: import('./client').ClaudeDesktopScope, more = false, options?: { preservePages?: boolean }): Promise<void> {
  const owner = need(), identity = claudeHistoryIdentity(deviceId);
  if (!state.agents[deviceId]?.list.find(item => item.id === 'claude-desktop')?.desktopHistory?.scopes.includes(scope)) throw new Error('这个桌面目录不可用');
  const entry = state.sessions[deviceId]?.readOnly?.[scope], cursor = more && entry?.identity === identity ? entry.nextCursor : undefined;
  const preserve = !more && options?.preservePages && entry?.identity === identity && entry.loaded;
  if (preserve && entry?.loading) return;
  if (more && (!cursor || entry?.loading)) return;
  const requestKey = `claude-history:${deviceId}:${scope}`, revision = (sessionRequests.get(requestKey) ?? 0) + 1;
  sessionRequests.set(requestKey, revision);
  const current = () => owner === hub && sessionRequests.get(requestKey) === revision;
  const publish = (directory: NonNullable<DeviceSessions['readOnly']>[typeof scope]) => set(previous => ({ sessions: { ...previous.sessions,
    [deviceId]: { ...(previous.sessions[deviceId] ?? { list: [], loading: false, loaded: false }), readOnly: { ...previous.sessions[deviceId]?.readOnly, [scope]: directory } } } }));
  publish({ list: entry?.identity === identity ? entry.list : [], nextCursor: entry?.identity === identity ? entry.nextCursor : undefined,
    loaded: entry?.identity === identity && entry.loaded === true, loading: !preserve, identity });
  try {
    const result = await runCommand<{ sessions?: SessionInfo[]; nextCursor?: string; historyIdentity?: string }>(owner, deviceId,
      { type: 'sessions.list', tool: 'claude', client: scope, controlSurface: 'read-only', historyIdentity: identity, limit: SESSION_PAGE_SIZE, ...(cursor ? { cursor } : {}) });
    if (!current()) return;
    if (claudeHistoryIdentity(deviceId) !== identity || result.historyIdentity !== identity) throw new Error('桌面账号已变更，请刷新');
    if (!Array.isArray(result.sessions) || result.sessions.some(row => !row || !isReadOnlyDesktopSession(row.sessionKey) || row.tool !== 'claude' || row.controlSurface !== 'read-only' || row.controllable !== false
      || row.client !== 'Claude Desktop' || row.sessionScope !== scope) || new Set(result.sessions.map(row => row.sessionKey)).size !== result.sessions.length) throw new Error('桌面目录无效');
    const nextCursor = safePageCursor(result.nextCursor);
    if (cursor && nextCursor === cursor) throw new Error('电脑没有推进读取位置，请刷新');
    const list = [...new Map([...(more || preserve ? entry?.list ?? [] : []), ...result.sessions].map(row => [row.sessionKey, row])).values()].sort((a, b) => b.updatedAt - a.updatedAt);
    publish({ list, nextCursor: preserve ? entry?.nextCursor : nextCursor, loading: false, loaded: true, identity });
    if (!more) warmDirectoryMessages(deviceId, list);
  } catch (error) {
    if (!current()) return;
    if (state.agents[deviceId]?.list.find(item => item.id === 'claude-desktop')?.desktopHistory?.identity !== identity) throw error;
    publish({ list: entry?.identity === identity ? entry.list : [], nextCursor: entry?.identity === identity ? entry.nextCursor : undefined, loading: false, loaded: true, identity, error: (error as Error).message, errorPage: more ? 'more' : 'head' });
    throw error;
  }
}
export async function loadSessions(deviceId: string, agent?: AgentId, options?: { preservePages?: boolean }): Promise<void> { return readSessions(deviceId, agent, false, options?.preservePages === true); }
export async function loadMoreSessions(deviceId: string, agent: AgentId): Promise<void> { return readSessions(deviceId, agent, true); }
const nativeThreadKey = /^codex:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function isNativeSession(deviceId: string, sessionKey: string): boolean {
  return Boolean(state.timelines[timelineKey(deviceId, sessionKey)]?.readSurface === 'desktop'
    || state.timelines[timelineKey(deviceId, sessionKey)]?.session?.controlSurface === 'desktop'
    || state.sessions[deviceId]?.native?.list.some(item => item.sessionKey === sessionKey)
    || state.agents[deviceId]?.list.find(item => item.id === 'codex')?.desktopLive?.sessionKeys.includes(sessionKey));
}
function nativeLease(deviceId: string, sessionKey?: string) {
  const live = state.agents[deviceId]?.list.find(item => item.id === 'codex')?.desktopLive;
  if (!live || live.expiresAt <= Date.now() || (sessionKey ? !live.capabilities?.read || !live.sessionKeys.includes(sessionKey) : !live.capabilities?.list)) {
    throw new Error('桌面连接已断开，请在电脑重新授权');
  }
  return live;
}
function nativeLeaseIdentity(deviceId: string, sessionKey?: string): string {
  const live = nativeLease(deviceId, sessionKey);
  return JSON.stringify([live.expiresAt, [...live.sessionKeys].sort(), live.accountId, live.modelOverrideTransport, live.modelOptions, live.capabilities]);
}
function requireNativeModelOptions(deviceId: string, sessionKey: string, options: Pick<SendOptions, 'model' | 'effort' | 'accountId'>, directory = false) {
  const live = nativeLease(deviceId, sessionKey);
  if (!live.capabilities?.modelOverride || live.modelOverrideTransport !== 'codex-tool-schema-v1' || live.modelOptions?.model !== true || !live.accountId) {
    throw new HubError('此连接暂不支持切换模型，请在桌面端设置', 200, 'desktop_capability_unavailable');
  }
  if (options.accountId !== undefined && options.accountId !== live.accountId) throw new HubError('电脑应用的 API 已改变，请重新读取模型', 200, 'request_scope_changed');
  if (options.effort && !live.modelOptions.thinking.includes(options.effort)) throw new HubError('电脑未提供这个模型强度', 200, 'desktop_capability_unavailable');
  if (!directory && !live.capabilities.send) throw new HubError('桌面连接尚未允许发送', 200, 'desktop_capability_unavailable');
  return live;
}
/** Local directory preference survives opening a thread and returning after lease expiry. */
export function selectSessionDirectory(deviceId: string, surface: 'desktop' | 'all'): void {
  set(current => { const entry = current.sessions[deviceId] ?? { list: [], loading: false, loaded: false };
    return { sessions: { ...current.sessions, [deviceId]: { ...entry, directorySurface: surface } } }; });
}
/** Native and all-history directories are separate; a native failure never falls back to CLI. */
export async function loadNativeSessions(deviceId: string, more = false, options?: { preservePages?: boolean }): Promise<void> {
  const original = state.sessions[deviceId]?.native;
  const preserve = !more && options?.preservePages && original?.loaded;
  if (preserve && original?.loading) return;
  const cursor = more ? original?.nextCursor : undefined;
  if (more && (!cursor || original?.loading)) return;
  const owner = need(), requestKey = `native-sessions:${deviceId}`;
  const revision = (sessionRequests.get(requestKey) ?? 0) + 1;
  sessionRequests.set(requestKey, revision);
  const currentRequest = () => owner === hub && sessionRequests.get(requestKey) === revision;
  set(current => { const entry = current.sessions[deviceId] ?? { list: [], loading: false, loaded: false };
    return { sessions: { ...current.sessions, [deviceId]: { ...entry, directorySurface: 'desktop', native: { ...(entry.native ?? { list: [], loaded: false }), loading: !preserve, error: undefined, errorPage: undefined } } } }; });
  try {
    const lease = nativeLeaseIdentity(deviceId);
    const result = await runCommand<{ sessions?: SessionInfo[]; nextCursor?: string }>(owner, deviceId, { type: 'desktop.sessions.list', tool: 'codex', controlSurface: 'desktop', limit: SESSION_PAGE_SIZE, ...(cursor ? { cursor } : {}) });
    if (!currentRequest()) return;
    if (nativeLeaseIdentity(deviceId) !== lease) throw new Error('桌面授权已更新，请重新读取');
    const allowed = new Set(nativeLease(deviceId).sessionKeys), seen = new Set<string>(), positions = new Set<number>();
    if (!Array.isArray(result.sessions) || result.sessions.length > 200) throw new Error('电脑返回的桌面目录无效');
    const list = result.sessions.map(item => {
      if (!item || !nativeThreadKey.test(item.sessionKey) || !allowed.has(item.sessionKey) || seen.has(item.sessionKey)
        || item.tool !== 'codex' || item.controlSurface !== 'desktop' || !Number.isInteger(item.sidebarIndex) || item.sidebarIndex! < 1 || item.sidebarIndex! > 200 || positions.has(item.sidebarIndex!)
        || item.pinnedIndex !== undefined && (!Number.isInteger(item.pinnedIndex) || item.pinnedIndex < 1 || item.pinnedIndex > 10000)) throw new Error('电脑返回的桌面目录无效');
      seen.add(item.sessionKey); positions.add(item.sidebarIndex!); return item;
    }).sort((a, b) => a.sidebarIndex! - b.sidebarIndex!);
    const nextCursor = safePageCursor(result.nextCursor);
    if (cursor && nextCursor === cursor) throw new Error('电脑没有推进读取位置，请刷新');
    set(current => { const entry = current.sessions[deviceId];
      const previous = entry.native?.list ?? [], updates = new Map(list.map(item => [item.sessionKey, item]));
      // A refreshed head is authoritative for its order, while older loaded
      // pages keep their relative order. Old sidebar indices can collide with
      // a newly inserted head; preserve the host metadata, not an invented rank.
      const merged = preserve ? [...list, ...previous.filter(item => !updates.has(item.sessionKey))]
        : more ? [...previous.map(item => updates.get(item.sessionKey) ?? item), ...list.filter(item => !previous.some(old => old.sessionKey === item.sessionKey))] : list;
      return { sessions: { ...current.sessions, [deviceId]: { ...entry, native: { list: merged, nextCursor: preserve ? original?.nextCursor : nextCursor, loading: false, loaded: true } } } }; });
    if (!more) warmDirectoryMessages(deviceId, list);
  } catch (error) {
    if (!currentRequest()) return;
    set(current => { const entry = current.sessions[deviceId];
      return { sessions: { ...current.sessions, [deviceId]: { ...entry, native: { ...entry.native!, loading: false, loaded: true, error: (error as Error).message, errorPage: more ? 'more' : 'head' } } } }; });
    throw error;
  }
}
async function readSessions(deviceId: string, agent: AgentId | undefined, more: boolean, preservePages = false): Promise<void> {
  const owner = need();
  if (agent) requireAgentCapability(deviceId, agent === 'claude-desktop' ? 'claude' : agent, 'list');
  const entry = state.sessions[deviceId] ?? { list: [], loading: false, loaded: false };
  const preserve = Boolean(agent && preservePages && entry.pages?.[agent]);
  // Automatic head refresh must not supersede a user's in-flight older page.
  if (preserve && agent && entry.pages?.[agent]?.loading) return;
  const cursor = agent && more ? entry.pages?.[agent]?.nextCursor : undefined;
  if (more && (!cursor || agent && entry.pages?.[agent]?.loading)) return;
  const requestKey = `sessions:${JSON.stringify([deviceId, agent ?? null])}`;
  const revision = (sessionRequests.get(requestKey) ?? 0) + 1;
  sessionRequests.set(requestKey, revision);
  const currentRequest = () => owner === hub && sessionRequests.get(requestKey) === revision;
  set(current => ({ sessions: { ...current.sessions, [deviceId]: { ...(current.sessions[deviceId] ?? entry),
    ...(more ? {} : { loading: !preserve, error: undefined, errorPage: undefined }),
    ...(agent ? { pages: { ...current.sessions[deviceId]?.pages, [agent]: { ...(more || preserve ? entry.pages?.[agent] : {}), loading: !preserve, error: undefined, errorPage: undefined } } } : {}) } } }));
  try {
    const result = await runCommand<{ sessions?: SessionInfo[]; nextCursor?: string }>(owner, deviceId, { type: 'sessions.list',
      limit: SESSION_PAGE_SIZE,
      ...(agent ? { tool: agent === 'claude-desktop' ? 'claude' : agent, ...(agent === 'claude' || agent === 'claude-desktop' ? { client: agent === 'claude-desktop' ? 'desktop-code' : 'code' } : {}) } : {}),
      ...(cursor ? { cursor } : {}) });
    if (!currentRequest()) return;
    if (agent) requireAgentCapability(deviceId, agent === 'claude-desktop' ? 'claude' : agent, 'list');
    const nextCursor = safePageCursor(result.nextCursor);
    if (cursor && nextCursor === cursor) throw new Error('电脑没有推进读取位置，请刷新');
    const received = [...(result.sessions ?? [])].filter(item => {
      try { return item && typeof item.sessionKey === 'string' && validSessionTool(item, item.sessionKey) && (!agent || sessionMatchesAgent(item, agent)); } catch { return false; }
    });
    set(current => {
      const latest = current.sessions[deviceId] ?? entry;
      const previous = more || preserve ? latest.list : agent ? latest.list.filter(item => !sessionMatchesAgent(item, agent)) : [];
      const list = [...new Map([...previous, ...received].map(item => [item.sessionKey, item])).values()].sort((a, b) => b.updatedAt - a.updatedAt);
      return { sessions: { ...current.sessions, [deviceId]: { ...latest, list, loading: false, loaded: true, error: undefined, errorPage: undefined,
        ...(agent ? { pages: { ...latest.pages, [agent]: { nextCursor: preserve ? entry.pages?.[agent]?.nextCursor : nextCursor, loading: false } } } : {}) } } };
    });
    if (!more && agent) warmDirectoryMessages(deviceId, received);
  } catch (error) {
    if (!currentRequest()) return;
    set(current => ({ sessions: { ...current.sessions, [deviceId]: { ...(current.sessions[deviceId] ?? entry), loading: false, loaded: true,
      ...(more ? {} : { error: (error as Error).message, errorPage: 'head' as const }),
      ...(agent ? { pages: { ...current.sessions[deviceId]?.pages, [agent]: { ...(more || preserve ? entry.pages?.[agent] : {}), loading: false, error: (error as Error).message, errorPage: more ? 'more' as const : 'head' as const } } } : {}) } } }));
    throw error;
  }
}

function warmDirectoryMessages(deviceId: string, sessions: SessionInfo[]) {
  if (!screenOpen || AppState.currentState !== 'active') return;
  directoryPreloads.get(deviceId)?.abort();
  const controller = new AbortController();
  directoryPreloads.set(deviceId, controller);
  void preloadRecentSessionMessages(deviceId, sessions, controller.signal).finally(() => {
    if (directoryPreloads.get(deviceId) === controller) directoryPreloads.delete(deviceId);
  }).catch(() => undefined);
}

/** First-page previews are optional background reads, never a directory gate. */
export async function preloadRecentSessionMessages(deviceId: string, sessions: SessionInfo[], signal?: AbortSignal): Promise<void> {
  if (signal?.aborted || !hub) return;
  const owner = hub, generation = connectionGeneration;
  const queue = [...new Map(sessions.filter(item => !item.parentSessionKey).map(item => [item.sessionKey, item])).values()]
    .slice(0, SESSION_PAGE_SIZE);
  let index = 0;
  const worker = async () => {
    while (!signal?.aborted && owner === hub && generation === connectionGeneration && index < queue.length) {
      const item = queue[index++], key = timelineKey(deviceId, item.sessionKey);
      const cached = state.timelines[key];
      if (snapshotFlights.has(key) || cached?.loading || cached?.loadingEarlier || cached?.historyExpanded
        || cached?.snapshotAt && Date.now() - cached.snapshotAt < 30_000) continue;
      try { await openSession(deviceId, item.sessionKey, { background: true, preload: true, signal }); }
      catch { /* Selecting the thread performs an authoritative foreground retry. */ }
    }
  };
  // Reserve capacity for a selected conversation, sends and approval replies.
  await Promise.all([worker(), worker()]);
}

interface SessionReadOptions {
  background?: boolean; preload?: boolean; signal?: AbortSignal; controlSurface?: 'desktop'; silent?: boolean;
  /** Internal recovery after the relay explicitly invalidates its old sequence range. */
  resetEventSequence?: boolean;
}

export function openSession(deviceId: string, sessionKey: string, options?: SessionReadOptions): Promise<void> {
  if (options?.signal?.aborted) return Promise.resolve();
  if (options?.controlSurface === 'desktop' && !sessionKey.startsWith('codex:')) return Promise.reject(new HubError('这个 Agent 没有此桌面控制能力', 200, 'agent_capability_unavailable'));
  if (!options?.controlSurface && !isNativeSession(deviceId, sessionKey) && !isReadOnlyDesktopSession(sessionKey)) {
    try { requireAgentCapability(deviceId, sessionAgentId(sessionKey), 'read'); } catch (error) { return Promise.reject(error); }
  }
  if (!options?.background) {
    resetIncompleteTurnRecovery(deviceId, sessionKey);
    directoryPreloads.get(deviceId)?.abort();
    directoryPreloads.delete(deviceId);
  }
  const key = timelineKey(deviceId, sessionKey), owner = need();
  const surface = options?.controlSurface === 'desktop' || isNativeSession(deviceId, sessionKey) ? 'desktop' : 'history';
  const existing = snapshotFlights.get(key);
  if (existing?.owner === owner && existing.surface === surface && options?.background) {
    // Directory previews share an in-flight read.  A foreground open is an
    // explicit refresh and deliberately supersedes an older read; the
    // revision guard in readSessionSnapshot then prevents its late response
    // from replacing the newer snapshot.
    return existing.promise;
  }
  const flight = { owner, surface: surface as 'desktop' | 'history', promise: Promise.resolve() as Promise<void> };
  flight.promise = readSessionSnapshot(deviceId, sessionKey, options).finally(() => {
    if (snapshotFlights.get(key) === flight) snapshotFlights.delete(key);
  });
  snapshotFlights.set(key, flight);
  return flight.promise;
}

async function readSessionSnapshot(deviceId: string, sessionKey: string, options?: SessionReadOptions, retriedAfterRevert = false): Promise<void> {
  const owner = need(), generation = connectionGeneration, pairing = pairingGeneration;
  if (options?.signal?.aborted) return;
  const key = timelineKey(deviceId, sessionKey);
  const revertSignal = state.timelines[key]?.revertSignal ?? 0;
  const revisionKey = `open:${key}`;
  const revision = (sessionRequests.get(revisionKey) ?? 0) + 1;
  sessionRequests.set(revisionKey, revision);
  if (!options?.background) sessionRequests.set(`history:${key}`, (sessionRequests.get(`history:${key}`) ?? 0) + 1);
  const currentRequest = () => owner === hub && generation === connectionGeneration && pairing === pairingGeneration
    && sessionRequests.get(revisionKey) === revision && !options?.signal?.aborted;
  const snapshotStartedAt = Date.now();
  const native = options?.controlSurface === 'desktop' || isNativeSession(deviceId, sessionKey);
  const readOnly = isReadOnlyDesktopSession(sessionKey);
  let lease = '';
  const originalApprovals = new Map((state.timelines[key]?.items ?? []).filter(item => item.kind === 'approval').map(item => [item.id, item]));
  set(current => {
    const identity = readOnly ? current.agents[deviceId]?.list.find(item => item.id === 'claude-desktop')?.desktopHistory?.identity : undefined;
    const observed = current.timelines[key] ?? EMPTY_TIMELINE;
    const cached = native && observed.session?.controlSurface !== 'desktop' ? EMPTY_TIMELINE : observed;
    const existing = readOnly && (!identity || cached.historyLease !== identity) ? EMPTY_TIMELINE : cached;
    return { timelines: { ...current.timelines, [key]: { ...existing,
      ...(native ? { readSurface: 'desktop' as const } : {}),
      ...(readOnly ? { historyLease: identity } : {}), loading: !options?.background, ...(options?.silent ? {} : { error: undefined, readErrorCode: undefined }),
      ...(options?.background ? {} : { loadingEarlier: false, earlierError: undefined }) } } };
  });
  try {
    lease = native ? nativeLeaseIdentity(deviceId, sessionKey) : readOnly ? claudeHistoryIdentity(deviceId) : '';
    const historyScope = readOnly ? await resolveClaudeHistoryScope(owner, deviceId, sessionKey, lease, options?.signal) : undefined;
    // Capture a baseline before reading the computer. Anything produced during
    // that read remains available to the next incremental request.
    const head = native || readOnly ? { lastSeq: 0, nextSeq: 0, featureChanges: undefined } : await sessionEventsPage(owner, deviceId, sessionKey, 0, 0, 1, options?.signal);
    if (!currentRequest()) return;
    consumeFeatureChanges(owner, generation, pairing, deviceId, head.featureChanges);
    if (!currentRequest()) return;
    if (!native && !readOnly) requireAgentCapability(deviceId, sessionAgentId(sessionKey), 'read');
    const result = await runCommand<{ session?: SessionInfo; events?: HubEvent[]; nextCursor?: string; historyIdentity?: string }>(owner, deviceId,
      native ? { type: 'desktop.session.open', sessionKey, controlSurface: 'desktop', limit: INITIAL_MESSAGE_COUNT, messageLimit: INITIAL_MESSAGE_COUNT } : { type: 'session.open', sessionKey, limit: HISTORY_EVENT_BUDGET, messageLimit: INITIAL_MESSAGE_COUNT, ...(readOnly ? { controlSurface: 'read-only' as const, historyIdentity: lease, client: historyScope } : {}) }, undefined, options?.signal, options?.preload);
    if (!currentRequest()) return;
    if ((state.timelines[key]?.revertSignal ?? 0) !== revertSignal) {
      if (retriedAfterRevert) throw new Error('会话在读取期间再次回退，请刷新记录');
      // The discarded page may have no native turn boundary at all. Re-read
      // once instead of guessing whether its untagged output belongs to the old turn.
      return readSessionSnapshot(deviceId, sessionKey, options, true);
    }
    if (!native && !readOnly) requireAgentCapability(deviceId, sessionAgentId(sessionKey), 'read');
    if (!result.session || !validSessionTool(result.session, sessionKey)) throw new Error('会话身份不一致，已取消读取');
    if (native && (nativeLeaseIdentity(deviceId, sessionKey) !== lease || result.session.controlSurface !== 'desktop' || result.session.tool !== 'codex')) throw new Error('桌面授权已更新，请重新读取');
    if (readOnly && (claudeHistoryIdentity(deviceId) !== lease || result.historyIdentity !== lease)) throw new Error('桌面账号已变更，请刷新');
    if (historyScope && !validClaudeHistorySession(result.session, sessionKey, historyScope)) throw new Error('桌面会话身份不一致，已取消读取');
    const history = (result.events ?? []).filter((event) => eventMatchesSession(event, sessionKey)
      && (!event.deviceId || event.deviceId === deviceId)
      && (event.type !== 'session.updated' || event.session.sessionKey === sessionKey)
      && (!readOnly || event.tool === 'claude' && event.type !== 'approval.request' && event.type !== 'approval.resolved'
        && (event.type !== 'session.updated' || validClaudeHistorySession(event.session, sessionKey, historyScope!))));
    set((current) => {
      const observed = current.timelines[key] ?? EMPTY_TIMELINE;
      // Recheck at the return boundary, not only when the snapshot starts:
      // stale CLI state or a different native lease cannot join this result.
      const cached = native && (observed.session?.controlSurface !== 'desktop' || observed.historyLease !== lease) ? EMPTY_TIMELINE : observed;
      const retained = readOnly && cached.historyLease !== lease ? EMPTY_TIMELINE : cached;
      // Old and new relay sequence numbers cannot be compared. Preserve the
      // content and message IDs, but discard obsolete ordering/version stamps
      // only after the replacement snapshot has passed all ownership checks.
      const existing = options?.resetEventSequence ? { ...retained, sessionSeq: undefined,
        items: retained.items.map(item => ({ ...item, seq: undefined, orderSeq: undefined })) } : retained;
      const concurrentApprovals = new Set(existing.items.filter(item => item.kind === 'approval' && originalApprovals.get(item.id) !== item).map(item => item.id));
      const keepFrontier = Boolean(options?.background && existing.historyExpanded && (!(native || readOnly) || existing.historyLease === lease));
      const merged = mergeHistory(existing, result.session, history, concurrentApprovals);
      // The baseline is a station-wide cursor.  It is safe as a lower bound
      // for this session and prevents a replayed session.updated status from
      // regressing a freshly opened thread after a reconnect.
      const historySeq = history.reduce((max, event) => Math.max(max, eventSeq(event.seq) ?? 0), 0);
      const snapshotSeq = native || readOnly ? (merged.sessionSeq ?? 0) : Math.max(merged.sessionSeq ?? 0, head.lastSeq, head.nextSeq, historySeq);
      const timeline = { ...merged, ...(snapshotSeq > 0 ? { sessionSeq: snapshotSeq } : {}), cachedAt: undefined, readErrorCode: undefined, snapshotAt: Date.now(), snapshotStartedAt,
        ...(native ? { readSurface: 'desktop' as const } : {}),
        nextCursor: keepFrontier ? existing.nextCursor : safePageCursor(result.nextCursor), historyLease: native || readOnly ? lease : undefined,
        historyExpanded: keepFrontier, loadingEarlier: options?.background ? existing.loadingEarlier : false,
        earlierError: options?.background ? existing.earlierError : undefined };
      const approvals = { ...current.approvals };
      // A fresh snapshot reconciles approvals for this thread only. Do not
      // resurrect a days-old request merely because it was once cached.
      for (const [id, approval] of Object.entries(approvals)) {
        if (approval.deviceId === deviceId && approval.sessionKey === sessionKey) delete approvals[id];
      }
      for (const item of timeline.items) {
        if (item.kind === 'approval' && item.state === 'pending' && (!item.expiresAt || item.expiresAt > Date.now())) approvals[approvalStateKey(deviceId, sessionKey, item.id)] = { approvalId: item.id, deviceId, sessionKey, tool: timeline.session?.tool ?? 'codex', title: item.title, ts: item.ts };
        else if (item.kind === 'approval') delete approvals[approvalStateKey(deviceId, sessionKey, item.id)];
      }
      const entry = current.sessions[deviceId];
      const sessions = entry && result.session ? { ...current.sessions, [deviceId]: { ...entry,
        list: native ? entry.list : entry.list.map((item) => item.sessionKey === sessionKey ? result.session! : item),
        ...(native && entry.native ? { native: { ...entry.native, list: entry.native.list.map(item => item.sessionKey === sessionKey ? { ...result.session!, sidebarIndex: item.sidebarIndex, pinnedIndex: item.pinnedIndex } : item) } } : {}) } } : current.sessions;
      return { timelines: { ...current.timelines, [key]: timeline }, approvals, sessions };
    });
    const baseline = Math.max(head.lastSeq, head.nextSeq);
    if (options?.resetEventSequence) {
      if (!hubCapabilities.has('events.durable.v1')) sessionCursors.set(key, baseline);
      sessionApprovalSnapshots.set(key, baseline);
    } else {
      if (!hubCapabilities.has('events.durable.v1')) advanceSessionCursor(key, baseline);
      sessionApprovalSnapshots.set(key, Math.max(sessionApprovalSnapshots.get(key) ?? 0, baseline));
    }
  } catch (error) {
    // Leaving the thread/backgrounding deliberately aborts this read. Do not
    // turn that lifecycle action into a visible timeline error.
    if (options?.signal?.aborted) return;
    if (!currentRequest()) return;
    if (readOnly && lease && state.agents[deviceId]?.list.find(item => item.id === 'claude-desktop')?.desktopHistory?.identity !== lease) throw error;
    if (!options?.silent || missingSessionReadCode(error)) set((current) => ({ timelines: { ...current.timelines, [key]: { ...(current.timelines[key] ?? EMPTY_TIMELINE),
      session: current.timelines[key]?.session ?? (native ? current.sessions[deviceId]?.native?.list : current.sessions[deviceId]?.list)?.find((item) => item.sessionKey === sessionKey),
      loading: false, error: (error as Error).message, readErrorCode: missingSessionReadCode(error) } } }));
    throw error;
  } finally {
    // A cancelled first snapshot has no snapshotAt yet. Release only its own
    // loading state, or the next foreground read would be skipped forever.
    if (owner === hub && sessionRequests.get(revisionKey) === revision && state.timelines[key]?.loading) {
      set(current => ({ timelines: { ...current.timelines, [key]: { ...(current.timelines[key] ?? EMPTY_TIMELINE), loading: false } } }));
    }
  }
}

/** Older history is local-computer data, not an extension of server event retention. */
export async function loadEarlierHistory(deviceId: string, sessionKey: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  const owner = need(), key = timelineKey(deviceId, sessionKey);
  const original = state.timelines[key];
  if (!original?.nextCursor || original.loading || original.loadingEarlier) return;
  if (original.session?.controlSurface !== 'desktop' && !isReadOnlyDesktopSession(sessionKey)) requireAgentCapability(deviceId, sessionAgentId(sessionKey), 'read');
  const cursor = original.nextCursor, historyRevision = sessionRequests.get(`history:${key}`);
  const pageKey = `earlier:${key}`, revision = (sessionRequests.get(pageKey) ?? 0) + 1;
  sessionRequests.set(pageKey, revision);
  const currentRequest = () => owner === hub && sessionRequests.get(pageKey) === revision && sessionRequests.get(`history:${key}`) === historyRevision && !signal?.aborted;
  const readOnly = isReadOnlyDesktopSession(sessionKey);
  let lease = '';
  set(current => ({ timelines: { ...current.timelines, [key]: { ...current.timelines[key], loadingEarlier: true, earlierError: undefined } } }));
  try {
    const native = original.session?.controlSurface === 'desktop';
    lease = native ? nativeLeaseIdentity(deviceId, sessionKey) : readOnly ? claudeHistoryIdentity(deviceId) : '';
    if (readOnly && original.historyLease !== lease) throw new Error('桌面账号已变更，请刷新');
    const historyScope = readOnly ? await resolveClaudeHistoryScope(owner, deviceId, sessionKey, lease, signal) : undefined;
    if (!native && !readOnly) requireAgentCapability(deviceId, sessionAgentId(sessionKey), 'read');
    const result = await runCommand<{ session?: SessionInfo; events?: HubEvent[]; nextCursor?: string; historyIdentity?: string }>(owner, deviceId,
      native ? { type: 'desktop.session.open', sessionKey, cursor, controlSurface: 'desktop', limit: OLDER_HISTORY_PAGE_SIZE, messageLimit: OLDER_HISTORY_PAGE_SIZE } : { type: 'session.open', sessionKey, cursor, limit: HISTORY_EVENT_BUDGET, messageLimit: OLDER_HISTORY_PAGE_SIZE, ...(readOnly ? { controlSurface: 'read-only' as const, historyIdentity: lease, client: historyScope } : {}) }, undefined, signal);
    if (!currentRequest()) return;
    if ((state.timelines[key]?.revertSignal ?? 0) !== (original.revertSignal ?? 0)) {
      // A pagination cursor belongs to the pre-revert transcript. Start at
      // its new head; a second concurrent revert fails closed rather than looping.
      return readSessionSnapshot(deviceId, sessionKey, { signal }, true);
    }
    if (!native && !readOnly) requireAgentCapability(deviceId, sessionAgentId(sessionKey), 'read');
    if (!result.session || !validSessionTool(result.session, sessionKey)) throw new Error('会话身份不一致，已取消读取');
    if (native && (nativeLeaseIdentity(deviceId, sessionKey) !== lease || result.session.controlSurface !== 'desktop' || result.session.tool !== 'codex')) throw new Error('桌面授权已更新，请重新读取');
    if (readOnly && (claudeHistoryIdentity(deviceId) !== lease || result.historyIdentity !== lease)) throw new Error('桌面账号已变更，请刷新');
    if (historyScope && !validClaudeHistorySession(result.session, sessionKey, historyScope)) throw new Error('桌面会话身份不一致，已取消读取');
    const nextCursor = safePageCursor(result.nextCursor);
    if (nextCursor === cursor) throw new Error('电脑没有推进读取位置，请刷新');
    const filtered = filterRevertedHistory(state.timelines[key] ?? original, result.events ?? []);
    let older: Timeline = EMPTY_TIMELINE;
    for (const event of filtered.events) {
      if (!eventMatchesSession(event, sessionKey) || event.deviceId && event.deviceId !== deviceId || event.type === 'approval.request' || event.type === 'approval.resolved' || event.type === 'session.updated') continue;
      if (readOnly && event.tool !== 'claude') continue;
      older = applyEvent(older, event);
    }
    set(current => {
      const cached = current.timelines[key];
      const latest = readOnly && cached?.historyLease !== lease ? { ...EMPTY_TIMELINE, session: result.session, historyLease: lease } : cached ?? EMPTY_TIMELINE;
      // The current page is authoritative for overlap; older rows only fill
      // gaps.  Sort by the Hub cursor when available so a late page cannot
      // put a newer event above an earlier one with a misleading timestamp.
      const items = sortTimelineItems([...new Map([...older.items, ...latest.items].filter(item=>!filtered.revertedItems?.includes(item.id)&&!(item.turnId&&latest.revertedTurns?.includes(item.turnId))).map(item => [`${item.kind}|${item.id}`, item])).values()]);
      return { timelines: { ...current.timelines, [key]: { ...latest, items, revertedItems: filtered.revertedItems, nextCursor, historyExpanded: true, loadingEarlier: false, earlierError: undefined } } };
    });
  } catch (error) {
    if (signal?.aborted) return;
    if (!currentRequest()) return;
    if (readOnly && lease && state.agents[deviceId]?.list.find(item => item.id === 'claude-desktop')?.desktopHistory?.identity !== lease) throw error;
    set(current => ({ timelines: { ...current.timelines, [key]: { ...current.timelines[key], loadingEarlier: false, earlierError: (error as Error).message } } }));
    throw error;
  } finally {
    // Cancellation is not a failed page. Keep its cursor and content while
    // releasing only the loading state still owned by this exact read.
    if (owner === hub && sessionRequests.get(pageKey) === revision && state.timelines[key]?.loadingEarlier
      && sessionRequests.get(`history:${key}`) === historyRevision) {
      set(current => ({ timelines: { ...current.timelines, [key]: { ...current.timelines[key], loadingEarlier: false } } }));
    }
  }
}

function newAttachmentRefs(images: RemoteImage[]): LocalAttachment[] {
  return images.map((image) => ({
    id: `att_${randomUUID().replace(/-/g, '')}`,
    mime: image.mime,
    size: Math.max(0, Math.floor(image.base64.length / 4) * 3 - (image.base64.endsWith('==') ? 2 : image.base64.endsWith('=') ? 1 : 0)),
    width: image.width,
    height: image.height,
    uri: image.uri,
  }));
}

async function uploadImageRefs(deviceId: string, images: RemoteImage[], refs: LocalAttachment[], owner: Hub = need(), source?: { agent: AgentId; accountId?: string }): Promise<LocalAttachment[]> {
  if (refs.length !== images.length || refs.length > 4) throw new Error('附件数量不一致');
  for (let imageIndex = 0; imageIndex < images.length; imageIndex += 1) {
    const image = images[imageIndex];
    if (!/^image\/(?:jpeg|png|webp)$/i.test(image.mime)) throw new Error('只支持 JPEG、PNG、WebP 图片');
    const id = refs[imageIndex].id;
    const total = Math.ceil(image.base64.length / ATTACHMENT_CHUNK);
    if (total < 1 || total > 64 || (refs[imageIndex].size ?? 0) > 8 * 1024 * 1024) throw new Error('图片太大（最大 8 MB）');
    for (let index = 0; index < total; index += 1) {
      if (owner !== hub) throw new Error('连接已切换，图片未发送');
      await command(owner, deviceId, { type: 'attachment.put', id, mime: image.mime, index, total, data: image.base64.slice(index * ATTACHMENT_CHUNK, (index + 1) * ATTACHMENT_CHUNK),
        ...(source ? { agent: source.agent, controlSurface: 'cli' as const, ...(source.accountId ? { accountId: source.accountId } : {}) } : {}) });
      if (owner !== hub) throw new Error('连接已切换，图片未发送');
    }
  }
  return refs;
}

/** Rehydrates the local source for an interrupted, pre-dispatch image upload.
 * The durable delivery receipt stores only a URI and dimensions; binary data
 * is read just-in-time and never placed in SQLite. */
function attachmentSourceDigest(base64: string): string {
  const digest = sha256.create(), encoder = new TextEncoder();
  for (let offset = 0; offset < base64.length; offset += 256 * 1024) digest.update(encoder.encode(base64.slice(offset, offset + 256 * 1024)));
  return Array.from(digest.digest(), byte => byte.toString(16).padStart(2, '0')).join('');
}
async function loadAttachmentSources(sources: NonNullable<import('./delivery').PendingDelivery['attachmentSources']>): Promise<RemoteImage[]> {
  return Promise.all(sources.map(async (source) => {
    const info = await FileSystem.getInfoAsync(source.uri);
    if (!info.exists || info.isDirectory !== false) throw new Error('原消息的图片已不在手机上，请先核对原会话');
    const base64 = await FileSystem.readAsStringAsync(source.uri, { encoding: FileSystem.EncodingType.Base64 });
    if (!base64 || base64.length > 11_200_000 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)
      || base64.length / 4 * 3 - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0) > 8 * 1024 * 1024
      || !source.digest || attachmentSourceDigest(base64) !== source.digest) throw new Error('原图片内容无法确认，请先核对原会话；不会改发其他图片');
    return { uri: source.uri, base64, mime: source.mime, width: source.width, height: source.height };
  }));
}

async function durableAttachmentUri(uri: string, id: string): Promise<string> {
  const root = FileSystem.documentDirectory;
  if (!root || uri.startsWith(root)) return uri;
  try {
    const directory = `${root}remote-delivery/`;
    await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
    const target = `${directory}${id}.jpg`;
    const info = await FileSystem.getInfoAsync(target);
    if (!info.exists) await FileSystem.copyAsync({ from: uri, to: target });
    return target;
  } catch {
    // The base64 payload is still available for this attempt.  If the app is
    // killed before the receipt completes, the pending record will explicitly
    // report that its source cannot be recovered instead of sending a phantom
    // attachment ID.
    return uri;
  }
}

/** Sends phone images to the computer in Hub-sized chunks; returns their ids. */
export async function uploadImages(deviceId: string, images: RemoteImage[], owner: Hub = need(), source?: { agent: AgentId; accountId?: string }): Promise<string[]> {
  const refs = await uploadImageRefs(deviceId, images, newAttachmentRefs(images), owner, source);
  return refs.map((ref) => ref.id);
}

/**
 * Fetches a computer-side attachment in bounded chunks and materializes it in
 * the app cache.  Reads are demand-driven and shared between thumbnails and
 * the full-screen viewer, so opening a thread never downloads every image.
 */
export async function materializeAttachment(deviceId: string, ref: AttachmentRef, signal?: AbortSignal, sessionKey?: string): Promise<string> {
  const safeRef = attachmentRef(ref);
  if (!safeRef || !ATTACHMENT_ID.test(safeRef.id)) throw new Error('附件编号无效');
  if (!ATTACHMENT_MIME.test(safeRef.mime)) throw new Error('这个附件类型暂不支持预览');
  const owner = need();
  if (!sessionKey) throw new Error('附件缺少会话身份');
  const deliveryScope = remoteDeliveryScope();
  if (owner !== hub) throw new Error('连接已切换，附件读取已取消');
  const cacheScope = `${deliveryScope}\u0000${deviceId}\u0000${sessionKey}`;
  return cachedAttachment(cacheScope, safeRef, async (offset, readSignal) => {
    if (owner !== hub) throw new Error('连接已切换，附件读取已取消');
    const result = await command<unknown>(owner, deviceId,
      { type: 'attachment.read', id: safeRef.id, sessionKey, offset, length: 90_000 }, undefined, readSignal);
    if (owner !== hub) throw new Error('连接已切换，附件读取已取消');
    return parseAttachmentPage(result);
  }, signal);
}

/** The list downloads a bounded server thumbnail without replacing the
 * original attachment URI used for saving, exporting or annotated input. */
export async function materializeAttachmentThumbnail(deviceId: string, ref: AttachmentRef, signal?: AbortSignal, sessionKey?: string): Promise<string | undefined> {
  if (!hubCapabilities.has('storage.blobs.v1')) return undefined;
  const safeRef = attachmentRef(ref), owner = need(), scope = remoteDeliveryScope();
  if (!safeRef || !sessionKey) throw new Error('缩略图缺少附件或会话身份');
  const key = JSON.stringify(['thumbnail-v1', attachmentContentKey(safeRef)]);
  const id = `att_${Array.from(sha256(new TextEncoder().encode(key)), byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 32)}`;
  const cacheScope = `${scope}\u0000${deviceId}\u0000${sessionKey}\u0000thumbnail`;
  return cachedAttachment(cacheScope, { id, mime: 'image/jpeg' }, async (offset, readSignal) => {
    if (owner !== hub || scope !== remoteDeliveryScope()) throw new Error('连接已切换，缩略图读取已取消');
    const raw = await command<unknown>(owner, deviceId, { type: 'attachment.read', id: safeRef.id, sessionKey, variant: 'thumbnail', offset, length: 90_000 }, undefined, readSignal);
    if (owner !== hub || scope !== remoteDeliveryScope()) throw new Error('连接已切换，缩略图读取已取消');
    const page = parseAttachmentPage(raw);
    if (page.id !== safeRef.id || page.mime !== 'image/jpeg' || page.size > 512 * 1024) throw new Error('服务器返回了无效的缩略图');
    return { ...page, id };
  }, signal);
}

/** A late read can only attach to its exact pairing and content metadata. */
export function attachMaterializedUri(deviceId: string, sessionKey: string, expected: AttachmentRef, uri: string, expectedScope: string): boolean {
  const safeRef = attachmentRef(expected);
  if (!safeRef || !localImageUri(uri)) return false;
  try { if (!expectedScope || expectedScope !== remoteDeliveryScope()) return false; } catch { return false; }
  const identity = attachmentContentKey(safeRef);
  const key = timelineKey(deviceId, sessionKey);
  let matched = false;
  set((current) => {
    const timeline = current.timelines[key];
    if (!timeline) return {};
    let changed = false;
    const items = timeline.items.map((item) => {
      if ((item.kind !== 'message' && item.kind !== 'tool') || !item.attachments?.some((ref) => attachmentContentKey(ref) === identity)) return item;
      matched = true;
      if (!item.attachments.some(ref => attachmentContentKey(ref) === identity && ref.uri !== uri)) return item;
      const attachments = item.attachments.map((ref) => attachmentContentKey(ref) === identity ? { ...ref, uri } : ref);
      changed = true;
      if (item.kind === 'message') {
        const images = attachments.map((ref) => ref.uri).filter((value): value is string => Boolean(value));
        return { ...item, attachments, ...(images.length ? { images } : {}) };
      }
      return { ...item, attachments };
    });
    return changed ? { timelines: { ...current.timelines, [key]: { ...timeline, items } } } : {};
  });
  return matched;
}

export async function startSession(deviceId: string, input: TurnFeatures & { tool: ToolId; cwd: string; projectless?: true; prompt: string; workspaceMode?: WorkspaceMode; model?: string; effort?: Effort; permissionMode?: PermissionMode; approval: ApprovalMode; accountId?: string; images?: RemoteImage[]; desktop?: boolean; composerDraft?: NewTaskSnapshot['composerDraft'] }): Promise<string> {
  // Own the complete submission before the first SQLite/network await. A
  // picker/caller may otherwise mutate the same object while it is queued.
  const frozen = { ...input, ...copyTurnFeatures(input), ...(input.composerDraft ? { composerDraft: { ...input.composerDraft } } : {}),
    ...(input.images ? { images: input.images.map(image => ({ ...image })) } : {}),
    accountId: input.accountId ?? selectedAgentAccount(deviceId, input.desktop ? 'claude-desktop' : input.tool) };
  if (frozen.projectless !== undefined && frozen.projectless !== true) throw new Error('新会话的开始方式无效，未发送');
  validateContextPrompt(frozen.prompt, frozen.contextReferences, frozen.skills?.length);
  return startSessionLocked(deviceId, frozen);
}

export async function getPendingNewSession(deviceId: string, tool: ToolId, desktop = false) {
  const pending = await pendingDelivery(remoteDeliveryScope(), deviceId, newSessionReceiptKey(tool, desktop));
  if (!pending) return undefined;
  const frozen = decodeNewTask(pending.text);
  if (frozen.tool !== tool || Boolean(frozen.desktop) !== desktop) throw new Error('新任务的会话归属无法确认');
  return { ...pending, text: frozen.prompt, ...(frozen.composerDraft ? { composerDraft: frozen.composerDraft } : {}) };
}

/** Pure local acknowledgement, after the original composer revision was consumed. */
export async function acknowledgeNewSession(deviceId: string, tool: ToolId, desktop: boolean, sessionKey: string, exactScope: string): Promise<void> {
  const owner = need();
  if (exactScope !== remoteDeliveryScope() || owner.deviceId && owner.deviceId !== deviceId) throw new Error('连接已切换，原任务确认记录未清理');
  const key = newSessionReceiptKey(tool, desktop);
  const pending = await pendingDelivery(exactScope, deviceId, key);
  if (owner !== hub || exactScope !== remoteDeliveryScope() || pending?.acceptedSessionKey !== sessionKey) throw new Error('原任务的确认记录已改变');
  await acknowledgeAcceptedDelivery(exactScope, deviceId, key, pending.requestId, sessionKey);
}

export async function retryNewSession(deviceId: string, tool: ToolId, desktop: boolean, requestId: string): Promise<string> {
  const owner = need(), scope = remoteDeliveryScope();
  const pending = await pendingDelivery(scope, deviceId, newSessionReceiptKey(tool, desktop));
  if (owner !== hub || scope !== remoteDeliveryScope() || !pending || pending.requestId !== requestId) throw new DeliveryPendingError('原任务的送达记录已改变，请重新核对电脑上的任务', false);
  const frozen = decodeNewTask(pending.text);
  if (frozen.tool !== tool || Boolean(frozen.desktop) !== desktop) throw new DeliveryPendingError('原任务的会话归属无法确认', false);
  const { images: _images, ...input } = frozen;
  return startSessionLocked(deviceId, input, requestId);
}

async function startSessionLocked(deviceId: string, input: TurnFeatures & { tool: ToolId; cwd: string; projectless?: true; prompt: string; workspaceMode?: WorkspaceMode; model?: string; effort?: Effort; permissionMode?: PermissionMode; approval: ApprovalMode; accountId?: string; images?: RemoteImage[]; desktop?: boolean; composerDraft?: NewTaskSnapshot['composerDraft'] }, retryRequestId?: string): Promise<string> {
  const owner = need();
  const scope = remoteDeliveryScope(), receiptKey = newSessionReceiptKey(input.tool, Boolean(input.desktop));
  const previous = await pendingDelivery(scope, deviceId, receiptKey);
  if (previous && !retryRequestId || retryRequestId && (!previous || previous.requestId !== retryRequestId)) throw new DeliveryPendingError('上一项任务尚未确认，请先核对原任务；新内容仍保留', false);
  if (apiWriteBusy(owner, deviceId)) throw new Error('API 正在切换，请稍候');
  const selectedAccountId = input.accountId ?? selectedAgentAccount(deviceId, input.desktop ? 'claude-desktop' : input.tool);
  const snapshot: NewTaskSnapshot = previous ? decodeNewTask(previous.text) : { version: 1, tool: input.tool, cwd: input.cwd, ...(input.projectless ? { projectless: true as const } : {}), prompt: input.prompt, approval: input.approval, workspaceMode: input.workspaceMode ?? 'code',
    ...(selectedAccountId ? { accountId: selectedAccountId } : {}), ...(input.model?.trim() ? { model: input.model.trim() } : {}), ...(input.effort ? { effort: input.effort } : {}),
    ...copyTurnFeatures(input), ...(input.permissionMode !== undefined ? { permissionMode: input.permissionMode } : {}),
    ...(input.desktop ? { desktop: true } : {}), ...(input.composerDraft ? { composerDraft: input.composerDraft } : {}), images: (input.images ?? []).map(image => ({ mime: image.mime, width: image.width, height: image.height, digest: attachmentSourceDigest(image.base64) })) };
  const text = encodeNewTask(snapshot);
  if (previous && (snapshot.tool !== input.tool || Boolean(snapshot.desktop) !== Boolean(input.desktop))) throw new DeliveryPendingError('原任务的会话归属无法确认', false);
  const guard = () => {
    if (owner !== hub || scope !== remoteDeliveryScope()) throw new HubError('连接已切换，尚未发送任务', 200, 'request_scope_changed');
    if (apiWriteBusy(owner, deviceId)) throw new HubError('API 正在切换，请稍候', 429, 'api_switching');
    if (!previous?.acceptedSessionKey) {
      if (snapshot.projectless && (!hubSupportsProjectless() || !state.devices.find(device => device.deviceId === deviceId)?.capabilities?.includes('session.projectless.v1'))) throw new Error('电脑或中转站尚不支持不关联文件夹的会话，请更新后重试，或返回选择项目文件夹');
      if (AppState.currentState === 'background' || AppState.currentState === 'inactive') throw new HubError('手机已进入后台，原任务尚未发送', 200, 'new_task_not_dispatched');
      const currentAccount = selectedAgentAccount(deviceId, snapshot.desktop ? 'claude-desktop' : snapshot.tool);
      // Explicit callers may have selected a key before a cold status read.
      // Claude receipt recovery retains its original wire account; all other
      // admissions keep the existing current-account check.
      if (!(snapshot.tool === 'claude' && previous?.attempted) && currentAccount !== undefined && currentAccount !== snapshot.accountId) throw new HubError('API 已改变，请先核对原任务', 200, 'request_scope_changed');
      requireExecution(deviceId, snapshot.desktop ? 'claude-desktop' : snapshot.tool, snapshot.tool, Boolean(snapshot.desktop));
      requireTurnCapabilities(deviceId, snapshot.desktop ? 'claude-desktop' : snapshot.tool, snapshot, snapshot.images.length, snapshot.tool === 'claude' && previous?.attempted === true, true);
      // Only a previously attempted, immutable UUID may recover an existing
      // receipt after API configuration disappears. A fresh receipt may not.
      if (!previous?.attempted) requireClaudeApiAdmission(deviceId, snapshot.desktop ? 'claude-desktop' : snapshot.tool, snapshot.accountId);
    }
  };
  guard();
  const idempotent = previous?.acceptedSessionKey ? true : await retryCapability(owner, previous?.attempted === true);
  guard();
  let sourceImages = previous?.attachmentsUploaded === false && previous.attachmentSources?.length
    ? await loadAttachmentSources(previous.attachmentSources) : previous ? [] : input.images ?? [];
  if (sourceImages.some((image, index) => {
    const expected = snapshot.images[index];
    return !expected || image.mime !== expected.mime || image.width !== expected.width || image.height !== expected.height || attachmentSourceDigest(image.base64) !== expected.digest;
  })) throw new DeliveryPendingError('原任务的图片与提交快照不一致，不会发送替换图片', false, previous?.requestId);
  if (previous && snapshot.images.length !== (previous.attachments?.length ?? 0)) throw new DeliveryPendingError('原任务的图片记录无法确认', false, previous.requestId);
  if (snapshot.images.length && (!previous || previous.attachmentsUploaded === false) && sourceImages.length !== snapshot.images.length) throw new DeliveryPendingError('原任务的图片无法恢复，不会只发送文字', false, previous?.requestId);
  // Queue images are private staging files. Transfer them to the immutable
  // submission namespace before a durable delivery receipt can reference
  // them. If the pairing changed or the bytes no longer match, this throws
  // before any attachment chunk or session.start command is sent.
  if (sourceImages.length) sourceImages = await handoffQueuedSubmissionImages(scope, sourceImages);
  const promptRefs = sourceImages.length ? newAttachmentRefs(sourceImages).map((ref, index) => ({ ...ref, ...(previous?.attachments?.[index] ? { id: previous.attachments[index] } : {}) })) : [];
  sourceImages = await Promise.all(sourceImages.map(async (image, index) => ({ ...image, uri: await durableAttachmentUri(image.uri, promptRefs[index].id) })));
  promptRefs.forEach((ref, index) => { ref.uri = sourceImages[index].uri; });
  guard();
  const readLock = beginApiRead(owner, deviceId, 'API 或中转站正在切换，请稍候');
  let sessionKey = '';
  try {
    await deliverMessage({ scope, deviceId, sessionKey: receiptKey, surface: 'cli', text, idempotent,
      ...(hubCapabilities.has('commands.durable.v2') && !snapshot.desktop ? { durableProtocol: 2 as const } : {}),
      requireNewReceipt: !retryRequestId, expectedRequestId: retryRequestId,
      attachments: previous?.attachments ?? promptRefs.map(ref => ref.id),
      attachmentSources: promptRefs.map((ref, index) => ({ id: ref.id, uri: sourceImages[index].uri, mime: sourceImages[index].mime, width: sourceImages[index].width, height: sourceImages[index].height, digest: snapshot.images[index].digest })),
      prepare: async () => { guard(); await uploadImageRefs(deviceId, sourceImages, promptRefs, owner, { agent: snapshot.tool, accountId: snapshot.accountId }); },
      perform: async (receipt) => {
        guard();
        const executionId = receipt.executionId ?? await durableExecutionId(scope, deviceId, receipt.requestId);
        const projectAcceptedPrompt = (clientId = executionId) => {
          if (owner !== hub || scope !== remoteDeliveryScope()) return;
          const key = timelineKey(deviceId, sessionKey);
          set(current => {
            const existing = current.timelines[key] ?? EMPTY_TIMELINE;
            const match = existing.items.find(item => item.kind === 'message' && item.role === 'user' && !item.parentId
              && !messageOrigin(item.messageOrigin) && item.clientId === clientId);
            if (match?.kind === 'message') return { timelines: { ...current.timelines, [key]: { ...existing,
              items: existing.items.map(item => item === match ? { ...match, contextReferences: messageContextReferences(match.contextReferences ?? snapshot.contextReferences), skills: messageSkills(match.skills ?? snapshot.skills) } : item) } } };
            const hasPrompt = existing.items.some(item => item.kind === 'message' && item.role === 'user' && !item.local);
            if (hasPrompt) return {};
            const refs = promptRefs.length ? promptRefs : receipt.attachments?.map(id => ({ id, mime: 'image/jpeg' })) ?? [];
            return { timelines: { ...current.timelines, [key]: { ...existing, items: [{ kind: 'message', id: `local:${receipt.requestId}`,
              clientId, role: 'user', text: snapshot.prompt, final: true, ts: Date.now(), local: true, contextReferences: messageContextReferences(snapshot.contextReferences), skills: messageSkills(snapshot.skills),
              ...(refs.length ? { attachments: refs } : {}) }, ...existing.items] } } };
          });
        };
        if (receipt.acceptedSessionKey) {
          if (sessionAgentId(receipt.acceptedSessionKey) !== snapshot.tool) throw new HubError('电脑没有返回正确的新会话，请先核对电脑上的任务', 409, 'command_delivery_uncertain');
          sessionKey = receipt.acceptedSessionKey;
          projectAcceptedPrompt();
          return { sessionKey, ...(snapshot.composerDraft ? { retain: true as const } : {}) };
        }
        const execution = requireExecution(deviceId, snapshot.desktop ? 'claude-desktop' : snapshot.tool, snapshot.tool, Boolean(snapshot.desktop));
        const result = await runCommand<{ sessionKey?: string }>(owner, deviceId, { type: 'session.start', tool: execution.tool, cwd: snapshot.cwd, ...(snapshot.projectless ? { projectless: true as const, controlSurface: 'cli' as const } : {}), prompt: snapshot.prompt, ...(snapshot.workspaceMode ? { workspaceMode: snapshot.workspaceMode } : {}), approval: snapshot.approval,
          ...(snapshot.accountId ? { accountId: snapshot.accountId } : {}), ...(snapshot.model ? { model: snapshot.model } : {}), ...(snapshot.effort ? { effort: snapshot.effort } : {}),
          ...copyTurnFeatures(snapshot), ...(snapshot.permissionMode !== undefined ? { permissionMode: snapshot.permissionMode } : {}),
          ...(receipt.attachments?.length ? { attachments: receipt.attachments } : {}), ...(execution.entrypoint ? { entrypoint: execution.entrypoint } : {}), operationId: receipt.requestId }, receipt.requestId);
        try { if (!result.sessionKey || sessionAgentId(result.sessionKey) !== snapshot.tool) throw new Error(); }
        catch { throw new HubError('电脑没有返回正确的新会话，请先核对电脑上的任务', 409, 'command_delivery_uncertain'); }
        sessionKey = result.sessionKey!;
        // A valid acceptance belongs to the original receipt even if its UI
        // owner changed during the request. Never project it into the new Hub.
        if (owner !== hub || scope !== remoteDeliveryScope()) return { sessionKey, retain: true as const };
        projectAcceptedPrompt(await durableExecutionId(scope, deviceId, receipt.requestId));
        return { sessionKey, ...(snapshot.composerDraft ? { retain: true as const } : {}) };
      } });
  } catch (error) {
    // Acceptance wins over failed local receipt cleanup. Keep its UUID on disk
    // for recovery, but do not leave a sent task in a resendable new composer.
    if (!sessionKey || owner !== hub || scope !== remoteDeliveryScope() || (await retiredDeliveryScopes()).includes(scope)) throw error;
  } finally { endApiRead(readLock); }
  if (owner !== hub || scope !== remoteDeliveryScope()) throw new HubError('连接已切换，任务仍在原电脑上', 200, 'request_scope_changed');
  return sessionKey;
}

export interface SendOptions extends TurnFeatures { model?: string; effort?: Effort; permissionMode?: PermissionMode; approval?: ApprovalMode; accountId?: string; images?: RemoteImage[]; surface?: 'cli' | 'desktop'; newSubmission?: boolean; retryRequestId?: string; control?: 'continue' | 'steer'; expectedTurnId?: string; draftOwner?: DeliveryDraftOwner }

export async function steerSession(deviceId: string, sessionKey: string, text: string, accountId?: string): Promise<void> {
  const expectedTurnId = turnControlTarget(state.timelines[timelineKey(deviceId, sessionKey)], 'stop');
  if (!expectedTurnId) throw new Error('请先刷新并确认正在运行的轮次');
  await sendToSession(deviceId, sessionKey, text, { control: 'steer', expectedTurnId, accountId, surface: 'cli', newSubmission: true });
}

export async function continueSession(deviceId: string, sessionKey: string, options: SendOptions = {}): Promise<void> {
  if (options.images?.length) throw new Error('请先处理输入框图片，再继续任务');
  if (isNativeSession(deviceId, sessionKey) || isReadOnlyDesktopSession(sessionKey)) throw new HubError('这个桌面操作请在电脑处理', 200, 'desktop_capability_unavailable');
  requireAgentCapability(deviceId, sessionAgentId(sessionKey), 'continue');
  const expectedTurnId = turnControlTarget(state.timelines[timelineKey(deviceId, sessionKey)], 'continue');
  if (!expectedTurnId) throw new Error('请先刷新并确认这一轮已结束');
  await sendToSession(deviceId, sessionKey, CONTINUE_PROMPT, { ...options, images: undefined, control: 'continue', expectedTurnId, surface: 'cli', newSubmission: true });
}

/** Continues a thread on the computer. Shows the message immediately; the computer's echo replaces it. */
export async function sendToSession(deviceId: string, sessionKey: string, text: string, options: SendOptions = {}): Promise<void> {
  // Freeze user intent before the first storage wait. A caller may reuse its
  // picker object while a durable receipt is still being prepared.
  const frozen = { ...options, ...copyTurnFeatures(options), ...(options.draftOwner ? { draftOwner: { ...options.draftOwner } } : {}), ...(options.images ? { images: options.images.map(image => ({ ...image })) } : {}) };
  if (frozen.surface === 'desktop' && frozen.retryRequestId === undefined) {
    const applied = state.agents[deviceId]?.list.find(item => item.id === 'codex')?.desktopLive?.accountId;
    if (frozen.accountId === undefined && applied) frozen.accountId = applied;
    if (frozen.model || frozen.effort) requireNativeModelOptions(deviceId, sessionKey, frozen);
  }
  validateContextPrompt(text, frozen.contextReferences, frozen.skills?.length);
  return sendToSessionLocked(deviceId, sessionKey, text, frozen);
}

async function sendToSessionLocked(deviceId: string, sessionKey: string, text: string, options: SendOptions = {}): Promise<void> {
  if (isReadOnlyDesktopSession(sessionKey) || state.timelines[timelineKey(deviceId, sessionKey)]?.session?.controlSurface === 'read-only') throw new Error('这个桌面对话目前只支持查看');
  const owner = need();
  if (apiWriteBusy(owner, deviceId)) throw new Error('API 正在切换，请稍候');
  const scope = remoteDeliveryScope();
  const previous = await pendingDelivery(scope, deviceId, sessionKey);
  if (previous?.draftOwner && previous.acceptedSessionKey === sessionKey && options.retryRequestId === previous.requestId && text === previous.text) {
    await settleAcceptedRemoteMessage(previous); return;
  }
  const diffReceiptRecovery = previous?.attempted === true && options.retryRequestId === previous.requestId && hasDiffAnnotations(previous.sendOptions?.contextReferences);
  if (options.retryRequestId !== undefined) {
    if (!previous || previous.requestId !== options.retryRequestId || previous.text !== text) throw new DeliveryPendingError('原消息的送达记录已改变，请重新核对原会话', false);
    if (options.newSubmission || options.images?.length) throw new DeliveryPendingError('重试只能使用原消息的图片，请先核对原消息', false);
  } else if (previous) {
    throw new DeliveryPendingError('上一条消息尚未确认，请先核对原消息；新内容仍保留', false);
  }
  if (!text.trim() && !(previous?.attachments?.length ?? options.images?.length) && !(previous?.sendOptions ?? options).contextReferences?.length) throw new Error('请输入内容或添加图片');
  const requireSessionAdmission = () => {
    // An attempted original UUID may still need its Hub receipt recovered.
    // This exemption cannot create a new request, change its surface or text.
    if (previous?.attempted) return;
    const observed = state.timelines[timelineKey(deviceId, sessionKey)]?.session
      ?? state.sessions[deviceId]?.list.find(session => session.sessionKey === sessionKey);
    if (claudeSessionAdmissionBlocked(observed)) throw new HubError('无法确认外部 Claude 会话是否已停止，请在电脑处理原会话；不会启动另一个进程接管', 200, 'external_session_state_unknown');
  };
  requireSessionAdmission();
  const surface = previous?.surface ?? options.surface ?? 'cli';
  if (!validTurnFeatures(previous?.sendOptions ?? options, surface)) throw new Error('此会话不支持工作模式或技能选项');
  if (surface !== 'cli' && (previous?.sendOptions ?? options).permissionMode !== undefined) throw new HubError('桌面原生会话的权限请在电脑设置', 200, 'permission_mode_unavailable');
  if (surface !== 'cli' && (previous?.sendOptions ?? options).approval !== undefined) throw new HubError('桌面原生会话的权限请在电脑设置', 200, 'permission_mode_unavailable');
  const sessionAgent = sessionAgentId(sessionKey);
  const controlOptions = previous?.sendOptions ?? options;
  const control = controlOptions.control;
  if (control) {
    if (control !== 'continue' && control !== 'steer') throw new Error('未知的轮次操作');
    requireAgentCapability(deviceId, sessionAgent, control);
    if (surface !== 'cli' || options.images?.length || previous?.attachments?.length || !validTurnId(controlOptions.expectedTurnId)) throw new Error('轮次操作的目标无效');
    if (control === 'steer' && (isNativeSession(deviceId, sessionKey) || ['model', 'effort', 'collaborationMode', 'skills', 'contextReferences', 'permissionMode', 'approval'].some(field => controlOptions[field as keyof typeof controlOptions] !== undefined))) throw new Error('引导只向当前轮次补充文字，不能修改模型或权限');
  }
  const requireSteerAdmission = () => {
    if (control !== 'steer' || previous?.attempted) return;
    const timeline = state.timelines[timelineKey(deviceId, sessionKey)];
    if (timeline?.session?.status !== 'running' || turnControlTarget(timeline, 'stop') !== controlOptions.expectedTurnId) throw new HubError('任务轮次已变化，引导未发送，请核对原会话', 200, 'turn_control_stale');
  };
  requireSteerAdmission();
  const requireCurrentDiffReview = (references?: readonly ContextReference[]) => {
    // attempted alone is not proof of dispatch. These retries use a separate
    // transport-envelope lookup flag; a missing Hub receipt cannot run work.
    if (diffReceiptRecovery) return;
    const problem = diffReviewProblem(state.timelines[timelineKey(deviceId, sessionKey)]?.items ?? [], sessionKey, references);
    if (problem) throw new HubError(problem, 200, 'diff_annotation_stale');
  };
  if (surface === 'desktop' && sessionAgent !== 'codex') throw new HubError('这个 Agent 没有此桌面控制能力', 200, 'agent_capability_unavailable');
  if (surface === 'cli') {
    requireSessionExecution(deviceId, sessionKey);
    requireTurnCapabilities(deviceId, sessionExecutionAgent(deviceId, sessionKey), previous?.sendOptions ?? options, previous?.attachments?.length ?? options.images?.length, sessionAgent === 'claude' && previous?.attempted === true);
    requireCurrentDiffReview((previous?.sendOptions ?? options).contextReferences);
  }
  const selectedAccountId = surface === 'desktop' ? options.accountId : options.accountId ?? selectedAgentAccount(deviceId, sessionExecutionAgent(deviceId, sessionKey));
  const requireApiAdmission = () => {
    if (surface === 'cli' && !previous?.attempted) requireClaudeApiAdmission(deviceId, sessionExecutionAgent(deviceId, sessionKey), previous?.sendOptions?.accountId ?? selectedAccountId);
  };
  requireApiAdmission();
  const nativeOptions = previous?.sendOptions ?? { ...options, accountId: selectedAccountId };
  if (surface === 'desktop' && (nativeOptions.model || nativeOptions.effort)) requireNativeModelOptions(deviceId, sessionKey, nativeOptions);
  const idempotent = await retryCapability(owner, previous?.attempted === true);
  if (diffReceiptRecovery && !hubCapabilities.has('commands.receipt-only.v1')) throw new Error('中转站暂不支持只核对原回执，批注仍保留，请更新 Hub');
  if (owner !== hub) throw new Error('连接已切换，消息未从新连接发送');
  if (control === 'steer' && !hubSupportsSteer()) throw new HubError('请先更新中转站以支持运行中引导', 200, 'agent_capability_unavailable');
  requireSteerAdmission();
  if (apiWriteBusy(owner, deviceId)) throw new Error('API 正在切换，请稍候');
  const key = timelineKey(deviceId, sessionKey);
  let localId = `local:${Date.now()}:${++localPromptSequence}`;
  let optimisticAttachments: LocalAttachment[] | undefined;
  let originalSession: SessionInfo | undefined, optimisticSession: SessionInfo | undefined;
  let originalItems = new Set<TimelineItem>();
  const optimisticContextReferences = messageContextReferences((previous?.sendOptions ?? options).contextReferences);
  const optimisticSkills = messageSkills((previous?.sendOptions ?? options).skills);
  set((current) => {
    const timeline = current.timelines[key] ?? EMPTY_TIMELINE;
    const priorLocals = previous ? timeline.items.filter((item): item is Extract<TimelineItem, { kind: 'message' }> =>
      item.kind === 'message' && item.local === true && item.text.trim() === text.trim()
        && (Boolean(text.trim()) || item.clientId === (previous.executionId ?? previous.requestId) || messageEchoMatches(item, { text, attachments: previous.attachments?.map(id => ({ id })) }))) : [];
    const receiptLocals = priorLocals.filter(item => item.clientId === (previous?.executionId ?? previous?.requestId));
    const legacyLocals = priorLocals.filter(item => !item.clientId);
    const priorLocal = receiptLocals.length === 1 ? receiptLocals[0]
      : receiptLocals.length === 0 && legacyLocals.length === 1 && !legacyLocals[0].skills?.length && !optimisticSkills?.length && !legacyLocals[0].contextReferences?.length && !optimisticContextReferences?.length ? legacyLocals[0] : undefined;
    if (priorLocal) {
      localId = priorLocal.id;
      return { timelines: { ...current.timelines, [key]: { ...timeline, items: timeline.items.map(item => item === priorLocal ? { ...priorLocal, contextReferences: optimisticContextReferences, skills: optimisticSkills } : item) } } };
    }
    originalSession = timeline.session; originalItems = new Set(timeline.items);
    optimisticSession = control === 'steer' ? timeline.session : timeline.session ? { ...timeline.session, status: 'running' } : undefined;
    const priorRefs = previous?.attachments?.map((id) => timeline.items.flatMap((item) => item.kind === 'message' ? (item.attachments ?? []) : []).find((ref) => ref.id === id)).filter((ref): ref is LocalAttachment => Boolean(ref));
    optimisticAttachments = priorRefs?.length ? priorRefs : options.images?.length ? newAttachmentRefs(options.images) : undefined;
    return { timelines: { ...current.timelines, [key]: { ...timeline, items: [...timeline.items, { kind: 'message', id: localId, role: 'user', text, final: true, ts: Date.now(), local: true, contextReferences: optimisticContextReferences, skills: optimisticSkills,
      ...(optimisticAttachments?.length ? { attachments: optimisticAttachments, images: optimisticAttachments.map((ref) => ref.uri).filter((uri): uri is string => Boolean(uri)) } : {}) }],
      session: optimisticSession } } };
  });
  try {
    // Write the receipt before uploading any image.  A retry reuses the same
    // attachment IDs and resumes an interrupted upload instead of creating a
    // second task or sending IDs whose bytes never reached the computer.
    let sourceImages: RemoteImage[] | undefined;
    try {
      sourceImages = previous
        ? previous.attachmentsUploaded === false && previous.attachmentSources?.length ? await loadAttachmentSources(previous.attachmentSources) : undefined
        : options.images?.length ? options.images : undefined;
    } catch (error) {
      // A missing local source is a durable receipt problem, not a transient
      // network failure. Mark it non-retryable so the foreground loop does not
      // spin forever trying to upload a file that no longer exists.
      if (previous?.attachments?.length && previous.attachmentsUploaded === false) {
        throw new DeliveryPendingError(error instanceof Error ? error.message : '原图片无法恢复，请先核对原会话', false, previous.requestId, false);
      }
      throw error;
    }
    // Move a staged queue image into the immutable submission namespace
    // before creating attachment refs or freezing the durable receipt. The
    // handoff is scope-checked and content-checked; a failure leaves the
    // original queue row recoverable and sends no partial message.
    if (sourceImages?.length) sourceImages = await handoffQueuedSubmissionImages(scope, sourceImages);
    const uploadRefs = previous?.attachments?.length
      ? (sourceImages?.length ? sourceImages.map((image, index) => ({ ...newAttachmentRefs([image])[0], id: previous.attachments![index] })) : undefined)
      : sourceImages?.length ? newAttachmentRefs(sourceImages) : undefined;
    if (sourceImages?.length && uploadRefs?.length) {
      sourceImages = await Promise.all(sourceImages.map(async (image, index) => ({ ...image, uri: await durableAttachmentUri(image.uri, uploadRefs[index].id) })));
      // Keep the durable URI in the receipt, never the transient picker cache
      // path.  The bytes remain in memory for the current upload as before.
      if (uploadRefs.length === sourceImages.length) uploadRefs.forEach((ref, index) => { ref.uri = sourceImages![index].uri; });
    }
    const attachments = previous?.attachments ?? uploadRefs?.map((ref) => ref.id);
    if (previous?.attachments?.length && sourceImages?.length && sourceImages.length !== previous.attachments.length) {
      throw new DeliveryPendingError('原消息的图片数量不一致，请重新选择全部原图片', false);
    }
    if (previous?.attachments?.length && previous.attachmentsUploaded === false && !sourceImages?.length) {
      throw new DeliveryPendingError('原消息的图片未完成上传，请重新选择原图片后重试', false);
    }
    const readLock = beginApiRead(owner, deviceId, 'API 或中转站正在切换，请稍候');
    try {
      await deliverMessage({ scope, deviceId, sessionKey, surface, text, idempotent, attachments, draftOwner: previous?.draftOwner ?? options.draftOwner, requireNewReceipt: options.retryRequestId === undefined, expectedRequestId: options.retryRequestId,
        ...(hubCapabilities.has('commands.durable.v2') && surface === 'cli' ? { durableProtocol: 2 as const } : {}),
        attachmentSources: uploadRefs?.map((ref, index) => ({ id: ref.id, uri: ref.uri ?? '', mime: sourceImages?.[index]?.mime ?? 'image/jpeg', width: ref.width ?? 1, height: ref.height ?? 1,
          ...(sourceImages?.[index] ? { digest: attachmentSourceDigest(sourceImages[index].base64) } : {}) })),
        prepare: async (receipt) => {
          if (diffReceiptRecovery) return;
          if (receipt.attachmentsUploaded !== false) return;
          requireSessionAdmission();
          requireApiAdmission();
          if (receipt.surface === 'cli') requireSessionExecution(deviceId, sessionKey);
          if (!sourceImages?.length || !uploadRefs?.length) throw new DeliveryPendingError('原消息的图片无法恢复，请重新选择图片', false);
          requireTurnCapabilities(deviceId, sessionExecutionAgent(deviceId, sessionKey), receipt.sendOptions ?? options, receipt.attachments?.length, sessionAgent === 'claude' && previous?.attempted === true);
          await uploadImageRefs(deviceId, sourceImages, uploadRefs, owner, { agent: sessionAgent, accountId: receipt.sendOptions?.accountId ?? selectedAccountId });
        },
        sendOptions: { ...copyTurnFeatures(options), ...(options.model ? { model: options.model } : {}), ...(options.effort ? { effort: options.effort } : {}), ...(options.permissionMode !== undefined ? { permissionMode: options.permissionMode } : {}), ...(options.approval !== undefined ? { approval: options.approval } : {}), ...(selectedAccountId ? { accountId: selectedAccountId } : {}), ...(options.control ? { control: options.control, expectedTurnId: options.expectedTurnId } : {}) },
        perform: async (receipt) => {
          if (owner !== hub) throw new HubError('连接已切换，尚未发送消息', 200, 'request_scope_changed');
          if (apiWriteBusy(owner, deviceId)) throw new HubError('API 正在切换，请稍候', 429, 'api_switching');
          requireSessionAdmission();
          requireApiAdmission();
          if (receipt.surface === 'cli') {
            set((current) => {
              const timeline = current.timelines[key];
              if (!timeline) return {};
              return { timelines: { ...current.timelines, [key]: { ...timeline, items: timeline.items.map((item) => item.kind === 'message' && item.id === localId
                ? { ...item, clientId: receipt.requestId, contextReferences: messageContextReferences((receipt.sendOptions ?? options).contextReferences), skills: messageSkills((receipt.sendOptions ?? options).skills) } : item) } } };
            });
          }
          const frozenOptions = receipt.sendOptions ?? options; // Pre-upgrade receipts retain their original compatibility behavior.
          requireCurrentDiffReview(frozenOptions.contextReferences);
          if (receipt.surface === 'cli') {
            requireSessionExecution(deviceId, sessionKey);
            requireTurnCapabilities(deviceId, sessionExecutionAgent(deviceId, sessionKey), frozenOptions, receipt.attachments?.length, sessionAgent === 'claude' && previous?.attempted === true);
          }
          else if (frozenOptions.model || frozenOptions.effort) requireNativeModelOptions(deviceId, sessionKey, frozenOptions);
          const common = { sessionKey, text, operationId: receipt.requestId, ...(frozenOptions.accountId ? { accountId: frozenOptions.accountId } : {}),
            ...(frozenOptions.model ? { model: frozenOptions.model } : {}), ...(frozenOptions.effort ? { effort: frozenOptions.effort } : {}),
            ...copyTurnFeatures(frozenOptions), ...(frozenOptions.permissionMode !== undefined ? { permissionMode: frozenOptions.permissionMode } : {}),
            ...(frozenOptions.approval !== undefined ? { approval: frozenOptions.approval } : {}) };
          const submitOriginalCommand = <T = Record<string, unknown>>(input: Command) => runCommand<T>(owner, deviceId, input, receipt.requestId, undefined, diffReceiptRecovery, diffReceiptRecovery ? { receiptOnly: true } : undefined);
          if (frozenOptions.control === 'steer') {
            requireAgentCapability(deviceId, sessionAgent, 'steer');
            requireSteerAdmission();
            if (!hubSupportsSteer() || receipt.surface !== 'cli' || receipt.attachments?.length || !validTurnId(frozenOptions.expectedTurnId)
              || ['model', 'effort', 'collaborationMode', 'skills', 'contextReferences', 'permissionMode', 'approval'].some(field => frozenOptions[field as keyof typeof frozenOptions] !== undefined)) throw new HubError('引导操作的目标或选项无效', 200, 'invalid_turn_control');
            const result = await runCommand<{ accepted: boolean; sessionKey: string; turnId: string; operationId: string }>(owner, deviceId,
              { type: 'session.steer', sessionKey, text, operationId: receipt.requestId, controlSurface: 'cli', expectedTurnId: frozenOptions.expectedTurnId,
                ...(frozenOptions.accountId ? { accountId: frozenOptions.accountId } : {}) }, receipt.requestId);
            if (result?.accepted !== true || result.sessionKey !== sessionKey || result.turnId !== frozenOptions.expectedTurnId || result.operationId !== await durableExecutionId(scope, deviceId, receipt.requestId)) throw new HubError('引导操作的送达结果未确认', 409, 'command_delivery_uncertain');
          } else if (frozenOptions.control === 'continue') {
            requireAgentCapability(deviceId, sessionAgent, 'continue');
            if (receipt.surface !== 'cli' || receipt.attachments?.length || !validTurnId(frozenOptions.expectedTurnId)) throw new HubError('继续操作的轮次无效', 200, 'invalid_turn_control');
            const result = await submitOriginalCommand<{ accepted: boolean; sessionKey: string; previousTurnId: string; operationId: string }>(
              { type: 'session.continue', ...common, controlSurface: 'cli', expectedTurnId: frozenOptions.expectedTurnId });
            if (result.accepted !== true || result.sessionKey !== sessionKey || result.previousTurnId !== frozenOptions.expectedTurnId || result.operationId !== await durableExecutionId(scope, deviceId, receipt.requestId)) throw new HubError('继续操作的送达结果未确认', 409, 'command_delivery_uncertain');
          } else await submitOriginalCommand({ type: 'session.send', ...common, controlSurface: receipt.surface,
            ...(receipt.attachments?.length ? { attachments: receipt.attachments } : {}) });
          if (owner !== hub) throw new HubError('连接已切换，请回原连接确认送达', 409, 'command_delivery_uncertain');
          if (receipt.surface === 'desktop' || frozenOptions.control === 'steer') {
            // Native read_thread may omit clientId and wrap our accepted send
            // as a delegation. Only this command's successful receipt retires
            // its local row; equal text or delegated metadata proves no echo.
            // turn/steer likewise has no documented client-ID echo contract.
            set((current) => {
              if (owner !== hub) return {};
              const timeline = current.timelines[key];
              if (!timeline) return {};
              return { timelines: { ...current.timelines, [key]: { ...timeline, items: timeline.items.filter((item) => !(item.kind === 'message' && item.local && item.id === localId)) } } };
            });
          }
          if (receipt.draftOwner) return { sessionKey, retain: true as const };
        } });
      const accepted = await pendingDelivery(scope, deviceId, sessionKey);
      if (accepted?.draftOwner && accepted.acceptedSessionKey === sessionKey) await settleAcceptedRemoteMessage(accepted, options.retryRequestId === undefined);
    } finally { endApiRead(readLock); }
  } catch (error) {
    // A retryable phone receipt keeps its exact prompt visible, but a locally
    // optimistic `running` status is not evidence that the computer accepted
    // it. Restore only that placeholder when no computer progress replaced it.
    if (owner === hub && error instanceof DeliveryPendingError && error.retryable) {
      set((current) => {
        const timeline = current.timelines[key];
        if (!timeline || !originalSession || timeline.session !== optimisticSession) return {};
        const progressed = timeline.items.some((item) => item.id !== localId && !originalItems.has(item));
        if (progressed) return {};
        return { timelines: { ...current.timelines, [key]: { ...timeline, session: originalSession } } };
      });
    } else if (owner === hub) {
      set((current) => {
        const timeline = current.timelines[key];
        if (!timeline) return {};
        // An explicit rejection before any actual worker progress must not
        // leave the API picker locked by our optimistic "running" placeholder.
        const progressed = timeline.items.some((item) => item.id !== localId && !originalItems.has(item));
        const restore = !(error instanceof DeliveryPendingError) && originalSession && timeline.session === optimisticSession && !progressed;
        return { timelines: { ...current.timelines, [key]: { ...timeline, items: timeline.items.filter((item) => item.id !== localId), session: restore ? originalSession : timeline.session } } };
      });
    }
    throw error;
  }
}

const CODEX_THREAD = /^codex:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Native launch is opt-in and bound to the exact current host lease. A
 * transcript client label never authorizes starting a desktop process. */
export function canOpenOnDesktop(sessionKey: string, _client?: string, deviceId?: string): boolean {
  if (!deviceId || !CODEX_THREAD.test(sessionKey)) return false;
  const profile = state.agents[deviceId]?.list.find(item => item.id === 'codex');
  return desktopLiveFor(profile, sessionKey) && profile?.desktopLive?.capabilities?.navigate === true;
}
/** Asks the computer to show this thread in its desktop app. Sends nothing. */
export async function openOnDesktop(deviceId: string, sessionKey: string, client?: string): Promise<void> {
  if (!canOpenOnDesktop(sessionKey, client, deviceId)) throw new HubError('当前桌面连接未开放打开会话，请在电脑处理', 200, 'desktop_capability_unavailable');
  const accountId = sessionAgentId(sessionKey) === 'codex'
    ? state.agents[deviceId]?.list.find(item => item.id === 'codex')?.desktopLive?.accountId
    : selectedAgentAccount(deviceId, sessionAgentId(sessionKey));
  await command(need(), deviceId, { type: 'desktop.navigate', sessionKey, ...(accountId ? { accountId } : {}), controlSurface: 'desktop' });
}

const interruptFlights = new Map<string, Promise<InterruptResult>>();
export function hubSupportsLatestTurnRevert():boolean {return hubSupportsIdempotency()&&hubCapabilities.has('session.revert.v1');}
export async function revertLatestSessionTurn(deviceId:string,sessionKey:string,message:SentUserMessage,operationId:string):Promise<void> {
  if(!hubSupportsLatestTurnRevert())throw new Error('中转站尚未支持编辑已发送消息');
  requireAgentCapability(deviceId,sessionAgentId(sessionKey),'latestTurnRevert');
  requireSessionExecution(deviceId,sessionKey,true);
  const owner=need(),scope=remoteDeliveryScope(),key=timelineKey(deviceId,sessionKey);
  const expectedTurnId=latestEditableTurn(state.timelines[key]??EMPTY_TIMELINE,message);
  if(!expectedTurnId)throw new Error('只能编辑已结束的最新一条消息，请先停止任务并刷新');
  const accountId=selectedAgentAccount(deviceId,sessionAgentId(sessionKey)),lock=beginApiRead(owner,deviceId,'API 正在切换');
  try {
    if(await getPendingRemoteMessage(deviceId,sessionKey))throw new Error('请先核对上一条消息的送达状态');
    if(owner!==hub||scope!==remoteDeliveryScope())throw new Error('电脑连接已变化');
    const request:SessionRevertRequest={sessionKey,expectedTurnId,expectedMessageId:message.id,operationId};
    const result=parseSessionRevertResult(await command<unknown>(owner,deviceId,{type:'session.revert',...request,accountId,controlSurface:'cli'},operationId),request);
    if(result.status!=='completed')throw new Error('编辑回退结果未确认，请刷新原会话核对；不会自动重发');
    if(owner!==hub||scope!==remoteDeliveryScope())throw new Error('原电脑已回退会话，连接已切换；修改内容仍已保存');
    set(current=>({timelines:{...current.timelines,[key]:applyEvent(current.timelines[key]??EMPTY_TIMELINE,
      {type:'session.reverted',deviceId,sessionKey,tool:sessionAgentId(sessionKey),ts:Date.now(),id:message.id,turnId:expectedTurnId,operationId})}}));
    await openSession(deviceId,sessionKey);
  }finally{endApiRead(lock);}
}
export async function interruptSession(deviceId: string, sessionKey: string, targetTurnId?: string): Promise<InterruptResult> {
  if (isReadOnlyDesktopSession(sessionKey)) throw new Error('这个桌面对话目前只支持查看');
  if (isNativeSession(deviceId, sessionKey)) throw new HubError('这个桌面请求请在电脑处理', 200, 'desktop_capability_unavailable');
  requireAgentCapability(deviceId, sessionAgentId(sessionKey), 'interrupt');
  requireAgentCapability(deviceId, sessionAgentId(sessionKey), 'preciseInterrupt');
  const owner = need(), scope = remoteDeliveryScope();
  const expectedTurnId = targetTurnId ?? turnControlTarget(state.timelines[timelineKey(deviceId, sessionKey)], 'stop');
  if (!validTurnId(expectedTurnId)) throw new Error('当前轮次尚未确认，请先刷新');
  const key = JSON.stringify([scope, deviceId, sessionKey, expectedTurnId]);
  const previous = interruptFlights.get(key); if (previous) return previous;
  const flight = (async () => {
    await pausePendingDelivery(scope, deviceId, sessionKey);
    if (owner !== hub || scope !== remoteDeliveryScope()) throw new Error('连接已切换，停止请求未从新连接发送');
    // The operation ID is also the command idempotency key.  A retry after a
    // relay timeout must address the same turn operation, never create a new
    // interrupt with a different request identity.
    const operationId = randomUUID();
    const result = await command<InterruptResult>(owner, deviceId, { type: 'session.interrupt', sessionKey, expectedTurnId, operationId, controlSurface: 'cli' }, operationId);
    if (!result || result.turnId !== expectedTurnId || !['requested', 'stopped', 'already_finished', 'unconfirmed'].includes(result.status)) throw new HubError('停止结果尚未确认，请刷新原会话', 409, 'command_delivery_uncertain');
    return result;
  })();
  interruptFlights.set(key, flight);
  void flight.finally(() => { if (interruptFlights.get(key) === flight) interruptFlights.delete(key); }).catch(() => undefined);
  return flight;
}

/** Capture before the durable outbox write; later API changes cannot rewrite this UUID. */
export function snapshotQuestionCommand(approval: { approvalId: string; deviceId: string; sessionKey: string; controlSurface?: 'cli' | 'desktop' }, decision: Decision, message?: string, answers?: QuestionAnswers): QuestionCommand {
  need();
  if (approval.controlSurface === 'desktop' || isNativeSession(approval.deviceId, approval.sessionKey) || isReadOnlyDesktopSession(approval.sessionKey)) throw new HubError('这个桌面请求请在电脑处理', 200, 'desktop_capability_unavailable');
  const accountId = selectedAgentAccount(approval.deviceId, sessionAgentId(approval.sessionKey));
  return { type: 'approval.respond', approvalId: approval.approvalId, sessionKey: approval.sessionKey, decision,
    ...(message?.trim() ? { message: message.trim() } : {}),
    ...(answers ? { answers: Object.fromEntries(Object.entries(answers).map(([key, values]) => [key, [...values]])) } : {}),
    ...(accountId ? { accountId } : {}), controlSurface: 'cli' };
}
export interface ApprovalReceipt { requestId: string; retrying: boolean; scope: string; expiresAt?: number; signal: AbortSignal; command?: QuestionCommand }
export async function respondApproval(approval: { approvalId: string; deviceId: string; sessionKey: string; controlSurface?: 'cli' | 'desktop' }, decision: Decision, message?: string, answers?: QuestionAnswers, receipt?: ApprovalReceipt): Promise<void> {
  if (isReadOnlyDesktopSession(approval.sessionKey)) throw new Error('这个桌面对话目前只支持查看');
  const owner = need();
  const frozenQuestion: QuestionCommand | undefined = receipt?.command ? JSON.parse(JSON.stringify(receipt.command)) : undefined;
  if (frozenQuestion && !questionCommandMatches(frozenQuestion, { ...approval, decision, message, answers })) throw new HubError('回答的原请求记录不一致', 200, 'question_source_unconfirmed');
  const guard = () => {
    if (!receipt) return;
    if (receipt.signal.aborted || owner !== hub || receipt.scope !== remoteDeliveryScope()) throw new HubError('连接已切换，回答没有从新连接发送', 200, 'request_scope_changed');
    if (receipt.expiresAt && receipt.expiresAt <= Date.now()) throw new HubError('问题已过期，请刷新', 200, 'question_expired');
  };
  guard();
  // Lost acknowledgements may only be retried on a Hub with durable deduplication.
  if (receipt?.retrying && !(await retryCapability(owner, true))) throw new HubError('本站不支持安全重试，请先核对电脑上的问题', 200, 'question_retry_unsupported');
  guard();
  const timeline = state.timelines[`${approval.deviceId}|${approval.sessionKey}`];
  const item = timeline?.items.find(value => value.kind === 'approval' && value.id === approval.approvalId);
  if (receipt?.retrying && !frozenQuestion && (answers !== undefined || item?.kind === 'approval' && item.approval === 'question')) {
    throw new HubError('旧回答缺少来源记录，未重新发送', 200, 'question_source_unconfirmed');
  }
  // Restricted Hub policies bind approvals to the same API source as the
  // session. Approval events historically had no accountId, so derive the
  // currently selected family handle before sending; this is metadata only
  // and never contains the key itself.
  const approvalAgent = sessionAgentId(approval.sessionKey);
  const native = approval.controlSurface === 'desktop' || timeline?.session?.controlSurface === 'desktop' || item?.kind === 'approval' && item.approvalTransport === 'codex-hook-v1';
  const validateDecision = () => {
    if (item?.kind === 'approval' && !approvalDecisions(item).includes(decision)) throw new HubError('这个请求不支持此批准方式', 200, 'approval_decision_unsupported');
  };
  const selectedAccountId = native ? state.agents[approval.deviceId]?.list.find(profile => profile.id === 'codex')?.desktopLive?.accountId
    : selectedAgentAccount(approval.deviceId, approvalAgent);
  const questionRecovery = Boolean(frozenQuestion && receipt?.retrying);
  const receiptOnly = questionRecovery && hubCapabilities.has('commands.receipt-only.v1');
  // A card handle survives Key/URL edits. Equality cannot prove that a second
  // dispatch would use the original source; recovery may only read its receipt.
  if (questionRecovery && !receiptOnly) throw new HubError('本站暂不支持核对原回答', 200, 'question_retry_unsupported');
  if (frozenQuestion && native) throw new HubError('回答的执行面已改变，未重新发送', 200, 'question_source_unconfirmed');
  if (native) {
    // Validate the executor before its decision contract so unsupported native
    // operations keep their desktop-specific error and never fall back to CLI.
    if (approvalAgent !== 'codex' || item?.kind !== 'approval' || item.approvalTransport !== 'codex-hook-v1' || item.state !== 'pending'
        || !desktopApprovalFor(state.agents[approval.deviceId]?.list.find(profile => profile.id === 'codex'), approval.sessionKey)
        || !item.expiresAt || item.expiresAt <= Date.now() || decision === 'allow_session' || answers) throw new HubError('这个桌面请求请在电脑处理', 200, 'desktop_capability_unavailable');
    validateDecision();
    const operationId = receipt?.requestId ?? randomUUID();
    await command(owner, approval.deviceId, { type: 'desktop.approval.respond', sessionKey: approval.sessionKey, approvalId: approval.approvalId, decision,
      message: message?.trim() || undefined, operationId, ...(selectedAccountId ? { accountId: selectedAccountId } : {}), controlSurface: 'desktop' }, operationId, receipt?.signal);
  } else {
    if (!receiptOnly) {
      validateDecision();
      requireAgentCapability(approval.deviceId, approvalAgent, 'approval');
      if (answers !== undefined) requireAgentCapability(approval.deviceId, approvalAgent, 'questions');
    }
    await command(owner, approval.deviceId, frozenQuestion ?? { type: 'approval.respond', approvalId: approval.approvalId, sessionKey: approval.sessionKey, decision, message: message?.trim() || undefined, ...(answers ? { answers } : {}), ...(selectedAccountId ? { accountId: selectedAccountId } : {}), controlSurface: 'cli' }, receipt?.requestId, receipt?.signal, receiptOnly ? { receiptOnly: true } : undefined);
  }
  if (owner !== hub) throw new HubError('请回原连接核对回答', 409, 'command_delivery_uncertain');
  handleEvent({ type: 'approval.resolved', approvalId: approval.approvalId, decision, by: 'phone', deviceId: approval.deviceId, sessionKey: approval.sessionKey, tool: approvalAgent, ts: Date.now() }, false, native);
}

export interface SessionContextReading { value: SessionContext; scope: string }
const contextCompactFlights = new Map<string, Promise<SessionContextReading>>();

export function sessionContextScope(deviceId: string, sessionKey: string): string {
  const owner = need(), tool = sessionAgentId(sessionKey), profile = agentProfile(deviceId, tool);
  return JSON.stringify([remoteDeliveryScope(), connectionGeneration, pairingGeneration, deviceId, sessionKey,
    apiChanges.get(apiMutationKey(owner, deviceId)) ?? 0, contextSourceGenerations.get(`${deviceId}|${tool}`) ?? 0, profile?.api, profile?.execution]);
}

function contextAdmission(deviceId: string, sessionKey: string, compact: boolean) {
  const owner = need(), tool = sessionAgentId(sessionKey), accountId = selectedAgentAccount(deviceId, tool);
  if (!hubCapabilities.has('session.context.v1')) throw new HubError('本站暂不支持上下文操作', 200, 'context_unavailable');
  const validate = () => {
    if (owner !== hub || owner.deviceId && owner.deviceId !== deviceId) throw new Error('上下文连接已改变');
    const session = state.timelines[timelineKey(deviceId, sessionKey)]?.session;
    if (isReadOnlyDesktopSession(sessionKey) || session?.controlSurface === 'desktop' || session?.controlSurface === 'read-only') throw new Error('当前控制方式不支持上下文操作');
    requireAgentCapability(deviceId, tool, compact ? 'compact' : 'context');
    requireSessionExecution(deviceId, sessionKey);
    requireClaudeApiAdmission(deviceId, tool, accountId);
  };
  validate();
  return { owner, tool, accountId, validate, scope: sessionContextScope(deviceId, sessionKey) };
}

export async function readSessionContext(deviceId: string, sessionKey: string, signal?: AbortSignal): Promise<SessionContextReading> {
  const admission = contextAdmission(deviceId, sessionKey, false);
  const lock = beginApiRead(admission.owner, deviceId, 'API 正在切换');
  try {
    const raw = await command<unknown>(admission.owner, deviceId, { type: 'session.context', sessionKey, tool: admission.tool,
      accountId: admission.accountId, controlSurface: 'cli' }, undefined, signal);
    admission.validate();
    if (signal?.aborted || admission.scope !== sessionContextScope(deviceId, sessionKey)) throw new Error('上下文来源已改变');
    const value = parseSessionContext(raw, sessionKey);
    if (!value) throw new Error('电脑返回的上下文状态无效');
    return { value, scope: admission.scope };
  } finally { endApiRead(lock); }
}

export function compactSessionContext(deviceId: string, sessionKey: string, reading: SessionContextReading): Promise<SessionContextReading> {
  const admission = contextAdmission(deviceId, sessionKey, true);
  if (reading.scope !== admission.scope || reading.value.sessionKey !== sessionKey || !reading.value.revision
    || !reading.value.canCompact || contextCompactionBusy(reading.value)) throw new Error('当前上下文不能压缩');
  const existing = contextCompactFlights.get(admission.scope);
  if (existing) return existing;
  const lock = beginApiRead(admission.owner, deviceId, 'API 正在切换');
  const operationId = randomUUID();
  const flight = (async () => {
    try {
      const raw = await command<unknown>(admission.owner, deviceId, { type: 'session.compact', sessionKey, tool: admission.tool,
        accountId: admission.accountId, controlSurface: 'cli', expectedRevision: reading.value.revision, operationId }, operationId);
      admission.validate();
      if (admission.scope !== sessionContextScope(deviceId, sessionKey)) throw new Error('上下文来源已改变');
      const value = parseSessionContext(raw, sessionKey);
      if (!value || value.compaction?.operationId !== operationId) throw new Error('压缩结果未确认');
      return { value, scope: admission.scope };
    } finally { endApiRead(lock); }
  })();
  contextCompactFlights.set(admission.scope, flight);
  void flight.finally(() => { if (contextCompactFlights.get(admission.scope) === flight) contextCompactFlights.delete(admission.scope); }).catch(() => undefined);
  return flight;
}

export function hubSupportsContext(): boolean { return hubCapabilities.has('session.context.v1'); }
export function hubSupportsDiffAnnotations(): boolean { return hubCapabilities.has('context.references.diff.v1'); }

const workflowFlights = new Map<string, { intent: string; flight: Promise<SessionWorkflowResult> }>();
const sideQuestionFlights = new Map<string, { intent: string; flight: Promise<SideQuestionResult> }>();
const sideQuestionHeads = new Map<string, string>();
const sideQuestionUnconfirmed = new Set<string>();
export const sessionSideQuestionScope = sessionContextScope;
export function sessionSideQuestionHistoryOwner(deviceId: string, sessionKey: string): string {
  return JSON.stringify([remoteDeliveryScope(), deviceId, sessionKey, sessionAgentId(sessionKey)]);
}
export function restoreSessionSideQuestionStorageScope(deviceId: string, sessionKey: string): Promise<string | undefined> {
  return restoreSideQuestionHistoryScope(sessionSideQuestionHistoryOwner(deviceId, sessionKey));
}
/** Durable identity excludes runtime generations; restored history is never an authorization. */
export function sessionSideQuestionStorageScope(deviceId: string, sessionKey: string): string {
  const tool = sessionAgentId(sessionKey), profile = agentProfile(deviceId, tool);
  if (!profile) return '';
  return JSON.stringify([remoteDeliveryScope(), deviceId, sessionKey, profile?.id ?? tool, profile?.execution,
    profile?.api.source, profile?.api.accountId ?? profile?.api.name ?? '']);
}
export async function loadSessionSideQuestionHistoryScopes(deviceId: string, sessionKey: string, savedScope?: string): Promise<string[]> {
  const scope = savedScope ?? sessionSideQuestionStorageScope(deviceId, sessionKey), owner = remoteDeliveryScope();
  const connection = state.connections.find(item => item.id === state.connectionId && item.deviceId === deviceId);
  if (!scope || !connection?.computerId) return [];
  let parts: unknown; try { parts = JSON.parse(scope); } catch { return []; }
  if (!Array.isArray(parts) || parts.length !== 7 || parts[0] !== owner || parts[1] !== deviceId || parts[2] !== sessionKey) return [];
  const credential = owner.slice(`${connection.id}|credential:`.length);
  if (!owner.startsWith(`${connection.id}|credential:`) || !/^[a-f0-9]{64}$/.test(credential)) return [];
  // Register existing installations before a future revoke removes the live
  // connection index. This directory grants local viewing only.
  await rememberSideQuestionPairing(connection.id, connection.computerId, undefined, credential);
  const previous = await sideQuestionHistoryScopes(scope, connection.id, connection.computerId);
  if (owner !== remoteDeliveryScope() || connection.id !== state.connectionId
    || !state.connections.some(item => item.id === connection.id && item.computerId === connection.computerId)) throw new Error('侧问历史来源已改变');
  return previous;
}
export function hubSupportsSideQuestions(): boolean { return hubSupportsIdempotency() && hubCapabilities.has('session.side-question.persistent.v1'); }
export function hubSupportsTemporarySideChat(): boolean { return hubSupportsIdempotency() && hubCapabilities.has('session.side-question.v1'); }
export function hubSupportsTemporarySideChatTools():boolean{return hubSupportsTemporarySideChat()&&hubCapabilities.has('session.side-question.tools.v1');}
function sideQuestionAdmission(deviceId: string, sessionKey: string, temporary = false) {
  const owner = need(), tool = sessionAgentId(sessionKey), accountId = selectedAgentAccount(deviceId, tool);
  if (!(temporary ? hubSupportsTemporarySideChat() : hubSupportsSideQuestions())) throw new Error('本站暂不支持这种侧边提问');
  const validate = () => {
    if (owner !== hub || owner.deviceId && owner.deviceId !== deviceId) throw new Error('会话连接已改变');
    const session = state.timelines[timelineKey(deviceId, sessionKey)]?.session ?? state.sessions[deviceId]?.list.find(item => item.sessionKey === sessionKey);
    if (isReadOnlyDesktopSession(sessionKey) || session?.controlSurface === 'desktop' || session?.controlSurface === 'read-only') throw new Error('当前控制方式不支持侧边提问');
    requireAgentCapability(deviceId, tool, 'sideQuestion'); requireSessionExecution(deviceId, sessionKey); requireClaudeApiAdmission(deviceId, tool, accountId);
  };
  validate(); return { owner, tool, accountId, validate, scope: sessionSideQuestionScope(deviceId, sessionKey) };
}
export async function readTemporarySideChat(deviceId: string, sessionKey: string, signal: AbortSignal): Promise<SideQuestionReading> {
  const admission = sideQuestionAdmission(deviceId, sessionKey, true), lock = beginApiRead(admission.owner, deviceId, 'API 正在切换');
  const guard = () => { admission.validate(); if (signal.aborted || admission.scope !== sessionSideQuestionScope(deviceId, sessionKey)) throw new Error('临时聊天来源已改变'); };
  try {
    await command<unknown>(admission.owner, deviceId, { type: 'session.open', sessionKey, limit: 400 }, undefined, signal); guard();
    const raw = await command<unknown>(admission.owner, deviceId, { type: 'session.side-question.catalog', sessionKey, tool: admission.tool, accountId: admission.accountId, controlSurface: 'cli' }, undefined, signal); guard();
    const value = parseSideQuestionCatalog(raw, sessionKey); if (!value) throw new Error('电脑返回的临时聊天能力无效');
    if(!hubSupportsTemporarySideChatTools()&&value.inputOptions)delete value.inputOptions.tools;
    return { scope: admission.scope, value };
  } finally { endApiRead(lock); }
}
export async function askTemporarySideChat(deviceId: string, sessionKey: string, reading: SideQuestionReading, input: TemporarySideQuestionInput, operationId: string): Promise<SideQuestionResult> {
  let admission: ReturnType<typeof sideQuestionAdmission>, lock: ReturnType<typeof beginApiRead>;
  try {
    admission = sideQuestionAdmission(deviceId, sessionKey, true);
    if (reading.scope !== admission.scope || reading.value.sessionKey !== sessionKey || !reading.value.available || !validTemporarySideQuestionInput(reading, input)) throw new Error('临时聊天来源或输入已变化，请新建侧聊');
    lock = beginApiRead(admission.owner, deviceId, 'API 正在切换');
  } catch (reason) { throw new SideQuestionNotDispatchedError(reason instanceof Error ? reason.message : '临时问题尚未发送'); }
  try {
    const raw = await command<unknown>(admission.owner, deviceId, { type: 'session.side-question.ask', sessionKey, tool: admission.tool, accountId: admission.accountId, controlSurface: 'cli', expectedRevision: reading.value.revision, operationId, ...input }, operationId);
    admission.validate(); if (admission.scope !== sessionSideQuestionScope(deviceId, sessionKey)) throw new Error('临时聊天来源已变化，回答未确认');
    const value = parseSideQuestionResult(raw, reading, operationId); if (!value) throw new Error('临时聊天回答未确认'); return value;
  } finally { endApiRead(lock); }
}
export async function uploadTemporarySideChatImages(deviceId: string, sessionKey: string, scope: string, images: RemoteImage[]): Promise<string[]> {
  const admission = sideQuestionAdmission(deviceId, sessionKey, true), lock = beginApiRead(admission.owner, deviceId, 'API 正在切换');
  try {
    if (scope !== admission.scope) throw new Error('临时聊天来源已变化');
    const ids = await uploadImages(deviceId, images, admission.owner, { agent: admission.tool, accountId: admission.accountId });
    admission.validate(); if (scope !== sessionSideQuestionScope(deviceId, sessionKey)) throw new Error('临时聊天来源已变化'); return ids;
  } finally { endApiRead(lock); }
}
export async function runTemporarySideChatTool(deviceId:string,sessionKey:string,reading:SideQuestionReading,request:SideToolRequest):Promise<SideToolState>{
  let admission:ReturnType<typeof sideQuestionAdmission>,lock:ReturnType<typeof beginApiRead>;
  try{
    admission=sideQuestionAdmission(deviceId,sessionKey,true);
    if(!hubSupportsTemporarySideChatTools()||admission.tool!=='codex'||reading.scope!==admission.scope||reading.value.sessionKey!==sessionKey||!reading.value.inputOptions?.tools||request.expectedRevision!==reading.value.revision)throw new Error('当前来源未开放工具型临时聊天');
    lock=beginApiRead(admission.owner,deviceId,'API 正在切换');
  }catch(reason){throw new SideQuestionNotDispatchedError(reason instanceof Error?reason.message:'临时执行尚未发送');}
  try{
    const raw=await command<unknown>(admission.owner,deviceId,{type:'session.side-question.tools',tool:admission.tool,sessionKey,controlSurface:'cli',accountId:admission.accountId,...request},request.operationId);
    admission.validate();if(admission.scope!==sessionSideQuestionScope(deviceId,sessionKey))throw new Error('临时执行来源已变化');
    const value=parseSideToolState(raw,sessionKey,request);if(!value)throw new Error('临时执行结果未确认，请核对状态');return value;
  }finally{endApiRead(lock);}
}
export async function readSessionSideQuestion(deviceId: string, sessionKey: string, chainId: string, signal?: AbortSignal, options: { create?: boolean; cursor?: string } = {}): Promise<SideQuestionReading> {
  const admission = sideQuestionAdmission(deviceId, sessionKey), lock = beginApiRead(admission.owner, deviceId, 'API 正在切换');
  const key = `${admission.scope}|${chainId}`, previousHead = sideQuestionHeads.get(key);
  try {
    if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(chainId) || options.cursor !== undefined && !/^\d{1,20}$/.test(options.cursor)) throw new Error('侧问身份无效');
    // Only a new chain captures a parent snapshot. Reading a saved chain does
    // not run the model or replace its original context.
    if (options.create) await command<unknown>(admission.owner, deviceId, { type: 'session.open', sessionKey, limit: 400 }, undefined, signal);
    admission.validate(); if (signal?.aborted || admission.scope !== sessionSideQuestionScope(deviceId, sessionKey)) throw new Error('会话来源已改变');
    const raw = await command<unknown>(admission.owner, deviceId, { type: options.create ? 'session.side-question.open' : 'session.side-question.read', chainId,
      sessionKey, tool: admission.tool, accountId: admission.accountId, controlSurface: 'cli', ...(options.cursor ? { cursor: options.cursor } : {}) }, options.create ? chainId : undefined, signal);
    admission.validate(); if (signal?.aborted || admission.scope !== sessionSideQuestionScope(deviceId, sessionKey)) throw new Error('会话来源已改变');
    const value = parseSideQuestionConversation(raw, sessionKey, chainId); if (!value) throw new Error('侧问记录无效');
    if (sideQuestionHeads.get(key) !== previousHead && sideQuestionHeads.get(key) !== value.lastOperationId) throw new Error('侧问刚收到新回答，请刷新结果');
    if (!options.cursor) {
      if (value.lastOperationId) sideQuestionHeads.set(key, value.lastOperationId); else sideQuestionHeads.delete(key);
      if (value.turns.some(turn => turn.state !== 'completed')) sideQuestionUnconfirmed.add(key); else sideQuestionUnconfirmed.delete(key);
    }
    await rememberSideQuestionHistoryScope(sessionSideQuestionHistoryOwner(deviceId, sessionKey), sessionSideQuestionStorageScope(deviceId, sessionKey));
    admission.validate(); if (admission.scope !== sessionSideQuestionScope(deviceId, sessionKey)) throw new Error('会话来源已改变');
    return { value, conversation: value, scope: admission.scope };
  } finally { endApiRead(lock); }
}
export function askSessionSideQuestion(deviceId: string, sessionKey: string, reading: SideQuestionReading, input: SideQuestionInput, operationId: string): Promise<SideQuestionResult> {
  try { return beginSessionSideQuestion(deviceId, sessionKey, reading, input, operationId); }
  catch (reason) { throw new SideQuestionNotDispatchedError(reason instanceof Error ? reason.message : '这次侧问尚未发送'); }
}
function beginSessionSideQuestion(deviceId: string, sessionKey: string, reading: SideQuestionReading, input: SideQuestionInput, operationId: string): Promise<SideQuestionResult> {
  const admission = sideQuestionAdmission(deviceId, sessionKey), chainId = reading.conversation?.chainId, key = `${admission.scope}|${chainId}`;
  if (!chainId || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(operationId)
    || reading.scope !== admission.scope || reading.value.sessionKey !== sessionKey || !reading.value.available || !reading.value.revision || !validSideQuestionInput(sessionKey, input)) throw new Error('当前会话不能侧边提问');
  if (sideQuestionUnconfirmed.has(key)) throw new Error('上次侧边提问结果未确认');
  if (input.previousOperationId !== sideQuestionHeads.get(key)) throw new Error('侧边对话已改变');
  const frozen: SideQuestionInput = { question: input.question, ...(input.selection ? { selection: { ...input.selection } } : {}), ...(input.previousOperationId ? { previousOperationId: input.previousOperationId } : {}) };
  const intent = JSON.stringify([operationId, frozen]), existing = sideQuestionFlights.get(key);
  if (existing) { if (existing.intent !== intent) throw new Error('侧边提问仍在进行'); return existing.flight; }
  const lock = beginApiRead(admission.owner, deviceId, 'API 正在切换');
  const flight = (async () => {
    try {
      const raw = await command<unknown>(admission.owner, deviceId, { type: 'session.side-question.send', chainId, sessionKey, tool: admission.tool, accountId: admission.accountId,
        controlSurface: 'cli', expectedRevision: reading.value.revision, operationId, ...frozen }, operationId);
      admission.validate(); if (admission.scope !== sessionSideQuestionScope(deviceId, sessionKey)) throw new Error('会话来源已改变，侧边结果未确认');
      const conversation = parseSideQuestionConversation(raw, sessionKey, chainId), turn = conversation?.turns.find(item => item.operationId === operationId);
      if (!conversation || !turn || turn.question !== frozen.question || !sameSideQuestionSelection(turn.selection, frozen.selection)) throw new Error('侧边提问结果未确认');
      const result: SideQuestionResult = { sessionKey, operationId, state: turn.state === 'completed' ? 'completed' : 'unconfirmed', answer: turn.answer,
        contextScope: conversation.contextScope, contextMessages: conversation.contextMessages, contextTruncated: conversation.contextTruncated, createdAt: turn.createdAt, conversation, ...(turn.error ? { error: turn.error } : {}) };
      if (result.state === 'unconfirmed') sideQuestionUnconfirmed.add(key); else { sideQuestionUnconfirmed.delete(key); sideQuestionHeads.set(key, operationId); }
      return result; // This result is never folded into the parent timeline.
    } catch (error) {
      if (!(error instanceof HubError) || error.status === 0 || error.status >= 500 || error.status === 408 || ['command_delivery_uncertain', 'command_timeout', 'side_question_unconfirmed'].includes(error.code ?? '')) sideQuestionUnconfirmed.add(key);
      throw error;
    } finally {
      endApiRead(lock);
      if (sideQuestionHeads.size > 256) sideQuestionHeads.delete(sideQuestionHeads.keys().next().value!);
      if (sideQuestionUnconfirmed.size > 256) sideQuestionUnconfirmed.delete(sideQuestionUnconfirmed.keys().next().value!);
    }
  })();
  sideQuestionFlights.set(key, { intent, flight });
  void flight.finally(() => { if (sideQuestionFlights.get(key)?.flight === flight) sideQuestionFlights.delete(key); }).catch(() => undefined);
  return flight;
}

export async function deleteSessionSideQuestion(deviceId: string, sessionKey: string, chainId: string, operationId: string): Promise<void> {
  const admission = sideQuestionAdmission(deviceId, sessionKey), lock = beginApiRead(admission.owner, deviceId, 'API 正在切换');
  try {
    const raw = await command<unknown>(admission.owner, deviceId, { type: 'session.side-question.delete', sessionKey, chainId, operationId,
      tool: admission.tool, accountId: admission.accountId, controlSurface: 'cli' }, operationId);
    admission.validate(); if (admission.scope !== sessionSideQuestionScope(deviceId, sessionKey)) throw new Error('来源已改变，请回原来源确认删除结果');
    if (parseSideQuestionConversation(raw, sessionKey, chainId)?.deleted !== true) throw new Error('删除结果未确认，请刷新记录');
  } finally { endApiRead(lock); }
}

const workflowUnconfirmed = new Map<string, string>();
export function hubSupportsSessionWorkflows(): boolean { return hubSupportsIdempotency() && hubCapabilities.has('session.workflows.v1'); }
export const sessionWorkflowScope = sessionContextScope;
function workflowAdmission(deviceId: string, sessionKey: string) {
  const owner = need(), tool = sessionAgentId(sessionKey), accountId = selectedAgentAccount(deviceId, tool);
  if (!hubSupportsSessionWorkflows()) throw new Error('本站暂不支持审查与目标');
  const validate = () => {
    if (owner !== hub || owner.deviceId && owner.deviceId !== deviceId) throw new Error('会话连接已改变');
    const session = state.timelines[timelineKey(deviceId, sessionKey)]?.session ?? state.sessions[deviceId]?.list.find(item => item.sessionKey === sessionKey);
    if (tool !== 'codex' || isReadOnlyDesktopSession(sessionKey) || session?.controlSurface === 'desktop' || session?.controlSurface === 'read-only') throw new Error('当前控制方式不支持审查与目标');
    requireAgentCapability(deviceId, tool, 'sessionWorkflows'); requireSessionExecution(deviceId, sessionKey);
  };
  validate();
  return { owner, tool, accountId, validate, scope: sessionWorkflowScope(deviceId, sessionKey) };
}
export async function readSessionWorkflows(deviceId: string, sessionKey: string, signal?: AbortSignal): Promise<SessionWorkflowsReading> {
  const admission = workflowAdmission(deviceId, sessionKey), lock = beginApiRead(admission.owner, deviceId, 'API 正在切换');
  try {
    const raw = await command<unknown>(admission.owner, deviceId, { type: 'session.workflows', sessionKey, tool: admission.tool,
      accountId: admission.accountId, controlSurface: 'cli' }, undefined, signal);
    admission.validate();
    if (signal?.aborted || admission.scope !== sessionWorkflowScope(deviceId, sessionKey)) throw new Error('会话来源已改变');
    const value = parseSessionWorkflows(raw, sessionKey);
    if (!value) throw new Error('电脑返回的会话任务状态无效');
    if (workflowUnconfirmed.get(admission.scope) === value.revision) {
      value.canReview = false; value.goalActions = []; value.unavailableReason = '上次操作结果未确认';
    }
    return { value, scope: admission.scope };
  } finally { endApiRead(lock); }
}
export function applySessionWorkflow(deviceId: string, sessionKey: string, reading: SessionWorkflowsReading, input: WorkflowInput): Promise<SessionWorkflowResult> {
  const admission = workflowAdmission(deviceId, sessionKey), revision = reading.value.revision;
  if (reading.scope !== admission.scope || reading.value.sessionKey !== sessionKey || !revision || !validWorkflowInput(input)
    || workflowUnconfirmed.get(admission.scope) === revision || (input.kind === 'review' ? !reading.value.canReview : !reading.value.goalActions.includes(input.kind.slice(5) as GoalAction))) throw new Error('当前会话不能执行此操作');
  const intent = JSON.stringify([input, revision]), existing = workflowFlights.get(admission.scope);
  if (existing) {
    if (existing.intent !== intent) throw new Error('会话操作仍在进行');
    return existing.flight;
  }
  const lock = beginApiRead(admission.owner, deviceId, 'API 正在切换'), operationId = randomUUID();
  const flight = (async () => {
    try {
      const raw = await command<unknown>(admission.owner, deviceId, { type: 'session.workflow', sessionKey, tool: admission.tool,
        accountId: admission.accountId, controlSurface: 'cli', expectedRevision: revision, operationId, ...input }, operationId);
      admission.validate();
      if (admission.scope !== sessionWorkflowScope(deviceId, sessionKey)) throw new Error('会话来源已改变，操作结果未确认');
      const result = parseSessionWorkflowResult(raw, sessionKey, input, operationId);
      if (!result) throw new Error('会话任务结果未确认');
      if (result.state === 'unconfirmed') workflowUnconfirmed.set(admission.scope, revision);
      else workflowUnconfirmed.delete(admission.scope);
      // Native turn and goal events drive the actual running state. A goal
      // receipt only confirms metadata; a review receipt may arrive after its
      // terminal event and must not revive a finished turn.
      return result;
    } catch (error) {
      if (!(error instanceof HubError) || error.status === 0 || error.status >= 500 || error.status === 408 || ['command_delivery_uncertain', 'command_timeout', 'session_workflow_unconfirmed'].includes(error.code ?? '')) workflowUnconfirmed.set(admission.scope, revision);
      throw error;
    } finally {
      endApiRead(lock);
      if (workflowUnconfirmed.size > 512) workflowUnconfirmed.delete(workflowUnconfirmed.keys().next().value!);
    }
  })();
  workflowFlights.set(admission.scope, { intent, flight });
  void flight.finally(() => { if (workflowFlights.get(admission.scope)?.flight === flight) workflowFlights.delete(admission.scope); }).catch(() => undefined);
  return flight;
}

const nativeActionFlights = new Map<string, { intent: string; flight: Promise<NativeSessionActionResult> }>();
const nativeActionUnconfirmed = new Map<string, string>();
export function hubSupportsSessionActions(): boolean { return hubSupportsIdempotency() && hubCapabilities.has('session.actions.v1'); }
export const nativeSessionActionScope = sessionContextScope;
function nativeActionAdmission(deviceId: string, sessionKey: string, archived = false) {
  const owner = need(), tool = sessionAgentId(sessionKey), accountId = selectedAgentAccount(deviceId, tool);
  if (!hubSupportsSessionActions()) throw new Error('本站暂不支持会话管理');
  const validate = () => {
    if (owner !== hub || owner.deviceId && owner.deviceId !== deviceId) throw new Error('会话连接已改变');
    const session = state.timelines[timelineKey(deviceId, sessionKey)]?.session
      ?? state.sessions[deviceId]?.list.find(item => item.sessionKey === sessionKey);
    if (isReadOnlyDesktopSession(sessionKey) || session?.controlSurface === 'desktop' || session?.controlSurface === 'read-only') throw new Error('当前控制方式不支持会话管理');
    requireAgentCapability(deviceId, tool, archived ? 'archivedSessions' : 'sessionActions');
    requireSessionExecution(deviceId, sessionKey, true);
    requireClaudeApiAdmission(deviceId, tool, accountId);
  };
  validate();
  return { owner, tool, accountId, validate, scope: nativeSessionActionScope(deviceId, sessionKey) };
}
export async function readNativeSessionActions(deviceId: string, sessionKey: string, signal?: AbortSignal): Promise<NativeSessionActionsReading> {
  const admission = nativeActionAdmission(deviceId, sessionKey), lock = beginApiRead(admission.owner, deviceId, 'API 正在切换');
  try {
    const raw = await command<unknown>(admission.owner, deviceId, { type: 'session.actions', sessionKey, tool: admission.tool,
      accountId: admission.accountId, controlSurface: 'cli' }, undefined, signal);
    admission.validate();
    if (signal?.aborted || admission.scope !== nativeSessionActionScope(deviceId, sessionKey)) throw new Error('会话来源已改变');
    const value = parseNativeSessionActions(raw, sessionKey);
    if (!value) throw new Error('电脑返回的会话管理状态无效');
    if (nativeActionUnconfirmed.get(admission.scope) === value.revision) {
      value.actions = []; value.unavailableReason = '上次操作结果未确认';
    }
    return { value, scope: admission.scope };
  } finally { endApiRead(lock); }
}
export function applyNativeSessionAction(deviceId: string, sessionKey: string, reading: NativeSessionActionsReading, action: SessionAction, name?: string): Promise<NativeSessionActionResult> {
  const admission = nativeActionAdmission(deviceId, sessionKey), revision = reading.value.revision;
  if (reading.scope !== admission.scope || reading.value.sessionKey !== sessionKey || !revision || !reading.value.actions.includes(action)
    || nativeActionUnconfirmed.get(admission.scope) === revision || action === 'rename' && (!name || !validSessionName(name)) || action !== 'rename' && name !== undefined) throw new Error('当前会话不能执行此操作');
  const intent = JSON.stringify([action, name, revision]), existing = nativeActionFlights.get(admission.scope);
  if (existing) {
    if (existing.intent !== intent) throw new Error('会话管理操作仍在进行');
    return existing.flight;
  }
  const lock = beginApiRead(admission.owner, deviceId, 'API 正在切换'), operationId = randomUUID();
  const flight = (async () => {
    try {
      const raw = await command<unknown>(admission.owner, deviceId, { type: 'session.action', sessionKey, tool: admission.tool, action,
        name, accountId: admission.accountId, controlSurface: 'cli', expectedRevision: revision, operationId }, operationId);
      admission.validate();
      if (admission.scope !== nativeSessionActionScope(deviceId, sessionKey)) throw new Error('会话来源已改变，操作结果未确认');
      const result = parseNativeSessionActionResult(raw, sessionKey, action, operationId);
      if (!result) throw new Error('会话操作结果未确认');
      if (result.state === 'unconfirmed') nativeActionUnconfirmed.set(admission.scope, revision);
      else {
        nativeActionUnconfirmed.delete(admission.scope);
        if (result.session) {
          const previous = state.timelines[timelineKey(deviceId, result.session.sessionKey)]?.session;
          handleEvent({ type: 'session.updated', deviceId, sessionKey: result.session.sessionKey,
            tool: admission.tool, ts: Date.now(), session: { ...previous, ...result.session,
              ...(action === 'archive' || action === 'unarchive' ? { activeTurnId: undefined } : {}) } }, false);
        }
        void loadSessions(deviceId, admission.tool).catch(() => undefined);
      }
      return result;
    } catch (error) {
      // Delivery may have reached the native tool. This exact reading cannot
      // create a second fork/mutation after an uncertain response.
      if (!(error instanceof HubError) || error.status === 0 || error.status >= 500 || error.status === 408 || ['command_delivery_uncertain', 'command_timeout', 'session_action_unconfirmed'].includes(error.code ?? '')) {
        nativeActionUnconfirmed.set(admission.scope, revision);
      }
      throw error;
    } finally {
      endApiRead(lock);
      if (nativeActionUnconfirmed.size > 512) nativeActionUnconfirmed.delete(nativeActionUnconfirmed.keys().next().value!);
    }
  })();
  nativeActionFlights.set(admission.scope, { intent, flight });
  void flight.finally(() => { if (nativeActionFlights.get(admission.scope)?.flight === flight) nativeActionFlights.delete(admission.scope); }).catch(() => undefined);
  return flight;
}
export interface ArchivedSessionsPage { sessions: SessionInfo[]; nextCursor: string; scope: string }
export async function readArchivedSessions(deviceId: string, tool: ToolId, previous?: Pick<ArchivedSessionsPage, 'scope' | 'nextCursor'>, signal?: AbortSignal): Promise<ArchivedSessionsPage> {
  const key = `${tool}:__salcara_archived_directory__`, admission = nativeActionAdmission(deviceId, key, true);
  if (previous && (previous.scope !== admission.scope || !previous.nextCursor)) throw new Error('归档读取位置已改变');
  const lock = beginApiRead(admission.owner, deviceId, 'API 正在切换');
  try {
    const raw = await command<{ sessions?: unknown; nextCursor?: unknown }>(admission.owner, deviceId,
      { type: 'sessions.archived', tool, accountId: admission.accountId, controlSurface: 'cli', limit: 50, ...(previous ? { cursor: previous.nextCursor } : {}) }, undefined, signal);
    admission.validate();
    if (signal?.aborted || admission.scope !== nativeSessionActionScope(deviceId, key)) throw new Error('归档来源已改变');
    if (!raw || !Array.isArray(raw.sessions) || raw.sessions.length > 50 || typeof raw.nextCursor !== 'string' || raw.nextCursor.length > 4096) throw new Error('电脑返回的归档目录无效');
    const sessions: SessionInfo[] = [], seen = new Set<string>();
    for (const item of raw.sessions) {
      const session = parseManagedSession(item, tool);
      if (!session || !session.archived || session.controllable || seen.has(session.sessionKey)) throw new Error('归档会话身份不一致');
      seen.add(session.sessionKey); sessions.push(session);
    }
    return { sessions, nextCursor: raw.nextCursor, scope: admission.scope };
  } finally { endApiRead(lock); }
}

export async function listProjects(deviceId: string): Promise<Project[]> {
  const owner = need();
  const result = await command<{ projects?: Project[] }>(owner, deviceId, { type: 'projects.list' });
  if (owner !== hub) throw new Error('连接已切换');
  return result.projects ?? [];
}

/** The selected API's upstream models (cached per computer and agent; refresh re-reads the provider). */
const modelCache = new Map<string, ModelCatalog>();
const modelRequests = new Map<string, number>();
export function cachedModels(deviceId: string, tool: ToolId): ModelCatalog | undefined { return modelCache.get(`${deviceId}|${tool}`); }
export async function listModels(deviceId: string, tool: ToolId, refresh = false, native?: { controlSurface: 'desktop'; sessionKey: string }): Promise<ModelCatalog> {
  const owner = need();
  if (native && tool !== 'codex') throw new HubError('这个 Agent 没有此桌面模型目录', 200, 'desktop_capability_unavailable');
  const live = native ? requireNativeModelOptions(deviceId, native.sessionKey, {}, true) : undefined;
  if (!native) requireModelDirectory(deviceId, tool);
  const lease = native ? nativeLeaseIdentity(deviceId, native.sessionKey) : undefined;
  const cacheKey = native ? `${deviceId}|${tool}|desktop|${native.sessionKey}` : `${deviceId}|${tool}`;
  const revision = (modelRequests.get(cacheKey) ?? 0) + 1;
  modelRequests.set(cacheKey, revision);
  const result = await command<{ models?: string[]; api?: string; modelCapabilities?: unknown; accountId?: string; controlSurface?: string }>(owner, deviceId, { type: 'models.list', tool, ...(refresh ? { refresh: true } : {}),
    ...(native ? { controlSurface: 'desktop' as const, sessionKey: native.sessionKey, agent: 'codex-desktop' as const, accountId: live!.accountId }
      : selectedAgentAccount(deviceId, tool) ? { accountId: selectedAgentAccount(deviceId, tool) } : {}) });
  if (owner !== hub || modelRequests.get(cacheKey) !== revision) throw new Error('API 或连接已切换，请重新读取模型');
  if (native) {
    requireNativeModelOptions(deviceId, native.sessionKey, { accountId: live!.accountId }, true);
    if (nativeLeaseIdentity(deviceId, native.sessionKey) !== lease || result.controlSurface !== 'desktop' || result.accountId !== live!.accountId) throw new Error('桌面连接或模型来源已改变，请重新读取模型');
  } else requireModelDirectory(deviceId, tool);
  const models = Array.from(new Set(Array.isArray(result.models) ? result.models.filter((item): item is string =>
    typeof item === 'string' && item.length > 0 && item.length <= 200 && item.trim() === item && !/[\r\n\u0000]/.test(item)) : [])).slice(0, 1000);
  const raw = result.modelCapabilities && typeof result.modelCapabilities === 'object' && !Array.isArray(result.modelCapabilities) ? result.modelCapabilities as Record<string, unknown> : {};
  const modelCapabilities = Object.fromEntries(models.map(id => {
    const entry = raw[id] && typeof raw[id] === 'object' ? raw[id] as Record<string, unknown> : {};
    const source: ModelCapability['source'] = entry.source === 'codex-model-list' || entry.source === 'relay-model-list' ? entry.source : 'unknown';
    const known = source === 'codex-model-list' && entry.reasoningKnown === true && Array.isArray(entry.reasoningEfforts);
    const efforts = Array.isArray(entry.reasoningEfforts) ? entry.reasoningEfforts.filter(isEffort) : [];
    const modalities = Array.isArray(entry.inputModalities) ? entry.inputModalities : [];
    const capability: ModelCapability = { source, reasoningKnown: known,
      ...(known ? { reasoningEfforts: CODEX_EFFORTS.filter(value => efforts.includes(value) && (!native || live!.modelOptions!.thinking.includes(value))) } : {}),
      ...(source === 'codex-model-list' && Array.isArray(entry.inputModalities) ? { inputModalities: ['text', 'image'].filter(value => modalities.includes(value)) as Array<'text' | 'image'> } : {}) };
    return [id, capability];
  }));
  const value: ModelCatalog = { models, modelCapabilities, api: typeof result.api === 'string' ? result.api : undefined };
  modelCache.set(cacheKey, value);
  return value;
}

const agentFeatureCache = new AgentFeatureCache();
const featureChangeSeqs = new Map<string, number>();
let featureChangeOwner: Hub | null = null, featureChangeConnection = -1, featureChangePairing = -1;
function ensureFeatureChangeScope(): void {
  if (featureChangeOwner === hub && featureChangeConnection === connectionGeneration && featureChangePairing === pairingGeneration) return;
  featureChangeSeqs.clear();
  featureChangeOwner = hub; featureChangeConnection = connectionGeneration; featureChangePairing = pairingGeneration;
}
/** Read synchronously in callbacks as well as render: a notification can precede a React render. */
export function agentFeaturesGeneration(deviceId: string, tool: ToolId): string {
  ensureFeatureChangeScope();
  return `${connectionGeneration}:${pairingGeneration}:${featureChangeSeqs.get(JSON.stringify([deviceId, tool])) ?? 0}`;
}
function consumeFeatureChanges(owner: Hub, generation: number, pairing: number, deviceId: string, changes: unknown): void {
  if (owner !== hub || generation !== connectionGeneration || pairing !== pairingGeneration || owner.deviceId && owner.deviceId !== deviceId
    || !Array.isArray(changes) || changes.length > 256) return;
  ensureFeatureChangeScope();
  let changed = false;
  for (const raw of changes) {
    const event = parseFeatureChange(raw, deviceId);
    if (!event || !validAgentId(event.tool)) continue;
    const profile = agentProfile(deviceId, event.tool), execution = resolveAgentExecution(profile, event.tool);
    if (!profile || profile.capabilities?.features !== true || !execution || execution.controlSurface !== 'cli' || execution.entrypoint
      || execution.tool !== event.tool) continue;
    const key = JSON.stringify([deviceId, event.tool]);
    if (event.seq <= (featureChangeSeqs.get(key) ?? 0)) continue;
    featureChangeSeqs.set(key, event.seq);
    agentFeatureCache.expire(deviceId, new Set([event.tool]));
    changed = true;
  }
  // No timeline event, notification, session cursor or persisted draft changes.
  if (changed) set({});
}
type AgentFeatureTarget = { cwd?: string; sessionKey?: string };
function agentFeatureScope(deviceId: string, tool: ToolId, target: AgentFeatureTarget): AgentFeatureScope {
  const owner = need(), profile = agentProfile(deviceId, tool), account = selectedAgentAccount(deviceId, tool);
  if (owner.deviceId && owner.deviceId !== deviceId) throw new Error('这台电脑不属于当前配对连接');
  requireAgentCapability(deviceId, tool, 'features');
  requireExecution(deviceId, tool, tool);
  requireClaudeApiAdmission(deviceId, tool, account);
  if (target.sessionKey && sessionAgentId(target.sessionKey) !== tool) throw new Error('Agent 与会话归属不一致');
  const session = target.sessionKey ? state.timelines[timelineKey(deviceId, target.sessionKey)]?.session
    ?? state.sessions[deviceId]?.list.find(item => item.sessionKey === target.sessionKey) : undefined;
  return { pairing: JSON.stringify([owner.url, remoteDeliveryScope(), pairingGeneration, connectionGeneration]), device: deviceId, agent: tool,
    source: JSON.stringify([profile?.id, profile?.tool, profile?.execution, profile?.api, profile?.available, session?.cwd]),
    account: account ?? '', cwd: target.cwd ?? '', session: target.sessionKey ?? '' };
}
/** A detached picker snapshot for immediate display; listAgentFeatures checks its TTL. */
export function cachedAgentFeatures(deviceId: string, tool: ToolId, target: AgentFeatureTarget): AgentFeatures | undefined {
  try { return agentFeatureCache.peek(agentFeatureScope(deviceId, tool, target)); } catch { return undefined; }
}
export async function listAgentFeatures(deviceId: string, tool: ToolId, target: AgentFeatureTarget, options?: { force?: boolean }): Promise<AgentFeatures> {
  const owner = need(), frozenTarget = { ...target }, scope = agentFeatureScope(deviceId, tool, frozenTarget);
  const featureGeneration = agentFeaturesGeneration(deviceId, tool);
  const sourceCurrent = () => {
    try { return owner === hub && JSON.stringify(scope) === JSON.stringify(agentFeatureScope(deviceId, tool, frozenTarget)); }
    catch { return false; }
  };
  const current = () => sourceCurrent() && agentFeaturesGeneration(deviceId, tool) === featureGeneration;
  const readLock = beginApiRead(owner, deviceId, 'API 或中转站正在切换，请稍候');
  try {
    const value = await agentFeatureCache.read(scope, async conditional => {
      const result = await command<unknown>(owner, deviceId,
        { type: 'features.list', tool, ...frozenTarget, controlSurface: 'cli', ...(scope.account ? { accountId: scope.account } : {}), ...conditional });
      if (!current()) throw new Error('API 或连接已切换，请重新读取技能');
      return result;
    }, options?.force);
    if (!current()) {
      // A feature change already retired the old entry. A newer read can now
      // own the same scope; a late cache-hit continuation must not delete it.
      if (!sourceCurrent()) agentFeatureCache.discard(scope);
      throw new Error('API 或连接已切换，请重新读取技能');
    }
    return value;
  } finally { endApiRead(readLock); }
}

/** Test hook. */
export function resetRemoteForTests() { if (recoveryMaintenanceTimer) clearInterval(recoveryMaintenanceTimer); recoveryMaintenanceTimer = undefined; agentFeatureCache.clear(); contextSourceGenerations.clear(); contextCompactFlights.clear(); nativeActionFlights.clear(); nativeActionUnconfirmed.clear(); workflowFlights.clear(); workflowUnconfirmed.clear(); sideQuestionFlights.clear(); sideQuestionHeads.clear(); sideQuestionUnconfirmed.clear(); localPromptSequence = 0; remoteContentRecoveryFlight = null; resetRemoteCacheForTests(); resetAttachmentCacheForTests(); modelCache.clear(); modelRequests.clear(); apiChanges.clear(); apiMutationOwners.clear(); apiMutationDevices.clear(); apiReadDevices.clear(); devicesRevision += 1; pairingGeneration += 1; pairingFlights.clear(); handoverRecoveryFlight = null; stationChangeTail = Promise.resolve(); stopStream(); connectionGeneration += 1; probeGeneration += 1; hub = null; lastSeq = 0; booted = false; screenOpen = false; hubCapabilities.clear(); sessionCursors.clear(); sessionEpochs.clear(); sessionSyncTails.clear(); sessionApprovalSnapshots.clear(); incompleteTurnRepairs.clear(); sessionRequests.clear(); snapshotFlights.clear(); agentRequests.clear(); interruptFlights.clear(); resetDeliveryForTests(); state = initial; }


// Cross-task messages are explicit phone-user submissions. Native peer events
// and source display labels never call this route or authorize its target.
export function hubSupportsCooperation(): boolean { return hubCapabilities.has('session.cooperation.v1'); }
export function cooperationReceiptOwner(deviceId: string): string { return JSON.stringify([remoteDeliveryScope(), deviceId]); }
export function cooperationScope(deviceId: string, source: string): string { return sessionContextScope(deviceId, source); }
function cooperationAdmission(deviceId: string, source: string, target: string) {
  const owner = need(), tool = sessionAgentId(source), accountId = selectedAgentAccount(deviceId, tool);
  const scope = cooperationScope(deviceId, source);
  const validate = () => {
    if (!hubSupportsCooperation() || owner !== hub || owner.deviceId && owner.deviceId !== deviceId || scope !== cooperationScope(deviceId, source)) throw new Error('跨任务连接已变化，请重新选择');
    if (tool !== 'codex' && tool !== 'claude' || sessionAgentId(target) !== tool || source === target) throw new Error('目前只支持同一 Agent 内的两个任务');
    for (const key of [source, target]) {
      const info = state.timelines[timelineKey(deviceId, key)]?.session ?? state.sessions[deviceId]?.list.find(item => item.sessionKey === key);
      if (info && (info.archived || info.parentSessionKey || info.controlSurface === 'desktop' || info.controlSurface === 'read-only' || !info.controllable)) throw new Error('这个任务不能接收跨任务消息');
      requireSessionExecution(deviceId, key);
    }
    requireAgentCapability(deviceId, tool, 'send'); requireClaudeApiAdmission(deviceId, tool, accountId);
  };
  validate(); return { owner, tool, accountId, scope, validate };
}
export async function prepareCooperation(deviceId: string, source: string, target: string, signal?: AbortSignal): Promise<CooperationReading> {
  const admission = cooperationAdmission(deviceId, source, target), lock = beginApiRead(admission.owner, deviceId, 'API 正在切换');
  try {
    const raw = await command<unknown>(admission.owner, deviceId, { type: 'session.cooperation.prepare', tool: admission.tool, sessionKey: target,
      sourceSessionKey: source, accountId: admission.accountId, controlSurface: 'cli' }, undefined, signal);
    admission.validate();
    if (signal?.aborted) throw new Error('读取已取消');
    const result = parseCooperationReading(raw, source, target, admission.scope);
    if (!result) throw new Error('电脑未能确认来源与目标任务');
    return result;
  } finally { endApiRead(lock); }
}
const cooperationFlights = new Set<string>();
export async function sendCooperation(deviceId: string, reading: CooperationReading, text: string): Promise<CooperationReceipt> {
  const source = reading.source.sessionKey, target = reading.target.sessionKey, admission = cooperationAdmission(deviceId, source, target);
  if (reading.scope !== admission.scope || reading.expiresAt <= Date.now() || !cooperationCandidate(reading.target, source) || !text.trim() || text.length > 16000) throw new Error('内容或任务票据已失效，请重新选择');
  if (cooperationFlights.has(admission.scope)) throw new Error('跨任务消息正在发送');
  const lock = beginApiRead(admission.owner, deviceId, 'API 正在切换'), receiptOwner = cooperationReceiptOwner(deviceId);
  cooperationFlights.add(admission.scope);
  const receipt: CooperationReceipt = { operationId: randomUUID(), sourceSessionKey: source, targetSessionKey: target,
    targetTitle: Array.from(reading.target.title).slice(0, 160).join(''), text: text.trim(), createdAt: Date.now(), state: 'unconfirmed' };
  let persisted = false, dispatched = false;
  try {
    if ((await readCooperationReceipts(receiptOwner, source)).some(item => item.state === 'unconfirmed')) throw new Error('还有一条跨任务消息待核对，请先打开目标任务');
    admission.validate();
    await saveCooperationReceipt(receiptOwner, receipt); persisted = true;
    admission.validate(); dispatched = true;
    const result = await command<{ via?: string; receiptId?: string }>(admission.owner, deviceId, { type: 'session.send', sessionKey: target,
      sourceSessionKey: source, cooperationTicket: reading.ticket, operationId: receipt.operationId, text: receipt.text,
      accountId: admission.accountId, controlSurface: 'cli' }, receipt.operationId);
    admission.validate();
    if (result.via !== 'background' || result.receiptId !== receipt.operationId) throw new Error('发送结果未确认，请打开目标任务核对');
    receipt.state = 'sent'; await saveCooperationReceipt(receiptOwner, receipt);
    void openSession(deviceId, target).catch(() => undefined);
    return receipt;
  } catch (error) {
    if (persisted && !dispatched) { receipt.state = 'not_sent'; await saveCooperationReceipt(receiptOwner, receipt).catch(() => undefined); }
    throw error;
  } finally { endApiRead(lock); cooperationFlights.delete(admission.scope); }
}
