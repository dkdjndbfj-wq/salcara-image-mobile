import React, { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, FlatList, Image, Keyboard, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Icon, type IconName } from '../components/Icon';
import { MessageContent } from '../components/MessageContent';
import { Appear, AppDialog, IconButton, MotionPressable, Sheet, showToast, useReducedMotion } from '../components/ui';
import { colors, prettyModel, radius, shadow, desk, themed, useDesk } from '../theme';
import { buildBlocks, conversationBlocks, fileEdits, planSteps, subagentStatus, type Block, type ConversationBlock, type FileEdit } from './blocks';
import { HubError, type AgentProfile, type ApprovalMode, type Decision, type Effort, type ModelCatalog, type Project, type QuestionAnswers, type ToolId, type ToolKind } from './client';
import { InlineApiPicker } from './ApiPicker';
import { apiProblem, modelCapabilityProblem, modelCatalogProblem, type ApiProblem } from './api-errors';
import { QuestionDock } from './QuestionDock';
import { deliverQuestionAnswer, QuestionDeliveryCancelled } from './question-delivery';
import { blockQuestionReceipt, finishQuestionReceipt, markQuestionAttempt, pendingQuestionReceipts, prepareQuestionReceipt, reconcileQuestionReceipts, type QuestionReceipt } from './question-outbox';
import { MAX_REMOTE_IMAGES, pickRemoteImages, type RemoteImage } from './attachments';
import { DeliveryPendingError } from './delivery';
import { deliveryRetryState } from './offline-policy';
import { defaultSelectionEffort, effortLabel, reportedEfforts, reportsTextOnly } from './effort';
import { loadRemoteDraft, saveRemoteDraft } from './drafts';
import { ModelDot, ModelPopover } from './ModelPopover';
import { EffortScrubChip, EffortScrubOverlay, type ScrubEvent } from './EffortScrub';
import { noteTaskSent, requestNotificationPermission, setVisibleThread } from './notifications';
import { modelDisplayLabel } from './model-presentation';
import { captureModelBackdrop } from './model-backdrop';
import { OptionSheet, type Option } from './OptionSheet';
import { loadThreadPrefs, saveThreadPrefs } from './thread-prefs';
import { DiffView, EmptyState, mono, PulseDot, toolName } from './parts';
import { desktopLiveFor, projectName } from './projection';
import {
  EMPTY_TIMELINE, cachedModels, canOpenOnDesktop, hydrateCachedThread, cancelPendingRemoteMessage, openOnDesktop, getPendingRemoteMessage, hubSupportsWait, interruptSession, listModels, listProjects, loadAgentProfiles, loadEarlierHistory, openSession,
  remoteDeliveryScope, respondApproval, sendToSession, startSession, syncSessionEvents, timelineKey, useRemote, type TimelineItem,
} from './store';
import { useLiveSync } from './useLiveSync';
import {
  clockText, copyUserMessage, DiffScreen, ImageViewer, JumpToLatest, MessageActions, OutputText, quoteFor, RemoteDictation, runningSince, SearchBar, searchBlocks, turnStats, useClock,
  type TurnStat, type VoiceSource,
} from './thread-extras';
import { renameThread, useThreadTitles } from './thread-titles';
import { ApprovalCard, BlockRow, ComposerChip, NewThreadIntro, ThreadUi, type ApprovalItem } from './thread-rows';
import { useThreadStyles } from './thread-styles';

