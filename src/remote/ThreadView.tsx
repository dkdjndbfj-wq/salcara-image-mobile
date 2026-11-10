import {ConversationDropZone,type ConversationFilesHandle} from './ConversationDropZone';
import {useSentEditBackup,type EditBackupBody} from './SentEditBackup';
import {mergeSentEditRecovery,type SentEditRestorer} from './sent-edit-recovery';
import {useConversationSyncNotice} from './useConversationSyncNotice';
import {latestRevisableMessage,type SentMessageRevisionHandler} from './sent-message-revision';
import {latestEditableTurn} from './session-revert';
import {getRemoteState,hubSupportsLatestTurnRevert,revertLatestSessionTurn} from './store';
import {appendComposerFiles,type ComposerFilesAppender} from './composer-files';
import {promptHistory,promptHistoryIdentity,type PromptHistoryEntry} from './prompt-history';
import {recoverHistoryInput,requireHistoryCapabilities} from './history-input';
import type {PromptHistoryHandle} from './PromptHistorySheet';
import type {ExecutionRecoveryAction} from './execution-recovery';
import {ArtifactAnnotationProvider} from './ArtifactAnnotationContext';
import { TaskProgressDock } from './TaskProgressDock';
import { LimitRetryNotice } from './LimitRetryNotice';
import { MissingSessionDraftRecovery } from './MissingSessionDraftRecovery';
import { QueuedMessages } from './QueuedMessages';
import { copyMissingComposerDraft, undoMissingComposerDraft, type ComposerDraftRecoveryReceipt } from './composer-drafts';
import { sameComposerDraftOrigin, validComposerDraftOrigin, type ComposerDraftOrigin } from './composer-draft-origin';
import {useConversationOutputs} from './ConversationOutputLibrary';
import {useModelChangeNotices} from './ModelChangeNotice';
import {withModelChanges} from './model-change-notices';
import {ToolbarButton,ToolbarMenu} from './WorkbenchToolbar';
import {useConversationPosition} from './useConversationPosition';
import {conversationReadScope} from './conversation-unread';
import {useConversationResultReader} from './ConversationUnread';
import {WORKBENCH_SPACING,WorkbenchPresentationProvider} from './workbench-presentation';
import { dismissKeyboardOnBack, useChildBackAction } from './useBackAction';
import {appendImageAnnotation} from './image-annotation-draft';
import {validConversationArtifact,type ConversationArtifactTarget} from './conversation-artifact-target';
import React, { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { randomUUID } from 'expo-crypto';
import { ActivityIndicator, AppState, FlatList, Image, Keyboard, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';

import { Icon, type IconName } from '../components/Icon';
import { MessageContent } from '../components/MessageContent';
import { Appear, AppDialog, IconButton, MotionPressable, Sheet, showToast, useReducedMotion } from '../components/ui';
import { colors, prettyModel, radius, shadow, desk, themed, useDesk } from '../theme';
import { buildBlocks, conversationBlocks, fileEdits, planSteps, subagentStatus, type Block, type ConversationBlock, type FileEdit } from './blocks';
import { HubError, type AgentProfile, type ApprovalMode, type AttachmentRef, type Decision, type Effort, type MessageOrigin, type ModelCatalog, type PermissionMode, type QuestionAnswers, type ToolId, type ToolKind, type WorkspaceMode } from './client';
import type { Space } from '../state/AppContext';
import { apiProblem, modelCapabilityProblem, modelCatalogProblem, type ApiProblem } from './api-errors';
import { QuestionDock } from './QuestionDock';
import { ApprovalQueueBar } from './ApprovalQueueBar';
import { approvalDecisions } from './approvals';
import type { QuestionDraft } from './QuestionCard';
import { deliverQuestionAnswer, QuestionDeliveryCancelled } from './question-delivery';
import { blockQuestionReceipt, finishQuestionReceipt, markQuestionAttempt, pendingQuestionReceipts, prepareQuestionReceipt, reconcileQuestionReceipts, type QuestionReceipt } from './question-outbox';
import { MAX_REMOTE_IMAGES, pickRemoteImages, type RemoteImage } from './attachments';
import { handleSystemPermissionError } from '../system-permissions';
import { DeliveryPendingError, type DeliveryDraftOwner } from './delivery';
import { deliveryRetryState } from './offline-policy';
import { effortLabel, reportedEfforts, reportsTextOnly } from './effort';
import { isApprovalMode, isPermissionMode, PERMISSION_LABEL, PERMISSION_MODES } from './permission-mode';
import { loadRemoteDraft, loadRemoteQueuedDraft, loadRemoteQueuedDrafts, MAX_REMOTE_QUEUE, readRemoteRetryImages, saveRemoteDraft, saveRemoteQueuedDraft, saveRemoteQueuedDrafts, mutateRemoteQueue, remoteQueueEditable, remoteQueueRevision, type RemoteQueueMutation, type LoadedQueuedRemoteDraft, type QueuedImageDraft } from './drafts';
import { createComposerDraftSession, hydrateComposerImages, type ComposerDraftInput, type ComposerDraftSession } from './composer-drafts';
import { copyComposerFeatureIntent, sameComposerFeatureSource, type ComposerFeatureIntent, type ComposerFeatureSource } from './composer-feature-intent';
import { ModelPopover } from './ModelPopover';
import { CompactActionMenu } from './CompactActionMenu';
import { EffortScrubOverlay, type ScrubEvent } from './EffortScrub';
import { noteTaskSent, requestNotificationPermission, setVisibleThread } from './notifications';
import { modelDisplayLabel } from './model-presentation';
import { captureModelBackdrop } from './model-backdrop';
import { PlanPreview } from './PlanCard';
import { AttachmentComposerInput } from './AttachmentComposerInput';
import { DraftImageStrip } from './DraftImageStrip';
import { appendContextReference, contextReferenceKey, copyContextReferences, hasDiffAnnotations, hasResponseAnnotations, isContextAnnotation, parseContextQuery, validContextReferences, type ContextReference } from './context-references';
import { hubSupportsDiffAnnotations, hubSupportsCooperation, resetIncompleteTurnRecovery } from './store';
import { undoWorkspaceChanges } from './workspace-change-undo';
import { diffReviewProblem } from './diff-review';
import type { BrowserNavigation } from './browser-navigation';
import { messageSourceRevision, selectedMessageReference, type SelectedMessageText } from './message-selection';
import { childAgentTitle, messageOrigin } from './conversation-metadata';
import { ContextReferencePicker, type ContextReferencePickerHandle, type ReferencePreview } from './ContextReferencePicker';
import { ContextReferenceChips } from './ContextReferenceChips';
import { ContextBar, type ContextBarHandle } from './ContextBar';
import { ContextIndicator } from './ContextIndicator';
import { SessionActionsSheet } from './SessionActionsSheet';
import { SessionWorkflowsSheet } from './SessionWorkflowsSheet';
import { CooperationSheet } from './CooperationSheet';
import { SideQuestionHistoryPanel as SideQuestionPanel } from './SideQuestionHistoryPanel';
import { TemporarySideChat } from './TemporarySideChat';
import { lastTurnFiles } from './last-turn-files';
import { askTemporarySideChat, readTemporarySideChat, hubSupportsTemporarySideChat, uploadTemporarySideChatImages,runTemporarySideChatTool } from './store';
import { askSessionSideQuestion, deleteSessionSideQuestion, hubSupportsSideQuestions, readSessionSideQuestion, sessionSideQuestionScope, sessionSideQuestionStorageScope, sessionSideQuestionHistoryOwner, restoreSessionSideQuestionStorageScope, loadSessionSideQuestionHistoryScopes } from './store';
import { hubSupportsSessionActions, hubSupportsSessionWorkflows } from './store';
import { hubSupportsContext, sessionContextScope, snapshotQuestionCommand } from './store';
import { insertSkillMention, reconcileSkillMentions, restoreSkillMentions, stripSkillMentions, type SkillMention } from './skill-mentions';
import { SlashCommandMenu } from './SlashCommandMenu';
import { applySlashCommand, buildSlashCommands, parseSlashQuery, slashCommandDisabled, type SlashCommandEntry } from './slash-commands';
import { composerSlashActions, initializationDraft } from './composer-slash-actions';
import { SessionCommandPopover, type SessionCommand } from './SessionCommandPopover';
import { copyTurnFeatures, skillKey, type AgentFeatures, type CollaborationMode, type SkillReference } from './agent-features';
import { OptionSheet, type Option } from './OptionSheet';
import { ComposerOptionMenu } from './ComposerPopover';
import { loadThreadPrefs, saveThreadPrefs } from './thread-prefs';
import { DiffView, EmptyState, mono, PulseDot, toolName } from './parts';
import { agentSupports, desktopLiveFor, desktopApprovalFor, resolveAgentExecution } from './projection';
import { claudeSessionAdmissionBlocked, turnControlTarget } from './turn-control';
import {
  EMPTY_TIMELINE, cachedModels, cachedAgentFeatures, agentFeaturesGeneration, canOpenOnDesktop, hydrateCachedThread, listAgentFeatures, cancelPendingRemoteMessage, pausePendingRemoteMessage, continueSession, openOnDesktop, getPendingRemoteMessage, hubSupportsWait, hubSupportsSteer, interruptSession, listModels, listProjects, loadEarlierHistory, materializeAttachment, materializeAttachmentThumbnail, attachMaterializedUri, openSession,
  remoteDeliveryScope, respondApproval, sendToSession, startSession, getPendingNewSession, newSessionReceiptKey, retryNewSession, acknowledgeNewSession, syncSessionEvents, timelineKey, setRemoteFocus, useRemote, type TimelineItem,
} from './store';
import { attachmentContentKey } from './attachment-ref';
import { useLiveSync } from './useLiveSync';
import {
  copyUserMessage, DiffScreen, ImageViewer, JumpToLatest, MessageActions, OutputText, quoteFor, RemoteDictation, runningSince, SearchBar, searchBlocks, turnStats,
  type TurnStat, type VoiceSource,
} from './thread-extras';
import { useThreadTitles } from './thread-titles';
import { runningTurnHeading } from './thread-stats';
import { ApprovalCard, BlockRow, NewThreadIntro, ThreadClockLabel, ThreadClockProvider, ThreadUi, type ApprovalItem } from './thread-rows';
import { useThreadStyles } from './thread-styles';
import { MainComposerAction, MainComposerModelButton, MainComposerModelGroup, MainComposerPermission, MainComposerSurface, MainComposerToolbar, MainEffortControl } from './MainComposer';
import { RemoteSidebar } from './RemoteSidebar';
import type { RemoteFileTarget } from './RemoteFiles';
import { RemoteFilePicker } from './RemoteFilePicker';
import { TabletThreadFrame } from './TabletThreadFrame';
import { openRemoteWebsite, resolveRemoteLink } from './remote-links';
import { claudeApiAdmissionReady } from './api-admission';
import { SkeletonGroup, SkeletonThread } from '../components/Skeleton';
import { hasActiveAgentWork } from './work-activity';
const appForeground = () => AppState.currentState == null || AppState.currentState === 'active';
export const REMOTE_STATUS_NOTICE_DELAY_MS = 30_000;
export const REMOTE_RETRY_INDICATOR_DELAY_MS = 8_000;

/** Keep routine transport interruptions quiet until they persist. */
function useDelayedNotice(active: boolean, key: string, dueAt: number, immediate = false, resumeDelay = REMOTE_STATUS_NOTICE_DELAY_MS): boolean {
  const [lifecycle, setLifecycle] = useState(() => ({ foreground: appForeground(), resumedAt: 0, revision: 0 }));
  const [ready, setReady] = useState<{ key: string; value: boolean; revision: number }>();
  useEffect(() => {
    const subscription = AppState.addEventListener('change', next => {
      setLifecycle(previous => next === 'active'
        ? previous.foreground ? previous : { foreground: true, resumedAt: Date.now(), revision: previous.revision + 1 }
        : previous.foreground ? { ...previous, foreground: false } : previous);
    });
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    if (!active || !lifecycle.foreground) { setReady(undefined); return undefined; }
    const notice = { key, revision: lifecycle.revision };
    if (immediate) { setReady({ ...notice, value: true }); return undefined; }
    setReady({ ...notice, value: false });
    // Time spent suspended is not evidence of a failed recovery. Give the
    // foreground read a full grace period before surfacing stale status.
    const deadline = Math.max(dueAt, lifecycle.revision ? lifecycle.resumedAt + resumeDelay : 0);
    const remaining = Math.max(0, deadline - Date.now());
    if (!remaining) { setReady({ ...notice, value: true }); return undefined; }
    const timer = setTimeout(() => setReady({ ...notice, value: true }), remaining);
    return () => clearTimeout(timer);
  }, [active, key, dueAt, immediate, lifecycle, resumeDelay]);
  return active && lifecycle.foreground && appForeground() && (immediate || ready?.key === key && ready.revision === lifecycle.revision && ready.value);
}

function isTransientReadFailure(message: string | undefined): boolean {
  return Boolean(message && /computer[_ ]offline|\b(?:408|429|5\d\d)\b|network|fetch|timed? ?out|timeout|econn(?:reset|refused)|enetwork|connection (?:lost|reset|refused|closed)|电脑.{0,8}(?:离线|断开|连接)|(?:中转站|网络).{0,10}(?:超时|失败|断开)|无法连接|连不上中转站，请检查网络|响应未接收完整，保留原请求等待重试/i.test(message));
}

// Older test hosts and pre-1.8 persisted bundles may provide only the text
// draft module. Keep the queued-image extension optional at this boundary.
const loadQueuedDraftsSafe = async (key: string): Promise<LoadedQueuedRemoteDraft[]> => {
  if (typeof loadRemoteQueuedDrafts === 'function') return loadRemoteQueuedDrafts(key);
  const legacy = typeof loadRemoteQueuedDraft === 'function' ? await loadRemoteQueuedDraft(key) : undefined;
  return legacy ? [{ ...legacy, state: 'blocked' }] : [];
};
const saveQueuedDraftsSafe = async (key: string, drafts: LoadedQueuedRemoteDraft[]): Promise<LoadedQueuedRemoteDraft[]> => {
  if (typeof saveRemoteQueuedDrafts === 'function') return await saveRemoteQueuedDrafts(key, drafts) ?? drafts;
  if (typeof saveRemoteQueuedDraft === 'function' && drafts.length <= 1) await saveRemoteQueuedDraft(key, drafts[0] ?? null);
  return drafts;
};
const sameQueuedDraft = (left: LoadedQueuedRemoteDraft | undefined, right: LoadedQueuedRemoteDraft): boolean => {
  if (!left) return false;
  if (left.id || right.id) return left.id === right.id && left.scope === right.scope;
  // Legacy rows have no ID. Compare their complete content, ignoring only
  // transient state and hydrated image bytes, before taking one back.
  const content = ({ state: _state, afterTurn: _afterTurn, images, ...draft }: LoadedQueuedRemoteDraft) =>
    JSON.stringify({ ...draft, images: images.map(({ base64: _bytes, ...image }) => image) });
  return content(left) === content(right);
};
const hydrateQueuedImages = async (draft: LoadedQueuedRemoteDraft): Promise<RemoteImage[]> => {
  if (draft.missingImages || (draft.imageCount ?? draft.images.length) !== draft.images.length) throw new Error('请重新选择全部原图片，不会只发送文字');
  if (!draft.images.length || draft.images.every(image => image.base64)) return draft.images;
  if (typeof readRemoteRetryImages !== 'function') throw new Error('原消息的图片无法恢复，请重新选择全部原图片');
  const hydrated = await readRemoteRetryImages(draft.images.map(({ uri, mime, width, height }) => ({ uri, mime, width, height })));
  if (hydrated.length !== draft.images.length || hydrated.some((image, index) => !image.base64 || image.uri !== draft.images[index].uri
    || image.mime !== draft.images[index].mime || image.width !== draft.images[index].width || image.height !== draft.images[index].height)) {
    throw new Error('原消息的图片无法完整恢复，请重新选择全部原图片');
  }
  return hydrated;
};
let queueSequence = 0;
const sameComposerSnapshot = (left: ComposerDraftInput, right: ComposerDraftInput) => left.text.trim() === right.text.trim()
  && JSON.stringify(left.featureIntent) === JSON.stringify(right.featureIntent)
  && (left.imageCount ?? left.images.length) === (right.imageCount ?? right.images.length)
  && Boolean(left.missingImages) === Boolean(right.missingImages) && left.images.length === right.images.length
  && left.images.every((image, index) => { const other = right.images[index]; return image.uri === other.uri && image.mime === other.mime
    && image.width === other.width && image.height === other.height && image.base64 === other.base64; });
const copyComposerSnapshot = (snapshot: ComposerDraftInput): ComposerDraftInput => ({ ...snapshot,
  ...(snapshot.featureIntent ? { featureIntent: copyComposerFeatureIntent(snapshot.featureIntent, snapshot.text) } : {}), images: snapshot.images.map(image => ({ ...image })) });
const receiptComposerOwner = (receipt: unknown): { key: string; revision: number; identity?: string } | undefined => {
  if (!receipt || typeof receipt !== 'object' || !('composerDraft' in receipt)) return undefined;
  const owner = receipt.composerDraft;
  if (!owner || typeof owner !== 'object' || !('key' in owner) || !('revision' in owner)
    || typeof owner.key !== 'string' || !Number.isSafeInteger(owner.revision) || Number(owner.revision) < 1) return undefined;
  return { key: owner.key, revision: Number(owner.revision), ...('identity' in owner && typeof owner.identity === 'string' ? { identity: owner.identity } : {}) };
};

const MODES: Array<Option<ApprovalMode>> = [
  { value: 'ask', label: '每一步都问我', detail: '运行命令和改文件前，在手机上点允许' },
  { value: 'auto_edits', label: '自动改文件', detail: '项目内的文件直接改，运行命令前问你' },
  { value: 'auto_all', label: '全部自动', detail: '跳过常规批准；问题仍需回答。仅用于信任的隔离环境', danger: true },
];
const MODE_LABEL: Record<ApprovalMode, string> = { ask: '每步询问', auto_edits: '自动改文件', auto_all: '全部自动' };

/**
 * One Codex / Claude Code thread on the computer, laid out like the Codex app:
 * messages in a single column, the agent's work folded in between, the composer
 * pinned at the bottom. With sessionKey null it is a new thread in a project.
 */
/** Context carried from a read-only Claude Desktop chat into a new Claude Code task. */
export interface ContinueSeed { title: string; transcript: string; cwd?: string }

/** Plain-text transcript of the visible conversation, newest kept, for continuing elsewhere. */
export function continueTranscript(items: readonly TimelineItem[], limit = 12_000): string {
  const lines: string[] = [];
  let size = 0;
  for (const item of [...items].reverse()) {
    if (item.kind !== 'message' || !item.text.trim()) continue;
    const line = `${item.role === 'user' ? '我' : 'Claude'}：${item.text.trim()}`;
    if (size + line.length > limit && lines.length) break;
    lines.unshift(line.length > limit ? `${line.slice(0, limit)}…` : line); size += line.length;
  }
  return lines.join('\n\n');
}

export function ThreadView(props:Parameters<typeof ThreadViewContent>[0]) {
  const tablet=useWindowDimensions().width>=1000;
  return <WorkbenchPresentationProvider presentation={tablet?'tablet':'phone'}><ThreadViewContent {...props}/></WorkbenchPresentationProvider>;
}
function ThreadViewContent({ visible, deviceId, sessionKey, agent, workspaceMode = 'code', onWorkspaceModeChange, activeSpace = 'remote', onSwitchSpace, onClose, onCreated, onNew, onAgentSettings, agentSettingsOpen = false, verifying = false, onContinue, seed, newProjectPath, newProjectless = false, voice }: {
  visible: boolean; deviceId: string | null; sessionKey: string | null; agent: AgentProfile | null;
  workspaceMode?: WorkspaceMode;
  onWorkspaceModeChange?: (mode: WorkspaceMode) => void;
  activeSpace?: Space;
  onSwitchSpace?: (space: Space) => void;
  onClose: () => void; onCreated: (sessionKey: string) => void;
  /** Opens a fresh CLI task editor without dispatching until the user submits. */
  onNew?: (mode?: WorkspaceMode, cwd?: string, projectless?: true) => void;
  newProjectPath?: string;
  newProjectless?: boolean;
  onAgentSettings?: () => void;
  agentSettingsOpen?: boolean;
  /** Opened instantly before the computer confirmed this Agent/API: readable, not sendable yet. */
  verifying?: boolean;
  /** Read-only Claude Desktop chats: continue the topic as a new Claude Code task. */
  onContinue?: (seed: ContinueSeed) => void;
  /** A new task that continues an earlier Claude Desktop chat. */
  seed?: ContinueSeed | null;
  /** The app's speech providers; enables voice typing in the composer. */
  voice?: VoiceSource;
}) {
  const styles = useThreadStyles();
  const dk = useDesk();
  const windowWidth=useWindowDimensions().width,tabletLayout = windowWidth >= 1000;
  const remote = useRemote();
  const isNew = !sessionKey;
  const timelineId = deviceId && sessionKey ? timelineKey(deviceId, sessionKey) : '';
  const operationScope = remoteDeliveryScope();
  const projectless = isNew && newProjectless;
  const cwd = projectless ? '' : newProjectPath || seed?.cwd || '';
  const hasNewLocation = Boolean(cwd) || projectless;
  // Private content belongs to this exact credential generation, not just
  // the saved station ID. Model preferences retain their public key below.
  const draftKey = `${operationScope}|${deviceId ?? ''}|${sessionKey ?? `new:${agent?.id ?? ''}:${workspaceMode}:${projectless ? 'projectless' : encodeURIComponent(cwd)}`}`;
  const timeline = remote.timelines[timelineId] ?? EMPTY_TIMELINE;
  const device = remote.devices.find((item) => item.deviceId === deviceId);
  const session = timeline.session ?? remote.sessions[deviceId ?? '']?.list.find((item) => item.sessionKey === sessionKey);
  const readOnly = session?.controlSurface === 'read-only' || Boolean(sessionKey?.startsWith('claude-desktop:'));
  const tool = session?.tool ?? agent?.tool ?? 'codex';
  const agentDirectory = remote.agents[deviceId ?? ''];
  // A selected prop can fill an initial read, never revive an adapter removed
  // from the computer's authoritative directory.
  const currentAgent = agentDirectory?.list.find((item) => item.id === agent?.id) ?? (agentDirectory?.loaded ? null : agent);
  // Keep the executor sticky: an expired native lease cannot turn this into a CLI task.
  const desktopTarget = useRef('');
  if (desktopLiveFor(currentAgent, sessionKey)) desktopTarget.current = draftKey;
  const desktopLive = Boolean(sessionKey && (desktopTarget.current === draftKey || session?.controlSurface === 'desktop'));
  const native = currentAgent?.desktopLive;
  const nativeModelEditable = desktopLive && desktopLiveFor(currentAgent, sessionKey) && native?.capabilities?.modelOverride === true
    && native.modelOverrideTransport === 'codex-tool-schema-v1' && native.modelOptions?.model === true && Boolean(native.accountId);
  const modelEditable = !readOnly && (desktopLive ? nativeModelEditable
    : agentSupports(currentAgent ?? undefined, tool, 'modelOverride') || isNew && currentAgent?.capabilities?.startModelOverride === true);
  const modelEditableRef = useRef(modelEditable); modelEditableRef.current = modelEditable;
  const imageInputSupported = desktopLive ? currentAgent?.desktopLive?.capabilities?.attachments === true
    : agentSupports(currentAgent ?? undefined, tool, 'imageInput');
  const selectedAccountId = desktopLive ? native?.accountId : currentAgent?.api.accountId;
  const apiIdentity = desktopLive ? `desktop:${JSON.stringify([native?.accountId, native?.modelOverrideTransport, native?.modelOptions, nativeModelEditable])}`
    : currentAgent ? `${currentAgent.api.source}:${currentAgent.api.accountId ?? currentAgent.api.name}` : '';
  const cooperationIdentity = JSON.stringify([operationScope, deviceId, sessionKey, apiIdentity]);
  const apiIdentityRef = useRef(apiIdentity); apiIdentityRef.current = apiIdentity;
  const previousApiIdentity = useRef(apiIdentity);
  const prefsRevision = useRef(0);
  const online = Boolean(device?.online) && remote.connection !== 'error';
  let contextScope = `${draftKey}|${apiIdentity}`;
  try { if (deviceId && sessionKey) contextScope = sessionContextScope(deviceId, sessionKey); } catch { /* disconnected */ }
  const [contextBusyState, setContextBusyState] = useState<{ scope: string; busy: boolean }>({ scope: '', busy: false });
  const contextBusy = contextBusyState.scope === contextScope && contextBusyState.busy;
  const contextBusyRef = useRef(contextBusy); contextBusyRef.current = contextBusy;
  const contextScopeRef = useRef(contextScope); contextScopeRef.current = contextScope;
  const contextEligible = !isNew && !readOnly && !desktopLive && currentAgent?.capabilities?.context === true && hubSupportsContext?.() === true;
  const contextBar = useRef<ContextBarHandle>(null);
  const compactSupported = contextEligible && currentAgent?.capabilities?.compact === true;

  const composerTextRevision = useRef(0), composerImageRevision = useRef(0);
  const [text, setTextState] = useState('');
  const setText: typeof setTextState = value => {
    composerTextRevision.current += 1;
    const context = composerContext.current;
    if (context?.key === draftKey) context.snapshot = { ...context.snapshot, text: typeof value === 'function' ? value(context.snapshot.text) : value };
    setTextState(value);
  };
  const [composerReady, setComposerReady] = useState(false);
  const [composerSaveProblem, setComposerSaveProblem] = useState('');
  const [savedDraftOrigin, setSavedDraftOrigin] = useState<{ key: string; origin: ComposerDraftOrigin }>();
  const [draftRecovery, setDraftRecovery] = useState<{ receipt: ComposerDraftRecoveryReceipt; text: string; images: string; features: string }>();
  const composerContext = useRef<{ key: string; scope: string; session: ComposerDraftSession; ready: boolean; problem?: string; submitting?: boolean; busy?: boolean; editRestore?: {operationId:string;previousMarker:string};
    durableRevision?: number; durableIdentity?: string; durableSnapshot?: ComposerDraftInput; snapshot: ComposerDraftInput } | undefined>(undefined);
  const composerMissing = useRef<{ key: string; count: number } | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const [stopState, setStopState] = useState<{ key: string; turnId?: string; phase: 'requesting' | 'requested' | 'unconfirmed' } | null>(null);
  const stopRef = useRef(stopState); stopRef.current = stopState;
  const [foreground, setForeground] = useState(appForeground);
  const [watchUntil, setWatchUntil] = useState(0);
  type PendingDeliveryView = { requestId?: string; executionId?: string; text: string; retryable: boolean; message: string; createdAt?: number; attempted?: boolean; acceptedSessionKey?: string; composerDraft?: { key: string; revision: number; identity?: string } };
  const [pendingDelivery, setPendingDelivery] = useState<PendingDeliveryView | null>(null);
  const [pendingChecked, setPendingChecked] = useState(false);
  const offlineSince = useRef(Date.now());
  const wasOnline = useRef(online);
  if (wasOnline.current !== online) {
    wasOnline.current = online;
    if (!online) offlineSince.current = Date.now();
  }
  const offlineNoticeKey = `${draftKey}|offline:${offlineSince.current}`;
  const offlineNoticeVisible = useDelayedNotice(visible && !isNew && !online, offlineNoticeKey,
    offlineSince.current + REMOTE_STATUS_NOTICE_DELAY_MS);
  const syncNotice=useConversationSyncNotice(draftKey,online,timeline.snapshotAt,timeline.loading,timeline.error);
  const readErrorValue = timeline.error ?? '';
  const readErrorRevision = useRef({ value: readErrorValue, startedAt: Date.now() });
  if (readErrorRevision.current.value !== readErrorValue) readErrorRevision.current = { value: readErrorValue, startedAt: Date.now() };
  const readErrorNoticeVisible = useDelayedNotice(visible && Boolean(readErrorValue), `${draftKey}|read:${readErrorValue}:${readErrorRevision.current.startedAt}`,
    readErrorRevision.current.startedAt + REMOTE_STATUS_NOTICE_DELAY_MS, Boolean(readErrorValue && !isTransientReadFailure(readErrorValue)));
  const pendingNoticeKey = `${draftKey}|delivery:${pendingDelivery?.requestId ?? ''}:${pendingDelivery?.createdAt ?? ''}`;
  const [model, setModel] = useState('');
  const modelRef = useRef(model); modelRef.current = model;
  const [effort, setEffort] = useState<Effort | ''>('');
  const effortRef = useRef(effort); effortRef.current = effort;
  useEffect(() => { if (!visible || !deviceId || !sessionKey) return undefined; setVisibleThread(deviceId, sessionKey); return () => setVisibleThread(null, null); }, [visible, deviceId, sessionKey]);
  // Press-and-slide effort: only the composer frosts while scrubbing.
  const [scrub, setScrub] = useState<{ index: number; texture?: string } | null>(null);
  const scrubRequest = useRef(0);
  const composerRef = useRef<View>(null);
  const reducedMotion = useReducedMotion();
  const [mode, setMode] = useState<ApprovalMode>();
  const [collaborationChoice, setCollaborationChoice] = useState<CollaborationMode>();
  const [contextReferences, setContextReferences] = useState<ContextReference[]>([]);
  const contextReferencesRef = useRef(contextReferences); contextReferencesRef.current = contextReferences;
  const [annotationEditRequest, setAnnotationEditRequest] = useState<{ key: string; nonce: number }>();
  const annotationEditSequence = useRef(0);
  const [annotationSourceId, setAnnotationSourceId] = useState<string>();
  const [annotationHighlight, setAnnotationHighlight] = useState<{ id: string; nonce: number; textBasis: 'source' | 'rendered'; blockIndex?: number; start: number; end: number; text: string }>();
  const [sideQuestion, setSideQuestion] = useState<{ scope: string; selection: ContextReference; nonce: number }>();
  const referencePicker = useRef<ContextReferencePickerHandle>(null);
  const [referencePreview, setReferencePreview] = useState<ReferencePreview>();
  const [referenceDismissed, setReferenceDismissed] = useState<string>();
  const [selectedSkills, setSelectedSkills] = useState<SkillReference[]>([]);
  const [intentSource, setIntentSource] = useState<ComposerFeatureSource>();
  const [skillMentions, setSkillMentions] = useState<SkillMention[]>([]);
  const [inputSelection, setInputSelection] = useState<{ text: string; start: number; end: number }>();
  const [forcedSelection, setForcedSelection] = useState<{ start: number; end: number }>();
  const inputCaret = inputSelection?.text === text ? inputSelection.end : text.length;
  const clearFeatureSelection = () => {
    setCollaborationChoice(undefined); setContextReferences([]); contextReferencesRef.current = []; setAnnotationEditRequest(undefined); setAnnotationSourceId(undefined); setAnnotationHighlight(undefined); setReferencePreview(undefined); setSelectedSkills([]); setSkillMentions([]); setIntentSource(undefined);
    const context = composerContext.current;
    if (context?.key === draftKey) context.snapshot = { ...context.snapshot, featureIntent: undefined };
  };
  const [featureState, setFeatureState] = useState<{ scope: string; generation: string; request: number; value?: AgentFeatures; loading: boolean; error: string }>({ scope: '', generation: '', request: 0, loading: false, error: '' });
  const featureRequest = useRef(0);
  const [featureRevision, setFeatureRevision] = useState(0);
  const forceFeatureRefresh = useRef(false);
  const composerInput = useRef<TextInput>(null);
  const filePicker=useRef<ConversationFilesHandle|undefined>(undefined),historyRef=useRef<PromptHistoryHandle|undefined>(undefined);
  const history=useMemo(()=>promptHistory(timeline.items),[timeline.items]);
  const [slashDismissed, setSlashDismissed] = useState<string>();
  const [slashFocus, setSlashFocus] = useState({ key: '', index: 0 });
  const [planPreview, setPlanPreview] = useState<{ id: string; epoch: number } | null>(null);
  const [permissionChoice, setPermissionChoice] = useState<PermissionMode>();
  const [picker, setPicker] = useState<'model' | 'effort' | 'mode' | 'permission' | null>(null);
  // Agent configuration owns API changes. Pause dispatch while that surface is open.
  const apiSwitching = agentSettingsOpen;
  const apiSwitchingRef = useRef(apiSwitching); apiSwitchingRef.current = apiSwitching;
  const [apiError, setApiError] = useState<ApiProblem | null>(null);
  const [dismissedError, setDismissedError] = useState('');
  const modelRequestRef = useRef(0);
  const [models, setModels] = useState<ModelCatalog>({ models: [] });
  const [modelsLoading, setModelsLoading] = useState(false);
  const [catalogOwner, setCatalogOwner] = useState('');
  const [catalogError, setCatalogError] = useState('');
  const [modelEpoch, setModelEpoch] = useState(0);
  const modelAnchor = useRef<View>(null), permissionAnchor = useRef<View>(null), attachmentAnchor = useRef<View>(null);
  const pickerRef = useRef(picker); pickerRef.current = picker;
  const [images, setImagesState] = useState<RemoteImage[]>([]);
  const setImages: typeof setImagesState = value => {
    composerImageRevision.current += 1; composerMissing.current = undefined;
    const context = composerContext.current;
    if (context?.key === draftKey) context.snapshot = { ...context.snapshot, text: context.snapshot.text,
      images: typeof value === 'function' ? value(context.snapshot.images) : value };
    setImagesState(value);
  };
  const [attachMenu, setAttachMenu] = useState(false);
  useEffect(() => { setAttachMenu(false); }, [visible, draftKey, apiIdentity]);
  const [remoteFilePicker, setRemoteFilePicker] = useState(false);
  const [menu, setMenu] = useState(false);
  const menuAnchor = useRef<View>(null);
  const [sessionManagement, setSessionManagement] = useState(false);
  const [sessionWorkflows, setSessionWorkflows] = useState(false);
  const [slashSessionCommand, setSlashSessionCommand] = useState<{ scope: string; command: SessionCommand }>();
  const [slashSideChat, setSlashSideChat] = useState<{ scope: string; nonce: number }>();
  const [cooperation, setCooperation] = useState<{ owner: string; sourceSessionKey: string; targetSessionKey?: string } | null>(null);
  useEffect(() => { setCooperation(null); }, [cooperationIdentity]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [sidebarFocus, setSidebarFocus] = useState<string | null>(null);
  const [sidebarFile, setSidebarFile] = useState<RemoteFileTarget | null>(null);
  const [previewTarget, setPreviewTarget] = useState<{ kind: 'web' | 'local-service'; url: string; pageId?: string; nonce: number; epoch: number } | null>(null);
  const fileLinkSequence = useRef(0);
  const sidebarSessionRef = useRef(sessionKey);
  const sidebarChildRouteRef = useRef<string | null>(null);
  const [denying, setDenying] = useState<ApprovalItem | null>(null);
  const [reason, setReason] = useState('');
  const [busyApproval, setBusyApproval] = useState<string | null>(null);
  const [questionProblem, setQuestionProblem] = useState('');
  const answerDraft = useRef<{ scope: string; id: string; answers?: QuestionAnswers } | null>(null);
  const questionDrafts = useRef({ scope: draftKey, values: new Map<string, QuestionDraft>() });
  // Fence synchronously: a child mounts before passive scope-cleanup effects.
  // A reused request ID after re-pairing must never hydrate an old answer.
  if (questionDrafts.current.scope !== draftKey) questionDrafts.current = { scope: draftKey, values: new Map() };
  const [selectedApproval, setSelectedApproval] = useState<{ scope: string; id: string } | null>(null);
  const approvalRequest = useRef<{ scope: string; id: string; controller?: AbortController } | null>(null);
  const historyReadController = useRef<AbortController | null>(null);
  const [inputSpace, setInputSpace] = useState<number>();
  const [approvalClock, setApprovalClock] = useState(Date.now());
  const listRef = useRef<FlatList<ConversationBlock>>(null);
  const followRef = useRef(true);
  // Jump-to-latest: shown once the reader has scrolled away; marked when new content arrives meanwhile.
  const [jump, setJump] = useState<{ visible: boolean; unseen: boolean }>({ visible: false, unseen: false });
  const jumpRef = useRef(jump); jumpRef.current = jump;
  const setJumpState = (next: { visible: boolean; unseen: boolean }) => { if (jumpRef.current.visible !== next.visible || jumpRef.current.unseen !== next.unseen) { jumpRef.current = next; setJump(next); } };
  const contentHeight = useRef(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchPos, setSearchPos] = useState(0);
  const [diffFile, setDiffFile] = useState<{ file: FileEdit; epoch: number } | null>(null);
  const diffOpenNonce = useRef(0);
  const [toolsPaneVisible, setToolsPaneVisible] = useState(false);
  const workspaceBack = useChildBackAction();
  const reportToolsVisibility=useCallback((open:boolean)=>{setToolsPaneVisible(open);if(!tabletLayout)setSidebarOpen(open);},[tabletLayout]);
  const [reviewTarget, setReviewTarget] = useState<{files: FileEdit[]; nonce: number; epoch: number} | null>(null);
  const [diffFullscreen, setDiffFullscreen] = useState(false);
  const [viewImage, setViewImage] = useState<{ uri: string; epoch: number } | null>(null);
  // A message written while the agent is busy waits here and goes out when the current turn ends.
  const [queuedItems, setQueuedItems] = useState<LoadedQueuedRemoteDraft[]>([]);
  const queued = queuedItems[0];
  const queuedRef = useRef(queuedItems); queuedRef.current = queuedItems;
  const queueBusyRef = useRef(false);
  // Every stop creates a new queue intent.  Late completion of an older
  // queued-send effect must not write its stale `remaining` rows back over a
  // durable stop decision.
  const queueStopEpoch = useRef(0);
  const queueExplicitResumes = useRef(new Set<string>());
  const [queueChecked, setQueueChecked] = useState(false);
  const [queueRepairId, setQueueRepairId] = useState<string | null>(null);
  const updateQueue = (rows: LoadedQueuedRemoteDraft[]) => { queuedRef.current = rows; setQueuedItems(rows); };
  const queuedRestoreRevision = useRef(0);
  const titleOf = useThreadTitles();
  const draggingRef = useRef(false);
  const draftRef = useRef(draftKey);
  const threadMounted = useRef(true);
  useEffect(() => { threadMounted.current = true; return () => { threadMounted.current = false; }; }, []);
  const materializedAttachments = useRef(new Set<string>());
  const attachmentRetryTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  // A malformed/expired attachment must not turn a folded image row into a
  // permanent 2.5s polling loop.  Keep retry state per selected thread so a
  // re-open is an explicit fresh attempt, while transient offline failures
  // still get a bounded exponential backoff.
  const attachmentRetryAttempts = useRef(new Map<string, number>());
  const attachmentContext = useRef<{ identity: string; scope: string; controller: AbortController } | undefined>(undefined);
  const [attachmentRetryTick, setAttachmentRetryTick] = useState(0);
  const attachmentIdentity = `${deviceId ?? ''}\u0000${sessionKey ?? ''}\u0000${draftKey}`;
  // Keep one cancellation scope for the selected thread.  The materializer
  // effect below also runs when new timeline items arrive; it must not cancel
  // images which are already being read merely because text streamed in.
  useEffect(() => {
    attachmentContext.current?.controller.abort();
    for (const timer of attachmentRetryTimers.current.values()) clearTimeout(timer);
    attachmentRetryTimers.current.clear();
    attachmentRetryAttempts.current.clear();
    materializedAttachments.current.clear();
    if (!visible || !deviceId || !sessionKey) {
      attachmentContext.current = undefined;
      return undefined;
    }
    const context = { identity: attachmentIdentity, scope: remoteDeliveryScope(), controller: new AbortController() };
    attachmentContext.current = context;
    return () => {
      context.controller.abort();
      for (const timer of attachmentRetryTimers.current.values()) clearTimeout(timer);
      attachmentRetryTimers.current.clear();
      attachmentRetryAttempts.current.clear();
      if (attachmentContext.current?.identity === context.identity) attachmentContext.current = undefined;
    };
  }, [visible, deviceId, sessionKey, attachmentIdentity]);
  /**
   * Materialize one image reference, sharing the bounded cache flight with
   * any other thumbnail/full-screen consumer. Message attachments call this
   * automatically; tool/image-view records call it only when their folded
   * row is expanded. This keeps Codex-style hidden work from downloading
   * bytes in the background while still allowing an explicit reveal.
   */
  const requestAttachment = useCallback((ref: AttachmentRef) => {
    const context = attachmentContext.current;
    const localRef = ref as AttachmentRef & { uri?: string };
    if (localRef.uri || !visible || !deviceId || !sessionKey || !context || context.identity !== attachmentIdentity) return;
    const key = `${draftKey}\u0000${attachmentContentKey(ref)}`;
    if (materializedAttachments.current.has(key) || attachmentRetryTimers.current.has(key)) return;
    void materializeAttachment(deviceId, ref, context.controller.signal, sessionKey).then(uri => {
      if (context.controller.signal.aborted || !threadMounted.current || draftRef.current !== draftKey || remoteDeliveryScope() !== context.scope) return;
      if (!attachMaterializedUri(deviceId, sessionKey, ref, uri, context.scope)) return;
      const retry = attachmentRetryTimers.current.get(key);
      if (retry) { clearTimeout(retry); attachmentRetryTimers.current.delete(key); }
      attachmentRetryAttempts.current.delete(key);
      materializedAttachments.current.add(key);
    }).catch((error: unknown) => {
      // Keep the ref visible as a placeholder and retry after a short quiet
      // period. A transient offline response must not become permanent, but a
      // failed page must also never create a hot request loop.
      if (context.controller.signal.aborted || materializedAttachments.current.has(key) || attachmentRetryTimers.current.has(key)) return;
      // 4xx responses and malformed/invalid attachment payloads are
      // definitive for this reference.  Retrying them only wastes the Hub's
      // resources; reopening the conversation starts a new explicit attempt.
      const status = error instanceof HubError ? error.status : 0;
      const message = error instanceof Error ? error.message : String(error ?? '');
      const definitive = (status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 429)
        || /附件(?:编号|类型|分片|游标|大小|读取不完整|保存失败)|图片(?:内容|校验失败|数据无效)/.test(message);
      if (definitive) return;
      const attempts = (attachmentRetryAttempts.current.get(key) ?? 0) + 1;
      attachmentRetryAttempts.current.set(key, attempts);
      // Six attempts (2.5s → 5s → 10s → 20s → 40s → 60s) cover normal
      // reconnects without creating an unbounded background poll. A user can
      // explicitly re-open the thread to retry after a longer outage.
      if (attempts > 6) return;
      const delay = Math.min(60_000, 2_500 * 2 ** (attempts - 1));
      const timer = setTimeout(() => {
        attachmentRetryTimers.current.delete(key);
        if (!context.controller.signal.aborted) setAttachmentRetryTick(value => value + 1);
      }, delay);
      attachmentRetryTimers.current.set(key, timer);
    });
  }, [visible, deviceId, sessionKey, draftKey, attachmentIdentity]);
  const freshSnapshot = useRef('');
  const [restoreGeneration, setRestoreGeneration] = useState(0);
  draftRef.current = draftKey;
  const autoAllowed = remote.agents[deviceId ?? '']?.autoAll === true;
  const prefsKey = `${remote.connectionId ?? remote.selectedHubUrl ?? ''}|${deviceId ?? ''}|${sessionKey ?? `new:${agent?.tool ?? ''}`}`;
  const catalogScope = `${draftKey}|${apiIdentity}`;
  const ownToolApi = !currentAgent || currentAgent.api.source === 'tool' || (currentAgent.api.source === 'computer' && !currentAgent.api.configured);
  // Once a thread was selected for native execution, an expired lease may not
  // silently change its executor while this thread remains selected.
  const featureEligible = !projectless && !readOnly && !desktopLive && currentAgent?.capabilities?.features === true;
  const featureCwd = isNew ? cwd : session?.cwd;
  const knownDraftCwd = featureCwd || (savedDraftOrigin?.key === draftKey ? savedDraftOrigin.origin.cwd : '');
  const originCandidate = { transport: 'hub' as const, deviceId: deviceId ?? '', agentId: agent?.id ?? '', cwd: knownDraftCwd,
    mode: workspaceMode, apiIdentity, ...(projectless || session?.projectless || savedDraftOrigin?.key === draftKey && savedDraftOrigin.origin.projectless ? { projectless: true as const } : {}), ...(sessionKey ? { sessionKey } : {}) };
  const draftOrigin = validComposerDraftOrigin(originCandidate) ? originCandidate : undefined;
  const draftOriginRef = useRef({ key: draftKey, origin: draftOrigin }); draftOriginRef.current = { key: draftKey, origin: draftOrigin };
  const featureSource: ComposerFeatureSource = { scope: operationScope, deviceId: deviceId ?? '', tool: tool === 'claude' ? 'claude' : 'codex',
    runtimeId: currentAgent?.id ?? '', surface: desktopLive ? 'desktop' : 'cli', apiIdentity, cwd: featureCwd ?? '' };
  const featureScope = JSON.stringify([featureSource, draftKey, featureEligible]);
  const featureOwner = useRef(featureScope); featureOwner.current = featureScope;
  // Directory changes retire catalog callbacks, not the draft or input owner.
  // Read the store directly too: a queued tap can run before React rerenders.
  const featureGeneration = deviceId ? agentFeaturesGeneration?.(deviceId, tool) ?? '' : '';
  const featureGenerationCurrent = () => !deviceId || (agentFeaturesGeneration?.(deviceId, tool) ?? '') === featureGeneration;
  const featureStateCurrent = featureState.scope === featureScope && featureState.generation === featureGeneration && featureState.request === featureRequest.current;
  const featureCatalogCurrent = () => featureGenerationCurrent() && featureOwner.current === featureScope
    && featureStateCurrent && featureState.request === featureRequest.current && !featureState.loading && !featureState.error;
  const featureSourceRef = useRef(featureSource); featureSourceRef.current = featureSource;
  const featureDraftIntent: ComposerFeatureIntent | undefined = intentSource && (collaborationChoice || selectedSkills.length || contextReferences.length)
    ? { version: 1, source: intentSource, ...(contextReferences.length ? { contextReferences } : {}), ...(collaborationChoice ? { collaborationMode: collaborationChoice } : {}),
      ...(selectedSkills.length ? { skills: selectedSkills, mentions: skillMentions } : {}) } : undefined;
  const referenceSupported = !readOnly && !desktopLive && currentAgent?.capabilities?.contextReferences === true;
  const computerFilesSupported = referenceSupported && Boolean(deviceId && featureCwd && device?.capabilities?.includes(isNew ? 'workspace.project.files.v1' : 'workspace.files.v1'));
  const annotationSupported = referenceSupported && currentAgent?.capabilities?.contextAnnotations === true;
  const diffAnnotationSupported = referenceSupported && !isNew && currentAgent?.capabilities?.contextDiffAnnotations === true && typeof hubSupportsDiffAnnotations === 'function' && hubSupportsDiffAnnotations();
  const sideHistorySupported = !isNew && !readOnly && !desktopLive && currentAgent?.capabilities?.sideQuestion === true && typeof hubSupportsSideQuestions === 'function' && hubSupportsSideQuestions();
  const sideQuestionSupported = !isNew && !readOnly && !desktopLive && currentAgent?.capabilities?.sideQuestion === true && typeof hubSupportsTemporarySideChat === 'function' && hubSupportsTemporarySideChat();
  let sideQuestionScope = '', sideQuestionStorageScope = '';
  if (deviceId && sessionKey && !readOnly && !desktopLive) {
    try { sideQuestionStorageScope = sessionSideQuestionStorageScope(deviceId, sessionKey); } catch { /* Local history is scoped to a known pairing and source. */ }
  }
  const sideHistoryOwner = deviceId && sessionKey && typeof sessionSideQuestionHistoryOwner === 'function' ? sessionSideQuestionHistoryOwner(deviceId, sessionKey) : draftKey;
  const historyLookupIdentity = `${sideHistoryOwner}|${sideQuestionStorageScope}`;
  const historyLookup = useRef({ identity: historyLookupIdentity, token: {} });
  if (historyLookup.current.identity !== historyLookupIdentity) historyLookup.current = { identity: historyLookupIdentity, token: {} };
  const [sideHistoryFallback, setSideHistoryFallback] = useState<{ token: object; scope: string }>();
  const liveSideScope = sideQuestionStorageScope;
  useEffect(() => {
    if (liveSideScope || !deviceId || !sessionKey || readOnly || desktopLive || typeof restoreSessionSideQuestionStorageScope !== 'function') return;
    let cancelled = false; const token = historyLookup.current.token;
    void restoreSessionSideQuestionStorageScope(deviceId, sessionKey).then(scope => {
      if (!cancelled && scope && historyLookup.current.token === token) setSideHistoryFallback({ token, scope });
    }).catch(error => { if (!cancelled && historyLookup.current.token === token) showToast(error instanceof Error ? error.message : '侧问历史暂时无法读取', 'alert'); });
    return () => { cancelled = true; };
  }, [historyLookupIdentity, deviceId, sessionKey, readOnly, desktopLive]);
  if (!sideQuestionStorageScope && sideHistoryFallback?.token === historyLookup.current.token) sideQuestionStorageScope = sideHistoryFallback.scope;
  if ((sideQuestionSupported || sideHistorySupported) && deviceId && sessionKey) {
    try { sideQuestionScope = sessionSideQuestionScope(deviceId, sessionKey); } catch { /* A disconnected source has no usable side conversation. */ }
  }
  useEffect(() => { setSideQuestion(undefined); }, [sideQuestionStorageScope]);
  const featureSourceBlocked = Boolean(featureDraftIntent && ((Boolean(collaborationChoice || selectedSkills.length) && !featureEligible) || (Boolean(contextReferences.length) && !referenceSupported) || (hasResponseAnnotations(contextReferences) && !annotationSupported) || (hasDiffAnnotations(contextReferences) && !diffAnnotationSupported) || !sameComposerFeatureSource(featureDraftIntent.source, featureSource)));
  const diffDraftProblem = useMemo(() => diffReviewProblem(timeline.items, sessionKey ?? '', contextReferences), [timeline.items, sessionKey, contextReferences]);
  const diffTimeline = useRef(timeline.items); diffTimeline.current = timeline.items;
  const features = featureStateCurrent ? featureState.value : undefined;
  const effectiveCollaboration = collaborationChoice ?? session?.collaborationMode;
  const slashKey = `${featureScope}\u0000${text}\u0000${inputCaret}`;
  const slashQuery = !readOnly && visible && composerReady && slashDismissed !== slashKey
    && !(inputSelection?.text === text && inputSelection.start !== inputSelection.end)
    && !skillMentions.some(mention => inputCaret > mention.start && inputCaret <= mention.end)
    ? parseSlashQuery(text, inputCaret) : undefined;
  const turnFeatures = copyTurnFeatures({ ...(contextReferences.length ? { contextReferences } : {}), ...(collaborationChoice ? { collaborationMode: collaborationChoice } : {}), ...(selectedSkills.length ? { skills: selectedSkills } : {}) });
  const composerHasContent = Boolean(text.trim() || images.length || contextReferences.length);
  const referenceKey = `${featureScope}\u0000${text}\u0000${inputCaret}`;
  const referenceQuery = referenceSupported && !featureSourceBlocked && visible && composerReady && referenceDismissed !== referenceKey && Boolean(featureCwd)
    && !(inputSelection?.text === text && inputSelection.start !== inputSelection.end) ? parseContextQuery(text, inputCaret) : undefined;
  const featuresBlocked = featureSourceBlocked || Boolean((collaborationChoice || selectedSkills.length) && !featureCatalogCurrent()
    || collaborationChoice && !features?.collaborationModes.includes(collaborationChoice)
    || selectedSkills.some(skill => !features?.skills.some(value => skillKey(value) === skillKey(skill))));
  useEffect(() => {
    setInputSelection(undefined); setForcedSelection(undefined); setAnnotationEditRequest(undefined); setAnnotationSourceId(undefined); setAnnotationHighlight(undefined);
  }, [featureScope]);
  useEffect(() => {
    if (!annotationSourceId) return;
    const timeout = setTimeout(() => { setAnnotationSourceId(undefined); setAnnotationHighlight(undefined); }, 3000);
    return () => clearTimeout(timeout);
  }, [annotationSourceId, annotationHighlight?.nonce]);
  useEffect(() => {
    let current = true;
    if (!visible || !foreground || !online || !deviceId || !featureEligible || !featureCwd) return;
    const request = ++featureRequest.current;
    const target = sessionKey ? { sessionKey } : { cwd: featureCwd };
    const cached = cachedAgentFeatures?.(deviceId, tool, target), force = forceFeatureRefresh.current;
    forceFeatureRefresh.current = false;
    const ownsRequest = () => current && featureOwner.current === featureScope && featureGenerationCurrent() && featureRequest.current === request;
    setFeatureState({ scope: featureScope, generation: featureGeneration, request, value: cached, loading: true, error: '' });
    void listAgentFeatures(deviceId, tool, target, ...(force ? [{ force: true }] : [])).then(value => {
      if (ownsRequest()) setFeatureState({ scope: featureScope, generation: featureGeneration, request, value, loading: false, error: '' });
    }).catch(error => {
      if (ownsRequest()) setFeatureState({ scope: featureScope, generation: featureGeneration, request, loading: false, error: error instanceof Error ? error.message : '暂时无法读取技能目录' });
    });
    return () => { current = false; };
  }, [visible, foreground, online, deviceId, featureScope, featureGeneration, featureRevision, Boolean(slashQuery)]);
  useEffect(() => {
    if (!visible || !foreground || !online || !slashQuery) return;
    const timer = setInterval(() => {
      if (!featureGenerationCurrent() || featureOwner.current !== featureScope) return;
      ++featureRequest.current; setFeatureRevision(value => value + 1);
    }, 30_000);
    return () => clearInterval(timer);
  }, [visible, foreground, online, Boolean(slashQuery), featureScope, featureGeneration]);
  const permissionModes = tool === 'codex' && !desktopLive && !readOnly ? (currentAgent?.capabilities?.permissionModes ?? []).filter(isPermissionMode) : [];
  const permissionEditable = permissionModes.length > 0;
  const approvalModes = tool === 'claude' && !desktopLive && !readOnly ? (currentAgent?.capabilities?.approvalModes ?? []).filter(isApprovalMode) : [];
  const approvalEditable = tool === 'claude' && !readOnly && !desktopLive && (isNew || approvalModes.length > 0);
  const nextApproval = tool === 'claude' && !desktopLive ? mode ?? (isNew ? 'ask' : undefined) : undefined;
  const approvalPreview = nextApproval ?? (isApprovalMode(session?.approvalMode) ? session.approvalMode : undefined);
  // Old sessions keep their host policy unless the user explicitly chooses.
  // The displayed SessionInfo is never optimistically rewritten by a choice.
  const nextPermissionMode = tool === 'codex' && !desktopLive ? permissionChoice ?? (isNew && permissionModes.includes('ask') ? 'ask' : undefined) : undefined;
  const permissionBlocked = nextPermissionMode !== undefined && (!permissionModes.includes(nextPermissionMode) || nextPermissionMode === 'full_access' && !autoAllowed)
    || nextApproval !== undefined && ((!isNew || nextApproval === 'auto_all') && !approvalModes.includes(nextApproval) || nextApproval === 'auto_all' && !autoAllowed);
  const permissionPreview = permissionChoice ?? (isNew && permissionModes.includes('ask') ? 'ask' : isPermissionMode(session?.permissionMode) ? session.permissionMode : undefined);
  const permissionScope = `${catalogScope}|${desktopLive ? 'desktop' : 'cli'}|${permissionModes.join(',')}|${approvalModes.join(',')}|${autoAllowed}`;
  const permissionRuntime = useRef({ scope: permissionScope, locked: false });
  permissionRuntime.current = { scope: permissionScope, locked: sending || apiSwitching || Boolean(pendingDelivery) || Boolean(busyApproval) };
  const desktopCanStop = !readOnly && !desktopLive && currentAgent?.capabilities?.preciseInterrupt === true;
  const desktopCanApprove = !desktopLive || desktopApprovalFor(currentAgent, sessionKey) && timeline.items.some(item => item.kind === 'approval' && item.state === 'pending' && item.approvalTransport === 'codex-hook-v1' && Boolean(item.expiresAt && item.expiresAt > Date.now()));
  const execution = resolveAgentExecution(currentAgent ?? undefined);
  const desktopCanSend = !readOnly && !session?.archived && !claudeSessionAdmissionBlocked(session) && (desktopLive
    ? desktopLiveFor(currentAgent, sessionKey) && currentAgent?.desktopLive?.capabilities?.send === true
    : Boolean(currentAgent && execution && execution.tool === tool && execution.controlSurface === 'cli'
      && agentSupports(currentAgent, currentAgent.id, 'send') && claudeApiAdmissionReady(currentAgent)));
  const cooperationSupported = Boolean(!isNew && sessionKey && deviceId && !readOnly && !desktopLive && !session?.archived
    && (tool === 'codex' || tool === 'claude') && typeof hubSupportsCooperation === 'function' && hubSupportsCooperation() && currentAgent
    && agentSupports(currentAgent, currentAgent.id, 'send') && claudeApiAdmissionReady(currentAgent));
  const interactionOwner = useRef({ visible, draftKey, scope: operationScope, epoch: 0 });
  if (interactionOwner.current.visible !== visible || interactionOwner.current.draftKey !== draftKey || interactionOwner.current.scope !== operationScope) {
    interactionOwner.current = { visible, draftKey, scope: operationScope, epoch: interactionOwner.current.epoch + 1 };
  }
  const interactionEpoch = interactionOwner.current.epoch;
  const currentPreviewTarget = previewTarget?.epoch === interactionEpoch ? previewTarget : null;
  const cooperationUiOwner = JSON.stringify([cooperationIdentity, interactionEpoch]);
  const interactionCurrent = () => threadMounted.current && interactionOwner.current.visible
    && interactionOwner.current.epoch === interactionEpoch && draftRef.current === draftKey
    && remoteDeliveryScope() === operationScope;
  const startCooperation = (targetSessionKey?: string) => {
    if (!interactionCurrent() || !cooperationSupported || !sessionKey) return;
    if (targetSessionKey && (targetSessionKey === sessionKey || targetSessionKey.split(':')[0] !== tool)) return;
    setCooperation({ owner: cooperationUiOwner, sourceSessionKey: sessionKey, targetSessionKey });
  };
  const replyToCrossTask = useCallback((origin: MessageOrigin) => {
    const verified = messageOrigin(origin);
    if (!interactionCurrent() || !cooperationSupported || !sessionKey || !verified || verified.kind !== 'user_cross_task'
      || verified.targetSessionKey !== sessionKey) return;
    setCooperation({ owner: cooperationUiOwner, sourceSessionKey: sessionKey, targetSessionKey: verified.sourceSessionKey });
  }, [cooperationSupported, sessionKey, cooperationUiOwner, interactionEpoch, draftKey, operationScope]); // eslint-disable-line react-hooks/exhaustive-deps
  // A recycled row or closing native modal can call back after this thread
  // was hidden, re-paired or replaced. Bind previews to that interaction too.
  const openImage = useCallback((uri: string) => {
    if (interactionCurrent()) setViewImage({ uri, epoch: interactionEpoch });
  }, [interactionEpoch, draftKey, operationScope]); // eslint-disable-line react-hooks/exhaustive-deps
  const openDiff = useCallback((file: FileEdit) => {
    if (!interactionCurrent()) return;
    diffOpenNonce.current += 1;
    setPreviewTarget(null); setSidebarFocus(null); setSidebarFile(null); setDiffFullscreen(false);
    setDiffFile({ file, epoch: interactionEpoch }); setSidebarOpen(true);
  }, [interactionEpoch, draftKey, operationScope]); // eslint-disable-line react-hooks/exhaustive-deps
  const composerBlockedImages = composerMissing.current?.key === draftKey ? composerMissing.current : undefined;
  if (composerContext.current?.key === draftKey) composerContext.current.snapshot = { text, images,
    ...(draftOrigin ? { origin: draftOrigin } : {}),
    ...(featureDraftIntent ? { featureIntent: featureDraftIntent } : {}),
    ...(composerBlockedImages ? { imageCount: composerBlockedImages.count, missingImages: true } : {}) };
  const persistComposer = async (snapshot: ComposerDraftInput, context = composerContext.current, strictLegacyMirror = true) => {
    if (!context?.ready) throw new Error(context?.problem || '草稿尚未读取，原内容未覆盖');
    // Async callers can outlive an API change without changing the text owner.
    // Use its latest origin; retired editors keep the origin in their snapshot.
    const latestOrigin = draftOriginRef.current.key === context.key ? draftOriginRef.current.origin : snapshot.origin;
    const saved = await context.session.save({ ...snapshot, ...(latestOrigin ? { origin: latestOrigin } : {}) });
    context.durableRevision = saved.revision; context.durableIdentity = saved.identity; context.durableSnapshot = copyComposerSnapshot(snapshot);
    // Old text-only bundles are a fallback only on true absence. Mirror
    // text only after the authoritative unified snapshot has committed.
    const mirror=saveRemoteDraft(context.key, snapshot.text, context.scope);
    if(strictLegacyMirror)await mirror;else await mirror.catch(()=>undefined);
    if (!snapshot.text && !snapshot.featureIntent && !(snapshot.imageCount ?? snapshot.images.length)) await context.session.pruneEmpty();
    return saved;
  };
  const missingEvidence = !isNew && deviceId && sessionKey && timeline.readErrorCode ? { kind: timeline.readErrorCode, deviceId, sessionKey } : undefined;
  const recoveredHere = draftRecovery?.receipt.targetKey === draftKey && draftOrigin
    && sameComposerDraftOrigin(draftRecovery.receipt.targetOrigin, draftOrigin) ? draftRecovery : undefined;
  const imageSignature = (input: ComposerDraftInput) => JSON.stringify(input.images.map(({ uri, mime, width, height }) => [uri, mime, width, height]));
  const recoveryUnchanged = () => {
    const owner = composerContext.current;
    return Boolean(recoveredHere && !apiSwitchingRef.current && apiIdentityRef.current === recoveredHere.receipt.targetOrigin.apiIdentity
      && owner?.key === draftKey && owner.snapshot.text === recoveredHere.text
      && imageSignature(owner.snapshot) === recoveredHere.images && JSON.stringify(owner.snapshot.featureIntent ?? null) === recoveredHere.features);
  };
  const restoreMissingDraft = async () => {
    const owner = composerContext.current, origin = draftOrigin;
    if (!interactionCurrent() || apiSwitchingRef.current || !onNew || !missingEvidence || !origin || !owner?.ready || owner.key !== draftKey || owner.busy || sending || pendingDelivery || queuedItems.length) return false;
    const ownerCurrent = () => interactionCurrent() && composerContext.current === owner && draftRef.current === draftKey;
    const current = () => ownerCurrent() && !apiSwitchingRef.current && apiIdentityRef.current === origin.apiIdentity;
    owner.busy = true; setSending(true);
    try {
      const projects = await listProjects(deviceId!);
      if (!current()) return false;
      if (!origin.projectless && !projects.some(project => project.path === origin.cwd)) throw new Error('原项目当前不可用，草稿已保留，请先在电脑恢复该项目');
      const frozen = copyComposerSnapshot(owner.snapshot);
      const transferCurrent = () => current() && owner.snapshot.text === frozen.text && sameComposerSnapshot(owner.snapshot, frozen);
      const prepared = await persistComposer(frozen, owner);
      if (!transferCurrent()) return false;
      const targetKey = `${operationScope}|${deviceId}|new:${origin.agentId}:${origin.mode}:${origin.projectless ? 'projectless' : encodeURIComponent(origin.cwd)}`;
      const result = await copyMissingComposerDraft({ scope: operationScope, sourceKey: draftKey, targetKey, origin,
        evidence: missingEvidence, expectedRevision: prepared.revision, expectedIdentity: prepared.identity!, isCurrent: transferCurrent });
      if (!transferCurrent()) {
        // The copy may have committed just as its origin changed. Its exact
        // receipt can remove only that copy; later edits still win the CAS.
        await undoMissingComposerDraft(result.receipt).catch(() => false); return false;
      }
      setDraftRecovery({ receipt: result.receipt, text: result.draft.text, images: imageSignature(result.draft), features: JSON.stringify(result.draft.featureIntent ?? null) });
      onNew(origin.mode, origin.projectless ? '' : origin.cwd, ...(origin.projectless ? [true as const] : [])); return true;
    } finally { owner.busy = false; if (ownerCurrent()) setSending(false); }
  };
  const undoDraftRecovery = async () => {
    const owner = composerContext.current;
    if (!interactionCurrent() || !recoveredHere || !owner?.ready || owner.busy || sending || !recoveryUnchanged()) return false;
    const current = () => interactionCurrent() && composerContext.current === owner && recoveryUnchanged();
    owner.busy = true; setSending(true);
    try {
      if (!await undoMissingComposerDraft(recoveredHere.receipt, current)) return false;
      await owner.session.restore();
      if (!current()) { if (composerContext.current === owner) await persistComposer(owner.snapshot, owner); return false; }
      await saveRemoteDraft(draftKey, '', operationScope);
      if (!current()) { if (composerContext.current === owner) await persistComposer(owner.snapshot, owner); return false; }
      setText(''); setImages([]); clearFeatureSelection(); composerMissing.current = undefined; setDraftRecovery(undefined);
      owner.snapshot = { text: '', images: [], ...(draftOrigin ? { origin: draftOrigin } : {}) };
      await persistComposer(owner.snapshot, owner); return true;
    } finally { owner.busy = false; if (interactionCurrent()) setSending(false); }
  };
  const consumeComposer = async (context: NonNullable<typeof composerContext.current>, revision: number, identity?: string) => {
    if (!await context.session.consume(revision, identity)) return false;
    await saveRemoteDraft(context.key, '', context.scope);
    await context.session.pruneEmpty();
    return true;
  };
  const composerSendOwner = `${JSON.stringify(turnFeatures)}\u0000${draftKey}\u0000${apiIdentity}\u0000${model}\u0000${effort}\u0000${nextPermissionMode ?? ''}\u0000${desktopLive ? 'desktop' : 'cli'}\u0000${agent?.id ?? ''}\u0000${isNew ? `${cwd}\u0000${mode}` : ''}`;
  const composerSendOwnerRef = useRef({ identity: composerSendOwner, allowed: desktopCanSend && online, imagesAllowed: imageInputSupported });
  composerSendOwnerRef.current = { identity: composerSendOwner, allowed: desktopCanSend && online, imagesAllowed: imageInputSupported };
  const composerSendCurrent = () => interactionCurrent() && appForeground()
    && composerSendOwnerRef.current.identity === composerSendOwner && composerSendOwnerRef.current.allowed && !apiSwitchingRef.current;
  const managedApi = Boolean(currentAgent && !ownToolApi && !desktopLive && modelEditable);
  const previousOwnToolApi = useRef(ownToolApi);
  const catalogReady = catalogOwner === catalogScope;
  const capabilityModel = model || (desktopLive ? native?.apiModel : ownToolApi ? session?.model || currentAgent?.api.model : currentAgent?.api.model) || '';
  const pickerCapabilities = useMemo(() => desktopLive ? Object.fromEntries(Object.entries(models.modelCapabilities ?? {}).map(([id, capability]) => [id,
    { ...capability, reasoningEfforts: reportedEfforts(capability).filter(level => nativeModelEditable && native?.modelOptions?.thinking.includes(level)) }])) : models.modelCapabilities,
  [desktopLive, models.modelCapabilities, nativeModelEditable, native?.modelOptions]);
  const effortLevels = modelEditable && tool === 'codex' && (!desktopLive || nativeModelEditable && Boolean(model)) && catalogReady ? reportedEfforts(pickerCapabilities?.[capabilityModel]) : [];
  const effortEditable = effortLevels.length > 0;
  const effectiveEffort = effortEditable && effort && effortLevels.includes(effort) ? effort : '';
  const slashCanManage = Boolean(deviceId && sessionKey && !readOnly && !desktopLive && !session?.archived
    && typeof hubSupportsSessionActions === 'function' && hubSupportsSessionActions() && agentSupports(currentAgent ?? undefined, tool, 'sessionActions'));
  const slashCanReview = Boolean(deviceId && sessionKey && !readOnly && !desktopLive && !session?.archived
    && typeof hubSupportsSessionWorkflows === 'function' && hubSupportsSessionWorkflows() && agentSupports(currentAgent ?? undefined, tool, 'sessionWorkflows'));
  const slashModelEditable = modelEditable;
  const slashActions = composerSlashActions({ model: slashModelEditable, reasoning: slashModelEditable && effortEditable,
    reasoningLabel: effectiveEffort ? effortLabel(effectiveEffort) : '默认', permissions: permissionEditable || approvalEditable,
    newChat: Boolean(onNew), sideChat: sideQuestionSupported && Boolean(sideQuestionScope), fork: slashCanManage, archive: slashCanManage,
    review: slashCanReview, initialize: Boolean(featureCwd && !readOnly) });
  const slashActionSignature = JSON.stringify(slashActions);
  const slashAgentSignature = JSON.stringify([currentAgent?.api, currentAgent?.capabilities, currentAgent?.desktopLive, currentAgent?.execution]);
  const slashEntries = useMemo(() => slashQuery ? buildSlashCommands(features, slashQuery, effectiveCollaboration, compactSupported, slashActions) : [],
    [features, text, inputCaret, effectiveCollaboration, compactSupported, Boolean(slashQuery), slashActionSignature]);
  const slashIndex = slashFocus.key === slashKey ? Math.min(slashFocus.index, Math.max(0, slashEntries.length - 1)) : 0;
  const slashSelectionKey = JSON.stringify([slashKey, slashActionSignature, contextScope, compactSupported]);
  const slashSelectionOwner = useRef({ key: slashSelectionKey });
  if (slashSelectionOwner.current.key !== slashSelectionKey) slashSelectionOwner.current = { key: slashSelectionKey };
  const renderedSlashOwner = slashSelectionOwner.current;
  const modelRejectsImages = tool === 'codex' && catalogReady && reportsTextOnly(models.modelCapabilities?.[capabilityModel]);
  const modelRejectsImagesRef = useRef(modelRejectsImages); modelRejectsImagesRef.current = modelRejectsImages;

  useEffect(() => {
    pickerRef.current = null; setPicker(null);
    setSlashSessionCommand(undefined); setSlashSideChat(undefined);
  }, [visible, draftKey, operationScope]);
  useEffect(() => {
    pickerRef.current = null; setPicker(null);
    setSlashSessionCommand(undefined); setSlashSideChat(undefined);
  }, [apiIdentity]);

  useEffect(() => {
    approvalRequest.current?.controller?.abort();
    freshSnapshot.current = '';
    approvalRequest.current = null; answerDraft.current = null; questionDrafts.current.values.clear(); setSelectedApproval(null); setBusyApproval(null); setQuestionProblem('');
    return () => { approvalRequest.current?.controller?.abort(); approvalRequest.current = null; };
  }, [visible, draftKey, operationScope]);

  useEffect(() => {
    if (previousApiIdentity.current === apiIdentity && previousOwnToolApi.current === ownToolApi) return;
    previousApiIdentity.current = apiIdentity;
    previousOwnToolApi.current = ownToolApi;
    prefsRevision.current += 1;
    setPermissionChoice(undefined);
    setMode(undefined);
    // Keep only a candidate until the new Key's catalog confirms membership.
    setModel((current) => desktopLive ? '' : ownToolApi ? '' : current || currentAgent?.api.model || '');
    effortRef.current = ''; setEffort('');
    setModels({ models: [] });
    setCatalogOwner(''); setCatalogError('');
    modelRequestRef.current += 1;
    setModelsLoading(false);
  }, [apiIdentity, currentAgent?.api.model, ownToolApi, desktopLive]);

  // Reset per thread; restore the draft and any message still waiting for a receipt.
  useEffect(() => {
    if (!visible) return;
    // An explicit no-folder choice has its own draft owner. A missing
    // selection must never recover that draft or the first project's receipt.
    if (isNew && !hasNewLocation) {
      composerContext.current = undefined; setTextState(''); setImagesState([]);
      setComposerReady(false); setPendingChecked(false); setQueueChecked(false);
      return;
    }
    let alive = true;
    // The initial authoritative read can be a long-poll/native desktop
    // command. Cancel it when backgrounded, closed or replaced so a hidden
    // screen cannot keep a transport occupied (or publish into the next
    // thread). This mirrors the live-sync cancellation path below.
    let controller = new AbortController();
    let initialReadFinished = false;
    historyReadController.current?.abort();
    historyReadController.current = null;
    const prefsRequest = ++prefsRevision.current, prefsApi = apiIdentityRef.current;
    composerTextRevision.current = 0; composerImageRevision.current = 0; composerMissing.current = undefined;
    setTextState(''); setImagesState([]); setComposerReady(false); setComposerSaveProblem('');
    setIntentSource(undefined);
    setSending(false); setPendingDelivery(null); setPendingChecked(false); setDenying(null); setModel(''); setEffort(''); setPermissionChoice(undefined); setMode(undefined); clearFeatureSelection(); setApiError(null); setDismissedError(''); setPicker(null);
    updateQueue([]); setQueueChecked(false); setQueueRepairId(null); queueBusyRef.current = false; queueExplicitResumes.current.clear();
    setSearchOpen(false); setSearchQuery(''); setSearchPos(0); setDiffFile(null); setDiffFullscreen(false); setPreviewTarget(null); setViewImage(null); setSessionManagement(false); setSessionWorkflows(false);
    const queuedRevision = ++queuedRestoreRevision.current;
    jumpRef.current = { visible: false, unseen: false }; setJump(jumpRef.current); contentHeight.current = 0;
    setCatalogOwner(''); setCatalogError('');
    modelRequestRef.current += 1;
    void loadThreadPrefs(prefsKey).then((prefs) => { if (alive && prefsRequest === prefsRevision.current && prefsApi === apiIdentityRef.current) { setModel(!prefs.apiIdentity || prefs.apiIdentity === prefsApi ? prefs.model ?? '' : ''); setEffort(prefs.apiIdentity === prefsApi ? prefs.effort ?? '' : ''); } }).catch(() => undefined);
    if (deviceId) setModels(desktopLive ? { models: [] } : cachedModels(deviceId, agent?.tool ?? 'codex') ?? { models: [] });
    followRef.current = true;
    const composer = createComposerDraftSession(draftKey, operationScope);
    const composerOwner = { key: draftKey, scope: operationScope, session: composer, ready: false, problem: undefined as string | undefined, submitting: false,
      durableRevision: undefined as number | undefined, durableIdentity: undefined as string | undefined, durableSnapshot: undefined as ComposerDraftInput | undefined, snapshot: { text: '', images: [] } as ComposerDraftInput };
    composerContext.current = composerOwner;
    setForeground(appForeground());
    const flushComposer = () => {
      const context = composerContext.current;
      if (!alive || !interactionCurrent() || context !== composerOwner || !context.ready || context.busy || context.submitting
        || queueBusyRef.current || (!composerTextRevision.current && !composerImageRevision.current)) return;
      const snapshot = copyComposerSnapshot(context.snapshot);
      if (context.durableSnapshot && context.durableSnapshot.text === snapshot.text && sameComposerSnapshot(context.durableSnapshot, snapshot)) return;
      void persistComposer(snapshot, context).then(() => {
        if (alive && interactionCurrent() && composerContext.current === context) setComposerSaveProblem('');
      }, reason => {
        if (alive && interactionCurrent() && composerContext.current === context) setComposerSaveProblem(`草稿尚未保存，输入仍在：${reason instanceof Error ? reason.message : '本机存储不可用'}`);
      });
    };
    const restoreApi = apiIdentityRef.current;
    // Settle an accepted UUID before restoring its old composer/queue. Local
    // cleanup never requires reconnecting or issuing the task again.
    const restoredReceipt = deviceId && (sessionKey || agent)
      ? sessionKey ? getPendingRemoteMessage(deviceId, sessionKey, { settleAccepted: true }) : getPendingNewSession(deviceId, agent!.tool, agent!.id === 'claude-desktop')
      : Promise.resolve(undefined);
    const restoreInputs = sessionKey ? restoredReceipt.catch(() => undefined) : Promise.resolve();
    void restoreInputs.then(() => composer.restore()).then(async saved => {
      // Only a genuinely absent unified record may consult a legacy exact
      // private text draft. Corrupt or unreadable storage is never absence.
      const savedText = saved?.text ?? await loadRemoteDraft(draftKey);
      if (!alive || !interactionCurrent() || composerContext.current !== composerOwner) return;
      composerOwner.durableRevision = saved?.revision;
      composerOwner.durableIdentity = saved?.identity;
      setSavedDraftOrigin(saved?.origin ? { key: draftKey, origin: saved.origin } : undefined);
      composerOwner.durableSnapshot = { text: savedText, images: saved?.images ?? [],
        ...(saved?.featureIntent ? { featureIntent: copyComposerFeatureIntent(saved.featureIntent, savedText) } : {}),
        ...(saved?.missingImages ? { imageCount: saved.imageCount, missingImages: true } : {}) };
      if (composerTextRevision.current === 0) {
        setTextState(current => current || savedText);
        if (saved?.featureIntent) {
          const intent = copyComposerFeatureIntent(saved.featureIntent, savedText)!;
          setIntentSource(intent.source); setCollaborationChoice(intent.collaborationMode);
          setContextReferences(copyContextReferences(intent.contextReferences) ?? []); setSelectedSkills(intent.skills ?? []); setSkillMentions(intent.mentions ?? []);
        }
      }
      if (composerImageRevision.current === 0 && restoreApi === apiIdentityRef.current) {
        setImagesState(saved?.images ?? []);
        if (saved?.missingImages) composerMissing.current = { key: draftKey, count: saved.imageCount };
      } else if (composerImageRevision.current === 0 && saved?.imageCount) {
        // An API switch during restoration cannot lose hidden attachments
        // and quietly send just the text through a different route.
        composerMissing.current = { key: draftKey, count: saved.imageCount };
      }
      composerOwner.ready = true; setComposerReady(true);
      if (!appForeground()) flushComposer();
    }).catch((error: Error) => {
      if (alive && interactionCurrent() && composerContext.current === composerOwner) composerOwner.problem = error.message;
    });
    void restoreInputs.then(() => loadQueuedDraftsSafe(draftKey)).then((saved) => {
      if (!alive || draftRef.current !== draftKey || queuedRestoreRevision.current !== queuedRevision) return;
      updateQueue(saved); setQueueChecked(true);
    }).catch(() => undefined);
    const readInitialHistory = () => {
      if (!alive || !deviceId || !sessionKey || controller.signal.aborted) return;
      const reading = controller;
      void openSession(deviceId, sessionKey, { signal: reading.signal, ...(desktopLive ? { controlSurface: 'desktop' as const } : {}) }).then(() => {
        if (alive && !reading.signal.aborted && controller === reading && draftRef.current === draftKey) {
          initialReadFinished = true;
          freshSnapshot.current = draftKey; setRestoreGeneration(value => value + 1);
        }
      }).catch(() => undefined);
    };
    if (deviceId && (sessionKey || agent)) {
      const readPending = restoredReceipt;
      void readPending.then((pending) => {
        if (!alive || !interactionCurrent()) return;
        if (pending) {
          const policy = deliveryRetryState(pending);
          const acceptedSessionKey = pending.acceptedSessionKey;
          setPendingDelivery({ requestId: pending.requestId, executionId: pending.executionId, text: pending.text, createdAt: pending.createdAt, attempted: pending.attempted, retryable: Boolean(acceptedSessionKey) || policy.retryable,
            message: acceptedSessionKey ? '消息已送达，手机确认记录未能清理，请先核对原会话' : policy.message,
            ...(acceptedSessionKey ? { acceptedSessionKey } : {}),
            ...(receiptComposerOwner(pending) ? { composerDraft: receiptComposerOwner(pending) } : {}) });
        }
        setPendingChecked(true);
      }).catch(() => undefined);
      if (sessionKey) void hydrateCachedThread(deviceId, sessionKey);
    } else setPendingChecked(true);
    const subscription = AppState.addEventListener('change', (next: string) => {
      if (!alive) return;
      setForeground(next === 'active');
      if (next !== 'active') {
        flushComposer();
        if (deviceId && sessionKey) resetIncompleteTurnRecovery(deviceId, sessionKey);
        controller.abort(); historyReadController.current?.abort(); historyReadController.current = null;
      } else if (!initialReadFinished && controller.signal.aborted) {
        controller = new AbortController(); readInitialHistory();
      }
    });
    if (AppState.currentState === 'background' || AppState.currentState === 'inactive') controller.abort();
    else readInitialHistory();
    return () => {
      alive = false; subscription.remove(); controller.abort(); historyReadController.current?.abort(); historyReadController.current = null;
      if (deviceId && sessionKey) resetIncompleteTurnRecovery(deviceId, sessionKey);
      if (composerOwner.ready && !composerOwner.submitting && (composerTextRevision.current || composerImageRevision.current)) {
        const restoring=(composerOwner as NonNullable<typeof composerContext.current>).editRestore;
        void persistComposer({...composerOwner.snapshot,...(restoring?{lastRestoredEdit:restoring.previousMarker}:{})}, composerOwner).catch(() => undefined).finally(() => composer.dispose());
      } else composer.dispose();
      if (composerContext.current === composerOwner) composerContext.current = undefined;
    };
  }, [visible, deviceId, sessionKey, draftKey, operationScope]); // eslint-disable-line react-hooks/exhaustive-deps

  const textRef = useRef(text); textRef.current = text;
  // Queue mutations persist at their point of ownership transfer. An unmount
  // must not write a stale render snapshot over a just-consumed accepted row.
  useEffect(() => {
    if (!visible || !foreground || !composerReady || sending || queueBusyRef.current || (!composerTextRevision.current && !composerImageRevision.current)) return;
    const context = composerContext.current;
    if (!context || context.key !== draftKey) return;
    const snapshot = context.snapshot;
    const timer = setTimeout(() => {
      if(context.busy||context.submitting||composerContext.current!==context||context.snapshot.text!==snapshot.text||!sameComposerSnapshot(snapshot,context.snapshot))return;
      void persistComposer(snapshot, context).then(() => {
        if (composerContext.current === context) setComposerSaveProblem('');
      }, reason => {
        if (composerContext.current === context) setComposerSaveProblem(`草稿尚未保存，输入仍在：${reason instanceof Error ? reason.message : '本机存储不可用'}`);
      });
    }, 400);
    return () => clearTimeout(timer);
  }, [text, images, draftKey, visible, foreground, composerReady, sending, JSON.stringify(featureDraftIntent)]);

  // A disconnected expired question must not hide the next actionable request.
  useEffect(() => {
    if (!visible) return;
    const now = Date.now();
    const next = timeline.items.reduce((deadline, item) => item.kind === 'approval' && item.state === 'pending' && item.expiresAt && item.expiresAt > now ? Math.min(deadline, item.expiresAt) : deadline, Infinity);
    if (!Number.isFinite(next)) return;
    const timer = setTimeout(() => setApprovalClock(Date.now()), Math.min(next - now + 1, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [visible, timeline.items, approvalClock]);
  const pending = useMemo(() => timeline.items.filter((item): item is ApprovalItem => item.kind === 'approval' && item.state === 'pending' && (!item.expiresAt || item.expiresAt > Date.now())), [visible, timeline.items, approvalClock]);
  const pendingSignature = JSON.stringify(pending.map(item => [item.id, item.approval, item.expiresAt]));
  const activeApproval = pending.find(item => selectedApproval?.scope === draftKey && item.id === selectedApproval.id) ?? pending[0];
  useEffect(() => {
    if (activeApproval && (selectedApproval?.scope !== draftKey || selectedApproval.id !== activeApproval.id)) setSelectedApproval({ scope: draftKey, id: activeApproval.id });
    const live = new Set(pending.map(item => item.id));
    for (const id of questionDrafts.current.values.keys()) if (!live.has(id)) questionDrafts.current.values.delete(id);
  }, [draftKey, pendingSignature, activeApproval?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const moveApproval = (offset: number) => {
    if (!interactionCurrent() || busyApproval || !activeApproval || pending.length < 2) return;
    const next = pending[(pending.findIndex(item => item.id === activeApproval.id) + offset + pending.length) % pending.length];
    setSelectedApproval({ scope: draftKey, id: next.id }); setDenying(null); setReason('');
  };
  const questionContext = useRef({ scope: draftKey, items: timeline.items, pending, online, desktopCanApprove });
  questionContext.current = { scope: draftKey, items: timeline.items, pending, online, desktopCanApprove };
  const problemQuestion = useRef('');
  useEffect(() => {
    if (activeApproval?.id && activeApproval.id !== problemQuestion.current) { problemQuestion.current = activeApproval.id; setQuestionProblem(''); }
  }, [activeApproval?.id]);
  const answerSending = Boolean(busyApproval && pending.some((item) => item.id === busyApproval && item.approval === 'question'));
  // Local dismissal is not a delivered/approved claim: receipt tracking stays in the main conversation.
  const question = visible && !answerSending && activeApproval?.approval === 'question' ? activeApproval : null;
  useEffect(() => {
    const request = approvalRequest.current;
    if (request && !pending.some((item) => item.id === request.id)) {
      request.controller?.abort(); approvalRequest.current = null; setBusyApproval(null);
    }
  }, [pending]);
  useEffect(() => {
    if (!visible || !deviceId || !sessionKey || timeline.loading || timeline.error || !timeline.snapshotAt || freshSnapshot.current !== draftKey) return;
    let active = true;
    const target = { scope: remoteDeliveryScope(), deviceId, sessionKey };
    // Local clock expiry only hides a form; it is not an authoritative withdrawal.
    // Retain its receipt tombstone until the computer actually resolves/removes it.
    const ids = timeline.items.filter((item): item is ApprovalItem => item.kind === 'approval' && item.approval === 'question'
      && (item.state === 'pending' || item.by === 'timeout')).map(item => item.id);
    void reconcileQuestionReceipts(target, ids, timeline.snapshotStartedAt ?? timeline.snapshotAt).then(() => pendingQuestionReceipts(target)).then(receipts => {
      if (!active || draftRef.current !== draftKey) return;
      const receipt = receipts.find(value => value.approvalId === activeApproval?.id && activeApproval?.approval === 'question');
      if (!receipt) return;
      answerDraft.current = { scope: draftKey, id: receipt.approvalId, answers: receipt.answers };
      if (receipt.blocked) { setQuestionProblem('请在电脑核对回答'); return; }
      const approval = pending.find(value => value.id === receipt.approvalId);
      if (approval && online && !approvalRequest.current) void decide(approval, receipt.decision, receipt.message, receipt.answers, receipt);
    }).catch(() => { if (active) setQuestionProblem('回答记录未恢复，请在电脑核对'); });
    return () => { active = false; };
  }, [visible, draftKey, operationScope, online, timeline.snapshotAt, timeline.loading, timeline.error, pendingSignature, activeApproval?.id, restoreGeneration]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!question) return;
    Keyboard.dismiss(); setPicker(null); setAttachMenu(false); setMenu(false); setDenying(null);
  }, [question?.id, draftKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const status = pending.length ? 'waiting_approval' : session?.status ?? 'idle';
  const running = status === 'running' || status === 'waiting_approval';
  const hostWorkActive = hasActiveAgentWork(session, timeline.items, pending.length, timeline.sessionSeq);
  const nativeBlocks = useMemo(() => conversationBlocks(buildBlocks(timeline.items, status === 'running'), tool, hostWorkActive), [timeline.items, status, tool, hostWorkActive]);
  const modelChanges = useModelChangeNotices(JSON.stringify([operationScope, prefsKey, apiIdentity]), `${draftKey}|${operationScope}|${apiIdentity}`, visible && !isNew && !readOnly, nativeBlocks);
  const blocks = useMemo(() => withModelChanges(nativeBlocks, modelChanges.records), [nativeBlocks, modelChanges.records]);
  const changedFiles = useMemo(() => lastTurnFiles(blocks), [blocks]);
  const readRetryProgressVisible = useDelayedNotice(visible && Boolean(readErrorValue) && isTransientReadFailure(readErrorValue) && !hostWorkActive,
    `${draftKey}|retry:${readErrorValue}:${readErrorRevision.current.startedAt}`,
    readErrorRevision.current.startedAt + REMOTE_RETRY_INDICATOR_DELAY_MS, false, REMOTE_RETRY_INDICATOR_DELAY_MS);
  const pendingNoticeClock = useRef<{ key: string; dueAt: number; deferredWhileWorking: boolean } | null>(null);
  if (!pendingNoticeClock.current || pendingNoticeClock.current.key !== pendingNoticeKey) {
    pendingNoticeClock.current = { key: pendingNoticeKey, dueAt: Date.now() + REMOTE_STATUS_NOTICE_DELAY_MS, deferredWhileWorking: false };
  }
  const pendingNoticeImmediate = Boolean(pendingDelivery && (!pendingDelivery.retryable || pendingDelivery.acceptedSessionKey));
  const pendingNeedsIdle = Boolean(pendingDelivery?.retryable && !pendingDelivery.acceptedSessionKey);
  if (pendingNeedsIdle && hostWorkActive) pendingNoticeClock.current.deferredWhileWorking = true;
  else if (pendingNeedsIdle && pendingNoticeClock.current.deferredWhileWorking) {
    // Let the agent's final echo/history sync arrive before escalating a stale
    // phone receipt. Only idle time counts toward a delayed delivery notice.
    pendingNoticeClock.current.dueAt = Date.now() + REMOTE_STATUS_NOTICE_DELAY_MS;
    pendingNoticeClock.current.deferredWhileWorking = false;
  }
  const pendingDeliveryNoticeVisible = useDelayedNotice(visible && Boolean(pendingDelivery) && (!pendingNeedsIdle || !hostWorkActive),
    pendingNoticeKey, pendingNoticeClock.current.dueAt, pendingNoticeImmediate);
  const pendingLocalMessage = !isNew && pendingDelivery?.retryable && !pendingDelivery.acceptedSessionKey && !hostWorkActive
    ? timeline.items.filter((item): item is Extract<TimelineItem, { kind: 'message' }> => item.kind === 'message' && item.local === true)
      .find(item => item.clientId === (pendingDelivery.executionId ?? pendingDelivery.requestId))
      ?? [...timeline.items].reverse().find((item): item is Extract<TimelineItem, { kind: 'message' }> => item.kind === 'message'
        && item.local === true && item.text === pendingDelivery.text)
    : undefined;
  const pendingDeliveryMessageId = pendingLocalMessage?.id;
  const retryTarget = useMemo(() => {
    const lastBlock = nativeBlocks[nativeBlocks.length - 1];
    if (lastBlock?.type !== 'turn' || lastBlock.item.status !== 'failed') return null;
    const failed = lastBlock.item;
    for (let index = timeline.items.length - 1; index >= 0; index -= 1) {
      const item = timeline.items[index];
      if (item.parentId) continue;
      if (item.kind === 'turn' && item.id !== failed.id
        && (item.status !== 'started' || item.turnId && failed.turnId && item.turnId !== failed.turnId)) return null;
      if (item.kind !== 'message' || item.role !== 'user') continue;
      // The nearest input owns this retry. Never replace a delegation,
      // pending local draft or another turn's input with an older request.
      if (item.messageOrigin || item.local || item.turnId && failed.turnId && item.turnId !== failed.turnId
        || !(item.text.trim() || item.attachments?.length || item.images?.length || item.contextReferences?.length)) return null;
      return { message: item, failed };
    }
    return null;
  }, [nativeBlocks, timeline.items]);
  const retryTargetRef = useRef(retryTarget);
  retryTargetRef.current = running ? null : retryTarget;
  // Keep the drawer's child section tied to protocol session handles, not to
  // display text.  A child can be created by a tool row nested in an activity
  // block, so collect both the direct and nested handles already exposed by
  // the normalized timeline.
  const childSessionKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const item of timeline.items) {
      if (item.kind === 'tool') for (const key of item.childSessionKeys ?? []) keys.add(key);
    }
    return [...keys];
  }, [timeline.items]);
  useEffect(() => {
    const changedSession = sidebarSessionRef.current !== sessionKey;
    sidebarSessionRef.current = sessionKey;
    if (!visible || !deviceId || isNew || (changedSession && sidebarChildRouteRef.current !== sessionKey)) {
      setSidebarOpen(false);
      setSidebarFocus(null);
      setSidebarFile(null);
      setPreviewTarget(null);
      setDiffFile(null);
    }
    if (changedSession && sidebarChildRouteRef.current === sessionKey) sidebarChildRouteRef.current = null;
  }, [visible, deviceId, isNew, sessionKey]);
  const last = nativeBlocks[nativeBlocks.length - 1];
  const thinking = status === 'running' && !(last?.type === 'activity' && last.live) && !(last?.type === 'assistant' && !last.item.final);
  const externallyOwnedBusy = Boolean(session && session.controllable === false && running);
  const externalBusy = contextBusy || externallyOwnedBusy;
  const recentProblem = useMemo(() => {
    for (let index = timeline.items.length - 1; index >= 0; index -= 1) {
      const item = timeline.items[index];
      if ('parentId' in item && item.parentId) continue;
      if (item.kind === 'turn') { const problem = item.status === 'failed' && item.id !== dismissedError ? apiProblem(item.error, item.errorCode) : null; return problem ? { ...problem, id: item.id } : null; }
      if (item.kind === 'notice' && item.level === 'error' && !item.retrying && item.id !== dismissedError) { const problem = apiProblem(item.text, item.errorCode); if (problem) return { ...problem, id: item.id }; }
    }
    return null;
  }, [timeline.items, dismissedError]);

  // After opening a thread, and whenever the app comes back to the foreground, follow it for
  // two minutes so work continued on the computer shows up without leaving and re-entering.
  useEffect(() => {
    if (!visible || !deviceId || !sessionKey) return undefined;
    setWatchUntil(Date.now() + 120_000);
    const subscription = AppState.addEventListener('change', (next: string) => { if (next === 'active') setWatchUntil(Date.now() + 120_000); });
    return () => subscription.remove();
  }, [visible, deviceId, sessionKey]);
  // `Date.now() < watchUntil` is deliberately evaluated during render, but a
  // timestamp expiring by itself does not cause React to render again.  Without
  // an explicit wake-up the live-sync effect would therefore keep polling
  // forever after the two-minute foreground window ended (until some unrelated
  // state change).  Release the demand window at its deadline so an idle thread
  // really becomes idle and the Hub receives no needless reads.
  useEffect(() => {
    if (!visible || !watchUntil) return undefined;
    const remaining = watchUntil - Date.now();
    if (remaining <= 0) { setWatchUntil(0); return undefined; }
    const timer = setTimeout(() => setWatchUntil(0), Math.min(remaining + 1, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [visible, watchUntil]);
  // A long turn may finish after the foreground watch window. Keep its bounded
  // transcript repair alive until the missing final arrives or repair expires.
  const recoveringReply = timeline.items.some(item => item.kind === 'message' && item.role === 'assistant'
    && item.streamState === 'terminal-unconfirmed' && Boolean(item.turnId));
  const needLive = Boolean(visible && deviceId && sessionKey) && (running || recoveringReply || Date.now() < watchUntil || Boolean(pendingDelivery?.retryable));
  useLiveSync(Boolean(visible && deviceId && sessionKey), needLive, !desktopLive && !readOnly && hubSupportsWait(), async (wait, signal) => {
    if (!deviceId || !sessionKey || signal?.aborted) return;
    if (pendingDelivery?.retryable && pendingDelivery.requestId && stopRef.current?.key !== draftKey) await deliver(pendingDelivery.text, true, [], undefined, false, pendingDelivery.requestId);
    if (signal?.aborted) return;
    if (desktopLive) await openSession(deviceId, sessionKey, { background: true, signal, controlSurface: 'desktop' });
    else await syncSessionEvents(deviceId, sessionKey, wait, signal);
  }, watchUntil);

  const refresh = async () => {
    if (!interactionCurrent() || !deviceId || !sessionKey) return;
    const key = draftKey;
    await openSession(deviceId, sessionKey, desktopLive ? { controlSurface: 'desktop' } : undefined);
    if (interactionCurrent() && draftRef.current === key) setWatchUntil(Date.now() + 120_000);
  };
  const recordApiError = (error: unknown) => {
    if (modelCapabilityProblem(error)) {
      effortRef.current = ''; setEffort('');
      modelRequestRef.current += 1; setCatalogOwner(''); setModelsLoading(false); setModels({ models: [] });
      setCatalogError(''); setApiError(null); setModelEpoch(value => value + 1);
    } else if (managedApi && modelCatalogProblem(error)) {
      modelRequestRef.current += 1;
      setCatalogOwner(''); setCatalogError('请选择模型');
      setModelsLoading(false); setModels({ models: [] }); setApiError(null);
    } else setApiError(apiProblem(error));
  };

  const acceptNewTask = async (key: string, composer: NonNullable<typeof composerContext.current>, original?: { key: string; revision: number; identity?: string }) => {
    void requestNotificationPermission(); noteTaskSent(deviceId!, key);
    const acceptedScope = composer.scope, acceptedDevice = deviceId!, acceptedTool = agent!.tool, acceptedDesktop = agent!.id === 'claude-desktop';
    const ownsOriginal = Boolean(original?.identity && original.key === composer.key);
    const unchanged = ownsOriginal && composer.durableIdentity === original!.identity && composer.durableRevision === original!.revision && composer.durableSnapshot
      && sameComposerSnapshot(composer.snapshot, composer.durableSnapshot);
    const originalTextRevision = composerTextRevision.current, originalImageRevision = composerImageRevision.current;
    // Unknown acceptance may have left the user composing a different task.
    // Commit that snapshot before an old accepted revision can be consumed.
    let preserved = true;
    if (interactionCurrent() && composerContext.current === composer && !unchanged && composer.ready) {
      await persistComposer(composer.snapshot, composer).catch((error: Error) => {
        preserved = false;
        composer.submitting = false;
        if (interactionCurrent()) showToast(error.message, 'alert');
      });
    }
    const cleanup = ownsOriginal && preserved ? consumeComposer(composer, original!.revision, original!.identity).catch((error: Error) => {
      if (interactionCurrent()) showToast(error.message, 'alert');
      return false;
    }) : Promise.resolve(false);
    if (interactionCurrent() && composerContext.current === composer) {
      setPendingDelivery(null);
      if (unchanged && originalTextRevision === composerTextRevision.current && originalImageRevision === composerImageRevision.current) {
        clearFeatureSelection(); setText(''); setImages([]);
      }
      void saveThreadPrefs(`${remote.connectionId ?? remote.selectedHubUrl ?? ''}|${deviceId}|${key}`, { model: model || undefined, effort: effort || undefined, apiIdentity }).catch(() => undefined);
      // Acceptance owns the task even if local receipt/draft cleanup fails.
      onCreated(key);
    }
    // Navigation may already have replaced the visual owner. A local ACK is
    // authorized by the original pairing and successful draft CAS, not that
    // old render; failed cleanup or newer edits retain the accepted receipt.
    if (await cleanup && remoteDeliveryScope() === acceptedScope) {
      await acknowledgeNewSession(acceptedDevice, acceptedTool, acceptedDesktop, key, acceptedScope).catch((error: Error) => {
        if (interactionCurrent()) showToast(error.message, 'alert');
      });
    }
  };

  const deliver = async (value: string, silent = false, attached: RemoteImage[] = [], frozen?: import('./store').SendOptions, restoreDraft = true, retryRequestId?: string, draftOwner?: DeliveryDraftOwner, observeRejection?: (confirmed: boolean) => void): Promise<'sent' | 'pending' | 'rejected' | 'stale'> => {
    const acceptedRecovery = Boolean(pendingDelivery?.acceptedSessionKey) && pendingDelivery?.requestId === retryRequestId;
    // A missing API blocks new work, not reconciliation of an already attempted
    // Claude UUID. The store still verifies and reuses its immutable wire body.
    const receiptRecovery = acceptedRecovery || Boolean(tool === 'claude' && !readOnly && !desktopLive && online
      && pendingDelivery?.attempted && retryRequestId && pendingDelivery.requestId === retryRequestId);
    if (!interactionCurrent() || !appForeground() || !receiptRecovery && !composerSendOwnerRef.current.allowed || !deviceId || (!sessionKey && !isNew)) return 'stale';
    const newComposer = isNew ? composerContext.current : undefined;
    if (isNew && (!agent || !retryRequestId || pendingDelivery?.requestId !== retryRequestId || !newComposer?.ready || newComposer.busy || newComposer.submitting)) return 'stale';
    const key = draftKey;
    try {
      if (isNew && agent && newComposer && retryRequestId) {
        newComposer.busy = true;
        // Preserve edits made while the original start was awaiting a receipt.
        // This is a local metadata write, not a second task or an auto retry.
        if (!newComposer.durableSnapshot || !sameComposerSnapshot(newComposer.snapshot, newComposer.durableSnapshot)) await persistComposer(newComposer.snapshot, newComposer);
        if (!interactionCurrent() || !appForeground() || !receiptRecovery && !composerSendOwnerRef.current.allowed || apiSwitchingRef.current) return 'stale';
        newComposer.submitting = true;
        const acceptedKey = await retryNewSession(deviceId, agent.tool, agent.id === 'claude-desktop', retryRequestId);
        await acceptNewTask(acceptedKey, newComposer, pendingDelivery?.composerDraft);
        return 'sent';
      }
      const diffProblem = !retryRequestId && diffReviewProblem(diffTimeline.current, sessionKey!, (frozen ?? turnFeatures).contextReferences);
      if (diffProblem) throw new Error(diffProblem);
      await sendToSession(deviceId, sessionKey!, value, retryRequestId ? { retryRequestId }
        : { ...(frozen ?? { model: nextModel || undefined, effort: effectiveEffort || undefined, ...turnFeatures, permissionMode: nextPermissionMode, approval: nextApproval, accountId: selectedAccountId, surface: desktopLive ? 'desktop' : 'cli' }), images: attached, newSubmission: true, ...(draftOwner ? { draftOwner } : {}) });
      void requestNotificationPermission(); noteTaskSent(deviceId, sessionKey!);
      if (!interactionCurrent()) return 'sent';
      setPendingDelivery(null);
      if (!frozen && !retryRequestId) {
        setPermissionChoice(undefined); setMode(undefined);
        if (!composerContext.current?.snapshot.text) clearFeatureSelection();
      }
      setWatchUntil(Date.now() + 120_000);
      return 'sent';
    } catch (error) {
      if (!interactionCurrent()) { if (silent) throw error; return 'stale'; }
      let receiptOwnsMessage = false;
      if (draftRef.current === key) recordApiError(error);
      if (error instanceof DeliveryPendingError && draftRef.current === key) {
        const pending = await (isNew && agent ? getPendingNewSession(deviceId, agent.tool, agent.id === 'claude-desktop') : getPendingRemoteMessage(deviceId, sessionKey!)).catch(() => {
          if (isNew && interactionCurrent()) setPendingChecked(false);
          return undefined;
        });
        if (interactionCurrent() && draftRef.current === key) {
          receiptOwnsMessage = Boolean(pending && error.requestId && pending.requestId === error.requestId && (retryRequestId === error.requestId || error.receiptCreatedByCall === true));
          const policy = pending ? deliveryRetryState(pending) : null;
          const acceptedSessionKey = pending?.acceptedSessionKey;
          // A durable receipt can be intentionally blocked (for example when
          // its original image disappeared from the phone).  Do not derive a
          // retryable state solely from the receipt age or the sync loop will
          // retry that impossible upload forever.
          setPendingDelivery(pending ? { requestId: pending.requestId, executionId: pending.executionId, text: pending.text, createdAt: pending.createdAt, attempted: pending.attempted,
            retryable: Boolean(acceptedSessionKey) || (receiptOwnsMessage ? error.retryable && (policy?.retryable ?? true) : policy?.retryable ?? false),
            message: acceptedSessionKey ? '消息已送达，手机确认记录未能清理，请先核对原会话' : receiptOwnsMessage && !error.retryable ? error.message : policy?.message ?? error.message,
            ...(acceptedSessionKey ? { acceptedSessionKey } : {}),
            ...(receiptComposerOwner(pending) ? { composerDraft: receiptComposerOwner(pending) } : {}) } : isNew ? pendingDelivery : null);
          if (restoreDraft && pending && pending.text !== value) {
            setText((current) => current || value);
          }
        }
      }
      if (silent) throw error;
      if (!(error instanceof DeliveryPendingError && error.retryable && receiptOwnsMessage)) showToast((error as Error).message, 'alert');
      if (restoreDraft && draftRef.current === key && !receiptOwnsMessage) {
        setText((current) => current || value);
        if (attached.length) setImages((current) => current.length ? current : attached);
      }
      // An unreadable/missing receipt is not proof that a timed-out request
      // was rejected. Edit recovery must retain the ambiguous backup.
      observeRejection?.(!(error instanceof DeliveryPendingError));
      return receiptOwnsMessage ? 'pending' : 'rejected';
    } finally {
      if (newComposer) { newComposer.busy = false; newComposer.submitting = false; }
    }
  };

  const applyComposerEdit = (next: { text: string; mentions: SkillMention[]; caret?: number }) => {
    setText(next.text); setSkillMentions(next.mentions); setSelectedSkills(next.mentions.map(value => ({ ...value.skill })));
    if (next.mentions.length) setIntentSource(featureSource);
    if (next.caret !== undefined) {
      setInputSelection({ text: next.text, start: next.caret, end: next.caret });
      setForcedSelection({ start: next.caret, end: next.caret });
    }
  };
  const editComposerText = (value: string, projectedEdit?: { text: string; mentions: SkillMention[]; caret?: number }) => {
    // Native text events already queued before the input became disabled still
    // belong to this draft. Preserve them; submission receipts own their copy.
    if (featureOwner.current !== featureScope || !interactionCurrent() || featureSourceBlocked) return;
    const next = projectedEdit ?? reconcileSkillMentions(text, value, skillMentions);
    applyComposerEdit(next); setSlashDismissed(undefined);
    if (next.caret === undefined) { setInputSelection(undefined); setForcedSelection(undefined); }
  };
  const featureSelectionCurrent = () => {
    const composer = composerContext.current;
    return featureCatalogCurrent() && interactionCurrent() && !featureSourceBlocked && featureEligible && online && composer?.ready
      && composer.key === draftKey && composer.snapshot.text === text && !permissionRuntime.current.locked && !apiSwitchingRef.current
      && !composer.busy && !composer.submitting && !queueBusyRef.current;
  };
  const selectSlashCommand = (entry: SlashCommandEntry) => {
    const liveDirectory = getRemoteState().agents[deviceId ?? ''];
    const liveAgent = liveDirectory?.list.find(value => value.id === agent?.id) ?? (liveDirectory?.loaded ? null : agent);
    if (JSON.stringify([liveAgent?.api, liveAgent?.capabilities, liveAgent?.desktopLive, liveAgent?.execution]) !== slashAgentSignature) return;
    const selected = slashEntries.find(candidate => candidate.id === entry.id), composer = composerContext.current;
    if (!slashQuery || !selected || slashSelectionOwner.current !== renderedSlashOwner || !interactionCurrent() || !appForeground() || !online || !composer?.ready || composer.key !== draftKey
      || composer.snapshot.text !== text || permissionRuntime.current.locked || apiSwitchingRef.current || composer.busy || composer.submitting || queueBusyRef.current
      || slashCommandDisabled(selected, { loading: featureEligible && (!featureStateCurrent || featureState.loading), error: featureStateCurrent ? featureState.error : '' })) return;
    entry = selected;
    if (entry.kind !== 'action' && entry.kind !== 'compact' && !featureSelectionCurrent()) return;
    if (entry.kind === 'action') {
      if (!entry.action) return;
      const edit = entry.action === 'init' ? initializationDraft(text, slashQuery) : { text: applySlashCommand(text, slashQuery, entry), caret: slashQuery.replaceStart };
      applyComposerEdit({ ...reconcileSkillMentions(text, edit.text, skillMentions), caret: edit.caret });
      setSlashDismissed(undefined); setSlashFocus({ key: '', index: 0 });
      if (entry.action === 'model') openModels();
      else if (entry.action === 'reasoning') setPicker('effort');
      else if (entry.action === 'permissions') setPicker(tool === 'codex' ? 'permission' : 'mode');
      else if (entry.action === 'new') onNew?.(workspaceMode, session?.projectless || projectless ? '' : session?.cwd || cwd, ...(session?.projectless || projectless ? [true as const] : []));
      else if (entry.action === 'side') { Keyboard.dismiss(); setSlashSideChat({ scope: contextScope, nonce: ++annotationEditSequence.current }); setSidebarOpen(true); }
      else if (entry.action === 'fork' || entry.action === 'archive' || entry.action === 'review') setSlashSessionCommand({ scope: contextScope, command: entry.action });
      else if (entry.action === 'init') composerInput.current?.focus();
      return;
    }
    if (entry.kind === 'compact') {
      if (!compactSupported || contextScopeRef.current !== contextScope || contextBusyRef.current) return;
      if (!contextBar.current?.compact()) { showToast('当前上下文不能压缩', 'code'); return; }
    } else if (entry.kind === 'mode') {
      if (!entry.mode || !features?.collaborationModes.includes(entry.mode)) return;
      setCollaborationChoice(entry.mode);
      setIntentSource(featureSource); composerTextRevision.current += 1;
    } else if (entry.kind === 'skill') {
      if (!entry.skill || !features?.skills.some(skill => skillKey(skill) === skillKey(entry.skill!))) return;
      if (tool === 'claude' && selectedSkills.length && !selectedSkills.some(skill => skillKey(skill) === skillKey(entry.skill!))) {
        showToast('Claude Code 每条消息支持一个技能，请先删除已选技能', 'code'); return;
      }
      try { applyComposerEdit(insertSkillMention(text, slashQuery.replaceStart, slashQuery.replaceEnd, entry.skill, skillMentions)); }
      catch (error) { showToast((error as Error).message, 'alert'); return; }
    }
    if (entry.kind !== 'skill') {
      const value = applySlashCommand(text, slashQuery, entry);
      applyComposerEdit({ ...reconcileSkillMentions(text, value, skillMentions), caret: slashQuery.replaceStart + (entry.kind === 'skills' ? '/skills '.length : 0) });
    }
    setSlashDismissed(undefined); setSlashFocus({ key: '', index: 0 });
    composerInput.current?.focus();
  };
  const disablePlan = () => {
    if (!featureSelectionCurrent()) return;
    setIntentSource(featureSource); composerTextRevision.current += 1;
    if (features?.collaborationModes.includes('default')) setCollaborationChoice('default');
    else if (session?.collaborationMode !== 'plan') setCollaborationChoice(undefined);
  };
  const clearFeatureRevision = composerTextRevision.current;
  const clearUnavailableFeatures = () => {
    const composer = composerContext.current;
    // Clearing does not depend on catalog freshness, but must own the exact
    // draft intent even when a same-name skill leaves the visible text equal.
    if (featureOwner.current !== featureScope || !interactionCurrent() || !composer || composer.snapshot.text !== text
      || composerTextRevision.current !== clearFeatureRevision || JSON.stringify(composer.snapshot.featureIntent) !== JSON.stringify(featureDraftIntent)
      || sending || composer.busy || composer.submitting || queueBusyRef.current) return;
    const body = stripSkillMentions(text, skillMentions);
    clearFeatureSelection(); setText(body); setInputSelection(undefined); setForcedSelection(undefined);
  };
  const closeSlash = () => { if (featureOwner.current === featureScope && featureGenerationCurrent() && interactionCurrent()) setSlashDismissed(slashKey); };
  const send = async (intent: 'queue' | 'steer' = 'queue') => {
    if(editBackup.blocked){showToast('请先核对上次编辑保留的内容','alert');return;}
    if (contextBusyRef.current) return;
    if (featureEligible && (!featureGenerationCurrent() || (collaborationChoice || selectedSkills.length) && !featureCatalogCurrent())) return;
    if (referenceQuery || referencePreview) { referencePicker.current?.keyDown('Enter'); return; }
    if (slashQuery) {
      if (slashEntries[slashIndex]) selectSlashCommand(slashEntries[slashIndex]);
      return;
    }
    if (!composerSendCurrent() || busyApproval || !desktopCanSend || stopRef.current?.key === draftKey) return;
    if (featureSourceBlocked) { showToast('草稿的模式、技能或引用来自其他来源，请切回原来源或清除后重新选择', 'alert'); return; }
    if (diffDraftProblem) { showToast(diffDraftProblem, 'alert'); return; }
    const value = stripSkillMentions(text, skillMentions).trim();
    if (!value && selectedSkills.length && !images.length && !contextReferences.length) { showToast('补充任务内容后发送', 'code'); return; }
    if ((!value && !images.length && !contextReferences.length) || sending || queueBusyRef.current || !queueChecked || !pendingChecked || !deviceId || !agent) return;
    const composer = composerContext.current;
    if (!composerReady || !composer?.ready || composer.key !== draftKey) { showToast(composer?.problem || '草稿尚未读取，原内容未覆盖', 'alert'); return; }
    if (composer.busy || composer.submitting) return;
    if (composerMissing.current?.key === draftKey) { showToast('请重新选择全部原图片，不会只发送文字', 'alert'); return; }
    if (apiSwitchingRef.current) return;
    if (!pendingDelivery && images.length && modelRejectsImagesRef.current) {
      showToast('当前模型仅支持文字，请移除图片或更换模型', 'alert'); return;
    }
    if (!pendingDelivery && images.length && !composerSendOwnerRef.current.imagesAllowed) {
      showToast('当前会话暂不支持发送图片，原内容未发送', 'alert'); return;
    }
    if (!pendingDelivery && desktopLive && (permissionChoice || !nativeModelEditable && (modelRef.current || effortRef.current))) {
      showToast('桌面实时连接请使用电脑设置；消息未发送', 'alert'); openModels(); return;
    }
    if (pendingDelivery) {
      showToast('上一条消息还在确认，请先处理待确认消息；新内容仍保留在输入框', 'alert');
      return;
    }
    if (intent === 'steer') {
      const expectedTurnId = turnControlTarget(timeline, 'stop');
      if (isNew || desktopLive || !running || !expectedTurnId || currentAgent?.capabilities?.steer !== true || !hubSupportsSteer?.()
        || images.length || queuedRef.current.length || queueRepairId || externalBusy) return;
      // Explicitly selected next-turn settings remain for the next send, not
      // silently applied (or discarded) by the active-turn text-only contract.
      if (permissionChoice !== undefined || mode !== undefined || collaborationChoice !== undefined || selectedSkills.length || contextReferences.length || effort || model && model !== session?.model) {
        showToast('工作模式、技能、引用、模型和权限应用到下一轮，更换设置请排队发送', 'alert'); return;
      }
      composer.busy = true; setSending(true);
      try {
        const prepared = await persistComposer({ text: value, images: [] }, composer);
        if (!composerSendCurrent()) return;
        composer.submitting = true; setText(''); followRef.current = true;
        const result = await deliver(value, false, [], { control: 'steer', expectedTurnId, accountId: selectedAccountId, surface: 'cli' }, true, undefined,
          { kind: 'composer', key: composer.key, revision: prepared.revision, identity: prepared.identity! });
        if (result === 'pending') await consumeComposer(composer, prepared.revision, prepared.identity);
      } catch (error) { if (interactionCurrent()) showToast((error as Error).message, 'alert'); }
      finally { composer.busy = false; composer.submitting = false; if (interactionCurrent()) setSending(false); }
      return;
    }
    if (featuresBlocked) { showToast('请重新选择工作模式或技能', 'listCheck'); return; }
    if (permissionBlocked) { showToast('请重新选择批准权限', 'lock'); setPicker(tool === 'claude' ? 'mode' : 'permission'); return; }
    if (!pendingDelivery && modelBlocked) {
      openModels(); return;
    }
    const repairing = queuedRef.current[0];
    if (!pendingDelivery && queueRepairId && repairing && queueRepairId === (repairing.id ?? 'restored-head')) {
      if ((repairing.sendOptions?.collaborationMode || repairing.sendOptions?.skills?.length || repairing.sendOptions?.contextReferences?.length)
        && (repairing.scope !== operationScope || repairing.apiIdentity !== apiIdentity || repairing.sendOptions?.surface !== (desktopLive ? 'desktop' : 'cli'))) {
        showToast('请切回原消息的来源后再发送，原工作模式、技能和引用仍保留', 'alert'); return;
      }
      const expectedImages = repairing.imageCount ?? repairing.images.length;
      if (repairing.missingImages && images.length !== expectedImages) { showToast(`请重新选择原消息的 ${expectedImages} 张图片，不会只发送文字`, 'alert'); return; }
      if (externalBusy) return;
      const queueEpoch = queueStopEpoch.current;
      const queueStillOwned = () => queueEpoch === queueStopEpoch.current && stopRef.current?.key !== draftKey;
      queueBusyRef.current = true; setSending(true);
      const replacement: LoadedQueuedRemoteDraft = { id: repairing.id ?? `${randomUUID()}-${++queueSequence}`, text: value, images, imageCount: images.length,
        state: running ? 'waiting' : 'attempting', attempted: !running, scope: operationScope, apiIdentity,
        sendOptions: { model: nextModel || undefined, effort: effectiveEffort || undefined, ...turnFeatures, permissionMode: nextPermissionMode, approval: nextApproval, accountId: selectedAccountId, surface: desktopLive ? 'desktop' : 'cli' } };
      let owned = false;
      let stagedHead = repairing;
      try {
        const rows = [replacement, ...queuedRef.current.slice(1)];
        const saved = await saveQueuedDraftsSafe(draftKey, rows);
        if (!interactionCurrent() || !queueStillOwned()) return;
        updateQueue(saved);
        // Accepted receipts may remove this row during the storage wait.
        // The next row must never inherit the edited prompt's ownership.
        if (!sameQueuedDraft(saved[0], replacement)) { setQueueRepairId(null); return; }
        stagedHead = saved[0];
        clearFeatureSelection();
        setText(''); setImages([]); setQueueRepairId(null); void persistComposer(composer.snapshot, composer).catch(() => undefined);
        if (running) return;
        const attached = await hydrateQueuedImages(stagedHead);
        if (!interactionCurrent() || !queueStillOwned()) return;
        if (apiIdentityRef.current !== stagedHead.apiIdentity) throw new Error('API 已改变，排队消息仍保留，请核对后发送');
        const result = await deliver(value, false, attached, stagedHead.sendOptions, false, undefined,
          { kind: 'queue', key: draftKey, id: stagedHead.id!, afterTurn: queueTurnMarker });
        if (!interactionCurrent() || !queueStillOwned() || result === 'stale') return;
        owned = result === 'sent' || result === 'pending';
        const remaining = owned ? queuedRef.current.filter(row => !sameQueuedDraft(row, stagedHead))
          : queuedRef.current.map(row => sameQueuedDraft(row, stagedHead) ? { ...row, state: 'blocked' as const } : row);
        if (owned && remaining.length) remaining[0] = { ...remaining[0], afterTurn: queueTurnMarker };
        updateQueue(remaining); const savedRemaining = await saveQueuedDraftsSafe(draftKey, remaining);
        if (interactionCurrent() && queueStillOwned()) updateQueue(savedRemaining);
      } catch (error) {
        if (interactionCurrent() && queueStillOwned()) {
          if (!owned) updateQueue(queuedRef.current.map(row => sameQueuedDraft(row, stagedHead) ? { ...row, state: 'blocked' } : row));
          showToast((error as Error).message, 'alert');
        }
      } finally { if (interactionCurrent()) { queueBusyRef.current = false; setSending(false); } }
      return;
    }
    if (!isNew && !running && queuedRef.current.length && !pendingDelivery) {
      showToast('请先处理排队消息，避免消息乱序', 'alert'); return;
    }
    // Busy agent: hold the message and send it when the current turn ends.
    if (!isNew && running && !pendingDelivery && !externalBusy) {
      const attached = images;
      if (queuedRef.current.length >= (MAX_REMOTE_QUEUE ?? 10)) { showToast('排队消息已满，请先处理已有消息', 'alert'); return; }
      queueBusyRef.current = true; setSending(true);
      const next: LoadedQueuedRemoteDraft = { id: `${randomUUID()}-${++queueSequence}`, text: value, images: attached, imageCount: attached.length, state: 'waiting', attempted: false,
        scope: operationScope, apiIdentity, sendOptions: { model: nextModel || undefined, effort: effectiveEffort || undefined, ...turnFeatures, permissionMode: nextPermissionMode, approval: nextApproval,
          accountId: selectedAccountId, surface: desktopLive ? 'desktop' : 'cli' } };
      const rows = [...queuedRef.current, next];
      ++queuedRestoreRevision.current;
      try {
        const saved = await saveQueuedDraftsSafe(draftKey, rows);
        if (!interactionCurrent()) return;
        updateQueue(saved);
        setPermissionChoice(undefined);
        setMode(undefined);
        clearFeatureSelection();
        setText(''); setImages([]); void persistComposer(composer.snapshot, composer).catch(() => undefined);
        followRef.current = true;
      } catch (error) { if (interactionCurrent()) showToast((error as Error).message, 'alert'); }
      finally { if (interactionCurrent()) { queueBusyRef.current = false; setSending(false); } }
      return;
    }
    followRef.current = true;
    composer.busy = true;
    setSending(true);
    try {
      if (isNew && !hasNewLocation) { showToast('请返回项目目录，选择项目后新建会话', 'alert'); return; }
      // Persist before transferring ownership to the outbox/computer. A
      // slow metadata/file read cannot send through a subsequently changed
      // Key, model, Agent, desktop lease or pairing.
      const prepared = await persistComposer({ text, images, ...(featureDraftIntent ? { featureIntent: featureDraftIntent } : {}) }, composer);
      const attached = await hydrateComposerImages(operationScope, prepared);
      if (!composerSendCurrent() || featureEligible && (!featureGenerationCurrent() || (collaborationChoice || selectedSkills.length) && !featureCatalogCurrent())) return;
      if (attached.length && modelRejectsImagesRef.current) { showToast('当前模型仅支持文字，请移除图片或更换模型', 'alert'); return; }
      if (attached.length && !composerSendOwnerRef.current.imagesAllowed) { showToast('当前会话暂不支持发送图片，原内容未发送', 'alert'); return; }
      composer.submitting = true;
      if (isNew) {
        const prompt = seed ? `下面是我之前在 Claude Desktop 里的对话《${seed.title}》。请接着这个话题继续帮我，这次在 Claude Code 中进行。\n\n<之前的对话>\n${seed.transcript}\n</之前的对话>\n\n我的新消息：${value}` : value;
        const original = { key: composer.key, revision: prepared.revision, identity: prepared.identity };
        if (!execution) return;
        const key = await startSession(deviceId, { tool: execution.tool, cwd, ...(projectless ? { projectless: true as const } : {}), prompt, workspaceMode, model: nextModel || undefined, effort: effectiveEffort || undefined, approval: nextApproval ?? 'ask', ...turnFeatures, permissionMode: nextPermissionMode, accountId: currentAgent?.api.accountId, images: attached, desktop: execution.entrypoint === 'claude-desktop', composerDraft: original });
        await acceptNewTask(key, composer, original);
      } else {
        setText(''); setImages([]);
        const result = await deliver(value, false, attached, undefined, true, undefined,
          { kind: 'composer', key: composer.key, revision: prepared.revision, identity: prepared.identity! });
        if (result === 'sent' || result === 'pending') {
          if (interactionCurrent() && !composer.snapshot.text) clearFeatureSelection();
          if (result === 'pending') await consumeComposer(composer, prepared.revision, prepared.identity);
        }
        else if (result === 'rejected' && interactionCurrent() && selectedSkills.length
          && (composer.snapshot.text === value || !composer.snapshot.text)) {
          applyComposerEdit(restoreSkillMentions(value, selectedSkills));
        }
      }
    } catch (error) { if (interactionCurrent()) {
      let pendingReceiptLoaded = false;
      if (isNew && error instanceof DeliveryPendingError) {
        try {
          const pending = await getPendingNewSession(deviceId, agent.tool, agent.id === 'claude-desktop');
          if (interactionCurrent() && pending) {
            pendingReceiptLoaded = true;
            const policy = deliveryRetryState(pending), originalError = error.requestId === pending.requestId;
            setPendingDelivery({ requestId: pending.requestId, executionId: pending.executionId, text: pending.text, createdAt: pending.createdAt, attempted: pending.attempted, retryable: Boolean(pending.acceptedSessionKey) || policy.retryable && (!originalError || error.retryable),
              message: pending.acceptedSessionKey ? '消息已送达，手机确认记录未能清理，请先核对原会话' : originalError && !error.retryable ? error.message : policy.message,
              ...(pending.acceptedSessionKey ? { acceptedSessionKey: pending.acceptedSessionKey } : {}), ...(pending.composerDraft ? { composerDraft: pending.composerDraft } : {}) });
          }
        } catch { if (interactionCurrent()) setPendingChecked(false); }
      }
      if (interactionCurrent()) { recordApiError(error); if (!pendingReceiptLoaded) showToast((error as Error).message, 'alert'); }
    } }
    finally { composer.busy = false; composer.submitting = false; if (interactionCurrent()) setSending(false); }
  };

  const lastQueueTurn = [...timeline.items].reverse().find(item => item.kind === 'turn' && !item.parentId);
  const queueTurnMarker = lastQueueTurn ? `${lastQueueTurn.id}|${lastQueueTurn.seq ?? 0}|${lastQueueTurn.ts}` : '';
  const queueTurnFinished = lastQueueTurn?.kind === 'turn' && lastQueueTurn.status !== 'started';
  // Persist attempting before dispatch. A crash can require manual review,
  // but cannot turn an uncertain submission into a second fresh command.
  useEffect(() => {
    if (!queued || queued.state !== 'waiting' || queued.missingImages || !queueChecked || !pendingChecked || !foreground || !appForeground() || isNew || running || sending || queueBusyRef.current || stopState?.key === draftKey
      || !online || !desktopCanSend || busyApproval || pendingDelivery || verifying || apiSwitching || (managedApi && !catalogReady)
      || queued.scope !== operationScope || queued.apiIdentity !== apiIdentity || queued.sendOptions?.surface !== (desktopLive ? 'desktop' : 'cli')
      || (queued.afterTurn !== undefined && (!queueTurnFinished || queueTurnMarker === queued.afterTurn))) return;
    if (!queueExplicitResumes.current.has(queued.id ?? '') && lastQueueTurn?.kind === 'turn' && (lastQueueTurn.status === 'failed' || lastQueueTurn.status === 'interrupted')) {
      // A full model, failed provider, or user stop must not drain follow-ups
      // through the same failed route. Keep the original queue for review.
      const blocked = [{ ...queued, state: 'blocked' as const }, ...queuedRef.current.slice(1)];
      queueBusyRef.current = true; updateQueue(blocked);
      void saveQueuedDraftsSafe(draftKey, blocked).then(saved => {
        if (interactionCurrent()) updateQueue(saved);
      }).catch((error: Error) => {
        if (interactionCurrent()) showToast(error.message, 'alert');
      }).finally(() => { if (interactionCurrent()) queueBusyRef.current = false; });
      return;
    }
    const next = queued;
    const queueEpoch = queueStopEpoch.current;
    const queueStillOwned = () => queueEpoch === queueStopEpoch.current && stopRef.current?.key !== draftKey;
    const attempt = { ...next, state: 'attempting' as const, attempted: true };
    const rows = [attempt, ...queuedRef.current.slice(1)];
    queueBusyRef.current = true; updateQueue(rows);
    setSending(true);
    followRef.current = true;
    let handedOff = false;
    let stagedHead = next;
    const deferInBackground = async () => {
      // No command crossed the transport yet. Preserve a waiting row for
      // foreground resumption instead of leaving an uncertain attempt or
      // issuing new work from a backgrounded phone.
      const waiting = [{ ...stagedHead, state: 'waiting' as const }, ...queuedRef.current.slice(1)];
      if (!queueStillOwned()) return;
      updateQueue(waiting);
      const saved = await saveQueuedDraftsSafe(draftKey, waiting);
      if (interactionCurrent() && queueStillOwned()) updateQueue(saved);
    };
    void (async () => {
      const saved = await saveQueuedDraftsSafe(draftKey, rows);
      if (!interactionCurrent() || !queueStillOwned()) return;
      updateQueue(saved);
      if (!sameQueuedDraft(saved[0], next)) return;
      stagedHead = saved[0];
      if (!appForeground() || !queueStillOwned()) { if (queueStillOwned()) await deferInBackground(); return; }
      const attached = await hydrateQueuedImages(stagedHead);
      if (!interactionCurrent() || !queueStillOwned()) return;
      if (!appForeground() || !queueStillOwned()) { if (queueStillOwned()) await deferInBackground(); return; }
      if (!composerSendOwnerRef.current.allowed) {
        if (!queueStillOwned()) return;
        const blocked = [{ ...stagedHead, state: 'blocked' as const }, ...queuedRef.current.slice(1)];
        updateQueue(blocked); const savedBlocked = await saveQueuedDraftsSafe(draftKey, blocked);
        if (interactionCurrent() && queueStillOwned()) updateQueue(savedBlocked);
        return;
      }
      if (apiIdentityRef.current !== stagedHead.apiIdentity) {
        if (!queueStillOwned()) return;
        const blocked = [{ ...stagedHead, state: 'blocked' as const }, ...queuedRef.current.slice(1)];
        updateQueue(blocked); const savedBlocked = await saveQueuedDraftsSafe(draftKey, blocked);
        if (interactionCurrent() && queueStillOwned()) updateQueue(savedBlocked);
        return;
      }
      const result = await deliver(stagedHead.text, false, attached, stagedHead.sendOptions, false, undefined,
        { kind: 'queue', key: draftKey, id: stagedHead.id!, afterTurn: queueTurnMarker });
      if (!interactionCurrent() || !queueStillOwned() || result === 'stale') return;
      handedOff = result === 'sent' || result === 'pending';
      if (handedOff && stagedHead.id) queueExplicitResumes.current.delete(stagedHead.id);
      const remaining = result === 'sent' || result === 'pending' ? queuedRef.current.slice(1)
        : [{ ...stagedHead, state: 'blocked' as const }, ...queuedRef.current.slice(1)];
      if ((result === 'sent' || result === 'pending') && remaining.length) remaining[0] = { ...remaining[0], afterTurn: queueTurnMarker };
      updateQueue(remaining);
      const savedRemaining = await saveQueuedDraftsSafe(draftKey, remaining);
      if (interactionCurrent() && queueStillOwned()) updateQueue(savedRemaining);
    })().catch((error: Error) => {
      if (interactionCurrent() && queueStillOwned()) {
        // Accepted messages belong to the computer/receipt now. A failed
        // queue cleanup cannot reinsert them as a fresh task in this screen.
        if (!handedOff) updateQueue(queuedRef.current.map(row => sameQueuedDraft(row, stagedHead) ? { ...row, state: 'blocked' } : row));
        showToast(error.message, 'alert');
      }
    }).finally(() => { if (interactionCurrent()) { queueBusyRef.current = false; setSending(false); } });
  }, [queued, queueChecked, pendingChecked, foreground, isNew, running, sending, online, desktopCanSend, busyApproval, pendingDelivery, verifying, apiSwitching, managedApi, catalogReady, operationScope, apiIdentity, desktopLive, queueTurnMarker, queueTurnFinished, stopState]); // eslint-disable-line react-hooks/exhaustive-deps
  const manageQueue = async (type: RemoteQueueMutation['type'], id?: string, input?: { text?: string; originalText?: string; offset?: -1 | 1 }) => {
    if (!interactionCurrent() || queueBusyRef.current || sending || pendingDelivery || !queueChecked || apiSwitchingRef.current) throw new Error('排队状态正在变化，请稍后再试');
    const row = id ? queuedRef.current.find(value => value.id === id) : undefined;
    if (type !== 'pause' && (!row || row.text !== (input?.originalText ?? row.text))) throw new Error('排队内容已变化，请重新查看');
    if (type === 'resume' && (!online || !desktopCanSend || !pendingChecked)) throw new Error('请先连接电脑并核对送达状态');
    const epoch = ++queueStopEpoch.current;
    const current = () => interactionCurrent() && apiIdentityRef.current === apiIdentity && !apiSwitchingRef.current && queueStopEpoch.current === epoch;
    const mutation: RemoteQueueMutation = type === 'pause' ? { type } : { type, id: row!.id!, expected: remoteQueueRevision(row!),
      ...(type === 'edit' ? { text: input?.text } : {}), ...(type === 'move' ? { offset: input?.offset, order: queuedRef.current.map(value => value.id ?? '') } : {}) };
    queueBusyRef.current = true; setSending(true);
    try {
      const rows = await mutateRemoteQueue(draftKey, operationScope, apiIdentity, mutation, current);
      if (!current()) return;
      if (type === 'resume' && id) queueExplicitResumes.current.add(id);
      else if (type !== 'remove') queueExplicitResumes.current.clear();
      updateQueue(rows);
    } finally { if (interactionCurrent()) { queueBusyRef.current = false; setSending(false); } }
  };
  const unqueue = async () => {
    const waiting = queuedRef.current[0];
    if (!interactionCurrent() || !waiting || queueBusyRef.current || waiting.state === 'attempting') return;
    if ((textRef.current.trim() && textRef.current.trim() !== waiting.text) || (images.length && queueRepairId !== (waiting.id ?? 'restored-head'))) { showToast('请先处理输入框内容，再取回排队消息', 'alert'); return; }
    const frozenFeatures = copyTurnFeatures(waiting.sendOptions ?? {});
    const hasFrozenFeatures = frozenFeatures.collaborationMode !== undefined || Boolean(frozenFeatures.skills?.length || frozenFeatures.contextReferences?.length);
    const featureRestoreCurrent = () => featureOwner.current === featureScope && waiting.scope === operationScope
      && waiting.apiIdentity === apiIdentityRef.current && waiting.sendOptions?.surface === (desktopLive ? 'desktop' : 'cli')
      && !apiSwitchingRef.current && (!(frozenFeatures.collaborationMode || frozenFeatures.skills?.length) || featureEligible) && (!frozenFeatures.contextReferences?.length || referenceSupported);
    const featureRestoreBlocked = () => showToast('排队消息的工作模式、技能和引用仍保留，请回原来源取回', 'alert');
    if (hasFrozenFeatures && !featureRestoreCurrent()) { featureRestoreBlocked(); return; }
    // Keep the durable row while it is edited. Ordinary text drafts cannot
    // preserve staged images across a crash, and later rows cannot overtake.
    const remaining = [{ ...waiting, state: 'blocked' as const }, ...queuedRef.current.slice(1)];
    queueBusyRef.current = true;
    try {
      const saved = await saveQueuedDraftsSafe(draftKey, remaining);
      if (!interactionCurrent()) return;
      updateQueue(saved);
      if (!sameQueuedDraft(saved[0], waiting)) return;
      const restored = saved[0];
      // An API/source change during the storage wait cannot restore an old
      // skill into a different runtime or silently erase its frozen intent.
      if (hasFrozenFeatures && !featureRestoreCurrent()) { featureRestoreBlocked(); return; }
      if (featureRestoreCurrent()) {
        setCollaborationChoice(frozenFeatures.collaborationMode); setContextReferences(copyContextReferences(frozenFeatures.contextReferences) ?? []);
        setIntentSource(featureSource);
        applyComposerEdit(restoreSkillMentions(waiting.text, frozenFeatures.skills ?? []));
      }
      if (!featureRestoreCurrent()) setText(waiting.text); setImages(waiting.missingImages ? [] : restored.images); setQueueRepairId(waiting.id ?? 'restored-head');
      if (waiting.missingImages) composerMissing.current = { key: draftKey, count: waiting.imageCount ?? waiting.images.length };
      const context = composerContext.current;
      if (context?.key === draftKey) await persistComposer({ text: context.snapshot.text, images: waiting.missingImages ? [] : restored.images,
        ...(hasFrozenFeatures ? { featureIntent: { version: 1, source: featureSource, ...frozenFeatures, mentions: restoreSkillMentions(waiting.text, frozenFeatures.skills ?? []).mentions } } : {}),
        ...(waiting.missingImages ? { imageCount: waiting.imageCount ?? waiting.images.length, missingImages: true } : {}) }, context);
      if (waiting.missingImages) showToast(`请重新选择原消息的 ${waiting.imageCount ?? waiting.images.length} 张图片`, 'alert');
    } catch (error) { if (interactionCurrent()) showToast((error as Error).message, 'alert'); }
    finally { if (interactionCurrent()) queueBusyRef.current = false; }
  };
  const retry = (target: NonNullable<typeof retryTarget>) => {
    const retryCurrent = () => composerSendCurrent() && retryTargetRef.current?.message === target.message
      && retryTargetRef.current?.failed === target.failed;
    if (!retryCurrent() || sending || running || !online || !desktopCanSend || !pendingChecked || pendingDelivery || queueBusyRef.current) return;
    if (queuedRef.current.length) { showToast('请先处理排队消息，避免消息乱序', 'alert'); return; }
    const message = target.message;
    queueBusyRef.current = true;
    setSending(true);
    followRef.current = true;
    void (async () => {
      const attached: RemoteImage[] = [];
      if (message.attachments?.length || message.images?.length) {
        if (typeof readRemoteRetryImages !== 'function' || !message.attachments?.length || message.attachments.length > MAX_REMOTE_IMAGES) throw new Error('原消息的图片无法恢复，请重新选择全部原图片');
        const sources: QueuedImageDraft[] = [];
        for (const ref of message.attachments) {
          if (!/^image\/(jpeg|png|webp)$/.test(ref.mime) || !ref.width || !ref.height) throw new Error('原消息的图片无法恢复，请重新选择全部原图片');
          const uri = ref.uri ?? await materializeAttachment(deviceId!, ref, attachmentContext.current?.controller.signal, sessionKey!);
          if (!retryCurrent()) return;
          sources.push({ uri, mime: ref.mime as QueuedImageDraft['mime'], width: ref.width, height: ref.height });
        }
        attached.push(...await readRemoteRetryImages(sources));
      }
      if (retryCurrent()) await deliver(message.text, false, attached, { accountId: selectedAccountId, surface: desktopLive ? 'desktop' : 'cli', ...(message.skills?.length ? { skills: message.skills } : {}), ...(message.contextReferences?.length ? { contextReferences: message.contextReferences } : {}) });
    })().catch((error: Error) => { if (interactionCurrent()) showToast(error.message, 'alert'); })
      .finally(() => { if (interactionCurrent()) { queueBusyRef.current = false; setSending(false); } });
  };
  const chooseReference = (reference: ContextReference, { consumeQuery = true, focusComposer = true } = {}) => {
    const composer = composerContext.current;
    if (featureOwner.current !== featureScope || apiIdentityRef.current !== apiIdentity || !interactionCurrent() || !appForeground() || !referenceSupported || reference.kind === 'diff' && !diffAnnotationSupported || featureSourceBlocked || !composer?.ready || composer.busy || composer.submitting || sending || queueBusyRef.current) return;
    const next = appendContextReference(contextReferencesRef.current, reference);
    composerTextRevision.current += 1; contextReferencesRef.current = next; setContextReferences(next); setIntentSource(featureSource); setReferencePreview(undefined);
    if (consumeQuery && referenceQuery && referenceQuery.source === text) editComposerText(text.slice(0, referenceQuery.start) + text.slice(referenceQuery.end));
    setReferenceDismissed(referenceKey); if (focusComposer) composerInput.current?.focus();
    return true;
  };
  const selectMessageText = (selection: SelectedMessageText & { action: 'add' | 'ask' }, item: Extract<TimelineItem, { kind: 'message' }>) => {
    if (!interactionCurrent() || featureOwner.current !== featureScope || !annotationSupported || !sessionKey || !visible || !appForeground()) return;
    const current = timeline.items.find(candidate => candidate.kind === 'message' && candidate.id === item.id);
    if (current?.kind !== 'message' || !current.final || current.local || current.parentId || current.messageOrigin || current.text !== selection.sourceText) {
      showToast('消息已变化，请重新选择文字', 'alert'); return;
    }
    try {
      const reference = selectedMessageReference(selection, { sessionKey, id: current.id, text: current.text, role: current.role });
      if (selection.action === 'ask') {
        if (sideQuestionSupported && sideQuestionScope && deviceId && apiIdentityRef.current === apiIdentity
          && sessionSideQuestionScope(deviceId, sessionKey) === sideQuestionScope) {
          Keyboard.dismiss(); setSidebarOpen(true); setSlashSideChat(undefined); setSideQuestion({ scope: sideQuestionStorageScope, selection: reference, nonce: ++annotationEditSequence.current });
        }
        return;
      }
      const key = contextReferenceKey(reference), existing = contextReferencesRef.current.find(value => contextReferenceKey(value) === key);
      if (chooseReference(existing ?? reference, { consumeQuery: false, focusComposer: false })) {
        setAnnotationEditRequest({ key, nonce: ++annotationEditSequence.current });
      }
    } catch (error) { showToast(error instanceof Error ? error.message : '无法添加文字注释', 'alert'); }
  };
  const changeAnnotation = (index: number, annotation: string) => {
    const composer = composerContext.current;
    if (!interactionCurrent() || featureOwner.current !== featureScope || featureSourceBlocked || !composer?.ready || composer.busy || composer.submitting || sending || queueBusyRef.current) return;
    const current = contextReferencesRef.current, item = current[index];
    if (!item || !isContextAnnotation(item) || (item.kind === 'diff' ? !diffAnnotationSupported : !annotationSupported)) return;
    const next = current.map((value, i) => i === index ? { ...value, annotation } : value);
    if (!validContextReferences(next)) { showToast('评论最多 8 KB，全部引用与评论合计最多 64 KB', 'alert'); setContextReferences([...current]); return; }
    composerTextRevision.current += 1; contextReferencesRef.current = next; setContextReferences(next);
  };
  const removeReference = (index: number) => {
    if (!interactionCurrent() || sending || featureSourceBlocked || queueBusyRef.current || composerContext.current?.busy || composerContext.current?.submitting) return;
    const next = contextReferencesRef.current.filter((_, i) => i !== index);
    composerTextRevision.current += 1; contextReferencesRef.current = next; setContextReferences(next);
  };
  const quote = (_reply: string, item?: Extract<TimelineItem, { kind: 'message' }>) => {
    if (!interactionCurrent() || !item || !sessionKey || !item.final || item.parentId || item.local || item.messageOrigin) return;
    if (!referenceSupported) { showToast('电脑暂不支持结构化引用，请更新 Bridge', 'alert'); return; }
    setReferencePreview({ kind: 'message', sessionKey, messageId: item.id, label: '当前对话 · Agent', text: item.text });
  };

  const stop = () => {
    if (!interactionCurrent() || !deviceId || !sessionKey || !desktopCanStop || stopRef.current?.key === draftKey) return;
    const turnId = turnControlTarget(timeline, 'stop');
    queueStopEpoch.current += 1;
    const next = { key: draftKey, turnId, phase: 'requesting' as const };
    stopRef.current = next; setStopState(next);
    if (pendingDelivery) setPendingDelivery({ ...pendingDelivery, retryable: false, message: '已暂停此消息的重发，请先核对原会话' });
    void (async () => {
      await pausePendingRemoteMessage(deviceId, sessionKey, operationScope);
      const blocked = queuedRef.current.map(item => ({ ...item, attempted: item.attempted ?? item.state !== 'waiting', state: 'blocked' as const }));
      if (blocked.length) {
        updateQueue(blocked); const saved = await saveQueuedDraftsSafe(draftKey, blocked);
        if (interactionCurrent()) updateQueue(saved);
      }
      if (!interactionCurrent()) return;
      if (!turnId) {
        // A refresh may later supply the exact turn ID.  Keep the composer
        // usable for reconciliation rather than leaving it permanently in a
        // disabled "waiting" state.
        stopRef.current = null; setStopState(null);
        throw new Error('当前轮次尚未确认，请先刷新原会话');
      }
      const result = await interruptSession(deviceId, sessionKey, turnId);
      if (!interactionCurrent()) return;
      if (result.status === 'stopped' || result.status === 'already_finished') {
        stopRef.current = null; setStopState(null);
        showToast(result.status === 'stopped' ? '已停止' : '这一轮已经结束', 'stop');
      } else {
        const state = { key: draftKey, turnId, phase: result.status === 'requested' ? 'requested' as const : 'unconfirmed' as const };
        stopRef.current = state; setStopState(state);
        showToast(result.status === 'requested' ? '已请求停止' : '停止结果待确认', 'stop');
      }
      await refresh();
    })().catch((error: Error) => {
      if (interactionCurrent()) {
        if (!turnId) { stopRef.current = null; setStopState(null); showToast(error.message, 'alert'); return; }
        const state = { key: draftKey, turnId, phase: 'unconfirmed' as const }; stopRef.current = state; setStopState(state); showToast(error.message, 'alert');
      }
    });
  };
  useEffect(() => {
    if (!stopState || stopState.key !== draftKey || !stopState.turnId) return;
    const terminal = timeline.items.find(item => item.kind === 'turn' && !item.parentId && item.turnId === stopState.turnId && item.status !== 'started');
    if (terminal) { stopRef.current = null; setStopState(null); }
  }, [draftKey, stopState, timeline.items]);
  const continueTask = () => {
    if (contextBusyRef.current) return;
    if (featureEligible && (!featureGenerationCurrent() || (collaborationChoice || selectedSkills.length) && !featureCatalogCurrent())) return;
    if (!composerSendCurrent() || !deviceId || !sessionKey || sending || composerHasContent || queuedRef.current.length || pendingDelivery
      || stopRef.current?.key === draftKey || !online || verifying || apiSwitching || !desktopCanSend || featuresBlocked || permissionBlocked || !turnControlTarget(timeline, 'continue')) return;
    setSending(true);
    void continueSession(deviceId, sessionKey, { accountId: currentAgent?.api.accountId, model: nextModel || undefined, effort: effectiveEffort || undefined, ...turnFeatures, permissionMode: nextPermissionMode, approval: nextApproval })
      .then(() => { if (interactionCurrent()) { setPermissionChoice(undefined); setMode(undefined); composerTextRevision.current += 1; clearFeatureSelection(); followRef.current = true; setWatchUntil(Date.now() + 120_000); } })
      .catch(async (error: Error) => {
        if (!interactionCurrent()) return;
        const pending = await getPendingRemoteMessage(deviceId, sessionKey).catch(() => null);
        if (!interactionCurrent()) return;
        if (pending) { const policy = deliveryRetryState(pending); setPendingDelivery({ requestId: pending.requestId, executionId: pending.executionId, text: pending.text, createdAt: pending.createdAt, attempted: pending.attempted, retryable: policy.retryable, message: policy.message }); }
        showToast(error.message, 'alert');
      }).finally(() => { if (interactionCurrent()) setSending(false); });
  };
  const decide = async (approval: ApprovalItem, decision: Decision, message?: string, answers?: QuestionAnswers, restored?: QuestionReceipt) => {
    const latest = questionContext.current.pending.find(value => value.id === approval.id);
    if (!interactionCurrent() || !deviceId || !sessionKey || !questionContext.current.online || !questionContext.current.desktopCanApprove
      || !latest || latest.state !== 'pending' || !approvalDecisions(latest).includes(decision) || (latest.expiresAt && latest.expiresAt <= Date.now()) || approvalRequest.current?.scope === draftKey) return;
    approval = latest;
    const isQuestion = approval.approval === 'question';
    if (isQuestion) answerDraft.current = { scope: draftKey, id: approval.id, answers };
    const request = { scope: draftKey, id: approval.id, controller: new AbortController() };
    approvalRequest.current = request;
    setBusyApproval(approval.id);
    setQuestionProblem('');
    let persisted: QuestionReceipt | undefined;
    try {
      const target = { approvalId: approval.id, deviceId, sessionKey, ...(desktopLive ? { controlSurface: 'desktop' as const } : {}) };
      if (isQuestion) {
        const scope = remoteDeliveryScope();
        // Freeze choices before dispatch; hidden UI content is never discarded.
        const frozen = answers ? Object.fromEntries(Object.entries(answers).map(([key, values]) => [key, [...values]])) : undefined;
        persisted = restored;
        if (restored?.attempted && !restored.command) throw new HubError('旧回答缺少来源记录，未重新发送', 200, 'question_source_unconfirmed');
        persisted = await prepareQuestionReceipt({ scope, deviceId, sessionKey, approvalId: approval.id, decision, message, answers: frozen, expiresAt: approval.expiresAt,
          command: restored?.command ?? snapshotQuestionCommand(target, decision, message, frozen) });
        const receipt = persisted;
        await deliverQuestionAnswer({ signal: request.controller.signal, expiresAt: approval.expiresAt,
          receipt, beforeAttempt: () => markQuestionAttempt(receipt),
          active: () => interactionCurrent() && approvalRequest.current === request && draftRef.current === request.scope,
          canSend: () => AppState.currentState == null || AppState.currentState === 'active',
          recover: () => syncSessionEvents(deviceId, sessionKey),
          perform: (requestId, retrying) => respondApproval(target, decision, message, frozen, { requestId, retrying, scope, expiresAt: approval.expiresAt, signal: request.controller!.signal, command: receipt.command }),
        });
        await finishQuestionReceipt(receipt);
      } else await respondApproval(target, decision, message, answers, {
        requestId: randomUUID(), retrying: false, scope: remoteDeliveryScope(), expiresAt: approval.expiresAt, signal: request.controller.signal,
      });
      if (approvalRequest.current === request) setWatchUntil(Date.now() + 60_000);
    } catch (error) {
      if (persisted && error instanceof QuestionDeliveryCancelled) {
        // The resolved event can cancel the POST wait before its response. A
        // same-scope, newer terminal event is proof; hiding/expiry/absence is not.
        const context = questionContext.current;
        const resolved = context.items.find((item): item is ApprovalItem => item.kind === 'approval' && item.approval === 'question' && item.id === approval.id);
        if (context.scope === request.scope && remoteDeliveryScope() === persisted.scope && resolved && resolved.state !== 'pending'
          && (resolved.by === 'phone' || resolved.by === 'desktop') && resolved.ts >= approval.ts
          && (resolved.seq === undefined || approval.seq === undefined || resolved.seq > approval.seq)) {
          await finishQuestionReceipt(persisted).catch(() => undefined);
        }
      } else if (persisted) {
        if (error instanceof HubError && ['command_delivery_uncertain', 'command_receipt_missing', 'command_receipt_pending', 'request_id_conflict', 'question_retry_unsupported', 'question_source_unconfirmed', 'question_expired', 'question_clock_changed', 'request_scope_changed'].includes(error.code ?? '') || error instanceof HubError && (error.status === 401 || error.status === 403)) {
          await blockQuestionReceipt(persisted, error instanceof HubError ? error.code ?? 'question_auth_failed' : 'question_failed').catch(() => undefined);
          if (interactionCurrent() && draftRef.current === request.scope) setQuestionProblem('请在电脑核对回答');
        } else await finishQuestionReceipt(persisted).catch(() => undefined); // Definitively rejected answers may be corrected with a new UUID.
      }
      if (approvalRequest.current === request && !(error instanceof QuestionDeliveryCancelled)) {
        approvalRequest.current = null; setBusyApproval(null); showToast((error as Error).message, 'alert');
      }
    } finally {
      // A question stays in the spinner state until its actual resolved event arrives.
      if (!isQuestion && approvalRequest.current === request) { approvalRequest.current = null; setBusyApproval(null); }
    }
  };
  const loadModels = async (refresh: boolean) => {
    if (!deviceId || !modelEditable || !modelEditableRef.current) return;
    const request = ++modelRequestRef.current, identity = apiIdentityRef.current, thread = draftKey;
    setModelsLoading(true);
    setCatalogError('');
    // Refresh failures must not leave an earlier catalog authorizing a send.
    setCatalogOwner('');
    try {
      if (desktopLive && (!nativeModelEditable || !sessionKey)) return;
      const result = desktopLive && sessionKey ? await listModels(deviceId, tool, refresh, { controlSurface: 'desktop', sessionKey }) : await listModels(deviceId, tool, refresh);
      if (!modelEditableRef.current || request !== modelRequestRef.current || identity !== apiIdentityRef.current || thread !== draftRef.current) return;
      setModels(result);
      setCatalogOwner(`${thread}|${identity}`);
      const candidateEffortModel = modelRef.current || (ownToolApi ? session?.model || currentAgent?.api.model : currentAgent?.api.model) || '';
      const nextEffort = reportedEfforts(result.modelCapabilities?.[candidateEffortModel]).includes(effortRef.current as Effort) ? effortRef.current : '';
      if (!pendingDelivery && nextEffort !== effortRef.current) { effortRef.current = nextEffort; setEffort(nextEffort); }
      if (managedApi && !pendingDelivery) {
        const candidate = modelRef.current || currentAgent?.api.model || '';
        const verified = result.models.includes(candidate) ? candidate : '';
        setModel(verified);
      }
    } catch {
      if (request === modelRequestRef.current && identity === apiIdentityRef.current && thread === draftRef.current) {
        setCatalogError('加载失败');
      }
    }
    finally { if (request === modelRequestRef.current) setModelsLoading(false); }
  };
  // Entry is a conversation boundary: the relay may have changed this Key's
  // group without changing the Key/URL. Bypass its old catalog once here;
  // opening the picker and normal turns can keep using the verified cache.
  useEffect(() => {
    if (!visible || !deviceId || !modelEditable || !online) return;
    void loadModels(true);
  }, [visible, deviceId, catalogScope, managedApi, desktopLive, modelEditable, online, modelEpoch]); // eslint-disable-line react-hooks/exhaustive-deps
  const openModels = () => {
    if (!interactionCurrent() || !desktopLive && (!modelEditable || !modelEditableRef.current)) return;
    pickerRef.current = 'model'; setPicker('model');
    if (!desktopLive || nativeModelEditable) void loadModels(false);
  };
  const openSkillsMenu = () => {
    const composer = composerContext.current;
    if (!featureEligible || featureSourceBlocked || !featureCwd || !composer?.ready || composer.key !== draftKey
      || !interactionCurrent() || composer.busy || composer.submitting || queueBusyRef.current || permissionRuntime.current.locked) return;
    const at = Math.min(inputCaret, text.length);
    const prefix = at > 0 && !/\s/.test(text[at - 1]) ? ' /skills ' : '/skills ';
    const value = text.slice(0, at) + prefix + text.slice(at);
    applyComposerEdit({ ...reconcileSkillMentions(text, value, skillMentions), caret: at + prefix.length });
    setSlashDismissed(undefined);
    composerInput.current?.focus();
  };
  const closeModels = () => { pickerRef.current = null; setPicker(null); };
  const chooseModel = (value: string) => {
    if (!interactionCurrent() || !modelEditable || !modelEditableRef.current || apiSwitchingRef.current) return;
    if (pendingDelivery) { showToast('先核对待确认消息', 'alert'); return; }
    if (desktopLive && !nativeModelEditable) return;
    if ((managedApi || desktopLive) && (!catalogReady || !models.models.includes(value || defaultModel))) {
      showToast('请选择模型', 'alert'); return;
    }
    prefsRevision.current += 1;
    const selectedCapability = pickerCapabilities?.[value || defaultModel];
    const strength = tool === 'codex' && catalogReady && effortRef.current && reportedEfforts(selectedCapability).includes(effortRef.current) ? effortRef.current : '';
    modelChanges.record(currentModel || native?.apiModel || defaultModel, value || defaultModel);
    modelRef.current = value; effortRef.current = strength;
    setModel(value); setEffort(strength); closeModels();
    void saveThreadPrefs(prefsKey, { model: value || undefined, effort: strength || undefined, apiIdentity }).catch(() => undefined);
  };
  const followDesktop = () => {
    if (!interactionCurrent() || !desktopLive || pendingDelivery) return;
    modelChanges.record(modelRef.current || native?.apiModel || '', native?.apiModel || '');
    prefsRevision.current += 1; modelRef.current = ''; effortRef.current = '';
    setModel(''); setEffort(''); closeModels();
    void saveThreadPrefs(prefsKey, { apiIdentity }).catch(() => undefined);
  };
  const chooseEffort = (value: Effort | '') => {
    if (!interactionCurrent() || !effortEditable || apiSwitchingRef.current) return;
    if (value && !effortLevels.includes(value)) return;
    if (pendingDelivery) { showToast('先核对待确认消息', 'alert'); return; }
    prefsRevision.current += 1;
    effortRef.current = value; setEffort(value); setPicker(null);
    void saveThreadPrefs(prefsKey, { model: currentModel || undefined, effort: value || undefined, apiIdentity }).catch(() => undefined);
  };
  const scrubLevels = useMemo(() => ['' as const, ...effortLevels], [JSON.stringify(effortLevels)]); // eslint-disable-line react-hooks/exhaustive-deps
  const onScrub = (event: ScrubEvent) => {
    if (event.phase === 'start') {
      const request = ++scrubRequest.current;
      setScrub({ index: event.index });
      // Tap/accessibility steps commit in this same callback. Only an actual
      // held scrub needs a native snapshot for the frosted composer animation.
      void Promise.resolve().then(() => scrubRequest.current === request ? captureModelBackdrop(composerRef) : undefined)
        .then((texture) => { if (texture && scrubRequest.current === request) setScrub((current) => current ? { ...current, texture } : current); });
    } else if (event.phase === 'move') setScrub((current) => current ? { ...current, index: event.index } : current);
    else {
      scrubRequest.current += 1; setScrub(null);
      const value = scrubLevels[event.index];
      if (event.phase === 'end' && value !== undefined && value !== effectiveEffort) chooseEffort(value);
    }
  };
  const openApi = () => {
    if (!interactionCurrent()) return;
    closeModels();
    if (onAgentSettings) onAgentSettings();
    else showToast('请在 Agent 配置中更换 API 密钥', 'alert');
  };
  const openProblem = (problem: ApiProblem | null) => {
    if (!interactionCurrent()) return;
    if (desktopLive && (!nativeModelEditable || problem?.kind !== 'model_capacity')) setMenu(true);
    else if (problem?.kind === 'model_capacity') openModels();
    else openApi();
  };
  const addImages = async (source: 'gallery' | 'camera') => {
    if (!interactionCurrent()) return;
    setAttachMenu(false);
    if (!composerSendOwnerRef.current.imagesAllowed || modelRejectsImagesRef.current) return;
    try {
      const pickerOwner = composerSendOwner;
      const picked = await pickRemoteImages(source, MAX_REMOTE_IMAGES - images.length);
      if (interactionCurrent() && composerSendOwnerRef.current.identity === pickerOwner && composerSendOwnerRef.current.imagesAllowed && !modelRejectsImagesRef.current && picked.length) setImages((current) => [...current, ...picked].slice(0, MAX_REMOTE_IMAGES));
    } catch (error) { if (interactionCurrent() && !handleSystemPermissionError(error)) showToast((error as Error).message, 'alert'); }
  };

  // Editable sessions use this API's next-turn default. Creation-only models
  // stay with the session and must never become a resume-time override.
  const configuredModel = desktopLive ? '' : !modelEditable ? session?.model || '' : ownToolApi ? session?.model || (currentAgent?.api.source === 'tool' ? currentAgent.api.model : '') || '' : currentAgent?.api.model || '';
  const defaultModel = !managedApi || (catalogReady && models.models.includes(configuredModel)) ? configuredModel : '';
  const candidateModel = modelEditable ? model || defaultModel : defaultModel;
  const currentModel = desktopLive ? nativeModelEditable && catalogReady && models.models.includes(model) ? model : ''
    : !managedApi || (catalogReady && models.models.includes(candidateModel)) ? candidateModel : '';
  const nextModel = !modelEditable ? '' : desktopLive ? model : managedApi ? currentModel : model || (effectiveEffort || !ownToolApi ? defaultModel : '');
  const currentModelLabel = currentModel ? modelDisplayLabel(currentModel, models.models) : '';
  const modelBlocked = managedApi && (!catalogReady || !currentModel) || desktopLive && Boolean(model) && (!nativeModelEditable || !catalogReady || !models.models.includes(model)) || permissionBlocked || featuresBlocked;
  const title = isNew ? '新对话' : titleOf(deviceId, sessionKey, session?.title || '对话');
  const stats = useMemo(() => turnStats(timeline.items), [timeline.items]);
  const runningHeading = useMemo(() => running && visible ? runningTurnHeading(timeline.items) : undefined, [timeline.items, running, visible]);
  const toolActivities = useMemo(() => timeline.items.filter((item): item is Extract<TimelineItem, { kind: 'tool' }> => item.kind === 'tool'), [timeline.items]);
  const startedAt = running ? runningSince(timeline.items) : undefined;
  const hits = useMemo(() => searchOpen ? searchBlocks(blocks, searchQuery) : [], [searchOpen, blocks, searchQuery]);
  const hitIndex = hits.length ? hits[Math.min(searchPos, hits.length - 1)] : -1;
  const goToBlock = (index: number) => {
    if (index < 0) return;
    readingPosition.interact();
    followRef.current = false;
    setJumpState({visible:true,unseen:false});
    try { listRef.current?.scrollToIndex({ index, viewPosition: 0.3, animated: true }); } catch { /* measured later */ }
  };
  const navigateAnnotation = useCallback((reference: ContextReference) => {
    if (!interactionCurrent() || reference.kind !== 'message') return;
    if (reference.sessionKey !== sessionKey) { showToast('这条注释来自其他对话，当前显示的是已保存的原文', 'alert'); return; }
    const index = blocks.findIndex(block => (block.type === 'user' || block.type === 'assistant') && block.item.id === reference.messageId);
    if (index < 0) { showToast('原消息尚未加载，注释原文仍已保存', 'alert'); return; }
    const block = blocks[index];
    if ((block.type === 'user' || block.type === 'assistant') && reference.sourceRevision && messageSourceRevision(block.item.text) !== reference.sourceRevision) {
      setAnnotationHighlight(undefined); showToast('原消息内容已变化，注释保留添加时的原文', 'alert');
    } else if (reference.textBasis && reference.messageId) setAnnotationHighlight({ id: reference.messageId, nonce: ++annotationEditSequence.current,
      textBasis: reference.textBasis, blockIndex: reference.blockIndex, start: reference.startOffset!, end: reference.endOffset!, text: reference.text });
    setAnnotationSourceId(reference.messageId); goToBlock(index);
  }, [blocks, sessionKey, interactionEpoch, operationScope, draftKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (searchOpen && hitIndex >= 0) goToBlock(hitIndex); }, [searchOpen, hitIndex]); // eslint-disable-line react-hooks/exhaustive-deps
  const outputScope=JSON.stringify([operationScope,deviceId,currentAgent?.id,workspaceMode,sessionKey,apiIdentity,session?.cwd,desktopLive?'desktop':'cli']);
  const restoreSentEdit:SentEditRestorer=async(value,operationId,policy)=>{
    const owner=composerContext.current;
    const current=()=>interactionCurrent()&&apiIdentityRef.current===apiIdentity&&!apiSwitchingRef.current&&composerContext.current===owner&&owner?.ready&&!owner.submitting&&(!policy?.isCurrent||policy.isCurrent());
    if(!owner||!current()||owner.busy||sending||queueBusyRef.current||pendingDelivery||running&&!policy?.allowRunning)return false;
    if(composerMissing.current?.key===draftKey)throw new Error('请先处理当前草稿缺失的图片，修改备份仍保留');
    const before=copyComposerSnapshot(owner.snapshot);owner.busy=true;
    const unchanged=()=>before.text===owner.snapshot.text&&sameComposerSnapshot(before,owner.snapshot);
    try{
      const stored=await owner.session.restore();if(!current())return false;
      if(stored?.lastRestoredEdit===operationId)return true;
      if(!unchanged())throw new Error('恢复期间草稿已变化，请重试');
      const intent=before.featureIntent;
      if(intent&&!sameComposerFeatureSource(intent.source,featureSource))throw new Error('当前草稿来自其他 API，请先处理当前草稿');
      const merged=mergeSentEditRecovery({text:stripSkillMentions(before.text,intent?.mentions??[]),images:before.images,features:copyTurnFeatures(intent??{})},value);
      const restored=restoreSkillMentions(merged.text,merged.features.skills??[]);
      if(restored.text.length>100_000)throw new Error('恢复后内容过长，请先处理当前草稿');
      const hasFeatures=Boolean(merged.features.collaborationMode||merged.features.skills?.length||merged.features.contextReferences?.length);
      const next:ComposerDraftInput={...before,text:restored.text,images:merged.images,imageCount:merged.images.length,missingImages:false,lastRestoredEdit:operationId,
        featureIntent:hasFeatures?{version:1,source:featureSource,...merged.features,mentions:restored.mentions}:undefined};
      owner.editRestore={operationId,previousMarker:stored?.lastRestoredEdit??''};
      // The unified snapshot is authoritative; a failed legacy text mirror
      // must not hide an already committed restoration from the input.
      const saved=await persistComposer(next,owner,false);
      if(!current()){
        if(composerContext.current===owner)await persistComposer({...owner.snapshot,lastRestoredEdit:stored?.lastRestoredEdit??''},owner,false);
        return false;
      }
      if(!unchanged()){await persistComposer({...owner.snapshot,lastRestoredEdit:stored?.lastRestoredEdit??''},owner,false);throw new Error('恢复期间草稿已变化，原输入已保留，请重试');}
      owner.snapshot={...next,images:saved.images};setText(restored.text);setImages(saved.images);
      setCollaborationChoice(merged.features.collaborationMode);setContextReferences(copyContextReferences(merged.features.contextReferences)??[]);
      contextReferencesRef.current=copyContextReferences(merged.features.contextReferences)??[];
      setSelectedSkills(merged.features.skills??[]);setSkillMentions(restored.mentions);setIntentSource(hasFeatures?featureSource:undefined);
      return true;
    }finally{owner.editRestore=undefined;owner.busy=false;}
  };
  const editBackup=useSentEditBackup(isNew?'':operationScope,deviceId??'',outputScope,{restore:restoreSentEdit,verify:refresh,revertOperations:timeline.revertOperations,disabled:sending||Boolean(pendingDelivery)||apiSwitching||!composerReady});
  const restoreHistory=async(entry:PromptHistoryEntry,signal:AbortSignal)=>{
    const identity=promptHistoryIdentity(entry);
    const current=()=>!signal.aborted&&interactionCurrent()&&apiIdentityRef.current===apiIdentity&&!apiSwitchingRef.current&&Boolean(deviceId&&sessionKey)
      &&promptHistory(getRemoteState().timelines[timelineKey(deviceId!,sessionKey!)]?.items??[]).some(item=>promptHistoryIdentity(item)===identity);
    if(!current()||editBackup.blocked)return false;
    requireHistoryCapabilities(entry,currentAgent?.capabilities?{...currentAgent.capabilities,features:featureEligible,contextReferences:referenceSupported,contextAnnotations:annotationSupported,contextDiffAnnotations:diffAnnotationSupported}:undefined);
    const value=await recoverHistoryInput(entry,async ref=>ref.uri??await materializeAttachment(deviceId!,ref,signal,sessionKey!),current);
    return restoreSentEdit(value,randomUUID(),{allowRunning:true,isCurrent:current});
  };
  const latestEditable=latestRevisableMessage(timeline.items);
  const editLatest:SentMessageRevisionHandler=async(message,revisedText,signal)=>{
    const current=()=>interactionCurrent()&&apiIdentityRef.current===apiIdentity&&!apiSwitchingRef.current&&composerSendCurrent();
    const live=()=>getRemoteState().timelines[timelineKey(deviceId??'',sessionKey??'')]??EMPTY_TIMELINE;
    const turnId=latestEditableTurn(live(),message);
    if(!deviceId||!sessionKey||!turnId||!current()||sending||queueBusyRef.current||pendingDelivery||queuedRef.current.length||editBackup.blocked||signal.aborted)return false;
    const before=()=>current()&&!signal.aborted&&latestEditableTurn(live(),message)===turnId;
    queueBusyRef.current=true;setSending(true);
    let body:EditBackupBody={version:1,text:revisedText,features:copyTurnFeatures(message),phase:'prepared',messageId:message.id,turnId,operationId:randomUUID()};
    try {
      const attached:RemoteImage[]=[];
      if(message.attachments?.length||message.images?.length){
        if(!message.attachments?.length||message.attachments.length>MAX_REMOTE_IMAGES)throw new Error('原消息图片无法完整恢复，编辑未提交');
        const sources:QueuedImageDraft[]=[];
        for(const ref of message.attachments){
          if(!/^image\/(jpeg|png|webp)$/.test(ref.mime)||!ref.width||!ref.height)throw new Error('原消息图片无法完整恢复，编辑未提交');
          const uri=ref.uri??await materializeAttachment(deviceId,ref,signal,sessionKey);
          if(!before())return false;
          sources.push({uri,mime:ref.mime as QueuedImageDraft['mime'],width:ref.width,height:ref.height});
        }
        attached.push(...await readRemoteRetryImages(sources));
      }
      if(!before())return false;
      await editBackup.begin(body,attached);
      if(!before())throw new Error('会话已变化，编辑未提交');
      body={...body,phase:'reverting'};await editBackup.save(body,attached);
      if(!before())throw new Error('会话已变化，编辑未提交');
      // A bubble unmount after dispatch is expected; the captured computer
      // and API owner, rather than the editor lifetime, owns the result.
      await revertLatestSessionTurn(deviceId,sessionKey,message,body.operationId);
      if(!current())return false;
      body={...body,phase:'reverted'};await editBackup.save(body,attached);
      if(!current())return false;
      body={...body,phase:'sending'};await editBackup.save(body,attached);
      if(!current())return false;
      let definitelyRejected=false;
      const result=await deliver(revisedText,false,attached,{...copyTurnFeatures(message),accountId:selectedAccountId,surface:'cli'},false,undefined,undefined,confirmed=>{definitelyRejected=confirmed;});
      if(definitelyRejected&&current()){body={...body,phase:'reverted'};await editBackup.save(body,attached);}
      if(result!=='sent')throw new Error(definitelyRejected?'电脑未接收修正版，完整内容已保留，可恢复到输入框':'修正版尚未确认送达，内容已保留，请先核对会话');
      await editBackup.clear();return true;
    }catch(reason){if(current())showToast(reason instanceof Error?reason.message:'编辑未完成，修改内容已保留','alert');throw reason;}
    finally{if(interactionCurrent()){queueBusyRef.current=false;setSending(false);}editBackup.settle();}
  };
  const readingScope=JSON.stringify([operationScope,deviceId,currentAgent?.id,workspaceMode,sessionKey,selectedAccountId??`${currentAgent?.api.source}:${currentAgent?.api.name}`,session?.cwd,desktopLive?'desktop':'cli']);
  const readingPosition=useConversationPosition({scope:readingScope,active:visible&&!isNew,blocks,list:listRef,earlierCursor:timeline.nextCursor,earlierLoading:timeline.loadingEarlier,earlierError:Boolean(timeline.earlierError),
    loadEarlier:online&&deviceId&&sessionKey?()=>{
      if(!interactionCurrent()||apiIdentityRef.current!==apiIdentity)return;
      historyReadController.current?.abort();
      const controller=new AbortController();historyReadController.current=controller;
      return loadEarlierHistory(deviceId,sessionKey,controller.signal).finally(()=>{if(historyReadController.current===controller)historyReadController.current=null;});
    }:undefined,
    onFollow:follow=>{followRef.current=follow;setJumpState({visible:!follow,unseen:false});}});
  const resultViewability=useConversationResultReader({scope:currentAgent?conversationReadScope(operationScope,deviceId??'',currentAgent,workspaceMode):'',session,timeline,
    active:visible&&!isNew&&online&&!timeline.loading&&!timeline.error&&!syncNotice&&(tabletLayout||!navigationOpen&&!sidebarOpen&&!toolsPaneVisible)},blocks,readingPosition.onViewableItemsChanged);
  const [artifactRequest,setArtifactRequest]=useState<{target:ConversationArtifactTarget;nonce:number;epoch:number}|null>(null);
  const currentArtifactRequest=artifactRequest?.epoch===interactionEpoch&&artifactRequest.target.scopeKey===outputScope?artifactRequest:null;
  const openArtifact=useCallback((target:ConversationArtifactTarget)=>{
    if(!interactionCurrent()||apiIdentityRef.current!==apiIdentity||!validConversationArtifact(target,outputScope))return;
    setPreviewTarget(null);setSidebarFile(null);setDiffFile(null);setSidebarFocus(null);
    setArtifactRequest({target,nonce:++fileLinkSequence.current,epoch:interactionEpoch});setSidebarOpen(true);
  },[outputScope,interactionEpoch,apiIdentity]);
  const appendArtifactToComposer=(value:string)=>{if(!interactionCurrent()||apiIdentityRef.current!==apiIdentity||!composerReady||composerContext.current?.submitting)return false;setText(current=>current?`${current}\n\n${value}`:value);return true;};
  const appendImageNotes=async(value:string,attached:readonly RemoteImage[])=>{
    const owner=composerContext.current;
    const current=()=>interactionCurrent()&&apiIdentityRef.current===apiIdentity&&composerContext.current===owner&&owner?.ready&&!owner.submitting;
    if(!owner||!current()||!composerReady||owner.busy)return false;
    if(!composerSendOwnerRef.current.imagesAllowed||modelRejectsImagesRef.current)throw new Error('当前 Agent 或模型不支持图片输入，请切换后再添加批注');
    if(composerMissing.current?.key===draftKey)throw new Error('请先恢复或移除当前草稿缺失的图片');
    const before=owner.snapshot,next=appendImageAnnotation(before,value,attached);owner.busy=true;
    try {
      await persistComposer(next,owner);
      if(!current())return false;
      if(owner.snapshot.text!==before.text||!sameComposerSnapshot(owner.snapshot,before)){await persistComposer(owner.snapshot,owner);throw new Error('添加期间草稿已变化，请重试；原内容已保留');}
      setText(next.text);setImages(next.images);return true;
    } finally {owner.busy=false;}
  };
  const importEnabled=visible&&composerReady&&!readOnly&&!sending&&!apiSwitching&&!pendingDelivery&&!queueBusyRef.current;
  const appendFiles:ComposerFilesAppender=async(files)=>{
    const owner=composerContext.current;
    const current=()=>interactionCurrent()&&apiIdentityRef.current===apiIdentity&&composerContext.current===owner&&owner?.ready&&!owner.submitting;
    if(!owner||!current()||!importEnabled||owner.busy)return false;
    if(files.images.length&&(!composerSendOwnerRef.current.imagesAllowed||modelRejectsImagesRef.current))throw new Error('当前 Agent 或模型不支持图片输入，请切换后再添加图片');
    if(composerMissing.current?.key===draftKey)throw new Error('请先恢复或移除当前草稿缺失的图片');
    const before=owner.snapshot,next=appendComposerFiles(before,files,100_000);owner.busy=true;
    try{
      await persistComposer(next,owner);
      if(!current()){if(composerContext.current===owner&&owner.ready&&!owner.submitting)await persistComposer(owner.snapshot,owner);return false;}
      if(owner.snapshot.text!==before.text||!sameComposerSnapshot(owner.snapshot,before)){await persistComposer(owner.snapshot,owner);throw new Error('添加期间草稿已变化，请重试；原内容已保留');}
      setText(next.text);setImages(next.images);return true;
    }finally{owner.busy=false;}
  };
  const outputs=useConversationOutputs({scopeKey:outputScope,generationKey:String(interactionEpoch),active:visible&&!isNew,items:timeline.items,
    selection:deviceId&&sessionKey&&currentAgent?{deviceId,sessionKey,agentId:currentAgent.id,surface:desktopLive?'desktop':'cli',expectedCwd:session?.cwd}:undefined,
    available:!readOnly&&device?.capabilities?.includes('workspace.artifacts.v1')===true,writable:!readOnly&&device?.capabilities?.includes('workspace.artifacts.write.v1')===true,
    requestAttachment,onCompose:appendArtifactToComposer,onComposeImages:appendImageNotes,isCurrent:()=>interactionCurrent()&&apiIdentityRef.current===apiIdentity});
  const openConversationImage=(uri:string)=>{if(!outputs.openImage(uri))openImage(uri);};
  const getAttachmentThumbnail = useCallback(async (ref: AttachmentRef, signal: AbortSignal) => {
    const context = attachmentContext.current;
    if (!visible || !deviceId || !sessionKey || !context || context.identity !== attachmentIdentity || signal.aborted) return undefined;
    if (typeof materializeAttachmentThumbnail !== 'function') return undefined;
    const controller = new AbortController(), abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true }); context.controller.signal.addEventListener('abort', abort, { once: true });
    if (context.controller.signal.aborted || signal.aborted) abort();
    try {
      const uri = await materializeAttachmentThumbnail(deviceId, ref, controller.signal, sessionKey);
      return !controller.signal.aborted && threadMounted.current && draftRef.current === draftKey && remoteDeliveryScope() === context.scope ? uri : undefined;
    } finally { signal.removeEventListener('abort', abort); context.controller.signal.removeEventListener('abort', abort); }
  }, [visible, deviceId, sessionKey, draftKey, attachmentIdentity]);
  const openAttachment = (ref: AttachmentRef) => {
    const context = attachmentContext.current;
    if (!visible || !deviceId || !sessionKey || !context || context.identity !== attachmentIdentity) return;
    const local = (ref as AttachmentRef & { uri?: string }).uri;
    if (local) { openConversationImage(local); return; }
    void materializeAttachment(deviceId, ref, context.controller.signal, sessionKey).then(uri => {
      if (context.controller.signal.aborted || !threadMounted.current || draftRef.current !== draftKey || remoteDeliveryScope() !== context.scope) return;
      if (attachMaterializedUri(deviceId, sessionKey, ref, uri, context.scope)) openConversationImage(uri);
    }).catch((error: unknown) => {
      if (!context.controller.signal.aborted && threadMounted.current && draftRef.current === draftKey) showToast(error instanceof Error ? error.message : '图片读取失败，请重试', 'alert');
    });
  };
  const openConversationLink = useCallback((target: string, exactSession: boolean, pageId?: string) => {
    if (!interactionCurrent()) return;
    const link = resolveRemoteLink(target, exactSession ? session?.cwd : undefined);
    if (link.kind === 'web' || link.kind === 'local-service') {
      setSidebarFocus(null); setSidebarFile(null); setDiffFile(null);
      setPreviewTarget({ kind: link.kind, url: target, pageId, nonce: ++fileLinkSequence.current, epoch: interactionEpoch }); setSidebarOpen(true); return;
    }
    if (link.kind === 'task' && link.connectionId && link.deviceId && link.agentId) {
      if (remote.connectionId !== link.connectionId || deviceId !== link.deviceId) { showToast('正在打开链接对应的会话', 'code'); setRemoteFocus({ connectionId: link.connectionId, deviceId: link.deviceId, sessionKey: link.sessionKey }); return; }
      if (!readOnly) { setPreviewTarget(null); setDiffFile(null); setSidebarFile(null); setSidebarFocus(link.sessionKey); setNavigationOpen(true); return; }
      showToast('桌面历史链接请从编程首页打开', 'alert'); return;
    }
    if (link.kind === 'task' && tool === 'codex' && !readOnly) {
      setPreviewTarget(null); setDiffFile(null); setSidebarFile(null); setSidebarFocus(link.sessionKey); setNavigationOpen(true); return;
    }
    if (link.kind === 'file') {
      if (!exactSession) { showToast('请先打开子智能体对话，再查看它的文件', 'alert'); return; }
      if(outputs.openFile(link.path))return;
      if (!sessionKey || !session?.cwd || !device?.capabilities?.includes('workspace.files.v1') || readOnly) { showToast('当前会话暂不支持查看项目文件', 'alert'); return; }
      setPreviewTarget(null); setDiffFile(null); setSidebarFocus(null); setSidebarFile({ ...link, expectedCwd: session.cwd, sessionKey, surface: desktopLive ? 'desktop' : 'cli', nonce: ++fileLinkSequence.current }); setSidebarOpen(true); return;
    }
    showToast('此链接请在对应电脑会话中查看', 'alert');
  }, [interactionEpoch, draftKey, operationScope, sessionKey, session?.cwd, desktopLive, device?.capabilities, tool, readOnly, outputs.openFile]); // eslint-disable-line react-hooks/exhaustive-deps
  const openPlan = useCallback((item: Extract<TimelineItem, { kind: 'tool' }>) => {
    if (interactionCurrent()) setPlanPreview({ id: item.id, epoch: interactionEpoch });
  }, [interactionEpoch, draftKey, operationScope]);
  const previewPlan = planPreview?.epoch === interactionEpoch && visible ? timeline.items.find((item): item is Extract<TimelineItem, { kind: 'tool' }> => item.kind === 'tool' && item.tool === 'plan' && item.id === planPreview.id) : undefined;
  const openChanges = useCallback((files: FileEdit[]) => {
    if (!interactionCurrent() || !files.length) return;
    setSidebarFile(null); setDiffFile(null); setPreviewTarget(null); setSidebarFocus(null);
    setReviewTarget({files, nonce: ++fileLinkSequence.current, epoch: interactionEpoch}); setSidebarOpen(true);
  }, [interactionEpoch, draftKey, operationScope]);
  const openBrowser = useCallback((navigation: BrowserNavigation) => openConversationLink(navigation.url, true, navigation.pageId), [openConversationLink]);
  const undoUnavailable = !online ? '电脑离线，连接后可撤销' : hostWorkActive ? '任务仍在运行，结束后可撤销'
    : readOnly || !session?.cwd || !device?.capabilities?.includes('workspace.files.write.v1') ? '当前电脑尚未开放文件撤销' : undefined;
  const undoChanges = useCallback(async (files: FileEdit[]) => {
    if (!interactionCurrent() || undoUnavailable || !deviceId || !sessionKey || !session?.cwd || !agent) throw new Error('当前状态无法撤销文件变更');
    const result = await undoWorkspaceChanges({deviceId,sessionKey,agentId:agent.id,surface:desktopLive?'desktop':'cli',expectedCwd:session.cwd},files);
    const restoredPaths = files.filter(file => {
      const link = resolveRemoteLink(file.path,session.cwd);
      return result.restoredPaths.includes(link.kind === 'file' ? link.path : file.path);
    }).map(file=>file.path);
    return {...result,restoredPaths};
  }, [interactionEpoch,draftKey,operationScope,undoUnavailable,deviceId,sessionKey,agent?.id,session?.cwd,desktopLive]);
  const resolveFailure=(action:ExecutionRecoveryAction)=>{
    if(!interactionCurrent()||apiIdentityRef.current!==apiIdentity)return;
    if(action==='connection'){void refresh().catch(reason=>{if(interactionCurrent()&&apiIdentityRef.current===apiIdentity)showToast(reason instanceof Error?reason.message:'连接检查失败，请稍后重试','alert');});showToast('正在读取电脑连接与会话状态，不会重发消息','code');return;}
    if(sending||apiSwitching||pendingDelivery||hostWorkActive){showToast('请先等待当前任务结束或核对待确认消息','alert');return;}
    if(action==='api')openApi();
    if(action==='model')openModels();
    if(action==='new'){if(onNew)onNew(workspaceMode, session?.projectless || projectless ? '' : session?.cwd || cwd, ...(session?.projectless || projectless ? [true as const] : []));else showToast('请返回项目目录新建对话，原草稿已保留','code');}
  };
  const threadUi = useMemo(() => ({ editDraftScope:operationScope,editDraftDeviceId:deviceId??undefined,latestEditableMessageId:!readOnly&&!desktopLive&&typeof hubSupportsLatestTurnRevert==='function'&&hubSupportsLatestTurnRevert()&&currentAgent?.capabilities?.latestTurnRevert===true&&session?.latestTurnRevert===true?latestEditable?.id:undefined,onEditMessage:editLatest,editMessageDisabledReason:running?'请先停止当前任务，再编辑最新消息':sending||pendingDelivery||!online?'请先等待操作完成并核对连接':queuedItems.length?'请先处理排队消息':editBackup.blocked?'请先核对上次编辑保留的内容':undefined,onResolveFailure:resolveFailure,openPlan, openDiff, openChanges, openBrowser, undoChanges: undoUnavailable ? undefined : undoChanges, undoUnavailable, openDiffInToolPanel: true, openImage:openConversationImage, artifactScope:outputScope, onOpenArtifact:openArtifact, onArtifactCompose:appendArtifactToComposer, requestAttachment, getAttachmentThumbnail, openAttachment, openLink: openConversationLink, openAnnotation: navigateAnnotation,
    childTitle: (key: string) => {
      const current = remote.timelines[timelineKey(deviceId ?? '', key)]?.session
        ?? remote.sessions[deviceId ?? '']?.list.find(item => item.sessionKey === key);
      return current ? childAgentTitle(current) : `子智能体 · ${key.split(':').slice(1).join(':').slice(0, 20)}`;
    },
    replyToCrossTask, currentSessionKey: sessionKey ?? undefined, attachmentRetryTick, presentation: tabletLayout ? 'tablet' as const : 'mobile' as const }),
    [editLatest,latestEditable,editBackup.blocked,running,sending,pendingDelivery,online,queuedItems.length,resolveFailure,openPlan, openDiff, openChanges, openBrowser, undoChanges, undoUnavailable, openConversationImage, outputScope, openArtifact, appendArtifactToComposer, openImage, requestAttachment, getAttachmentThumbnail, openAttachment, openConversationLink, navigateAnnotation, replyToCrossTask, sessionKey, attachmentRetryTick, remote.timelines, remote.sessions, deviceId, tabletLayout]);
  const subtitle = isNew ? (agent?.name ?? toolName(tool))
    : [desktopLive ? '桌面续聊' : toolName(tool), device && syncNotice ? syncNotice : ''].filter(Boolean).join(' · ');
  const placeholder = running ? '发送下一条消息…' : `和 ${agent?.name ?? toolName(tool)} 一起工作`;
  const composerPlan=featureEligible&&effectiveCollaboration==='plan'?<Pressable accessibilityRole="button" accessibilityLabel="关闭计划模式"
    accessibilityHint={collaborationChoice==='plan'&&session?.collaborationMode!=='plan'?'将应用到下一条消息，点击关闭':'点击切回常规模式'} disabled={permissionRuntime.current.locked||!featureCwd} onPress={disablePlan}
    style={{alignSelf:'flex-start',flexDirection:'row',alignItems:'center',gap:4,marginLeft:4,marginBottom:5,paddingHorizontal:8,minHeight:27,borderRadius:7,backgroundColor:dk.surface2}}>
    <Icon name="listCheck" size={13} color={dk.text2}/><Text style={{color:dk.text2,fontSize:12}}>计划</Text><Icon name="close" size={11} color={dk.muted}/></Pressable>:null;

  const composerBar = (mic: React.ReactNode) => (
  <MainComposerToolbar features={<>
    <ToolbarButton icon="plus" label="添加到对话" anchorRef={attachmentAnchor} disabled={!importEnabled} onPress={() => setAttachMenu(true)} />
    {tool === 'codex' || approvalEditable || featureEligible ? tool === 'codex'
      ? <MainComposerPermission anchorRef={permissionAnchor} label={permissionPreview ? PERMISSION_LABEL[permissionPreview] : '权限'}
          disabled={!permissionEditable || permissionRuntime.current.locked} danger={permissionEditable && permissionPreview === 'full_access'} onPress={() => setPicker('permission')} />
      : <MainComposerPermission anchorRef={permissionAnchor} label={approvalPreview ? MODE_LABEL[approvalPreview] : '权限'} disabled={!approvalEditable || permissionRuntime.current.locked || running}
          danger={approvalPreview === 'auto_all'} onPress={() => setPicker('mode')} /> : null}
    {mic}
    </>} actions={<>
    <MainComposerModelGroup>
    {contextEligible && deviceId && sessionKey ? <ContextBar ref={contextBar} key={contextScope} deviceId={deviceId} sessionKey={sessionKey} scopeKey={contextScope}
      active={visible && online && !verifying && !apiSwitching} busy={running || sending || Boolean(pendingDelivery) || queuedItems.length > 0}
      signalVersion={`${timeline.contextSignal ?? 0}|${session?.activeTurnId ?? ''}|${session?.lastTerminalTurnId ?? ''}|${status}|${session?.model ?? ''}`}
      canCompact={currentAgent?.capabilities?.compact === true} onBusyChange={busy => { if (contextScopeRef.current !== contextScope) return; contextBusyRef.current = busy; setContextBusyState({ scope: contextScope, busy }); }} />
      : <ContextIndicator key={contextScope} scopeKey={contextScope} active={visible && foreground} unavailableReason={isNew ? '开始对话后显示上下文用量' : '当前会话暂未提供上下文用量'} />}
    <MainComposerModelButton anchorRef={modelAnchor} label={currentModelLabel || (desktopLive || managedApi ? '选择模型' : modelEditable ? '默认' : '未提供模型')} disabled={!desktopLive && !modelEditable} onPress={openModels}/>
    </MainComposerModelGroup>
    {effortEditable ? <MainEffortControl levels={scrubLevels} value={effectiveEffort} scopeKey={`${catalogScope}|${capabilityModel}`}
      disabled={apiSwitching || Boolean(pendingDelivery) || !foreground} open={picker === 'effort'} onClose={() => setPicker(current => current === 'effort' ? null : current)} onSelect={chooseEffort} onScrub={onScrub} /> : null}
    {running && !isNew && !desktopLive && !readOnly && !slashQuery && currentAgent?.capabilities?.steer === true && hubSupportsSteer?.() && text.trim()
      ? <IconButton icon="chevronRight" label="引导当前轮次" size={34} iconSize={17}
        disabled={verifying || sending || apiSwitching || !desktopCanSend || !online || externalBusy || Boolean(busyApproval) || !pendingChecked || Boolean(pendingDelivery)
          || Boolean(images.length || queuedItems.length) || stopState?.key === draftKey || !turnControlTarget(timeline, 'stop')}
        onPress={() => void send('steer')} /> : null}
    {slashQuery ? <MainComposerAction icon="check" label="选择命令"
      disabled={!slashEntries.length || !online || permissionRuntime.current.locked || !composerReady} onPress={() => { if (slashEntries[slashIndex]) selectSlashCommand(slashEntries[slashIndex]); }} />
    : running && desktopCanStop && !composerHasContent && !isNew && !externallyOwnedBusy && !busyApproval
      ? <MainComposerAction icon="stop" label={stopState?.key === draftKey ? '停止待确认' : '停止'} disabled={stopState?.key === draftKey} onPress={stop}/>
      : !isNew && !running && !composerHasContent && currentAgent?.capabilities?.continue === true && Boolean(turnControlTarget(timeline, 'continue'))
        ? <MainComposerAction icon="chevronRight" label="继续" disabled={editBackup.blocked || contextBusy || verifying || sending || apiSwitching || !desktopCanSend || !online || Boolean(busyApproval) || !pendingChecked || Boolean(pendingDelivery) || Boolean(queuedItems.length) || stopState?.key === draftKey || modelBlocked} onPress={continueTask} />
      : <MainComposerAction icon={running && !isNew && !pendingDelivery && composerHasContent ? 'hourglass' : 'arrowUp'} label={running && !isNew && !pendingDelivery && composerHasContent ? '排队发送' : '发送'} disabled={editBackup.blocked || !composerHasContent || verifying || sending || apiSwitching || !desktopCanSend || !online || externalBusy || Boolean(busyApproval) || !pendingChecked || Boolean(pendingDelivery) || stopState?.key === draftKey || modelBlocked || (isNew && !hasNewLocation)} onPress={() => void send()} />}
  </>} />
  );

  const sideChatHistory = sideQuestionStorageScope && deviceId && sessionKey ? (paneVisible: boolean) => <SideQuestionPanel key={sideQuestionStorageScope} visible={visible && paneVisible}
        scopeKey={sideQuestionStorageScope} authorizationScope={sideQuestionScope} sessionKey={sessionKey} availableHeight={inputSpace}
        loadHistoryScopes={() => typeof loadSessionSideQuestionHistoryScopes === 'function' ? loadSessionSideQuestionHistoryScopes(deviceId, sessionKey, sideQuestionStorageScope) : Promise.resolve([])}
        compactComposer showHistory
        transport={{
          isCurrent: () => { try { return sideHistorySupported && online && !verifying && !apiSwitching && interactionCurrent() && apiIdentityRef.current === apiIdentity && sessionSideQuestionScope(deviceId, sessionKey) === sideQuestionScope; } catch { return false; } },
          read: (chainId, signal, options) => readSessionSideQuestion(deviceId, sessionKey, chainId, signal, options),
          ask: (reading, input, operationId) => askSessionSideQuestion(deviceId, sessionKey, reading, input, operationId),
          remove: (chainId, operationId) => deleteSessionSideQuestion(deviceId, sessionKey, chainId, operationId),
        }} /> : null;
  const sideChatPanel = (paneVisible: boolean, tabId = 'side-chat') => <TemporarySideChat visible={visible && paneVisible}
    scopeKey={JSON.stringify([operationScope, deviceId, sessionKey, currentAgent?.id, currentAgent?.api, tabId])} sessionKey={sessionKey ?? ''}
    unavailableReason={desktopLive ? '当前原生 Work 连接尚未提供临时侧边聊天能力' : readOnly ? '当前只读连接尚未提供临时侧边聊天能力' : '当前电脑尚未提供临时侧边聊天能力'}
    selection={sideQuestion?.scope === sideQuestionStorageScope ? sideQuestion.selection : undefined} selectionNonce={sideQuestion?.scope === sideQuestionStorageScope ? sideQuestion.nonce : undefined}
    onSelectionConsumed={() => setSideQuestion(current => current === sideQuestion ? undefined : current)}
    transport={sideQuestionSupported && deviceId && sessionKey ? {
      isCurrent: () => { try { return online && !verifying && !apiSwitching && interactionCurrent() && apiIdentityRef.current === apiIdentity && sessionSideQuestionScope(deviceId, sessionKey) === sideQuestionScope; } catch { return false; } },
      read: signal => readTemporarySideChat(deviceId, sessionKey, signal), ask: (reading, input, operationId) => askTemporarySideChat(deviceId, sessionKey, reading, input, operationId),
      tools:(reading,request)=>runTemporarySideChatTool(deviceId,sessionKey,reading,request),
      models: refresh => listModels(deviceId, tool, refresh), uploadImages: images => uploadTemporarySideChatImages(deviceId, sessionKey, sideQuestionScope, images),
    } : undefined}/>;

  const tabletNavigation = tabletLayout && !isNew && deviceId && agent ? <RemoteSidebar mode="navigation" side="left" docked dockedWidth="100%" visible deviceId={deviceId} agent={currentAgent ?? agent}
    workspaceMode={workspaceMode} onWorkspaceModeChange={onWorkspaceModeChange} activeSpace={activeSpace} onSwitchSpace={onSwitchSpace} activeSessionKey={sessionKey} controlSurface={readOnly ? 'read-only' : desktopLive ? 'desktop' : 'cli'}
    childSessionKeys={childSessionKeys} parentSessionKey={session?.parentSessionKey} focusSessionKey={sidebarFocus} onClose={() => setNavigationOpen(false)}
    onOpenCommands={featureEligible && Boolean(featureCwd) ? openSkillsMenu : undefined} onOpenModel={openModels}
    onOpenSession={key => { if (!interactionCurrent()) return; setNavigationOpen(false); if (key !== sessionKey) { if (desktopLive) desktopTarget.current = `${operationScope}|${deviceId}|${key}`; onCreated(key); } }}
    onNew={onNew ? (mode, projectCwd, selectedProjectless) => { if (!interactionCurrent()) return; setNavigationOpen(false); const none = selectedProjectless || !projectCwd && (session?.projectless || projectless); onNew(workspaceMode, none ? '' : projectCwd || session?.cwd || cwd, ...(none ? [true as const] : [])); } : undefined} /> : null;
  const closeToolWorkspace = () => { setSidebarOpen(false); setSidebarFocus(null); setSidebarFile(null); setPreviewTarget(null); setDiffFile(null); };
  const toolWorkspace = deviceId && agent && !isNew ? <ArtifactAnnotationProvider value={appendImageNotes}><RemoteSidebar
    artifactScope={outputScope} artifactTarget={currentArtifactRequest}
    docked dockedWidth="100%" mode="tools" side="right" sideChat={sideChatPanel} sideChatHistory={sideChatHistory ?? undefined} sideChatOpenNonce={Math.max(sideQuestion?.scope === sideQuestionStorageScope ? sideQuestion.nonce : 0, slashSideChat?.scope === contextScope ? slashSideChat.nonce : 0) || undefined} fileEdits={changedFiles} toolActivities={toolActivities} workspaceMode={workspaceMode} onWorkspaceModeChange={onWorkspaceModeChange}
    onComputerUseStop={desktopCanStop && online && !verifying && !apiSwitching && Boolean(turnControlTarget(timeline, 'stop')) ? stop : undefined}
    computerUseStopPending={stopState?.key === draftKey} onComputerUseImage={openImage} onComputerUseAttachment={requestAttachment}
    onCompose={value => { if (!interactionCurrent() || apiIdentityRef.current !== apiIdentity || !composerReady || composerContext.current?.submitting) { showToast('当前草稿尚未就绪，请稍后添加批注', 'alert'); return false; } setText(current => current ? `${current}\n\n${value}` : value); if (!tabletLayout) setSidebarOpen(false); return true; }}
    reviewTarget={reviewTarget?.epoch === interactionEpoch ? reviewTarget : null}
    previewTarget={currentPreviewTarget} previewOpenNonce={currentPreviewTarget?.nonce} diffTarget={diffFile?.epoch === interactionEpoch ? diffFile.file : null} diffOpenNonce={diffOpenNonce.current}
    onOpenDiffFullscreen={() => { if (interactionCurrent() && diffFile?.epoch === interactionEpoch) { setSidebarOpen(false); setDiffFullscreen(true); } }}
    onReference={referenceSupported ? value => { if (interactionCurrent() && value.sessionKey === sessionKey) { setSidebarOpen(false); setReferencePreview(value); } } : undefined}
    onReviewReference={diffAnnotationSupported ? reference => { if (!interactionCurrent() || reference.kind !== 'diff' || reference.sessionKey !== sessionKey || diffReviewProblem(timeline.items, sessionKey ?? '', [reference])) return false; return chooseReference(reference, { consumeQuery: false, focusComposer: false }); } : undefined}
    visible={visible && toolsPaneVisible} deviceId={deviceId} agent={currentAgent ?? agent} activeSessionKey={sessionKey} controlSurface={readOnly ? 'read-only' : desktopLive ? 'desktop' : 'cli'}
    childSessionKeys={childSessionKeys} parentSessionKey={session?.parentSessionKey} focusSessionKey={sidebarFocus} fileTarget={sidebarFile}
    onClose={() => { setSidebarOpen(false); setSidebarFocus(null); setSidebarFile(null); setPreviewTarget(null); setDiffFile(null); }}
    onOpenSession={key => {
      if (!interactionCurrent()) return;
      setSidebarOpen(false); setSidebarFocus(null); setSidebarFile(null); setPreviewTarget(null); setDiffFile(null);
      if (key !== sessionKey) { if (desktopLive) desktopTarget.current = `${operationScope}|${deviceId}|${key}`; onCreated(key); }
    }}
    onNew={onNew ? (mode, projectCwd, selectedProjectless) => { if (!interactionCurrent()) return; setSidebarOpen(false); setSidebarFocus(null); setSidebarFile(null); setPreviewTarget(null); setDiffFile(null); const none = selectedProjectless || !projectCwd && (session?.projectless || projectless); onNew(workspaceMode, none ? '' : projectCwd || session?.cwd || cwd, ...(none ? [true as const] : [])); } : undefined}
  /></ArtifactAnnotationProvider> : null;
  const tabletHeader = <View style={styles.tabletHeaderContent}>
    <View style={styles.tabletHeaderBody}>
      <Text style={styles.tabletHeaderTitle} numberOfLines={1}>{title}</Text>
      <View style={styles.tabletHeaderMeta}>
        <View style={[styles.tabletHeaderDot, { backgroundColor: verifying ? dk.warn : !online ? dk.faint : running ? dk.accent : dk.ok }]} />
        <Text style={styles.tabletHeaderSubtitle} numberOfLines={1}>{syncNotice ?? (verifying ? '正在连接' : running ? `${subtitle} · 正在运行` : subtitle || '已连接')}</Text>
      </View>
    </View>
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      <ToolbarButton icon="more" label="更多" anchorRef={tabletLayout?menuAnchor:undefined} onPress={() => setMenu(true)} />
    </View>
  </View>;

  return <Sheet visible={visible && Boolean(deviceId)} presentation="page" scroll={false} background={dk.surface}
    onClose={() => { if (!tabletLayout && (sidebarOpen || toolsPaneVisible)) closeToolWorkspace(); else onClose(); }} onSystemBack={() => {
    if (dismissKeyboardOnBack() || workspaceBack.handle()) return;
    if (searchOpen) { setSearchOpen(false); setSearchQuery(''); setSearchPos(0); return; }
    if (slashQuery) { closeSlash(); return; }
    onClose();
  }} title={title} subtitle={subtitle} hideHeader={!isNew&&(tabletLayout||!tabletLayout&&(sidebarOpen||toolsPaneVisible))}
    headerLeft={<View testID="conversation-header-navigation" style={{flexDirection:'row',alignItems:'center'}}>
      <ToolbarButton icon="arrowLeft" label="返回" onPress={onClose}/>
      {!tabletLayout && !isNew ? <ToolbarButton icon="panelLeft" label="打开会话导航" onPress={()=>setNavigationOpen(true)}/> : null}
    </View>}
    headerRight={!isNew ? <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      {!tabletLayout ? <>
        <ToolbarButton icon="panelRight" label="打开工具栏" onPress={() => { setPreviewTarget(null); setDiffFile(null); setSidebarFile(null); setSidebarFocus(null); setSidebarOpen(true); }} />
      </> : null}
      <ToolbarButton icon="more" label="更多" anchorRef={!tabletLayout?menuAnchor:undefined} onPress={() => setMenu(true)} />
    </View> : <View style={{ width: 40 }} />}>
    <TabletThreadFrame onRegisterBack={workspaceBack.register} workspaceHasTabBar enabled={tabletLayout && !isNew} navigation={tabletNavigation} header={tabletHeader} workspace={toolWorkspace} mobileWorkspaceOpen={sidebarOpen} onCloseWorkspace={closeToolWorkspace} onWorkspaceVisibilityChange={reportToolsVisibility}
      workspaceOpenNonce={[sidebarFile?.nonce, currentPreviewTarget?.nonce, currentArtifactRequest?.nonce, diffOpenNonce.current, reviewTarget?.epoch === interactionEpoch ? reviewTarget.nonce : undefined, sideQuestion?.nonce, slashSideChat?.scope === contextScope ? slashSideChat.nonce : undefined].filter(Boolean).join('|')}>
    <View style={{ flex: 1, minWidth: 0 }}>
    <ConversationDropZone scopeKey={`${draftKey}|${apiIdentity}|${interactionEpoch}`} enabled={importEnabled} onFiles={appendFiles} importRef={filePicker}>
    <ThreadUi.Provider value={threadUi}><ThreadClockProvider visible={visible} startedAt={startedAt}>
    <View style={{ flex: 1, minWidth: 0 }} onLayout={(event) => { const height = event.nativeEvent.layout.height; if (height > 0) setInputSpace(height); }}>
      {searchOpen && !isNew ? <SearchBar query={searchQuery} onChange={(value) => { setSearchQuery(value); setSearchPos(0); }} position={Math.min(searchPos, Math.max(0, hits.length - 1))} total={hits.length}
        onPrev={() => { if (hits.length) setSearchPos((value) => (value - 1 + hits.length) % hits.length); }}
        onNext={() => { if (hits.length) setSearchPos((value) => (value + 1) % hits.length); }}
        onClose={() => { setSearchOpen(false); setSearchQuery(''); setSearchPos(0); }} /> : null}
      {searchOpen&&!isNew?<Text style={{paddingHorizontal:20,paddingBottom:6,color:dk.muted,fontSize:12}}>搜索已加载的消息{timeline.nextCursor?' · 加载更早记录可继续查找':''}</Text>:null}
      {isNew ? <NewThreadIntro agent={agent} cwd={cwd} projectless={projectless} workspaceMode={workspaceMode} onReturnToProjects={onClose} />
        : <View style={{ flex: 1 }}><FlatList
          testID="remote-conversation"
          key={readingScope}
          ref={listRef}
          onLayout={readingPosition.onLayout}
          onViewableItemsChanged={resultViewability}
          data={blocks}
          keyExtractor={(item: ConversationBlock) => item.id}
          maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
          contentContainerStyle={[styles.list, tabletLayout && styles.tabletList]}
          refreshing={timeline.loading && blocks.length > 0}
          onRefresh={() => { void refresh().catch((error: Error) => showToast(error.message, 'alert')); }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          showsVerticalScrollIndicator={false}
          onScroll={(event: { nativeEvent: { layoutMeasurement: { height: number }; contentOffset: { y: number }; contentSize: { height: number } } }) => {
            if(!readingPosition.onScroll(event as never))return;
            const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent;
            const away = contentSize.height - layoutMeasurement.height - contentOffset.y;
            if (!draggingRef.current) followRef.current = away < 120;
            setJumpState(away > 320 ? { visible: true, unseen: jumpRef.current.unseen } : { visible: false, unseen: false });
          }}
          onScrollBeginDrag={() => { readingPosition.interact(); draggingRef.current = true; followRef.current = false; }}
          onScrollEndDrag={(event: { nativeEvent: { layoutMeasurement: { height: number }; contentOffset: { y: number }; contentSize: { height: number } } }) => {
            draggingRef.current = false;
            const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent;
            followRef.current = contentSize.height - layoutMeasurement.height - contentOffset.y < 40;
          }}
          scrollEventThrottle={64}
          onContentSizeChange={(_width: number, height: number) => {
            const restoring=readingPosition.onContentSizeChange(_width,height);
            const grew = height > contentHeight.current + 1;
            contentHeight.current = height;
            if(restoring)return;
            if (followRef.current) listRef.current?.scrollToEnd({ animated: true });
            else if (grew && jumpRef.current.visible) setJumpState({ visible: true, unseen: true });
          }}
          onScrollToIndexFailed={(info: { index: number; averageItemLength: number }) => {
            if(readingPosition.onScrollToIndexFailed(info))return;
            const navigationCurrent=readingPosition.captureInteraction();
            listRef.current?.scrollToOffset({ offset: Math.max(0, info.averageItemLength * info.index - 120), animated: false });
            setTimeout(() => { if(!navigationCurrent()||!interactionCurrent())return;try { listRef.current?.scrollToIndex({ index: info.index, viewPosition: 0.3, animated: true }); } catch { /* still measuring */ } }, 120);
          }}
          ListHeaderComponent={timeline.nextCursor ? <Pressable accessibilityRole="button" accessibilityLabel="加载更早记录"
            disabled={timeline.loadingEarlier || !online} onPress={() => {
              if (!interactionCurrent() || !deviceId || !sessionKey || !online) return;
              readingPosition.interact();
              followRef.current = false;
               historyReadController.current?.abort();
               const controller = new AbortController();
               historyReadController.current = controller;
               void loadEarlierHistory(deviceId, sessionKey, controller.signal).catch(() => undefined).finally(() => {
                 if (historyReadController.current === controller) historyReadController.current = null;
               });
            }} style={{ minHeight: 42, alignItems: 'center', justifyContent: 'center' }}>
            {timeline.loadingEarlier ? <ActivityIndicator size="small" color={dk.muted} /> : <Text style={{ color: dk.muted, fontSize: 12 }}>{timeline.earlierError ? '加载失败，重试' : '更早记录'}</Text>}
          </Pressable> : null}
          ListEmptyComponent={timeline.loading
            ? <SkeletonGroup label="正在从电脑读取对话"><SkeletonThread /><Text style={[styles.loadingText, { textAlign: 'center', marginTop: 18 }]}>正在从电脑读取对话…</Text></SkeletonGroup>
            : timeline.error && readErrorNoticeVisible ? <EmptyState icon="alert" title="没有读到这个对话" detail={timeline.error} />
              : timeline.error && readRetryProgressVisible ? <View accessibilityRole="progressbar" accessibilityLabel="正在重试连接" style={{ alignItems: 'center', paddingVertical: 42 }}><ActivityIndicator size="small" color={dk.muted} /></View>
                : timeline.error && isTransientReadFailure(readErrorValue) ? null
                  : <EmptyState icon="chat" title="还没有内容" detail="在下面继续这个对话" />}
          ListFooterComponent={answerSending ? <View testID="remote-answer-delivery" style={styles.thinking} accessibilityRole="progressbar" accessibilityLabel="正在发送回答" accessibilityState={{ busy: true }}><ActivityIndicator size="small" color={dk.muted} /></View>
            : thinking ? <View style={styles.thinking}><PulseDot /><Text style={styles.thinkingText}><ThreadClockLabel prefix="正在处理" /></Text></View>
              : timeline.error && readRetryProgressVisible && !readErrorNoticeVisible ? <View accessibilityRole="progressbar" accessibilityLabel="正在重试连接" style={{ alignItems: 'center', paddingVertical: 12 }}><ActivityIndicator size="small" color={dk.muted} /></View> : null}
          renderItem={({ item, index }: { item: ConversationBlock; index: number }) => {
            const previous = index > 0 ? blocks[index - 1] : undefined;
            const tabletGap = index === 0 ? 0 : item.type === 'assistant' || previous?.type === 'assistant' ? WORKBENCH_SPACING.turn : 4;
            return <View style={tabletLayout ? { marginTop: tabletGap } : undefined}><BlockRow block={item} tool={tool}
            stat={item.type === 'assistant' ? stats.get(item.item.id) : undefined}
            runningTurnStartedAt={item.type === 'assistant' && item.item.id === runningHeading?.messageId ? runningHeading.startedAt : undefined}
            highlight={index === hitIndex || (item.type === 'user' || item.type === 'assistant') && item.item.id === annotationSourceId}
            searchQuery={index === hitIndex ? searchQuery : ''}
            onQuote={readOnly ? undefined : quote}
            onSelectText={annotationSupported ? selectMessageText : undefined}
            selectionScope={featureScope} allowAskSelection={sideQuestionSupported && Boolean(sideQuestionScope)}
            selectionHighlight={(item.type === 'user' || item.type === 'assistant') && item.item.id === annotationHighlight?.id ? annotationHighlight : undefined}
            onRetry={retryTarget && item.type === 'turn' && item.item.id === retryTarget.failed.id && !running && online && desktopCanSend ? () => retry(retryTarget) : undefined}
            pendingDeliveryMessageId={pendingDeliveryMessageId}
            onOpenChild={(key) => {
              if (!interactionCurrent()) return;
              // Handles are opaque, but the protocol requires a namespaced
              // session key. Accept extension agents (Hermes and future
              // adapters) instead of hard-coding the parent tool prefix.
              const validHandle = typeof key === 'string' && /^[A-Za-z0-9._-]{1,64}:[^\r\n\0]{1,512}$/.test(key);
              if (validHandle && key !== sessionKey) {
                setSidebarFile(null);
                setSidebarFocus(key);
                setNavigationOpen(true);
                // The drawer validates the child's current surface/lease.
                // An observed raw handle is not permission to route a native
                // child through a CLI fallback while its directory is cold.
              }
            }} /></View>;
          }}
        />
        <JumpToLatest visible={jump.visible && !searchOpen} unseen={jump.unseen} onPress={() => {
          readingPosition.interact();
          followRef.current = true; setJumpState({ visible: false, unseen: false }); listRef.current?.scrollToEnd({ animated: true });
        }} />
        </View>}

      <View>
      {!readOnly && activeApproval?.approval !== 'question' ? <ApprovalQueueBar count={pending.length} disabled={Boolean(busyApproval)} onMove={moveApproval} /> : null}
      {!readOnly && activeApproval && activeApproval.approval !== 'question' ? <ApprovalCard approval={activeApproval} more={0} tool={tool} busy={Boolean(busyApproval)} disabled={!online || !desktopCanApprove} allowSession={!desktopLive}
        onDecide={(decision) => void decide(activeApproval, decision)} onDeny={() => { setReason(''); setDenying(activeApproval); }} /> : null}
      </View>

      {!readOnly ? <View><QuestionDock key={draftKey} question={question} busy={Boolean(busyApproval)} availableHeight={inputSpace} blocked={questionProblem || (!desktopCanApprove || question && !approvalDecisions(question).includes('allow') ? '请在电脑回答' : !online ? '电脑离线，恢复后可回答' : undefined)}
        canCancel={!question || approvalDecisions(question).includes('deny')}
        cancelBlocked={Boolean(questionProblem) || !desktopCanApprove || !online}
        cancelLabel={question?.approvalOptions?.denyEffect === 'cancel_turn' ? '取消本轮' : '取消回答'}
        queueControl={<ApprovalQueueBar count={pending.length} disabled={Boolean(busyApproval)} onMove={moveApproval} />}
        initialAnswers={answerDraft.current?.scope === draftKey && answerDraft.current?.id === question?.id ? answerDraft.current.answers : undefined}
        initialDraft={question ? questionDrafts.current.values.get(question.id) : undefined}
        onDraftChange={(id, draft) => { if (draftRef.current === draftKey && questionContext.current.pending.some(item => item.id === id)) questionDrafts.current.values.set(id, draft); }}
        onAnswer={(answers) => { if (question) void decide(question, 'allow', undefined, answers); }} onCancel={() => { if (question) void decide(question, 'deny'); }}>
      <View style={[styles.composerWrap, tabletLayout && styles.tabletComposerWrap]}>
        <MissingSessionDraftRecovery scopeKey={draftKey} evidence={missingEvidence} restored={Boolean(recoveredHere)}
          hasDraft={Boolean(text || images.length || composerBlockedImages || featureDraftIntent || recoveredHere)} disabled={!composerReady || sending || !online || apiSwitching || Boolean(pendingDelivery) || Boolean(queuedItems.length)}
          undoDisabled={!recoveryUnchanged()} onRestore={onNew && !desktopLive ? restoreMissingDraft : undefined} onUndo={undoDraftRecovery} />
        <TaskProgressDock items={timeline.items} activeTurnId={session?.activeTurnId} running={running && visible} scopeKey={draftKey} />
        <LimitRetryNotice failure={retryTarget?.failed} scopeKey={JSON.stringify([draftKey, apiIdentity, model, effort, permissionChoice, mode])}
          cancelKey={JSON.stringify([text, images.map(image => image.uri), featureDraftIntent])}
          enabled={visible && foreground && online && !running && !sending && !pendingDelivery && !queuedItems.length && !apiSwitching && desktopCanSend && composerReady && pendingChecked && !featureSourceBlocked}
          onRetry={() => { if (retryTarget) retry(retryTarget); }} />
        {composerSaveProblem ? <View style={styles.banner}><Icon name="alert" size={15} color={dk.warn} /><Text style={styles.bannerText}>{composerSaveProblem}</Text></View> : null}
        {diffDraftProblem ? <View style={styles.banner}><Icon name="alert" size={15} color={dk.warn} /><Text style={styles.bannerText}>{diffDraftProblem}</Text></View> : null}
        {session?.archived ? <View style={styles.banner}><Icon name="archive" size={15} color={dk.muted} /><Text style={styles.bannerText}>已归档</Text>
          {typeof hubSupportsSessionActions === 'function' && hubSupportsSessionActions() && agentSupports(currentAgent ?? undefined, tool, 'sessionActions') && !desktopLive
            ? <Pressable accessibilityRole="button" accessibilityLabel="管理已归档会话" onPress={() => { if (interactionCurrent()) setSessionManagement(true); }}><Text style={styles.apiLink}>管理</Text></Pressable> : null}</View> : null}
        {featureSourceBlocked ? <View style={styles.banner}>
          <Icon name="alert" size={15} color={dk.warn} />
          <Text style={styles.bannerText}>草稿的模式、技能或引用属于其他电脑、项目或账号。切回原来源，或清除后重新选择。</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="清除其他来源的模式、技能和引用" onPress={clearUnavailableFeatures}><Text style={styles.apiLink}>清除</Text></Pressable>
        </View> : featuresBlocked && featureStateCurrent && !featureState.loading && !featureState.error ? <View style={styles.banner}>
          <Icon name="alert" size={15} color={dk.warn} />
          <Text style={styles.bannerText}>所选模式或技能已不可用，请清除后重新选择。</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="清除不可用的模式和技能" onPress={clearUnavailableFeatures}><Text style={styles.apiLink}>清除</Text></Pressable>
        </View> : null}
        {apiError || recentProblem?.message ? <Pressable accessibilityRole="button"
          accessibilityLabel={desktopLive && (!nativeModelEditable || (apiError || recentProblem)?.kind !== 'model_capacity') ? '在电脑处理当前错误' : ((apiError || recentProblem)?.kind === 'model_capacity') ? '模型容量已满，换模型或重试' : (apiError || recentProblem)?.kind === 'quota' ? 'API 额度不足，更换 API' : 'API 出错，更换 API'}
          onPress={() => openProblem(apiError || recentProblem)} style={styles.banner}>
          <Icon name={((apiError || recentProblem)?.kind === 'model_capacity') ? 'sparkle' : 'key'} size={15} color={dk.warn} />
          <Text style={styles.bannerText}>{apiError?.message || recentProblem?.message}</Text>
          <Text style={styles.apiLink}>{desktopLive && (!nativeModelEditable || (apiError || recentProblem)?.kind !== 'model_capacity') ? '在电脑处理 ›' : ((apiError || recentProblem)?.kind === 'model_capacity') ? '换模型 ›' : (apiError || recentProblem)?.kind === 'quota' ? '更换 API ›' : '更换 ›'}</Text>
        </Pressable> : null}
        {session?.parentSessionKey ? <Pressable accessibilityRole="button" accessibilityLabel="返回主任务" onPress={() => {
          if (!interactionCurrent()) return;
          setSidebarFocus(session.parentSessionKey!); setNavigationOpen(true);
        }} style={styles.parentLink}><Text style={styles.apiLink}>‹ 返回主任务</Text></Pressable> : null}
        {pendingDelivery && pendingDeliveryNoticeVisible
          && (!pendingDelivery.retryable || Boolean(pendingDelivery.acceptedSessionKey) || !hostWorkActive)
          ? <Pressable accessibilityRole="button" onPress={() => setMenu(true)} style={styles.banner}>
          <Icon name={pendingDelivery.retryable ? 'hourglass' : 'alert'} size={15} color={dk.warn} />
          <Text style={styles.bannerText} numberOfLines={2}>{pendingDelivery.message}</Text>
        </Pressable> : null}
        {syncNotice && (online || offlineNoticeVisible) ? <View testID="conversation-sync-notice" accessibilityRole="alert" style={styles.banner}><Icon name="laptop" size={15} color={dk.warn} /><Text style={styles.bannerText}>{syncNotice}</Text></View>
          : verifying && !hostWorkActive ? <View style={styles.banner}><ActivityIndicator size="small" color={dk.warn} /><Text style={styles.bannerText}>正在连接电脑，确认后就能发送</Text></View>
          : verifying ? null
          : timeline.error && timeline.items.length && readErrorNoticeVisible ? <Pressable accessibilityRole="button" accessibilityLabel="重新读取对话" onPress={() => { if (interactionCurrent() && deviceId && sessionKey) void openSession(deviceId, sessionKey, desktopLive ? { controlSurface: 'desktop' } : undefined).catch(() => undefined); }} style={styles.banner}>
            <Icon name="alert" size={15} color={dk.warn} /><Text style={styles.bannerText}>{timeline.error}，显示的是上次的记录</Text><Text style={styles.apiLink}>重试</Text></Pressable> : null}
        {editBackup.panel}
        <QueuedMessages draftScope={operationScope} draftDeviceId={deviceId??undefined} scopeKey={`${draftKey}|${apiIdentity}`} disabled={!visible || !queueChecked || sending || Boolean(pendingDelivery) || apiSwitching}
          entries={queuedItems.map((entry,index) => { const owned = entry.scope === operationScope && entry.apiIdentity === apiIdentity;
            return { id: entry.id ?? `legacy-${index}`, text: entry.text, images: entry.images, imageCount: entry.imageCount, missingImages: entry.missingImages,
              detail: entry.state === 'attempting' ? '正在确认送达…' : entry.state === 'blocked' || !owned ? owned && remoteQueueEditable(entry) ? '已暂停，请核对后继续' : '已暂停，取回后核对再发送' : '当前任务结束后发送',
              options: [entry.sendOptions?.model,entry.sendOptions?.effort,entry.sendOptions?.permissionMode ?? entry.sendOptions?.approval,entry.sendOptions?.collaborationMode,...(entry.sendOptions?.skills ?? []).map(skill=>skill.name)].filter(Boolean).join(' · '),
              editable: owned && remoteQueueEditable(entry), removable: owned && remoteQueueEditable(entry),
              resumable: index === 0 && owned && remoteQueueEditable(entry) && entry.state === 'blocked' && !entry.missingImages,
              uncertain: entry.attempted === true || entry.state === 'attempting' }; })}
          onPause={() => manageQueue('pause')} onEdit={(id,text,originalText) => manageQueue('edit',id,{text,originalText})}
          onMove={(id,offset) => manageQueue('move',id,{offset})} onRemove={id => manageQueue('remove',id)} onResume={id => manageQueue('resume',id)}
          onReview={() => { if (interactionCurrent() && deviceId && sessionKey) void openSession(deviceId,sessionKey).catch(() => undefined); }}
          onRetrieve={() => void unqueue()} />
        <MainComposerSurface>
          <View pointerEvents="box-none" style={{ position: 'absolute', bottom: '100%', left: 0, right: 0, marginBottom: 6, zIndex: 20 }}>
        {(referenceQuery || referencePreview) && deviceId && referenceSupported ? <ContextReferencePicker ref={referencePicker} key={`${featureScope}:${referencePreview?.messageId ?? referencePreview?.path ?? 'search'}`}
          deviceId={deviceId} sessionKey={sessionKey ?? undefined} tool={tool} agentId={currentAgent?.id ?? tool} cwd={featureCwd ?? ''} scope={operationScope} query={referenceQuery?.query ?? ''}
          messages={timeline.items} sessions={remote.sessions[deviceId]?.list ?? []} filesAllowed={remote.devices.find(d => d.deviceId === deviceId)?.capabilities?.includes(isNew ? 'workspace.project.files.v1' : 'workspace.files.v1') === true}
          initial={referencePreview} availableHeight={inputSpace} onSelect={chooseReference} onClose={() => { if (interactionCurrent()) { setReferencePreview(undefined); setReferenceDismissed(referenceKey); composerInput.current?.focus(); } }} /> : null}
        {slashQuery ? <SlashCommandMenu entries={slashEntries} sourceLabel={currentAgent?.name || toolName(tool)} selectedId={slashEntries[slashIndex]?.id} onSelect={selectSlashCommand} onClose={closeSlash}
          onReload={() => { if (featureOwner.current === featureScope && featureGenerationCurrent() && interactionCurrent() && !permissionRuntime.current.locked) { forceFeatureRefresh.current = true; ++featureRequest.current; setFeatureRevision(value => value + 1); } }}
          loading={featureEligible && online && (!featureStateCurrent || featureState.loading)} error={!online ? '电脑离线，连接后可选择命令' : featureEligible && featureStateCurrent ? featureState.error : ''}
          disabled={!online || permissionRuntime.current.locked} /> : null}
          </View><View ref={composerRef} collapsable={false}>
          {isNew && seed ? <View style={styles.seedRow}><Icon name="history" size={13} color={dk.accentText} /><Text style={styles.seedText} numberOfLines={1}>接着 Claude Desktop 对话：{seed.title}</Text></View> : null}
          <DraftImageStrip scopeKey={draftKey} images={images} visible={visible} disabled={sending || !composerReady}
            onRemove={index => { if (interactionCurrent()) setImages(current => current.filter((_, i) => i !== index)); }} />
          {contextReferences.length ? <View style={{ paddingHorizontal: 12, paddingVertical: 5 }}><ContextReferenceChips references={contextReferences}
            onRemove={removeReference} onAnnotationChange={(annotationSupported || diffAnnotationSupported) && !featureSourceBlocked ? changeAnnotation : undefined}
            onNavigate={navigateAnnotation} editRequest={annotationEditRequest} availableHeight={inputSpace}
            onFinishEditing={() => { setAnnotationEditRequest(undefined); composerInput.current?.focus(); }} /></View> : null}
          {composerPlan}
          <AttachmentComposerInput history={history} historyRef={historyRef} onRestoreHistory={restoreHistory} active={visible} scopeKey={`${draftKey}|${apiIdentity}`} key={featureScope} ref={composerInput} value={text} mentions={skillMentions} onChangeText={editComposerText} onSkillEdit={edit => editComposerText(edit.text, edit)}
            selection={forcedSelection ? { start: Math.min(text.length, forcedSelection.start), end: Math.min(text.length, forcedSelection.end) } : undefined}
            onSelectionChange={event => {
              const next = event.nativeEvent.selection;
              setInputSelection({ text, start: next.start, end: next.end });
              if (forcedSelection && next.start === forcedSelection.start && next.end === forcedSelection.end) setForcedSelection(undefined);
            }} multiline placeholder={placeholder} placeholderTextColor={dk.muted}
            onKeyPress={event => {
              if ((referenceQuery || referencePreview) && event.nativeEvent.key === 'Escape') { event.preventDefault?.(); setReferencePreview(undefined); setReferenceDismissed(referenceKey); return; }
              if (referenceQuery && !(event.nativeEvent as { isComposing?: boolean }).isComposing && referencePicker.current?.keyDown(event.nativeEvent.key)) { event.preventDefault?.(); return; }
              if (!slashQuery || !featureCatalogCurrent() || (event.nativeEvent as { isComposing?: boolean }).isComposing) return;
              const key = event.nativeEvent.key;
              if (key === 'Escape') { event.preventDefault?.(); closeSlash(); }
              else if (key === 'ArrowDown' || key === 'ArrowUp') { event.preventDefault?.(); setSlashFocus({ key: slashKey, index: (slashIndex + (key === 'ArrowDown' ? 1 : -1) + slashEntries.length) % Math.max(1, slashEntries.length) }); }
              else if ((key === 'Enter' || key === 'Tab') && !(event.nativeEvent as {shiftKey?:boolean}).shiftKey && slashEntries[slashIndex]) { event.preventDefault?.(); selectSlashCommand(slashEntries[slashIndex]); }
            }}
            style={[styles.input, tabletLayout && styles.tabletInput]} accessibilityLabel="给电脑上的 Agent 发消息" editable={!sending && !featureSourceBlocked && (!isNew || hasNewLocation)} />
          {voice ? <RemoteDictation voice={voice} text={text} onText={editComposerText} disabled={sending}>{(mic) => composerBar(mic)}</RemoteDictation> : composerBar(null)}
          </View>
          {scrub && effortEditable ? <EffortScrubOverlay levels={scrubLevels} index={scrub.index} texture={scrub.texture} reduced={reducedMotion} /> : null}
        </MainComposerSurface>
      </View>
      </QuestionDock></View> : <View testID="remote-readonly-footer" style={styles.readOnlyBar}>
        <View style={{ flex: 1, minWidth: 0 }}><Text style={styles.readOnlyTitle}>只读</Text><Text style={styles.readOnlyText} numberOfLines={2}>Claude Desktop 的聊天只能在电脑上回复</Text></View>
        {onContinue && timeline.items.some((item) => item.kind === 'message') ? <MotionPressable accessibilityRole="button" accessibilityLabel="在 Claude Code 中继续" scaleTo={0.96}
          onPress={() => onContinue({ title: session?.title || '对话', transcript: continueTranscript(timeline.items), cwd: session?.cwd || undefined })} style={styles.continueButton}>
          <Icon name="terminal" size={14} color={dk.accentText} /><Text style={styles.continueText}>在 Claude Code 中继续</Text></MotionPressable> : null}
      </View>}
    </View>
    </ThreadClockProvider></ThreadUi.Provider></ConversationDropZone>


    </View>
    </TabletThreadFrame>

    {!tabletLayout && deviceId && agent && !isNew ? <RemoteSidebar mode="navigation" side="left" visible={navigationOpen} deviceId={deviceId} agent={currentAgent ?? agent}
      workspaceMode={workspaceMode} onWorkspaceModeChange={onWorkspaceModeChange} activeSpace={activeSpace} onSwitchSpace={onSwitchSpace} activeSessionKey={sessionKey} controlSurface={readOnly ? 'read-only' : desktopLive ? 'desktop' : 'cli'}
      childSessionKeys={childSessionKeys} parentSessionKey={session?.parentSessionKey} focusSessionKey={sidebarFocus} onClose={() => setNavigationOpen(false)}
      onOpenSession={key => { if (!interactionCurrent()) return; setNavigationOpen(false); if (key !== sessionKey) { if (desktopLive) desktopTarget.current = `${operationScope}|${deviceId}|${key}`; onCreated(key); } }}
      onNew={onNew ? (mode, projectCwd, selectedProjectless) => { if (!interactionCurrent()) return; setNavigationOpen(false); const none = selectedProjectless || !projectCwd && (session?.projectless || projectless); onNew(workspaceMode, none ? '' : projectCwd || session?.cwd || cwd, ...(none ? [true as const] : [])); } : undefined} /> : null}

    <PlanPreview item={previewPlan} onClose={() => setPlanPreview(current => current === planPreview ? null : current)} onOpenLink={previewPlan ? target => openConversationLink(target, !previewPlan.parentId) : undefined} />
    <ModelPopover visible={picker === 'model' && (desktopLive || modelEditable)} anchor={null} anchorRef={modelAnchor} value={model} fallback={defaultModel} models={desktopLive && !nativeModelEditable ? [] : models.models}
      catalogOnly={managedApi || desktopLive} catalogReady={catalogReady} error={catalogError}
      scopeKey={catalogScope} selectionEnabled={modelEditable}
      onFollowComputer={desktopLive ? followDesktop : undefined}
      interactionBlocked={contextBusy || apiSwitching || Boolean(pendingDelivery)}
      loading={modelsLoading} onRefresh={() => { if (!desktopLive || nativeModelEditable) void loadModels(true); }} onSelect={chooseModel} onClose={closeModels} />
    <CompactActionMenu visible={visible&&attachMenu} anchorRef={attachmentAnchor} scopeKey={`${draftKey}|${apiIdentity}`}
      label="添加到对话" onClose={()=>setAttachMenu(false)} actions={[
        {id:'local-files',label:'添加本地文件',icon:'file',disabled:!importEnabled,onPress:()=>{if(interactionCurrent()&&apiIdentityRef.current===apiIdentity){setAttachMenu(false);filePicker.current?.pick();}}},
        {id:'history',label:'最近输入',icon:'history',disabled:!importEnabled||!history.length,onPress:()=>{if(interactionCurrent()&&apiIdentityRef.current===apiIdentity){setAttachMenu(false);historyRef.current?.open();}}},
        {id:'gallery',label:'从相册选择',icon:'image',disabled:!imageInputSupported||desktopLive||sending||modelRejectsImages||images.length>=MAX_REMOTE_IMAGES,onPress:()=>void addImages('gallery')},
        {id:'camera',label:'拍照',icon:'camera',disabled:!imageInputSupported||desktopLive||sending||modelRejectsImages||images.length>=MAX_REMOTE_IMAGES,onPress:()=>void addImages('camera')},
        ...(computerFilesSupported&&!sending?[{id:'computer-file',label:'选择电脑文件',icon:'folder' as const,onPress:()=>{if(interactionCurrent())setRemoteFilePicker(true);}}]:[]),
      ]}/>
    {deviceId && agent && featureCwd ? <RemoteFilePicker visible={remoteFilePicker && visible && computerFilesSupported} deviceId={deviceId} deviceName={device?.name} sessionKey={sessionKey ?? undefined}
      agentId={currentAgent?.id ?? tool} tool={tool} cwd={featureCwd} scope={operationScope} existingReferences={contextReferences}
      onClose={() => { if (interactionCurrent()) { setRemoteFilePicker(false); requestAnimationFrame(() => composerInput.current?.focus()); } }}
      onAdd={next => {
        if (!interactionCurrent() || !referenceSupported || featureSourceBlocked || !composerContext.current?.ready || composerContext.current.busy || composerContext.current.submitting || sending || queueBusyRef.current) return;
        composerTextRevision.current += 1; contextReferencesRef.current = next; setContextReferences(next); setIntentSource(featureSource); setRemoteFilePicker(false); composerInput.current?.focus();
      }} /> : null}
    <ComposerOptionMenu<PermissionMode | ''> visible={picker === 'permission'} anchorRef={permissionAnchor} scopeKey={permissionScope} value={permissionPreview ?? ''} onClose={() => setPicker(null)}
      options={PERMISSION_MODES.filter(value => permissionModes.includes(value)).map(value => ({ value, label: PERMISSION_LABEL[value],
        danger: value === 'full_access', disabled: permissionRuntime.current.locked || value === 'full_access' && !autoAllowed }))}
      onSelect={value => {
        if (!isPermissionMode(value) || !interactionCurrent() || permissionRuntime.current.scope !== permissionScope || permissionRuntime.current.locked
          || composerContext.current?.busy || composerContext.current?.submitting || queueBusyRef.current || !permissionModes.includes(value)
          || value === 'full_access' && !autoAllowed) return;
        setPermissionChoice(value); setPicker(null);
      }} />
    <ComposerOptionMenu<ApprovalMode | ''> visible={picker === 'mode'} anchorRef={permissionAnchor} scopeKey={permissionScope} value={approvalPreview ?? ''} onClose={() => setPicker(null)}
      options={MODES.filter(item => approvalModes.includes(item.value) || isNew && item.value !== 'auto_all').map(item => ({ ...item,
        disabled: permissionRuntime.current.locked || running || item.value === 'auto_all' && !autoAllowed,
        ...(item.value === 'auto_all' && !autoAllowed ? { detail: '电脑「设置」里允许后才能用' } : {}) }))}
      onSelect={(value) => {
        if (!isApprovalMode(value) || !interactionCurrent() || permissionRuntime.current.scope !== permissionScope || permissionRuntime.current.locked || !approvalEditable
          || composerContext.current?.busy || composerContext.current?.submitting || queueBusyRef.current || running
          || !approvalModes.includes(value) && (!isNew || value === 'auto_all')) return;
        if (value === 'auto_all' && !autoAllowed) { showToast('电脑上还没允许手机使用「全部自动」', 'lock'); return; }
        setMode(value); setPicker(null);
      }} />


    <ToolbarMenu visible={menu} anchorRef={menuAnchor} label="对话菜单" testID="conversation-actions-menu" onClose={() => setMenu(false)} actions={[
      ...(pendingDelivery?.retryable && pendingDelivery.requestId ? [{ label: '重试原消息', icon:'retry' as const, tone: 'secondary' as const, onPress: () => {
        if (!interactionCurrent() || sending) return;
        setMenu(false); setSending(true);
        void deliver(pendingDelivery.text, false, [], undefined, false, pendingDelivery.requestId)
          .finally(() => { if (interactionCurrent()) setSending(false); });
      } }] : []),
      ...(pendingDelivery ? [{ label: '复制待确认文字', icon:'copy' as const, tone: 'secondary' as const, onPress: () => {
        if (!interactionCurrent()) return;
        setMenu(false);
        void import('expo-clipboard').then((clipboard) => { if (interactionCurrent()) return clipboard.setStringAsync(pendingDelivery.text); })
          .then(() => { if (interactionCurrent()) showToast('文字已复制，请先核对原会话，避免重复发布任务', 'checkCircle'); }).catch((error: Error) => { if (interactionCurrent()) showToast(error.message, 'alert'); });
      } }] : []),
      ...(pendingDelivery ? [{ label: '已核对，停止重发', icon:'checkCircle' as const, tone: 'danger' as const, onPress: () => {
        if (!interactionCurrent()) return;
        setMenu(false);
        const pendingKey = sessionKey ?? (agent ? newSessionReceiptKey(agent.tool, agent.id === 'claude-desktop') : undefined);
        if (deviceId && pendingKey) void cancelPendingRemoteMessage(deviceId, pendingKey, operationScope).then(() => { if (interactionCurrent()) setPendingDelivery(null); }).catch((error: Error) => { if (interactionCurrent()) showToast(error.message, 'alert'); });
      } }] : []),
      ...(running && desktopCanStop && !externallyOwnedBusy ? [{ label: '停止任务', icon:'stop' as const, tone: 'danger' as const, onPress: () => { setMenu(false); stop(); } }] : []),
      ...(sessionKey && deviceId && canOpenOnDesktop(sessionKey, session?.client, deviceId) ? [{ label: tool === 'codex' ? '在电脑的 Codex 里打开' : '在电脑上打开 Claude Desktop', icon:'laptop' as const, tone: 'secondary' as const, onPress: () => {
        if (!interactionCurrent()) return;
        setMenu(false);
        void openOnDesktop(deviceId, sessionKey, session?.client).then(() => { if (interactionCurrent()) showToast('已请求在电脑打开', 'laptop'); }).catch((error: Error) => { if (interactionCurrent()) showToast(error.message, 'alert'); });
      } }] : []),
      ...(blocks.length ? [{ label: '搜索对话', icon:'search' as const, tone: 'secondary' as const, onPress: () => { setMenu(false); setSearchOpen(true); } }] : []),
      ...(cooperationSupported ? [{ label: '发送到另一任务', icon:'share' as const, tone: 'secondary' as const, onPress: () => {
        if (!interactionCurrent() || !cooperationSupported) return;
        setMenu(false); startCooperation();
      } }] : []),
      ...(deviceId && sessionKey && !readOnly && !desktopLive && typeof hubSupportsSessionActions === 'function' && hubSupportsSessionActions() && agentSupports(agent ?? undefined, tool, 'sessionActions')
        ? [{ label: '管理会话', icon:'settings' as const, tone: 'secondary' as const, onPress: () => { if (!interactionCurrent()) return; setMenu(false); setSessionManagement(true); } }] : []),
      ...(deviceId && sessionKey && !readOnly && !desktopLive && !session?.archived && typeof hubSupportsSessionWorkflows === 'function' && hubSupportsSessionWorkflows() && agentSupports(currentAgent ?? agent ?? undefined, tool, 'sessionWorkflows')
        ? [{ label: '审查与目标', icon:'listCheck' as const, tone: 'secondary' as const, onPress: () => { if (!interactionCurrent()) return; setMenu(false); setSessionWorkflows(true); } }] : []),
      { label: '刷新', icon:'regenerate', tone: 'secondary', onPress: () => { setMenu(false); void refresh().catch((error: Error) => showToast(error.message, 'alert')); } },
    ]} message={pendingDelivery ? `${pendingDelivery.message}\n停止重发只清除手机的重试记录，不会取消电脑上已开始的任务。` : undefined} />
    <AppDialog visible={Boolean(denying)} title={denying?.approvalOptions?.denyEffect === 'cancel_turn' ? '取消本轮？' : '拒绝这一步？'} message={denying?.title} icon="close" onClose={() => setDenying(null)} actions={[
      { label: '取消', tone: 'secondary', onPress: () => setDenying(null) },
      { label: denying?.approvalOptions?.denyEffect === 'cancel_turn' ? '取消本轮' : '拒绝', tone: 'danger', onPress: () => { const target = denying; setDenying(null); if (target) void decide(target, 'deny', reason); } },
    ]}>
      <TextInput value={reason} onChangeText={setReason} placeholder="告诉它为什么（可选）" placeholderTextColor={dk.muted} style={styles.reason} multiline maxLength={300} />
    </AppDialog>
    {visible && sessionManagement && deviceId && sessionKey && !readOnly && !desktopLive ? <SessionActionsSheet key={`${operationScope}|${deviceId}|${sessionKey}`} visible deviceId={deviceId} sessionKey={sessionKey}
      onClose={() => setSessionManagement(false)} onFork={key => { if (interactionCurrent()) onCreated(key); }} onArchive={() => { if (interactionCurrent()) onClose(); }} /> : null}
    {visible && sessionWorkflows && deviceId && sessionKey && !readOnly && !desktopLive ? <SessionWorkflowsSheet key={`${operationScope}|${deviceId}|${sessionKey}`} visible deviceId={deviceId} sessionKey={sessionKey} onClose={() => setSessionWorkflows(false)} /> : null}
    {visible && slashSessionCommand?.scope === contextScope && deviceId && sessionKey && !readOnly && !desktopLive ? <SessionCommandPopover
      key={`${contextScope}|${slashSessionCommand.command}`} visible anchorRef={modelAnchor} scopeKey={contextScope} deviceId={deviceId} sessionKey={sessionKey} command={slashSessionCommand.command}
      onClose={() => setSlashSessionCommand(undefined)} onFork={key => { if (interactionCurrent()) onCreated(key); }} onArchive={() => { if (interactionCurrent()) onClose(); }}
      onReviewStarted={() => { if (interactionCurrent()) void openSession(deviceId, sessionKey).catch(() => undefined); }} /> : null}
    {visible && cooperationSupported && cooperation && cooperation.owner === cooperationUiOwner && deviceId && sessionKey ? <CooperationSheet
      key={`${cooperation.owner}|${cooperation.sourceSessionKey}|${cooperation.targetSessionKey ?? ''}`}
      deviceId={deviceId} sourceSessionKey={cooperation.sourceSessionKey} initialTarget={cooperation.targetSessionKey}
      onClose={() => { if (interactionCurrent() && cooperation.owner === cooperationUiOwner) setCooperation(null); }}
      onOpenTask={key => {
        if (!interactionCurrent() || !cooperationSupported || key === sessionKey || key.split(':')[0] !== tool
          || !/^(codex|claude):[A-Za-z0-9_-]{1,160}$/.test(key)) return;
        setCooperation(null); onCreated(key);
      }} /> : null}
    <DiffScreen file={visible && diffFullscreen && diffFile?.epoch === interactionEpoch ? diffFile.file : null} onClose={() => { setDiffFullscreen(false); setDiffFile(current => current === diffFile ? null : current); }}
      sessionKey={sessionKey ?? undefined} annotationCount={contextReferences.filter(reference => reference.kind === 'diff').length}
      unavailableReason={!diffAnnotationSupported ? '电脑或中转站暂不支持差异行批注，请更新 Bridge 和 Hub' : featureSourceBlocked ? '批注来源已改变，请先处理当前草稿' : diffFile?.file.status !== 'done' ? '文件修改仍在进行或未完成，暂时不能添加批注' : undefined}
      onAddAnnotation={reference => { if (!interactionCurrent() || !diffAnnotationSupported || diffFile?.epoch !== interactionEpoch || diffFile.file.status !== 'done' || reference.sessionKey !== sessionKey) return false;
        return chooseReference(reference, { consumeQuery: false, focusComposer: false }); }} />
    {outputs.panel}
    <ImageViewer uri={visible && viewImage?.epoch === interactionEpoch ? viewImage.uri : null} onClose={() => setViewImage(current => current === viewImage ? null : current)} />
  </Sheet>;
}