const MODES: Array<Option<ApprovalMode>> = [
  { value: 'ask', label: '每一步都问我', detail: '运行命令和改文件前，在手机上点允许' },
  { value: 'auto_edits', label: '自动改文件', detail: '项目内的文件直接改，运行命令前问你' },
  { value: 'auto_all', label: '全部自动', detail: '不再询问。只在信任这个项目时使用', danger: true },
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

export function ThreadView({ visible, deviceId, sessionKey, agent, onClose, onCreated, verifying = false, onContinue, seed, voice }: {
  visible: boolean; deviceId: string | null; sessionKey: string | null; agent: AgentProfile | null;
  onClose: () => void; onCreated: (sessionKey: string) => void;
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
  const remote = useRemote();
  const isNew = !sessionKey;
  const timelineId = deviceId && sessionKey ? timelineKey(deviceId, sessionKey) : '';
  const draftKey = `${remote.connectionId ?? remote.selectedHubUrl ?? ''}|${deviceId ?? ''}|${sessionKey ?? `new:${agent?.tool ?? ''}`}`;
  const timeline = remote.timelines[timelineId] ?? EMPTY_TIMELINE;
  const device = remote.devices.find((item) => item.deviceId === deviceId);
  const session = timeline.session ?? remote.sessions[deviceId ?? '']?.list.find((item) => item.sessionKey === sessionKey);
  const readOnly = session?.controlSurface === 'read-only' || Boolean(sessionKey?.startsWith('claude-desktop:'));
  const tool = session?.tool ?? agent?.tool ?? 'codex';
  const currentAgent = remote.agents[deviceId ?? '']?.list.find((item) => item.id === agent?.id) ?? agent;
  const apiIdentity = currentAgent ? `${currentAgent.api.source}:${currentAgent.api.accountId ?? currentAgent.api.name}` : '';
  const apiIdentityRef = useRef(apiIdentity); apiIdentityRef.current = apiIdentity;
  const previousApiIdentity = useRef(apiIdentity);
  const prefsRevision = useRef(0);
  const online = Boolean(device?.online) && remote.connection !== 'error';

  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [watchUntil, setWatchUntil] = useState(0);
  const [pendingDelivery, setPendingDelivery] = useState<{ text: string; retryable: boolean; message: string } | null>(null);
  const [model, setModel] = useState('');
  const modelRef = useRef(model); modelRef.current = model;
  const changedModelPrefs = useRef<{ scope: string } | null>(null);
  const [effort, setEffort] = useState<Effort | ''>('');
  const effortRef = useRef(effort); effortRef.current = effort;
  useEffect(() => { if (!visible || !deviceId || !sessionKey) return undefined; setVisibleThread(deviceId, sessionKey); return () => setVisibleThread(null, null); }, [visible, deviceId, sessionKey]);
  // Press-and-slide effort: only the composer frosts while scrubbing.
  const [scrub, setScrub] = useState<{ index: number; texture?: string } | null>(null);
  const scrubRequest = useRef(0);
  const composerRef = useRef<View>(null);
  const reducedMotion = useReducedMotion();
  const [mode, setMode] = useState<ApprovalMode>('ask');
  const [projects, setProjects] = useState<Project[]>([]);
  const [cwd, setCwd] = useState('');
  const [picker, setPicker] = useState<'model' | 'effort' | 'project' | 'mode' | null>(null);
  const [apiSwitching, setApiSwitching] = useState(false);
  const apiSwitchingRef = useRef(false);
  const apiRequests = useRef(new Set<string>());
  const setApiBusy = (busy: boolean, requestId = 'legacy') => {
    if (busy) apiRequests.current.add(requestId); else apiRequests.current.delete(requestId);
    apiSwitchingRef.current = apiRequests.current.size > 0; setApiSwitching(apiSwitchingRef.current);
  };
  const [apiError, setApiError] = useState<ApiProblem | null>(null);
  const [dismissedError, setDismissedError] = useState('');
  const modelRequestRef = useRef(0);
  const [models, setModels] = useState<ModelCatalog>({ models: [] });
  const [modelsLoading, setModelsLoading] = useState(false);
  const [catalogOwner, setCatalogOwner] = useState('');
  const [catalogError, setCatalogError] = useState('');
  const [modelEpoch, setModelEpoch] = useState(0);
  const [modelBackdrop, setModelBackdrop] = useState<string>();
  const modelSurfaceRef = useRef<View>(null);
  const modelBackdropRequest = useRef(0);
  const pickerRef = useRef(picker); pickerRef.current = picker;
  const [images, setImages] = useState<RemoteImage[]>([]);
  const [attachMenu, setAttachMenu] = useState(false);
  const [menu, setMenu] = useState(false);
  const [denying, setDenying] = useState<ApprovalItem | null>(null);
  const [reason, setReason] = useState('');
  const [busyApproval, setBusyApproval] = useState<string | null>(null);
  const [questionProblem, setQuestionProblem] = useState('');
  const answerDraft = useRef<{ scope: string; id: string; answers?: QuestionAnswers } | null>(null);
  const approvalRequest = useRef<{ scope: string; id: string; controller?: AbortController } | null>(null);
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
  const [diffFile, setDiffFile] = useState<FileEdit | null>(null);
  const [viewImage, setViewImage] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  // A message written while the agent is busy waits here and goes out when the current turn ends.
  const [queued, setQueued] = useState<{ text: string; images: RemoteImage[] } | null>(null);
  const queuedRef = useRef(queued); queuedRef.current = queued;
  const titleOf = useThreadTitles();
  const draggingRef = useRef(false);
  const draftRef = useRef(draftKey);
  const threadMounted = useRef(true);
  useEffect(() => { threadMounted.current = true; return () => { threadMounted.current = false; }; }, []);
  const operationScope = remoteDeliveryScope();
  const apiOperationCurrent = () => {
    try { return threadMounted.current && draftRef.current === draftKey && remoteDeliveryScope() === operationScope; } catch { return false; }
  };
  const freshSnapshot = useRef('');
  const [restoreGeneration, setRestoreGeneration] = useState(0);
  draftRef.current = draftKey;
  const autoAllowed = remote.agents[deviceId ?? '']?.autoAll !== false;
  const prefsKey = `${remote.connectionId ?? remote.selectedHubUrl ?? ''}|${deviceId ?? ''}|${sessionKey ?? `new:${agent?.tool ?? ''}`}`;
  const catalogScope = `${draftKey}|${apiIdentity}`;
  const ownToolApi = !currentAgent || currentAgent.api.source === 'tool' || (currentAgent.api.source === 'computer' && !currentAgent.api.configured);
  // Once a thread was selected for native execution, an expired lease may not
  // silently change its executor while this thread remains selected.
  const desktopTarget = useRef('');
  if (desktopLiveFor(currentAgent, sessionKey)) desktopTarget.current = draftKey;
  const desktopLive = Boolean(sessionKey && (desktopTarget.current === draftKey || session?.controlSurface === 'desktop'));
  const desktopCanStop = !readOnly && (!desktopLive || currentAgent?.desktopLive?.capabilities?.interrupt === true);
  const desktopCanApprove = !desktopLive || timeline.items.some(item => item.kind === 'approval' && item.state === 'pending' && item.approvalTransport === 'codex-hook-v1' && Boolean(item.expiresAt && item.expiresAt > Date.now()));
  const desktopCanSend = !readOnly && (!desktopLive || desktopLiveFor(currentAgent, sessionKey) && currentAgent?.desktopLive?.capabilities?.send === true);
  const interactionOwner = useRef({ visible, draftKey, scope: operationScope, epoch: 0 });
  if (interactionOwner.current.visible !== visible || interactionOwner.current.draftKey !== draftKey || interactionOwner.current.scope !== operationScope) {
    interactionOwner.current = { visible, draftKey, scope: operationScope, epoch: interactionOwner.current.epoch + 1 };
  }
  const interactionEpoch = interactionOwner.current.epoch;
  const interactionCurrent = () => threadMounted.current && interactionOwner.current.visible
    && interactionOwner.current.epoch === interactionEpoch && draftRef.current === draftKey
    && remoteDeliveryScope() === operationScope;
  const managedApi = Boolean(currentAgent && !ownToolApi && !desktopLive && !readOnly);
  const previousOwnToolApi = useRef(ownToolApi);
  const catalogReady = catalogOwner === catalogScope;
  const capabilityModel = model || (ownToolApi ? session?.model || currentAgent?.api.model : currentAgent?.api.model) || '';
  const effortLevels = tool === 'codex' && !desktopLive && catalogReady ? reportedEfforts(models.modelCapabilities?.[capabilityModel]) : [];
  const effortEditable = effortLevels.length > 0;
  const effectiveEffort = effortEditable && effort && effortLevels.includes(effort) ? effort : '';
  const modelRejectsImages = tool === 'codex' && catalogReady && reportsTextOnly(models.modelCapabilities?.[capabilityModel]);
  const modelRejectsImagesRef = useRef(modelRejectsImages); modelRejectsImagesRef.current = modelRejectsImages;

  useEffect(() => {
    modelBackdropRequest.current += 1;
    pickerRef.current = null; setModelBackdrop(undefined); setPicker(null);
  }, [visible, draftKey, operationScope]);
  useEffect(() => {
    modelBackdropRequest.current += 1; setModelBackdrop(undefined);
  }, [apiIdentity]);
  useEffect(() => {
    if (picker !== 'model') { modelBackdropRequest.current += 1; setModelBackdrop(undefined); }
  }, [picker]);
  useEffect(() => () => { modelBackdropRequest.current += 1; }, []);

  useEffect(() => {
    approvalRequest.current?.controller?.abort();
    freshSnapshot.current = '';
    approvalRequest.current = null; answerDraft.current = null; setBusyApproval(null); setQuestionProblem('');
    return () => { approvalRequest.current?.controller?.abort(); approvalRequest.current = null; };
  }, [visible, draftKey, operationScope]);

  useEffect(() => {
    if (previousApiIdentity.current === apiIdentity && previousOwnToolApi.current === ownToolApi) return;
    previousApiIdentity.current = apiIdentity;
    previousOwnToolApi.current = ownToolApi;
    prefsRevision.current += 1;
    // Keep only a candidate until the new Key's catalog confirms membership.
    setModel((current) => ownToolApi ? '' : current || currentAgent?.api.model || '');
    effortRef.current = ''; setEffort('');
    setModels({ models: [] });
    setCatalogOwner(''); setCatalogError('');
    modelRequestRef.current += 1;
    setModelsLoading(false);
  }, [apiIdentity, currentAgent?.api.model, ownToolApi]);

  // Reset per thread; restore the draft and any message still waiting for a receipt.
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    const prefsRequest = ++prefsRevision.current, prefsApi = apiIdentityRef.current;
    setText(''); setSending(false); setPendingDelivery(null); setDenying(null); setModel(''); setEffort(''); setImages([]); setApiError(null); setDismissedError(''); setPicker(null);
    setQueued(null); setSearchOpen(false); setSearchQuery(''); setSearchPos(0); setDiffFile(null); setViewImage(null); setRenaming(null);
    jumpRef.current = { visible: false, unseen: false }; setJump(jumpRef.current); contentHeight.current = 0;
    setCatalogOwner(''); setCatalogError('');
    modelRequestRef.current += 1;
    void loadThreadPrefs(prefsKey).then((prefs) => { if (alive && prefsRequest === prefsRevision.current && prefsApi === apiIdentityRef.current) { setModel(!prefs.apiIdentity || prefs.apiIdentity === prefsApi ? prefs.model ?? '' : ''); setEffort(prefs.apiIdentity === prefsApi ? prefs.effort ?? '' : ''); } }).catch(() => undefined);
    if (deviceId) setModels(cachedModels(deviceId, agent?.tool ?? 'codex') ?? { models: [] });
    followRef.current = true;
    void loadRemoteDraft(draftKey).then((saved) => { if (alive && draftRef.current === draftKey) setText((current) => current || saved); }).catch(() => undefined);
    if (deviceId && sessionKey) {
      void getPendingRemoteMessage(deviceId, sessionKey).then((pending) => {
        if (!alive || !pending) return;
        const policy = deliveryRetryState(pending);
        setPendingDelivery({ text: pending.text, retryable: policy.retryable, message: policy.message });
      }).catch(() => undefined);
      void hydrateCachedThread(deviceId, sessionKey);
      void openSession(deviceId, sessionKey).then(() => {
        if (alive && draftRef.current === draftKey) { freshSnapshot.current = draftKey; setRestoreGeneration(value => value + 1); }
      }).catch(() => undefined);
    }
    return () => { alive = false; };
  }, [visible, deviceId, sessionKey, draftKey, operationScope]); // eslint-disable-line react-hooks/exhaustive-deps

  const textRef = useRef(text); textRef.current = text;
  useEffect(() => {
    if (!visible) return undefined;
    const key = draftKey;
    // Leaving with a queued message: nothing is lost, it returns as the draft.
    return () => {
      const waiting = queuedRef.current;
      if (!waiting) return;
      const typed = textRef.current.trim();
      void saveRemoteDraft(key, typed ? `${waiting.text}\n\n${typed}` : waiting.text).catch(() => undefined);
    };
  }, [visible, draftKey]);
  useEffect(() => {
    if (!visible) return;
    const value = text; const key = draftKey;
    const timer = setTimeout(() => { void saveRemoteDraft(key, value).catch(() => undefined); }, 400);
    return () => clearTimeout(timer);
  }, [text, draftKey, visible]);

  // New thread: pick a project folder from the computer (allowed folders and recent workspaces).
  useEffect(() => {
    if (!visible || !isNew || !deviceId) return;
    let alive = true;
    const local = device?.projects ?? [];
    setProjects(local);
    // Continuing a Claude Desktop conversation starts in its original folder when the computer allows it.
    const preferred = (list: readonly { path: string }[]) => seed?.cwd && list.some((item) => item.path === seed.cwd) ? seed.cwd : undefined;
    setCwd((current) => current || preferred(local) || local[0]?.path || '');
    void listProjects(deviceId).then((list) => {
      if (!alive || !list.length) return;
      setProjects(list);
      setCwd((current) => preferred(list) ?? (list.some((item) => item.path === current) ? current : list[0].path));
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [visible, isNew, deviceId]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const questionContext = useRef({ pending, online, desktopCanApprove });
  questionContext.current = { pending, online, desktopCanApprove };
  const problemQuestion = useRef('');
  useEffect(() => {
    if (pending[0]?.id && pending[0].id !== problemQuestion.current) { problemQuestion.current = pending[0].id; setQuestionProblem(''); }
  }, [pending[0]?.id]);
  const answerSending = Boolean(busyApproval && pending.some((item) => item.id === busyApproval && item.approval === 'question'));
  // Local dismissal is not a delivered/approved claim: receipt tracking stays in the main conversation.
  const question = visible && !answerSending && pending[0]?.approval === 'question' ? pending[0] : null;
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
      const receipt = receipts.find(value => value.approvalId === pending[0]?.id && pending[0]?.approval === 'question');
      if (!receipt) return;
      answerDraft.current = { scope: draftKey, id: receipt.approvalId, answers: receipt.answers };
      if (receipt.blocked) { setQuestionProblem('请在电脑核对回答'); return; }
      const approval = pending.find(value => value.id === receipt.approvalId);
      if (approval && online && !approvalRequest.current) void decide(approval, receipt.decision, receipt.message, receipt.answers, receipt);
    }).catch(() => { if (active) setQuestionProblem('回答记录未恢复，请在电脑核对'); });
    return () => { active = false; };
  }, [visible, draftKey, operationScope, online, timeline.snapshotAt, timeline.loading, timeline.error, pendingSignature, restoreGeneration]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!question) return;
    Keyboard.dismiss(); setPicker(null); setAttachMenu(false); setMenu(false); setDenying(null);
  }, [question?.id, draftKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const status = pending.length ? 'waiting_approval' : session?.status ?? 'idle';
  const running = status === 'running' || status === 'waiting_approval';
  const blocks = useMemo(() => conversationBlocks(buildBlocks(timeline.items, status === 'running'), tool), [timeline.items, status, tool]);
  const last = blocks[blocks.length - 1];
  const thinking = status === 'running' && !(last?.type === 'activity' && last.live) && !(last?.type === 'assistant' && !last.item.final);
  const externalBusy = Boolean(session && session.controllable === false && running);
  const recentProblem = useMemo(() => {
    for (let index = timeline.items.length - 1; index >= 0; index -= 1) {
      const item = timeline.items[index];
      if (item.kind === 'turn') { const problem = item.status === 'failed' && item.id !== dismissedError ? apiProblem(item.error) : null; return problem ? { ...problem, id: item.id } : null; }
      if (item.kind === 'notice' && item.level === 'error' && item.id !== dismissedError) { const problem = apiProblem(item.text); if (problem) return { ...problem, id: item.id }; }
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
  // Live updates: one held request while something is happening; nothing while idle.
  const needLive = Boolean(visible && deviceId && sessionKey) && (running || Date.now() < watchUntil || Boolean(pendingDelivery?.retryable));
  useLiveSync(Boolean(visible && deviceId && sessionKey), needLive, !desktopLive && !readOnly && hubSupportsWait(), async (wait) => {
    if (!deviceId || !sessionKey) return;
    if (pendingDelivery?.retryable) await deliver(pendingDelivery.text, true);
    await syncSessionEvents(deviceId, sessionKey, wait);
  }, watchUntil);

  const refresh = async () => {
    if (!interactionCurrent() || !deviceId || !sessionKey) return;
    const key = draftKey;
    await openSession(deviceId, sessionKey);
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

  const deliver = async (value: string, silent = false, attached: RemoteImage[] = []) => {
    if (!interactionCurrent() || !deviceId || !sessionKey) return;
    const key = draftKey;
    try {
      await sendToSession(deviceId, sessionKey, value, { model: nextModel || undefined, effort: effectiveEffort || undefined, images: attached, surface: desktopLive ? 'desktop' : 'cli' });
      void requestNotificationPermission(); noteTaskSent(deviceId, sessionKey);
      if (!interactionCurrent()) return;
      setPendingDelivery(null);
      setWatchUntil(Date.now() + 120_000);
    } catch (error) {
      if (!interactionCurrent()) { if (silent) throw error; return; }
      if (draftRef.current === key) recordApiError(error);
      if (error instanceof DeliveryPendingError && draftRef.current === key) {
        const pending = await getPendingRemoteMessage(deviceId, sessionKey).catch(() => undefined);
        if (interactionCurrent() && draftRef.current === key) {
          const policy = pending ? deliveryRetryState(pending) : null;
          setPendingDelivery({ text: pending?.text ?? value, retryable: policy?.retryable ?? error.retryable, message: policy?.message ?? error.message });
          if (pending && pending.text !== value) {
            setText((current) => current || value);
            void saveRemoteDraft(key, value).catch(() => undefined);
          }
        }
      }
      if (silent) throw error;
      showToast((error as Error).message, 'alert');
      if (draftRef.current === key && !(error instanceof DeliveryPendingError)) {
        setText((current) => current || value);
        if (attached.length) setImages((current) => current.length ? current : attached);
      }
    }
  };

  const send = async () => {
    if (!interactionCurrent() || busyApproval || !desktopCanSend) return;
    const value = text.trim();
    if (!value || sending || !deviceId || !agent) return;
    if (apiSwitchingRef.current) return;
    if (!pendingDelivery && images.length && modelRejectsImagesRef.current) {
      showToast('当前模型仅支持文字，请移除图片或更换模型', 'alert'); return;
    }
    if (!pendingDelivery && desktopLive && (modelRef.current || effortRef.current)) {
      showToast('桌面实时连接请使用电脑设置；消息未发送', 'alert'); openModels(); return;
    }
    if (pendingDelivery && value !== pendingDelivery.text) {
      showToast('上一条消息还在确认，请先处理待确认消息；新文字仍保留在输入框', 'alert');
      return;
    }
    if (!pendingDelivery && modelBlocked) {
      openModels(); return;
    }
    // Busy agent: hold the message and send it when the current turn ends.
    if (!isNew && running && !pendingDelivery && !externalBusy) {
      const attached = images;
      setQueued((current) => ({ text: current ? `${current.text}\n\n${value}` : value, images: [...(current?.images ?? []), ...attached].slice(0, MAX_REMOTE_IMAGES) }));
      setText(''); setImages([]); void saveRemoteDraft(draftKey, '').catch(() => undefined);
      followRef.current = true;
      return;
    }
    followRef.current = true;
    setSending(true);
    try {
      if (isNew) {
        if (!cwd) { showToast('先选择一个项目文件夹', 'alert'); return; }
        const prompt = seed ? `下面是我之前在 Claude Desktop 里的对话《${seed.title}》。请接着这个话题继续帮我，这次在 Claude Code 中进行。\n\n<之前的对话>\n${seed.transcript}\n</之前的对话>\n\n我的新消息：${value}` : value;
        const key = await startSession(deviceId, { tool: agent.tool, cwd, prompt, model: nextModel || undefined, effort: effectiveEffort || undefined, approval: mode, images, desktop: agent.id === 'claude-desktop' });
        void requestNotificationPermission(); noteTaskSent(deviceId, key);
        if (!interactionCurrent()) return;
        setText(''); setImages([]); void saveRemoteDraft(draftKey, '').catch(() => undefined);
        void saveThreadPrefs(`${remote.connectionId ?? remote.selectedHubUrl ?? ''}|${deviceId}|${key}`, { model: model || undefined, effort: effort || undefined, apiIdentity }).catch(() => undefined);
        onCreated(key);
      } else {
        const attached = images;
        setText(''); setImages([]); void saveRemoteDraft(draftKey, '').catch(() => undefined);
        await deliver(value, false, attached);
      }
    } catch (error) { if (interactionCurrent()) { recordApiError(error); showToast((error as Error).message, 'alert'); } }
    finally { if (interactionCurrent()) setSending(false); }
  };

  // Send the queued message once the agent is free again.
  useEffect(() => {
    if (!queued || isNew || running || sending || !online || !desktopCanSend || busyApproval || pendingDelivery || verifying || apiSwitching) return;
    const next = queued;
    setQueued(null);
    setSending(true);
    followRef.current = true;
    void deliver(next.text, false, next.images).finally(() => { if (interactionCurrent()) setSending(false); });
  }, [queued, isNew, running, sending, online, desktopCanSend, busyApproval, pendingDelivery, verifying, apiSwitching]); // eslint-disable-line react-hooks/exhaustive-deps
  const unqueue = () => {
    const waiting = queuedRef.current;
    if (!waiting) return;
    setQueued(null);
    setText((current) => current.trim() ? `${waiting.text}\n\n${current}` : waiting.text);
    setImages((current) => [...waiting.images, ...current].slice(0, MAX_REMOTE_IMAGES));
  };
  const retry = (value: string) => {
    if (!interactionCurrent() || sending || running || !online || !desktopCanSend || pendingDelivery) return;
    setSending(true);
    followRef.current = true;
    void deliver(value).finally(() => { if (interactionCurrent()) setSending(false); });
  };
  const quote = (reply: string) => setText((current) => `${quoteFor(reply)}${current}`);

  const stop = () => {
    if (!interactionCurrent() || !deviceId || !sessionKey || !desktopCanStop) return;
    void interruptSession(deviceId, sessionKey).then(() => { if (interactionCurrent()) showToast('已让电脑停下', 'stop'); }).catch((error: Error) => { if (interactionCurrent()) showToast(error.message, 'alert'); });
  };
  const decide = async (approval: ApprovalItem, decision: Decision, message?: string, answers?: QuestionAnswers, restored?: QuestionReceipt) => {
    const latest = questionContext.current.pending.find(value => value.id === approval.id);
    if (!interactionCurrent() || !deviceId || !sessionKey || !questionContext.current.online || !questionContext.current.desktopCanApprove
      || !latest || latest.state !== 'pending' || (latest.expiresAt && latest.expiresAt <= Date.now()) || approvalRequest.current?.scope === draftKey) return;
    approval = latest;
    const isQuestion = approval.approval === 'question';
    if (isQuestion) answerDraft.current = { scope: draftKey, id: approval.id, answers };
    const request = { scope: draftKey, id: approval.id, ...(isQuestion ? { controller: new AbortController() } : {}) };
    approvalRequest.current = request;
    setBusyApproval(approval.id);
    setQuestionProblem('');
    let persisted: QuestionReceipt | undefined;
    try {
      const target = { approvalId: approval.id, deviceId, sessionKey, ...(desktopLive ? { controlSurface: 'desktop' as const } : {}) };
      if (request.controller) {
        const scope = remoteDeliveryScope();
        // Freeze choices before dispatch; hidden UI content is never discarded.
        const frozen = answers ? Object.fromEntries(Object.entries(answers).map(([key, values]) => [key, [...values]])) : undefined;
        persisted = restored ?? await prepareQuestionReceipt({ scope, deviceId, sessionKey, approvalId: approval.id, decision, message, answers: frozen, expiresAt: approval.expiresAt });
        const receipt = persisted;
        await deliverQuestionAnswer({ signal: request.controller.signal, expiresAt: approval.expiresAt,
          receipt, beforeAttempt: () => markQuestionAttempt(receipt),
          active: () => interactionCurrent() && approvalRequest.current === request && draftRef.current === request.scope,
          canSend: () => AppState.currentState == null || AppState.currentState === 'active',
          recover: () => syncSessionEvents(deviceId, sessionKey),
          perform: (requestId, retrying) => respondApproval(target, decision, message, frozen, { requestId, retrying, scope, expiresAt: approval.expiresAt, signal: request.controller!.signal }),
        });
        await finishQuestionReceipt(receipt);
      } else await respondApproval(target, decision, message, answers);
      if (approvalRequest.current === request) setWatchUntil(Date.now() + 60_000);
    } catch (error) {
      if (persisted && !(error instanceof QuestionDeliveryCancelled)) {
        if (error instanceof HubError && ['command_delivery_uncertain', 'request_id_conflict', 'question_retry_unsupported', 'question_expired', 'question_clock_changed', 'request_scope_changed'].includes(error.code ?? '') || error instanceof HubError && (error.status === 401 || error.status === 403)) {
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
    if (!deviceId) return;
    const request = ++modelRequestRef.current, identity = apiIdentityRef.current, thread = draftKey;
    setModelsLoading(true);
    setCatalogError('');
    // Refresh failures must not leave an earlier catalog authorizing a send.
    setCatalogOwner('');
    try {
      const result = await listModels(deviceId, tool, refresh);
      if (request !== modelRequestRef.current || identity !== apiIdentityRef.current || thread !== draftRef.current) return;
      setModels(result);
      setCatalogOwner(`${thread}|${identity}`);
      const candidateEffortModel = modelRef.current || (ownToolApi ? session?.model || currentAgent?.api.model : currentAgent?.api.model) || '';
      const nextEffort = reportedEfforts(result.modelCapabilities?.[candidateEffortModel]).includes(effortRef.current as Effort) ? effortRef.current : '';
      if (!pendingDelivery && nextEffort !== effortRef.current) { effortRef.current = nextEffort; setEffort(nextEffort); }
      if (managedApi && !pendingDelivery) {
        const candidate = modelRef.current || currentAgent?.api.model || '';
        const verified = result.models.includes(candidate) ? candidate : '';
        setModel(verified);
        if (changedModelPrefs.current?.scope === `${thread}|${identity}`) {
          changedModelPrefs.current = null;
          void saveThreadPrefs(prefsKey, { model: verified || undefined, effort: nextEffort || undefined, apiIdentity: identity }).catch(() => undefined);
        }
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
    if (!visible || !deviceId || desktopLive || readOnly || !online) return;
    void loadModels(true);
  }, [visible, deviceId, catalogScope, managedApi, desktopLive, readOnly, online, modelEpoch]); // eslint-disable-line react-hooks/exhaustive-deps
  const openModels = () => {
    Keyboard.dismiss();
    const scope = catalogScope, request = ++modelBackdropRequest.current;
    const texture = captureModelBackdrop(modelSurfaceRef);
    pickerRef.current = 'model'; setPicker('model');
    void texture.then((uri) => {
      if (request === modelBackdropRequest.current && pickerRef.current === 'model' && `${draftRef.current}|${apiIdentityRef.current}` === scope) setModelBackdrop(uri);
    });
    if (!desktopLive) void loadModels(false);
  };
  const closeModels = () => { modelBackdropRequest.current += 1; pickerRef.current = null; setModelBackdrop(undefined); setPicker(null); };
  const chooseModel = (value: string, selectedEffort?: Effort) => {
    if (!interactionCurrent() || apiSwitchingRef.current) return;
    if (pendingDelivery) { showToast('先核对待确认消息', 'alert'); return; }
    if (desktopLive) return;
    if (managedApi && (!catalogReady || !models.models.includes(value || defaultModel))) {
      showToast('请选择模型', 'alert'); return;
    }
    prefsRevision.current += 1;
    const selectedCapability = models.modelCapabilities?.[value || defaultModel];
    const strength = tool === 'codex' && catalogReady ? selectedEffort && reportedEfforts(selectedCapability).includes(selectedEffort) ? selectedEffort : defaultSelectionEffort(selectedCapability) : '';
    modelRef.current = value; effortRef.current = strength;
    setModel(value); setEffort(strength); closeModels();
    void saveThreadPrefs(prefsKey, { model: value || undefined, effort: strength || undefined, apiIdentity }).catch(() => undefined);
  };
  const followDesktop = () => {
    if (!interactionCurrent() || !desktopLive || pendingDelivery) return;
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
      void captureModelBackdrop(composerRef).then((texture) => { if (texture && scrubRequest.current === request) setScrub((current) => current ? { ...current, texture } : current); });
    } else if (event.phase === 'move') setScrub((current) => current ? { ...current, index: event.index } : current);
    else {
      scrubRequest.current += 1; setScrub(null);
      const value = scrubLevels[event.index];
      if (event.phase === 'end' && value !== undefined && value !== effectiveEffort) chooseEffort(value);
    }
  };
  const openApi = () => {
    if (!interactionCurrent()) return;
    if (pickerRef.current !== 'model') openModels();
    if (deviceId) void loadAgentProfiles(deviceId).catch((error: Error) => showToast(error.message, 'alert'));
  };
  const changedApi = (profile?: AgentProfile) => {
    prefsRevision.current += 1;
    modelRequestRef.current += 1; setModelsLoading(false); setModels({ models: [] });
    setCatalogOwner(''); setCatalogError(''); setModelEpoch((value) => value + 1);
    effortRef.current = ''; setEffort('');
    const followsTool = profile?.api.source === 'tool' || (profile?.api.source === 'computer' && !profile.api.configured);
    setModel(followsTool ? '' : model || configuredModel || profile?.api.model || ''); setApiError(null);
    if (recentProblem?.id) setDismissedError(recentProblem.id);
    const identity = profile ? `${profile.api.source}:${profile.api.accountId ?? profile.api.name}` : apiIdentityRef.current;
    changedModelPrefs.current = { scope: `${draftKey}|${identity}` };
    // Do not persist an unverified model under the new API's identity.
    void saveThreadPrefs(prefsKey, { apiIdentity: identity }).catch(() => undefined);
  };
  const addImages = async (source: 'gallery' | 'camera') => {
    if (!interactionCurrent()) return;
    setAttachMenu(false);
    if (modelRejectsImagesRef.current) return;
    try {
      const picked = await pickRemoteImages(source, MAX_REMOTE_IMAGES - images.length);
      if (interactionCurrent() && !modelRejectsImagesRef.current && picked.length) setImages((current) => [...current, ...picked].slice(0, MAX_REMOTE_IMAGES));
    } catch (error) { if (interactionCurrent()) showToast((error as Error).message, 'alert'); }
  };

  // session.model describes the previous turn, not this API's next-turn default.
  const configuredModel = ownToolApi ? session?.model || (currentAgent?.api.source === 'tool' ? currentAgent.api.model : '') || '' : currentAgent?.api.model || '';
  const defaultModel = !managedApi || (catalogReady && models.models.includes(configuredModel)) ? configuredModel : '';
  const candidateModel = model || defaultModel;
  const currentModel = !managedApi || (catalogReady && models.models.includes(candidateModel)) ? candidateModel : '';
  const nextModel = desktopLive ? '' : managedApi ? currentModel : model || (effectiveEffort || !ownToolApi ? defaultModel : '');
  const currentModelLabel = currentModel ? modelDisplayLabel(currentModel, models.models) : '';
  const modelBlocked = managedApi && (!catalogReady || !currentModel);
  const title = isNew ? '新对话' : titleOf(deviceId, sessionKey, session?.title || '对话');
  const stats = useMemo(() => turnStats(timeline.items), [timeline.items]);
  const startedAt = running ? runningSince(timeline.items) : undefined;
  const now = useClock(Boolean(visible && startedAt));
  const runClock = startedAt ? clockText(now - startedAt) : undefined;
  const hits = useMemo(() => searchOpen ? searchBlocks(blocks, searchQuery) : [], [searchOpen, blocks, searchQuery]);
  const hitIndex = hits.length ? hits[Math.min(searchPos, hits.length - 1)] : -1;
  const goToBlock = (index: number) => {
    if (index < 0) return;
    followRef.current = false;
    try { listRef.current?.scrollToIndex({ index, viewPosition: 0.3, animated: true }); } catch { /* measured later */ }
  };
  useEffect(() => { if (searchOpen && hitIndex >= 0) goToBlock(hitIndex); }, [searchOpen, hitIndex]); // eslint-disable-line react-hooks/exhaustive-deps
  // Retry is offered on the newest failed turn: resend the user's last message.
  const retryText = useMemo(() => {
    const lastBlock = blocks[blocks.length - 1];
    if (lastBlock?.type !== 'turn' || lastBlock.item.status !== 'failed') return null;
    for (let index = timeline.items.length - 1; index >= 0; index -= 1) {
      const item = timeline.items[index];
      if (item.kind === 'message' && item.role === 'user' && !item.parentId && item.text.trim()) return item.text;
    }
    return null;
  }, [blocks, timeline.items]);
  const threadUi = useMemo(() => ({ openDiff: setDiffFile, openImage: setViewImage, runClock }), [runClock]);
  const subtitle = isNew ? (cwd ? `${projectName(cwd)} · ${agent?.name ?? toolName(tool)}` : agent?.name)
    : [session?.cwd ? projectName(session.cwd) : '', desktopLive ? '桌面续聊' : toolName(tool), device && !online ? '电脑离线' : ''].filter(Boolean).join(' · ');
  const placeholder = '随心输入';

  const composerBar = (mic: React.ReactNode) => (
  <View style={styles.composerBar}>
    <IconButton icon="plus" label="添加图片" size={30} iconSize={18} disabled={desktopLive || modelRejectsImages || images.length >= MAX_REMOTE_IMAGES || sending} onPress={() => setAttachMenu(true)} />
    {mic}
    <View>
      <MotionPressable accessibilityRole="button" accessibilityLabel={`模型：${desktopLive ? '跟随电脑' : currentModelLabel || (managedApi ? '选择模型' : '默认')}`} scaleTo={0.94} onPress={openModels} style={styles.modelChip}>
        {currentModel && !desktopLive ? <ModelDot model={currentModel} size={14} /> : <Icon name="sparkle" size={12} color={dk.text2} />}
        <Text style={styles.chipText} numberOfLines={1}>{desktopLive ? '跟随电脑' : currentModelLabel || (managedApi ? '选择模型' : '模型')}</Text>
      </MotionPressable>
    </View>
    {effortEditable ? <EffortScrubChip levels={scrubLevels} value={effectiveEffort} onScrub={onScrub} /> : null}
    <View style={{ flex: 1 }} />
    {running && desktopCanStop && !text.trim() && !isNew && !externalBusy && !busyApproval
      ? <MotionPressable accessibilityRole="button" accessibilityLabel="停止" onPress={stop} style={[styles.send, styles.stop]}><Icon name="stop" size={16} color={dk.onInk} /></MotionPressable>
      : <IconButton icon={running && !isNew && !pendingDelivery && text.trim() ? 'hourglass' : 'arrowUp'} label={running && !isNew && !pendingDelivery && text.trim() ? '排队发送' : '发送'} variant="ink" size={34} iconSize={17} disabled={!text.trim() || verifying || sending || apiSwitching || !desktopCanSend || !online || externalBusy || Boolean(busyApproval) || (!pendingDelivery && modelBlocked) || (isNew && !cwd)} onPress={() => void send()} />}
  </View>
  );

  return <Sheet visible={visible && Boolean(deviceId)} surfaceRef={modelSurfaceRef} presentation="page" scroll={false} background={dk.surface} onClose={onClose} title={title} subtitle={subtitle}
    headerRight={!isNew ? <IconButton icon="more" label="更多" onPress={() => setMenu(true)} /> : <View style={{ width: 40 }} />}>
    <ThreadUi.Provider value={threadUi}>
    <View style={{ flex: 1 }} onLayout={(event) => { const height = event.nativeEvent.layout.height; if (height > 0) setInputSpace(height); }}>
      {searchOpen && !isNew ? <SearchBar query={searchQuery} onChange={(value) => { setSearchQuery(value); setSearchPos(0); }} position={Math.min(searchPos, Math.max(0, hits.length - 1))} total={hits.length}
        onPrev={() => { if (hits.length) setSearchPos((value) => (value - 1 + hits.length) % hits.length); }}
        onNext={() => { if (hits.length) setSearchPos((value) => (value + 1) % hits.length); }}
        onClose={() => { setSearchOpen(false); setSearchQuery(''); setSearchPos(0); }} /> : null}
      {isNew ? <NewThreadIntro agent={agent} cwd={cwd} onPickProject={() => setPicker('project')} />
        : <View style={{ flex: 1 }}><FlatList
          testID="remote-conversation"
          ref={listRef}
          data={blocks}
          keyExtractor={(item: ConversationBlock) => item.id}
          maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
          contentContainerStyle={styles.list}
          refreshing={timeline.loading && blocks.length > 0}
          onRefresh={() => { void refresh().catch((error: Error) => showToast(error.message, 'alert')); }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          showsVerticalScrollIndicator={false}
          onScroll={(event: { nativeEvent: { layoutMeasurement: { height: number }; contentOffset: { y: number }; contentSize: { height: number } } }) => {
            const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent;
            const away = contentSize.height - layoutMeasurement.height - contentOffset.y;
            if (!draggingRef.current) followRef.current = away < 120;
            setJumpState(away > 320 ? { visible: true, unseen: jumpRef.current.unseen } : { visible: false, unseen: false });
          }}
          onScrollBeginDrag={() => { draggingRef.current = true; followRef.current = false; }}
          onScrollEndDrag={(event: { nativeEvent: { layoutMeasurement: { height: number }; contentOffset: { y: number }; contentSize: { height: number } } }) => {
            draggingRef.current = false;
            const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent;
            followRef.current = contentSize.height - layoutMeasurement.height - contentOffset.y < 40;
          }}
          scrollEventThrottle={64}
          onContentSizeChange={(_width: number, height: number) => {
            const grew = height > contentHeight.current + 1;
            contentHeight.current = height;
            if (followRef.current) listRef.current?.scrollToEnd({ animated: true });
            else if (grew && jumpRef.current.visible) setJumpState({ visible: true, unseen: true });
          }}
          onScrollToIndexFailed={(info: { index: number; averageItemLength: number }) => {
            listRef.current?.scrollToOffset({ offset: Math.max(0, info.averageItemLength * info.index - 120), animated: false });
            setTimeout(() => { try { listRef.current?.scrollToIndex({ index: info.index, viewPosition: 0.3, animated: true }); } catch { /* still measuring */ } }, 120);
          }}
          ListHeaderComponent={timeline.nextCursor ? <Pressable accessibilityRole="button" accessibilityLabel="加载更早记录"
            disabled={timeline.loadingEarlier || !online} onPress={() => {
              if (!visible || !deviceId || !sessionKey || !online) return;
              followRef.current = false;
              void loadEarlierHistory(deviceId, sessionKey).catch(() => undefined);
            }} style={{ minHeight: 42, alignItems: 'center', justifyContent: 'center' }}>
            {timeline.loadingEarlier ? <ActivityIndicator size="small" color={dk.muted} /> : <Text style={{ color: dk.muted, fontSize: 12 }}>{timeline.earlierError ? '加载失败，重试' : '更早记录'}</Text>}
          </Pressable> : null}
          ListEmptyComponent={timeline.loading
            ? <View style={styles.loading}><ActivityIndicator color={dk.muted} /><Text style={styles.loadingText}>正在从电脑读取对话…</Text></View>
            : timeline.error ? <EmptyState icon="alert" title="没有读到这个对话" detail={timeline.error} />
              : <EmptyState icon="chat" title="还没有内容" detail="在下面继续这个对话" />}
          ListFooterComponent={answerSending ? <View testID="remote-answer-delivery" style={styles.thinking} accessibilityRole="progressbar" accessibilityLabel="正在发送回答" accessibilityState={{ busy: true }}><ActivityIndicator size="small" color={dk.muted} /></View>
            : thinking ? <View style={styles.thinking}><PulseDot /><Text style={styles.thinkingText}>正在处理{runClock ? ` · ${runClock}` : ''}</Text></View> : null}
          renderItem={({ item, index }: { item: ConversationBlock; index: number }) => <BlockRow block={item} tool={tool}
            stat={item.type === 'assistant' ? stats.get(item.item.id) : undefined}
            highlight={index === hitIndex}
            onQuote={readOnly ? undefined : quote}
            onRetry={retryText && index === blocks.length - 1 && item.type === 'turn' && !running && online && desktopCanSend ? () => retry(retryText) : undefined}
            onOpenChild={(key) => { if (key !== sessionKey && key.startsWith(`${tool}:`)) onCreated(key); }} />}
        />
        <JumpToLatest visible={jump.visible && !searchOpen} unseen={jump.unseen} onPress={() => {
          followRef.current = true; setJumpState({ visible: false, unseen: false }); listRef.current?.scrollToEnd({ animated: true });
        }} />
        </View>}

      {!readOnly && pending.length > 0 && pending[0].approval !== 'question' ? <ApprovalCard approval={pending[0]} more={pending.length - 1} tool={tool} busy={busyApproval === pending[0].id || !online || !desktopCanApprove} allowSession={!desktopLive}
        onDecide={(decision) => void decide(pending[0], decision)} onDeny={() => { setReason(''); setDenying(pending[0]); }} /> : null}

      {!readOnly ? <QuestionDock key={draftKey} question={question} busy={Boolean(busyApproval)} availableHeight={inputSpace} blocked={questionProblem || (!desktopCanApprove ? '请在电脑回答' : !online ? '电脑离线，恢复后可回答' : undefined)}
        initialAnswers={answerDraft.current?.scope === draftKey && answerDraft.current?.id === question?.id ? answerDraft.current.answers : undefined}
        onAnswer={(answers) => { if (question) void decide(question, 'allow', undefined, answers); }} onCancel={() => { if (question) void decide(question, 'deny'); }}>
      <View style={styles.composerWrap}>
        {apiError || recentProblem?.message ? <Pressable accessibilityRole="button" accessibilityLabel="API 出错，更换 API" onPress={openApi} style={styles.banner}>
          <Icon name="key" size={15} color={dk.warn} /><Text style={styles.bannerText}>{apiError?.message || recentProblem?.message}</Text><Text style={styles.apiLink}>更换 ›</Text>
        </Pressable> : null}
        {session?.parentSessionKey ? <Pressable accessibilityRole="button" accessibilityLabel="返回主任务" onPress={() => onCreated(session.parentSessionKey!)} style={styles.parentLink}><Text style={styles.apiLink}>‹ 返回主任务</Text></Pressable> : null}
        {pendingDelivery ? <Pressable accessibilityRole="button" onPress={() => setMenu(true)} style={styles.banner}>
          <Icon name="hourglass" size={15} color={dk.warn} />
          <Text style={styles.bannerText} numberOfLines={3}>{pendingDelivery.message}</Text>
        </Pressable> : null}
        {!online ? <View style={styles.banner}><Icon name="laptop" size={15} color={dk.warn} /><Text style={styles.bannerText}>{timeline.items.length ? '电脑暂时离线，显示的是上次保存的记录；可以先写好，恢复后再发送' : '电脑暂时离线，可以先写好，恢复后再发送'}</Text></View>
          : verifying ? <View style={styles.banner}><ActivityIndicator size="small" color={dk.warn} /><Text style={styles.bannerText}>正在连接电脑，确认后就能发送</Text></View>
          : timeline.error && timeline.items.length ? <Pressable accessibilityRole="button" accessibilityLabel="重新读取对话" onPress={() => { if (deviceId && sessionKey) void openSession(deviceId, sessionKey).catch(() => undefined); }} style={styles.banner}>
            <Icon name="alert" size={15} color={dk.warn} /><Text style={styles.bannerText}>{timeline.error}，显示的是上次的记录</Text><Text style={styles.apiLink}>重试</Text></Pressable> : null}
        {queued ? <View style={styles.queued} accessibilityLabel={`排队中：${queued.text}`}>
          <Icon name="hourglass" size={14} color={dk.accentText} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.queuedText} numberOfLines={1}>{queued.text}{queued.images.length ? `（${queued.images.length} 张图）` : ''}</Text>
            <Text style={styles.queuedHint} numberOfLines={1}>{running ? 'Agent 完成当前这一轮后自动发送' : '正在发送…'}</Text>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="取消排队，放回输入框" hitSlop={8} onPress={unqueue} style={styles.queuedClose}><Icon name="close" size={13} color={dk.muted} /></Pressable>
        </View> : null}
        <View style={styles.composer}><View ref={composerRef} collapsable={false}>
          {isNew && seed ? <View style={styles.seedRow}><Icon name="history" size={13} color={dk.accentText} /><Text style={styles.seedText} numberOfLines={1}>接着 Claude Desktop 对话：{seed.title}</Text></View> : null}
          {isNew ? <View style={styles.chipRow}>
            <ComposerChip icon="archive" label={cwd ? projectName(cwd) : '选择项目'} onPress={() => setPicker('project')} />
            <ComposerChip icon="lock" label={MODE_LABEL[mode]} danger={mode === 'auto_all'} onPress={() => setPicker('mode')} />
          </View> : null}
          {images.length ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.thumbs} keyboardShouldPersistTaps="handled">
            {images.map((image, index) => <View key={image.uri} style={styles.thumb}>
              <Image source={{ uri: image.uri }} style={styles.thumbImage} />
              <Pressable accessibilityRole="button" accessibilityLabel="移除图片" hitSlop={6} onPress={() => setImages((current) => current.filter((_, i) => i !== index))} style={styles.thumbRemove}>
                <Icon name="close" size={11} color={dk.onInk} strokeWidth={2.6} />
              </Pressable>
            </View>)}
          </ScrollView> : null}
          <TextInput value={text} onChangeText={setText} multiline placeholder={placeholder} placeholderTextColor={dk.muted}
            style={styles.input} accessibilityLabel="给电脑上的 Agent 发消息" editable={!sending} />
          {voice ? <RemoteDictation voice={voice} text={text} onText={setText} disabled={sending}>{(mic) => composerBar(mic)}</RemoteDictation> : composerBar(null)}
          </View>
          {scrub && effortEditable ? <EffortScrubOverlay levels={scrubLevels} index={scrub.index} texture={scrub.texture} reduced={reducedMotion} /> : null}
        </View>
      </View>
      </QuestionDock> : <View testID="remote-readonly-footer" style={styles.readOnlyBar}>
        <View style={{ flex: 1, minWidth: 0 }}><Text style={styles.readOnlyTitle}>只读</Text><Text style={styles.readOnlyText} numberOfLines={2}>Claude Desktop 的聊天只能在电脑上回复</Text></View>
        {onContinue && timeline.items.some((item) => item.kind === 'message') ? <MotionPressable accessibilityRole="button" accessibilityLabel="在 Claude Code 中继续" scaleTo={0.96}
          onPress={() => onContinue({ title: session?.title || '对话', transcript: continueTranscript(timeline.items), cwd: session?.cwd || undefined })} style={styles.continueButton}>
          <Icon name="terminal" size={14} color={dk.accentText} /><Text style={styles.continueText}>在 Claude Code 中继续</Text></MotionPressable> : null}
      </View>}
    </View>
    </ThreadUi.Provider>

    <ModelPopover visible={picker === 'model'} anchor={null} value={desktopLive ? '' : model} fallback={desktopLive ? '' : defaultModel} models={desktopLive ? [] : models.models}
      catalogOnly={managedApi} catalogReady={catalogReady} error={catalogError}
      scopeKey={catalogScope} backgroundUri={modelBackdrop} effort={effectiveEffort} modelCapabilities={tool === 'codex' && catalogReady ? models.modelCapabilities ?? {} : {}} selectionEnabled={!desktopLive}
      onFollowComputer={desktopLive ? followDesktop : undefined}
      interactionBlocked={apiSwitching}
      apiHeader={currentAgent && deviceId ? <InlineApiPicker visible={picker === 'model'} deviceId={deviceId} agent={currentAgent} apis={remote.agents[deviceId]?.apis ?? []} sessionKey={sessionKey ?? undefined}
        externalBusy={apiSwitching} operationCurrent={apiOperationCurrent}
        blocked={pendingDelivery ? '先核对待确认消息，再换 API' : running || sending ? '任务结束或停止后再换 API' : desktopLive ? '先结束桌面实时连接，再换 API' : undefined}
        onChanged={changedApi} onBusyChange={setApiBusy} /> : undefined}
      apiName={models.api || currentAgent?.api.name || '跟随电脑'}
      loading={modelsLoading} onRefresh={() => { if (!desktopLive) void loadModels(true); }} onSelect={chooseModel} onClose={closeModels} />
    <AppDialog visible={attachMenu} title="添加图片" message={`最多 ${MAX_REMOTE_IMAGES} 张，会压缩后发给电脑上的 ${agent?.name ?? 'Agent'}`} icon="image" onClose={() => setAttachMenu(false)} actions={[
      { label: '从相册选择', tone: 'secondary', onPress: () => void addImages('gallery') },
      { label: '拍照', tone: 'secondary', onPress: () => void addImages('camera') },
      { label: '取消', tone: 'primary', onPress: () => setAttachMenu(false) },
    ]} />
    <OptionSheet visible={picker === 'mode'} title="需要你批准吗" value={mode} onClose={() => setPicker(null)}
      options={autoAllowed ? MODES : MODES.map((item) => item.value === 'auto_all' ? { ...item, detail: '电脑「设置」里允许后才能用' } : item)}
      onSelect={(value) => {
        if (value === 'auto_all' && !autoAllowed) { showToast('电脑上还没允许手机使用「全部自动」', 'lock'); return; }
        setMode(value); setPicker(null);
      }} />
    <OptionSheet visible={picker === 'project'} title="项目" subtitle="在电脑的这个文件夹里工作" value={cwd} onClose={() => setPicker(null)} onSelect={(value) => { setCwd(value); setPicker(null); }}
      options={projects.map((item) => ({ value: item.path, label: item.name || projectName(item.path), detail: item.path }))}
      empty="电脑上还没有项目。请在电脑端 Salcara Bridge 的「手机远程」里添加项目文件夹。" />

    <AppDialog visible={menu} title={title} icon="code" onClose={() => setMenu(false)} actions={[
      ...(pendingDelivery ? [{ label: '复制待确认文字', tone: 'secondary' as const, onPress: () => {
        if (!interactionCurrent()) return;
        setMenu(false);
        void import('expo-clipboard').then((clipboard) => { if (interactionCurrent()) return clipboard.setStringAsync(pendingDelivery.text); })
          .then(() => { if (interactionCurrent()) showToast('文字已复制，请先核对原会话，避免重复发布任务', 'checkCircle'); }).catch((error: Error) => { if (interactionCurrent()) showToast(error.message, 'alert'); });
      } }] : []),
      ...(pendingDelivery ? [{ label: '已核对，停止重发', tone: 'danger' as const, onPress: () => {
        if (!interactionCurrent()) return;
        setMenu(false);
        if (deviceId && sessionKey) void cancelPendingRemoteMessage(deviceId, sessionKey, operationScope).then(() => { if (interactionCurrent()) setPendingDelivery(null); }).catch((error: Error) => { if (interactionCurrent()) showToast(error.message, 'alert'); });
      } }] : []),
      ...(running && desktopCanStop && !externalBusy ? [{ label: '停止任务', tone: 'danger' as const, onPress: () => { setMenu(false); stop(); } }] : []),
      ...(sessionKey && canOpenOnDesktop(sessionKey, session?.client) && deviceId ? [{ label: tool === 'codex' ? '在电脑的 Codex 里打开' : '在电脑上打开 Claude Desktop', tone: 'secondary' as const, onPress: () => {
        if (!interactionCurrent()) return;
        setMenu(false);
        void openOnDesktop(deviceId, sessionKey, session?.client).then(() => { if (interactionCurrent()) showToast(tool === 'codex'
          ? '已在电脑打开；重新进入会话可刷新内容'
          : '已打开 Claude Desktop 的 Code 会话', 'laptop'); }).catch((error: Error) => { if (interactionCurrent()) showToast(error.message, 'alert'); });
      } }] : []),
      ...(blocks.length ? [{ label: '搜索对话', tone: 'secondary' as const, onPress: () => { setMenu(false); setSearchOpen(true); } }] : []),
      ...(deviceId && sessionKey ? [{ label: '重命名', tone: 'secondary' as const, onPress: () => { setMenu(false); setRenaming(title); } }] : []),
      { label: '刷新', tone: 'secondary', onPress: () => { setMenu(false); void refresh().catch((error: Error) => showToast(error.message, 'alert')); } },
      { label: '关闭', tone: 'primary', onPress: () => setMenu(false) },
    ]} message={[pendingDelivery ? `${pendingDelivery.message}\n停止重发只清除手机的重试记录，不会取消电脑上已开始的任务。` : '',
      session?.cwd, session?.model ? prettyModel(session.model) : '', session?.client,
      desktopLive && !desktopCanApprove ? '审批和停止请在电脑处理。' : ''].filter(Boolean).join('\n') || undefined} />
    <AppDialog visible={Boolean(denying)} title="拒绝这一步？" message={denying?.title} icon="close" onClose={() => setDenying(null)} actions={[
      { label: '取消', tone: 'secondary', onPress: () => setDenying(null) },
      { label: '拒绝', tone: 'danger', onPress: () => { const target = denying; setDenying(null); if (target) void decide(target, 'deny', reason); } },
    ]}>
      <TextInput value={reason} onChangeText={setReason} placeholder="告诉它为什么（可选）" placeholderTextColor={dk.muted} style={styles.reason} multiline maxLength={300} />
    </AppDialog>
    <AppDialog visible={renaming !== null} title="重命名对话" message="名字只保存在这台手机上，不会改电脑上的会话；清空即恢复原名。" icon="edit" onClose={() => setRenaming(null)} actions={[
      { label: '取消', tone: 'secondary', onPress: () => setRenaming(null) },
      { label: '保存', tone: 'primary', onPress: () => {
        const value = renaming ?? ''; setRenaming(null);
        if (deviceId && sessionKey) void renameThread(deviceId, sessionKey, value === (session?.title || '对话') ? '' : value).catch((error: Error) => showToast(error.message, 'alert'));
      } },
    ]}>
      <TextInput value={renaming ?? ''} onChangeText={setRenaming} placeholder={session?.title || '对话名称'} placeholderTextColor={dk.muted} style={styles.renameInput} maxLength={80} autoFocus selectTextOnFocus />
    </AppDialog>
    <DiffScreen file={diffFile} onClose={() => setDiffFile(null)} />
    <ImageViewer uri={viewImage} onClose={() => setViewImage(null)} />
  </Sheet>;
}

