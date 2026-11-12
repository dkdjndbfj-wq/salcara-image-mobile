import {splitPastedText} from './pasted-text';
import {TextAttachmentChips} from './AttachmentComposerInput';
import {InlineConversationArtifact} from './InlineConversationArtifact';
import {ModelChangeNoticeRow} from './ModelChangeNotice';
import {isModelChangeNotice} from './model-change-notices';
import {useConversationReading} from './ConversationReading';
import type {ConversationArtifactTarget} from './conversation-artifact-target';
/* Rows and cards of a remote thread: messages, the agent's work, plans, files and approvals. Split from ThreadView.tsx. */
import React, { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { retainCachedAttachment } from './attachment-cache-policy';
import { ManagedImage } from './ManagedImage';
import { ActivityIndicator, AppState, FlatList, Image, Keyboard, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Icon, type IconName } from '../components/Icon';
import { DeskOrb } from './DeskOrb';
import { MessageContent } from '../components/MessageContent';
import { MessageSelectionSurface, type MessageTextSelection, type MessageSelectionHighlight } from '../components/MessageSelectionSurface';
import { Appear, AppDialog, IconButton, MotionPressable, Sheet, showToast, useReducedMotion } from '../components/ui';
import { colors, prettyModel, radius, shadow, desk, themed, useDesk } from '../theme';
import { buildBlocks, conversationBlocks, fileEdits, planSteps, subagentStatus, visibleReasoningId, visibleWorkItems, type Block, type ConversationBlock, type FileEdit } from './blocks';
import { searchItemMatches } from './thread-stats';
import { HubError, type AgentProfile, type ApprovalMode, type AttachmentRef, type Decision, type Effort, type MessageOrigin, type ModelCatalog, type Project, type QuestionAnswers, type ToolId, type ToolKind } from './client';
import { executionErrorDetail, modelCapabilityProblem, modelCatalogProblem, type ApiProblem } from './api-errors';
import { QuestionDock } from './QuestionDock';
import { approvalDecisions } from './approvals';
import { deliverQuestionAnswer, QuestionDeliveryCancelled } from './question-delivery';
import { blockQuestionReceipt, finishQuestionReceipt, markQuestionAttempt, pendingQuestionReceipts, prepareQuestionReceipt, reconcileQuestionReceipts, type QuestionReceipt } from './question-outbox';
import { MAX_REMOTE_IMAGES, pickRemoteImages, type RemoteImage } from './attachments';
import { DeliveryPendingError } from './delivery';
import { deliveryRetryState } from './offline-policy';
import { defaultSelectionEffort, effortLabel, reportedEfforts, reportsTextOnly } from './effort';
import { loadRemoteDraft, saveRemoteDraft } from './drafts';
import { EffortScrubChip, EffortScrubOverlay, type ScrubEvent } from './EffortScrub';
import { noteTaskSent, requestNotificationPermission, setVisibleThread } from './notifications';
import { modelDisplayLabel } from './model-presentation';
import { captureModelBackdrop } from './model-backdrop';
import { OptionSheet, type Option } from './OptionSheet';
import { loadThreadPrefs, saveThreadPrefs } from './thread-prefs';
import { DiffView, EmptyState, mono, PulseDot, ToolBadge, toolName } from './parts';
import { desktopLiveFor, projectName } from './projection';
import { formatDuration, formatTokens } from './thread-stats';
import {
  EMPTY_TIMELINE, cachedModels, canOpenOnDesktop, hydrateCachedThread, cancelPendingRemoteMessage, openOnDesktop, getPendingRemoteMessage, hubSupportsWait, interruptSession, listModels, listProjects, loadAgentProfiles, loadEarlierHistory, openSession,
  remoteDeliveryScope, respondApproval, sendToSession, startSession, syncSessionEvents, timelineKey, useRemote, type TimelineItem,
} from './store';
import { useLiveSync } from './useLiveSync';
import {
  clockText, CompletedTurnHeader, RunningTurnHeader, copyUserMessage, DiffScreen, ImageViewer, JumpToLatest, MessageActions, OutputText, quoteFor, RemoteDictation, runningSince, SearchBar, searchBlocks, turnStats, useClock,
  type TurnStat, type VoiceSource,
} from './thread-extras';
import { renameThread, useThreadTitles } from './thread-titles';
import { PlanSummaryCard } from './PlanCard';
import { useThreadStyles } from './thread-styles';
import { inlineRemoteReference } from './remote-links';
import { SkillReferenceLabel } from './SkillReferenceLabel';
import { ContextReferenceChips } from './ContextReferenceChips';
import { messageContextReferences } from './conversation-metadata';
import { messageSkills, messageOrigin } from './conversation-metadata';
import { skillKey } from './agent-features';
import type { ContextReference } from './context-references';
import { ConversationChangesCard, ConversationPreviewCard, type UndoChangesResult } from './ConversationArtifacts';
import { ExecutionFailureActions } from './ExecutionFailureActions';
import type { ExecutionRecoveryAction } from './execution-recovery';
import { parseBrowserNavigation, type BrowserNavigation } from './browser-navigation';
import { executionLabel } from './execution-presentation';
import { CommandOutput } from './CommandOutput';
import { InlineSentMessageEditor } from './InlineSentMessageEditor';
import { canReviseSentMessage, sentMessageRevisionIdentity, type SentMessageRevisionHandler } from './sent-message-revision';

export type ApprovalItem = Extract<TimelineItem, { kind: 'approval' }>;

/** Actions and live status shared with deeply nested rows (files, images, the live summary). */
export const ThreadUi = createContext<{ editDraftScope?:string;editDraftDeviceId?:string;latestEditableMessageId?:string;onEditMessage?:SentMessageRevisionHandler;editMessageDisabledReason?:string;onResolveFailure?:(action:ExecutionRecoveryAction)=>void; artifactScope?:string;onOpenArtifact?:(target:ConversationArtifactTarget)=>void;onArtifactCompose?:(text:string)=>boolean; openPlan?: (item: Extract<TimelineItem, { kind: 'tool' }>) => void; openAnnotation?: (reference: ContextReference) => void; replyToCrossTask?: (origin: MessageOrigin) => void; currentSessionKey?: string; childTitle?: (key: string) => string; openDiff: (file: FileEdit) => void; openChanges?: (files: FileEdit[]) => void; undoChanges?: (files: FileEdit[]) => Promise<UndoChangesResult>; undoUnavailable?: string; openBrowser?: (navigation: BrowserNavigation) => void; openDiffInToolPanel?: boolean; openImage: (uri: string) => void; requestAttachment: (ref: AttachmentRef) => void; getAttachmentThumbnail?: (ref: AttachmentRef, signal: AbortSignal) => Promise<string | undefined>; openAttachment?: (ref: AttachmentRef) => void; openLink?: (target: string, exactSession: boolean) => void; attachmentRetryTick?: number; presentation?: 'mobile' | 'tablet' }>({ openDiff: () => undefined, openImage: () => undefined, requestAttachment: () => undefined });
/** Per-second elapsed time is isolated from the message/action context. */
export const ThreadClock = createContext<string | undefined>(undefined);
export function ThreadClockProvider({ startedAt, visible, children }: { startedAt?: number; visible: boolean; children: React.ReactNode }) {
  const now = useClock(Boolean(visible && startedAt));
  const runClock = startedAt ? clockText(now - startedAt) : undefined;
  return <ThreadClock.Provider value={runClock}>{children}</ThreadClock.Provider>;
}
export function ThreadClockLabel({ prefix }: { prefix: string }) {
  const runClock = useContext(ThreadClock);
  return <>{prefix}{runClock ? ` · ${runClock}` : ''}</>;
}

/** Nested child work lacks a verified cwd: never resolve its files as parent files. */
function RemoteContent({ text, streaming, exactSession = true, messageId }: { text: string; streaming?: boolean; exactSession?: boolean;messageId?:string }) {
  const ui = useContext(ThreadUi);
  return <MessageContent text={text} streaming={streaming} isInteractiveReference={inlineRemoteReference}
    desktop={ui.presentation === 'tablet'}
    renderInteractive={exactSession&&messageId&&ui.artifactScope?(source,_language,index)=><InlineConversationArtifact key={JSON.stringify([ui.artifactScope,messageId,index])} scopeKey={ui.artifactScope!} messageId={messageId} index={index} source={source} onCompose={ui.onArtifactCompose} onOpen={ui.onOpenArtifact}/>:undefined}
    onOpenLink={ui.openLink ? target => ui.openLink!(target, exactSession) : undefined} />;
}

export function ComposerChip({ icon, label, onPress, danger, disabled }: { icon: IconName; label: string; onPress: () => void; danger?: boolean; disabled?: boolean }) {
  const styles = useThreadStyles();
  const dk = useDesk();
  return <MotionPressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} scaleTo={0.94} onPress={() => { if (!disabled) onPress(); }} style={[styles.chip, danger && { backgroundColor: dk.badSoft }]}>
    <Icon name={icon} size={14} color={danger ? dk.bad : dk.muted} />
    <Text style={[styles.chipText, danger && { color: dk.bad }]} numberOfLines={1}>{label}</Text>
  </MotionPressable>;
}

export function NewThreadIntro({ agent, cwd, projectless = false, workspaceMode = 'code', onReturnToProjects }: { agent: AgentProfile | null; cwd: string; projectless?: boolean; workspaceMode?: 'code' | 'work'; onReturnToProjects?: () => void }) {
  const styles = useThreadStyles();
  const dk = useDesk();
  return <View style={styles.intro}>
    <Appear><DeskOrb size={72} /></Appear>
    <Text style={styles.introTitle}>{workspaceMode === 'code' ? '要构建什么？' : '要处理什么工作？'}</Text>
    <Text style={styles.introDetail}>{agent?.name ?? 'Codex'} {projectless ? '会在电脑上处理这次任务' : '会在电脑上已授权的文件夹里工作'}，进度实时同步到这里。</Text>
    <View style={styles.introProject}>
      <Icon name="archive" size={15} color={dk.text2} />
      <Text style={styles.introProjectText} numberOfLines={1}>{projectless ? '不关联文件夹' : cwd ? projectName(cwd) : '请选择新会话的开始方式'}</Text>
    </View>
    {cwd ? <Text style={styles.introPath} numberOfLines={1}>{cwd}</Text> : null}
    {!cwd && !projectless && onReturnToProjects ? <Pressable accessibilityRole="button" accessibilityLabel="返回项目目录" onPress={onReturnToProjects} style={styles.introProject}><Text style={{color:dk.accentText}}>返回项目目录</Text></Pressable> : null}
  </View>;
}

/** Origin is protocol metadata. A conversation's tool cannot prove its sender. */
function MessageOriginBar({ item, tool, nested = false }: { item: Extract<TimelineItem, { kind: 'message' }>; tool: ToolId; nested?: boolean }) {
  const styles = useThreadStyles();
  const dk = useDesk();
  const ui = useContext(ThreadUi);
  const origin = messageOrigin(item.messageOrigin);
  if (item.role !== 'user' || !origin) return null;
  const own = origin.kind === 'user_cross_task' && origin.verification === 'bridge_receipt';
  const label = own ? '你从 ' + (origin.sourceTitle || '另一项任务') + ' 发来的消息' : '来自另一项任务';
  return <View testID="remote-message-origin" style={[styles.messageOrigin, { flexWrap: 'wrap' }, nested && { alignSelf: 'flex-start' }]}>
    <View accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"><Icon name="chat" size={14} color={colors.textMuted} /></View>
    <Text accessibilityLabel={toolName(tool) + ' 对话，' + label} style={styles.messageOriginText}>{label}</Text>
    {!own ? <Text style={styles.messageOriginText}>来源未核验</Text> : null}
    {own && !nested && typeof origin.sourceSessionKey === 'string' && typeof origin.targetSessionKey === 'string' && origin.targetSessionKey === ui.currentSessionKey && ui.replyToCrossTask ? <Pressable accessibilityRole="button" accessibilityLabel="回复到另一任务" onPress={() => ui.replyToCrossTask?.(origin as MessageOrigin)} style={{ minHeight: 30, justifyContent: 'center', paddingHorizontal: 4 }}>
      <Text style={[styles.messageOriginText, { color: dk.accentText }]}>回复</Text>
    </Pressable> : null}
  </View>;
}

/** Measure both layouts at the same width; character count cannot predict wrapping. */
function UserMessageBubble({ item, styles, searchQuery = '', onSelectText, selectionScope = '', allowAskSelection = false, selectionHighlight }: {
  item: Extract<TimelineItem, { kind: 'message' }>; styles: ReturnType<typeof useThreadStyles>; searchQuery?: string;
  onSelectText?: (selection: MessageTextSelection, item: Extract<TimelineItem, { kind: 'message' }>) => void;
  selectionScope?: string; allowAskSelection?: boolean;
  selectionHighlight?: MessageSelectionHighlight;
}) {
  const ui = useContext(ThreadUi);
  const dk = useDesk();
  const skills = messageSkills(item.skills) ?? [];
  const references = messageContextReferences(item.contextReferences) ?? [];
  const [expanded, setExpanded] = useState(false);
  const [lineCount, setLineCount] = useState<number | null>(null);
  const [measurements, setMeasurements] = useState<Partial<Record<'full' | 'clipped', {width:number;height:number}>>>({});
  const [hovered,setHovered] = useState(false), [copyFocused,setCopyFocused] = useState(false);
  const editScope = ui.artifactScope ?? selectionScope, editIdentity = `${editScope}|${sentMessageRevisionIdentity(item)}`;
  const editable = Boolean(ui.onEditMessage && ui.latestEditableMessageId === item.id && canReviseSentMessage(item));
  const editOwner = useRef({ identity: editIdentity, editable, epoch: 0 });
  if (editOwner.current.identity !== editIdentity || editOwner.current.editable !== editable) editOwner.current = { identity: editIdentity, editable, epoch: editOwner.current.epoch + 1 };
  const editEpoch = editOwner.current.epoch;
  const [editing, setEditing] = useState<{ identity: string; epoch: number }>();
  const editingNow = editable && editing?.identity === editIdentity && editing.epoch === editEpoch;
  useEffect(() => { setEditing(undefined); }, [editIdentity, editable]);
  const [touchInput,setTouchInput] = useState(()=>Platform.OS!=='web'||typeof window!=='undefined'&&typeof window.matchMedia==='function'&&window.matchMedia('(pointer: coarse)').matches);
  useEffect(()=>{
    if(Platform.OS!=='web'||typeof window==='undefined'||typeof window.matchMedia!=='function')return;
    const media=window.matchMedia('(pointer: coarse)'), update=()=>setTouchInput(media.matches);
    update();media.addEventListener?.('change',update);return()=>media.removeEventListener?.('change',update);
  },[]);
  const {full,clipped} = measurements;
  const collapsible = (lineCount !== null && lineCount > 2) || Boolean(full && clipped && Math.abs(full.width-clipped.width)<1 && full.height>clipped.height+1);
  const measure = (kind:'full'|'clipped',event:{nativeEvent:{layout:{width:number;height:number}}}) => {
    const {width,height}=event.nativeEvent.layout;
    if(width<=0||height<=0)return;
    setMeasurements(current=>current[kind]?.width===width&&current[kind]?.height===height?current:{...current,[kind]:{width,height}});
  };
  useEffect(() => { setExpanded(false); setLineCount(null); setMeasurements({}); }, [item.id, item.text]);
  useEffect(() => { if (searchItemMatches(item, searchQuery)) setExpanded(true); }, [item.id, item.text, searchQuery]);
  const attachedText = splitPastedText(item.text), visibleText = attachedText.prompt;
  const textStyle = [styles.userText, ui.presentation === 'tablet' && styles.tabletUserText];
  const hasBody = Boolean(visibleText.trim() || attachedText.attachments.length || references.length || skills.length);
  return <View testID="remote-user-message-group" onPointerEnter={()=>setHovered(true)} onPointerLeave={()=>setHovered(false)} onPointerDown={event=>{if(event.nativeEvent.pointerType==='touch')setTouchInput(true);}} style={[styles.userMessageGroup,ui.presentation==='tablet'&&styles.tabletUserMessageGroup,(editingNow || !hasBody) && { width: '100%' }]}>
    {hasBody || editingNow ? <View testID="remote-user-message-bubble" style={[styles.userBubble, ui.presentation === 'tablet' && styles.tabletUserBubble, item.local && { opacity: 0.72 }]}>
    {!editingNow ? <TextAttachmentChips key={selectionScope + item.id} attachments={attachedText.attachments} /> : null}
    {references.length ? <ContextReferenceChips references={references} onNavigate={ui.openAnnotation} /> : null}
    {skills.length ? <Text style={[styles.userText, ui.presentation === 'tablet' && styles.tabletUserText]}>{skills.map(skill => <React.Fragment key={skillKey(skill)}><SkillReferenceLabel skill={skill} />{' '}</React.Fragment>)}</Text> : null}
    {editingNow && ui.onEditMessage ? <InlineSentMessageEditor key={`${editIdentity}:${editEpoch}`} scopeKey={editScope} draftScope={ui.editDraftScope} draftDeviceId={ui.editDraftDeviceId} message={item} disabledReason={ui.editMessageDisabledReason} onSubmit={ui.onEditMessage}
      onClose={() => { if (editOwner.current.identity === editIdentity && editOwner.current.epoch === editEpoch) setEditing(undefined); }} /> : <><View style={{position:'relative'}}>
      <View pointerEvents="none" accessible={false} aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.userMeasure}>
        <Text testID="user-message-measure-full" style={textStyle} onLayout={event=>measure('full',event)}
          onTextLayout={event=>{const count=event.nativeEvent.lines.length;if(count>0)setLineCount(current=>current===count?current:count);}}>{visibleText}</Text>
      </View>
      <View pointerEvents="none" accessible={false} aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.userMeasure}>
        <Text testID="user-message-measure-clipped" style={textStyle} numberOfLines={2} onLayout={event=>measure('clipped',event)}>{visibleText}</Text>
      </View>
      <MessageSelectionSurface sourceText={item.text} scopeKey={selectionScope + ':' + item.id} textBasis="source" allowAsk={allowAskSelection} highlight={selectionHighlight}
      onSelectText={onSelectText && !item.local ? selection => onSelectText(selection, item) : undefined}>
        <Text selectable testID="message-selectable-text" style={textStyle} numberOfLines={!expanded ? 2 : undefined}>{visibleText}</Text>
      </MessageSelectionSurface>
    </View>
    {item.text.trim() ? <>
      {collapsible ? <Pressable accessibilityRole="button" accessibilityLabel={expanded ? '收起消息' : '展开消息'} onPress={() => setExpanded(value => !value)} hitSlop={6} style={styles.userToggle}>
        <Text style={styles.userToggleText}>{expanded ? '收起' : '显示更多'}</Text><View style={expanded?{transform:[{rotate:'180deg'}]}:undefined}><Icon name="chevronDown" size={14} color={colors.textSecondary}/></View>
      </Pressable> : null}
    </> : null}</>}
    </View> : null}
    {!editingNow && editable ? <MotionPressable accessibilityRole="button" accessibilityLabel="编辑最新消息" scaleTo={0.94} wrapperStyle={{ position:'absolute', bottom:0, right:item.text.trim()?28:0 }}
      onFocus={()=>setCopyFocused(true)} onBlur={()=>setCopyFocused(false)} onHoverIn={()=>setHovered(true)} hitSlop={5}
      onPress={() => { if (editOwner.current.identity !== editIdentity || editOwner.current.epoch !== editEpoch || !editable) return;if (ui.editMessageDisabledReason) { showToast(ui.editMessageDisabledReason, 'alert');return; }setEditing({ identity:editIdentity, epoch:editEpoch }); }}
      style={{ width:26, height:24, alignItems:'center', justifyContent:'center', opacity:Platform.OS==='web'&&!touchInput&&!hovered&&!copyFocused?0:1 }}><Icon name="edit" size={13} color={colors.textMuted}/></MotionPressable> : null}
    {!editingNow && item.text.trim() ? <Pressable accessibilityRole="button" accessibilityLabel="复制消息" onPress={() => copyUserMessage(item.text)} onFocus={()=>setCopyFocused(true)} onBlur={()=>setCopyFocused(false)} onHoverIn={()=>setHovered(true)} hitSlop={5}
      style={[styles.userCopy,Platform.OS==='web'&&!touchInput&&!hovered&&!copyFocused&&{opacity:0}]}><Icon name="copy" size={13} color={colors.textMuted}/></Pressable> : null}
  </View>;
}

function AttachmentThumbnail({ attachment }: { attachment: AttachmentRef & { uri?: string } }) {
  const ui = useContext(ThreadUi), styles = useThreadStyles(), dk = useDesk();
  const [thumbnail, setThumbnail] = useState<{ identity: string; uri?: string; error?: string }>();
  const [retry,setRetry]=useState(0);
  const alive=useRef(true);useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const identity = JSON.stringify([attachment.id, attachment.sha256, attachment.uri]);
  const owner=useRef({identity,ui:ui.getAttachmentThumbnail,epoch:0});
  if(owner.current.identity!==identity||owner.current.ui!==ui.getAttachmentThumbnail)owner.current={identity,ui:ui.getAttachmentThumbnail,epoch:owner.current.epoch+1};
  const source=owner.current,flight=useRef<AbortController|undefined>(undefined);
  const retrieve=async()=>{
    if(!alive.current||flight.current||owner.current!==source)return;
    const controller=new AbortController();flight.current=controller;setThumbnail({identity});
    try{
      const uri=await ui.getAttachmentThumbnail?.(attachment,controller.signal);
      if(controller.signal.aborted||owner.current!==source)return;
      if(uri)setThumbnail({identity,uri});
      else{ui.requestAttachment(attachment);setThumbnail({identity,error:'原图片尚未恢复，请重试'});}
    }catch(error){if(!controller.signal.aborted&&owner.current===source)setThumbnail({identity,error:error instanceof Error?error.message:'图片预览不可用'});}
    finally{if(flight.current===controller)flight.current=undefined;}
  };
  useEffect(() => {
    if ((!attachment.uri||retry>0)&&ui.getAttachmentThumbnail)void retrieve();
    return () => {flight.current?.abort();flight.current=undefined;};
  }, [source, ui.requestAttachment, ui.attachmentRetryTick,retry]);
  const current = thumbnail?.identity === identity ? thumbnail : undefined;
  const uri = current?.uri ?? attachment.uri;
  const retryHere=()=>{setThumbnail({identity});setRetry(value=>value+1);};
  if(!uri&&current?.error)return <Pressable accessibilityRole="button" accessibilityLabel="重新加载图片预览" accessibilityHint={current.error} onPress={event=>{event.stopPropagation();retryHere();}} style={styles.userImagePending}>
    <Icon name="regenerate" size={15} color={dk.muted}/><Text style={{color:dk.muted,fontSize:10}}>重试</Text>
  </Pressable>;
  return <Pressable accessibilityRole="imagebutton" accessibilityLabel={current?.error ?? '查看图片'} onPress={() => {
    if (ui.openAttachment) ui.openAttachment(attachment); else if (attachment.uri) ui.openImage(attachment.uri); else ui.requestAttachment(attachment);
  }}>{uri ? <ManagedImage uri={uri} onRetry={ui.getAttachmentThumbnail?retrieve:undefined} style={styles.userImage} /> : <View style={styles.userImagePending}>
    {current?.error ? <Text numberOfLines={2} style={{ color: dk.muted, fontSize: 10 }}>点按读取图片</Text> : <ActivityIndicator size="small" color={dk.muted} />}
  </View>}</Pressable>;
}

function AttachmentStrip({ refs, legacyImages, align = 'right' }: { refs?: Array<AttachmentRef & { uri?: string }>; legacyImages?: string[]; align?: 'left' | 'right' }) {
  const styles = useThreadStyles();
  const dk = useDesk();
  const ui = useContext(ThreadUi);
  useEffect(() => { const releases = [...(refs?.map(ref => ref.uri) ?? []), ...(legacyImages ?? [])].map(retainCachedAttachment);
    return () => releases.forEach(release => release()); }, [refs, legacyImages]);
  // The row is virtualized, so this effect is the visibility boundary: a
  // message image is read when its thumbnail enters the list, while a folded
  // tool/image record is read only after its row has been expanded.
  useEffect(() => {
    if (!ui.getAttachmentThumbnail) refs?.filter((ref) => !ref.uri).forEach(ui.requestAttachment);
  }, [refs, ui.requestAttachment, ui.getAttachmentThumbnail, ui.attachmentRetryTick]);
  if (!refs?.length && !legacyImages?.length) return null;
  return <ScrollView horizontal showsHorizontalScrollIndicator={false} style={[styles.userImagesScroll, align === 'right' && { alignSelf: 'flex-end' }]} contentContainerStyle={[styles.userImages, align === 'left' && { alignSelf: 'flex-start', justifyContent: 'flex-start' }]}>
    {(refs ?? []).map(ref => <AttachmentThumbnail key={ref.id} attachment={ref} />)}
    {!refs?.length ? legacyImages?.map((uri) => <Pressable key={uri} accessibilityRole="imagebutton" accessibilityLabel="查看图片" onPress={() => ui.openImage(uri)}>
      <ManagedImage uri={uri} style={styles.userImage} /></Pressable>) : null}
  </ScrollView>;
}

function MessageAttachments({ item, align = 'right' }: { item: Extract<TimelineItem, { kind: 'message' }>; align?: 'left' | 'right' }) {
  return <AttachmentStrip refs={item.attachments} legacyImages={item.images} align={align} />;
}

export const BlockRow = memo(function BlockRow({ block, tool, onOpenChild, stat, runningTurnStartedAt, highlight, searchQuery = '', onQuote, onRetry, onSelectText, selectionScope = '', allowAskSelection = false, selectionHighlight, pendingDeliveryMessageId }: {
  block: ConversationBlock; tool: ToolId; onOpenChild: (key: string) => void;
  stat?: TurnStat; highlight?: boolean; searchQuery?: string; onQuote?: (text: string, item?: Extract<TimelineItem, { kind: 'message' }>) => void; onRetry?: () => void;
  runningTurnStartedAt?: number;
  onSelectText?: (selection: MessageTextSelection, item: Extract<TimelineItem, { kind: 'message' }>) => void;
  selectionScope?: string; allowAskSelection?: boolean;
  selectionHighlight?: MessageSelectionHighlight;
  pendingDeliveryMessageId?: string;
}) {
  const styles = useThreadStyles();
  const dk = useDesk();
  const ui = useContext(ThreadUi);
  const row = (() => {
    switch (block.type) {
      case 'user': {
        const deliveryPending = Boolean(block.item.local && pendingDeliveryMessageId === block.item.id);
        const hasBubble = Boolean(block.item.text.trim() || messageSkills(block.item.skills)?.length || messageContextReferences(block.item.contextReferences)?.length || ui.onEditMessage && ui.latestEditableMessageId === block.item.id && canReviseSentMessage(block.item));
        return <View style={styles.userRow}>
        <MessageOriginBar item={block.item} tool={tool} />
        <MessageAttachments item={block.item} />
        {hasBubble ? <View style={{ alignSelf: 'flex-end', flexDirection: 'row', justifyContent:'flex-end', alignItems: 'flex-end', gap: 7, width: '100%' }}>
          <UserMessageBubble item={block.item} styles={styles} searchQuery={searchQuery} onSelectText={onSelectText} selectionScope={selectionScope} allowAskSelection={allowAskSelection} selectionHighlight={selectionHighlight} />
          {deliveryPending ? <ActivityIndicator testID="remote-delivery-spinner" accessibilityRole="progressbar" accessibilityLabel="正在确认送达" accessibilityState={{ busy: true }} size="small" color={dk.muted} style={{ transform: [{ scale: 0.78 }], marginBottom: 5 }} /> : null}
        </View> : null}
      </View>;
      }
      case 'assistant': {
        const live = !block.item.final && !block.item.streamState;
        const progressLabel = block.item.streamState === 'terminal-unconfirmed' ? '正在同步回复'
          : block.item.streamState === 'incomplete' ? '回复未完整' : block.item.messagePhase === 'commentary' ? '正在更新进度' : '正在回复';
        return <View style={[styles.assistant, ui.presentation === 'tablet' && styles.tabletAssistant]}>
        {runningTurnStartedAt !== undefined ? <RunningTurnHeader startedAt={runningTurnStartedAt} />
          : block.item.final && block.item.messagePhase !== 'commentary' ? <CompletedTurnHeader stat={stat}/> : null}
        <MessageAttachments item={block.item} align="left" />
        <MessageSelectionSurface sourceText={block.item.text} scopeKey={selectionScope + ':' + block.item.id} allowAsk={allowAskSelection} highlight={selectionHighlight}
          onSelectText={onSelectText ? selection => onSelectText(selection, block.item) : undefined}>
          <RemoteContent messageId={block.item.id} text={block.item.text} streaming={live} />
        </MessageSelectionSurface>
        {!block.item.final ? <View {...(block.item.streamState === 'incomplete' ? { testID: 'remote-incomplete-reply', accessibilityRole: 'text' as const, accessibilityLabel: progressLabel }
          : { accessibilityRole: 'progressbar' as const, accessibilityLabel: progressLabel, accessibilityState: { busy: true } })}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 7, paddingTop: 4 }}>
          {block.item.streamState === 'incomplete' ? <Icon name="alert" size={13} color={dk.warn} /> : block.item.streamState ? <ActivityIndicator size="small" color={dk.muted} /> : <PulseDot color={dk.accentText} />}
          <Text style={[styles.planCount, { color: block.item.streamState === 'incomplete' ? dk.warn : dk.muted }]}>{progressLabel}</Text>
        </View> : null}
        {block.item.final && block.item.messagePhase !== 'commentary' && block.item.text.trim() ? <MessageActions text={block.item.text} stat={stat} hideDuration onQuote={onQuote ? text => onQuote(text, block.item) : undefined} /> : null}
        </View>;
      }
      case 'plan': return <PlanCard block={block} />;
      case 'activity': return <ExecutionTimeline block={block} tool={tool} onOpenChild={onOpenChild} searchQuery={searchQuery} />;
      case 'turn': {
        const failed = block.item.status === 'failed';
        const stopped = block.item.status === 'interrupted';
        const tokens = (block.item.usage?.inputTokens ?? 0) + (block.item.usage?.outputTokens ?? 0);
        const meta = [block.item.durationMs !== undefined ? formatDuration(block.item.durationMs) : '', tokens > 0 ? `${formatTokens(tokens)} tokens` : ''].filter(Boolean).join(' · ');
        if (failed) return <ExecutionFailureActions id={block.item.id} scopeKey={JSON.stringify([selectionScope,ui.artifactScope,ui.currentSessionKey])} error={block.item.error} code={block.item.errorCode}
          meta={meta} onRetry={onRetry} onResolve={ui.onResolveFailure} />;
        return <View style={[styles.notice, ui.presentation === 'tablet' && styles.tabletNotice]}>
          <Icon name={stopped?'stop':'checkCircle'} size={14} color={dk.muted}/>
          <Text style={styles.noticeText}>{stopped ? `本轮已中断${block.item.error ? `：${executionErrorSummary(block.item.error)}` : ''}` : '已完成'}{meta ? ` · ${meta}` : ''}</Text>
          {onRetry?<Pressable accessibilityRole="button" accessibilityLabel="重试上一条消息" hitSlop={8} onPress={onRetry} style={styles.retry}>
            <Icon name="retry" size={13} color={dk.accentText} accent={dk.accentText}/><Text style={styles.retryText}>重试</Text>
          </Pressable>:null}
        </View>;
      }
      case 'notice': {
        if (isModelChangeNotice(block.item)) return <ModelChangeNoticeRow record={block.item.localModelChange}/>;
        const retrying = block.item.retrying === true;
        const error = block.item.level === 'error' && !retrying;
        const warning = block.item.level === 'warn' && !retrying;
        // A host retry is progress, not a terminal failure or task completion.
        const compacting = block.item.noticeKind === 'context_compaction';
        const noticeText = retrying
          ? block.item.text.replace(/[，,]\s*正在重试(?:[（(]\d+(?:\/\d+)?[）)])?\s*$/, '').replace(/\s*[（(]正在重试[）)]\s*$/, '').replace(/^正在重试(?:[（(]\d+(?:\/\d+)?[）)])?$/, '').trim() || '请求暂时不可用'
          : block.item.text;
        return <View style={[styles.notice, ui.presentation === 'tablet' && styles.tabletNotice, error && styles.noticeError, warning && styles.noticeWarning]}>
          {compacting && block.item.progress ? <ActivityIndicator size="small" color={dk.accentText} style={{ transform: [{ scale: 0.78 }] }} />
            : retrying ? <ActivityIndicator accessibilityRole="progressbar" accessibilityLabel="请求重试进度" size="small" color={dk.muted} style={{ transform: [{ scale: 0.78 }] }} />
            : <Icon name={error || warning ? 'alert' : compacting ? 'checkCircle' : 'clock'} size={14} color={error ? dk.bad : warning ? dk.warn : compacting ? dk.accentText : dk.muted} />}
          <View style={{ flex: 1 }}>
            <Text style={[styles.noticeText, { flex: 0 }, compacting && { color: dk.accentText }, error && { color: dk.bad }, warning && { color: dk.warn }]}>{noticeText}</Text>
            {block.item.errorCode === 'session_source_frozen' && ui.onResolveFailure ? <Pressable accessibilityRole="button" accessibilityLabel="用当前配置新建" style={{ minHeight: 44, justifyContent: 'center' }} onPress={() => ui.onResolveFailure?.('new')}><Text style={{color:dk.accentText}}>用当前配置新建</Text></Pressable> : null}
          </View>
          {retrying ? <Text accessibilityLabel="正在重试" style={[styles.noticeText, { color: dk.muted, fontSize: 11 }]}>正在重试</Text> : null}
        </View>;
      }
      default: return null;
    }
  })();
  const content = block.completedChanges?.length ? <>{row}<ConversationChangesCard files={block.completedChanges} onOpenFile={ui.openDiff}
    onReview={files => ui.openChanges ? ui.openChanges(files) : ui.openDiff(files[0])}
    onUndo={ui.undoChanges} undoUnavailable={ui.undoUnavailable} /></> : row;
  return highlight ? <View style={styles.highlight}>{content}</View> : content;
});

const KIND_ICON: Record<ToolKind, IconName> = { command: 'terminal', file_change: 'edit', read: 'file', image_view: 'image', image_generation: 'image', search: 'search', web: 'globe', mcp: 'link', plan: 'listCheck', subagent: 'code', skill: 'sparkle', other: 'settings' };

function PlanCard({ block }: { block: Extract<Block, { type: 'plan' }>; exactSession?: boolean }) {
  const { openPlan } = useContext(ThreadUi);
  return <PlanSummaryCard block={block} onOpen={openPlan} />;
}

/** Each observed action stays between the prose that preceded/followed it.
 * Disclosure belongs to the individual row, never to the whole execution. */
function ExecutionTimeline({ block, tool, onOpenChild, searchQuery = '' }: { block: Extract<ConversationBlock, { type: 'activity' }>; tool: ToolId; onOpenChild: (key: string) => void; searchQuery?: string }) {
  const styles = useThreadStyles();
  const ui = useContext(ThreadUi);
  const d=useDesk(),{simple}=useConversationReading(),[expanded,setExpanded]=useState(false);
  // Compact mode only folds completed work. Running actions, failures, plans,
  // subagents and output cards remain visible and actionable.
  const completed=block.parts.filter(part=>part.type==='work'&&!part.live&&part.items.every(item=>item.kind==='tool'&&item.status==='done'||item.kind==='reasoning'&&item.final));
  const folded=simple&&!expanded&&!searchQuery&&!block.live;
  const renderPart = (part: Extract<ConversationBlock, { type: 'activity' }>['parts'][number]) => part.type === 'work'
    ? <View key={part.id}>{visibleWorkItems(part.items, part.live, searchQuery).map((item) => <WorkItemRow key={`${item.kind}:${item.id}`} item={item} active={block.live && item.id === block.currentItemId} searchQuery={searchQuery} />)}</View>
    : part.type === 'plan' ? <PlanCard key={part.id} block={part} />
      : <SubagentDetails key={part.id} block={part} tool={tool} onOpenChild={onOpenChild} searchQuery={searchQuery} />;
  const previews = new Map<string, BrowserNavigation>();
  for (const part of block.parts) if (part.type === 'work') for (const item of part.items) {
    if (item.kind !== 'tool' || item.status !== 'done') continue;
    const navigation = parseBrowserNavigation(item.browser);
    if (navigation) previews.set(navigation.pageId ?? navigation.url, navigation);
  }
  const renderFiles = () => <>
    {[...previews].map(([id, navigation]) => <ConversationPreviewCard key={id} navigation={navigation}
      onOpen={value => ui.openBrowser ? ui.openBrowser(value) : ui.openLink?.(value.url, true)} />)}
  </>;
  return <View testID="execution-timeline" style={[styles.work, ui.presentation === 'tablet' && styles.tabletWork]}>
    {simple&&completed.length&&!searchQuery&&!block.live?<Pressable accessibilityRole="button" accessibilityLabel={expanded?'收起已完成过程':'展开已完成过程'} accessibilityState={{expanded}} onPress={()=>setExpanded(value=>!value)} style={{minHeight:36,flexDirection:'row',alignItems:'center',gap:8}}><Icon name={expanded?'chevronDown':'chevronRight'} size={12} color={d.muted}/><Text style={{fontSize:13,lineHeight:20,color:d.muted}}>已完成 {completed.reduce((sum,part)=>sum+(part.type==='work'?part.items.length:0),0)} 项操作</Text></Pressable>:null}
    {block.parts.filter(part=>!folded||!completed.includes(part)).map(renderPart)}
    {renderFiles()}
  </View>;
}

function SubagentDetails({ block, tool, onOpenChild, searchQuery = '' }: { block: Extract<Block, { type: 'subagent' }>; tool: ToolId; onOpenChild: (key: string) => void; searchQuery?: string }) {
  const styles = useThreadStyles();
  const dk = useDesk();
  const ui = useContext(ThreadUi);
  const [open, setOpen] = useState(false);
  const matched = Boolean(searchQuery && searchBlocks([block], searchQuery).length);
  useEffect(() => { if (matched) setOpen(true); }, [matched, searchQuery]);
  const children = block.children;
  const state = subagentStatus(block, tool);
  const subagentLabel = block.item.status === 'running' && /^(?:正在启动|准备启动)/.test((block.item.output ?? '').trim()) ? '开始运行'
    : state === 'running' ? '运行中' : state === 'interrupted' ? '被中断' : state === 'failed' ? '失败' : state === 'done' ? '已完成' : '状态待同步';
  const activeChildId = state === 'running' ? [...children].reverse().find((item) => item.kind === 'tool' && item.status === 'running'
    || item.kind === 'reasoning' && !item.final || item.kind === 'message' && item.role === 'assistant' && !item.final)?.id : undefined;
  const sessions = [...new Set([...(block.item.childSessionKeys ?? []), ...children.flatMap((item) => item.kind === 'tool' ? item.childSessionKeys ?? [] : [])])];
  const name = sessions.length === 1 ? ui.childTitle?.(sessions[0]) || block.item.title : block.item.title;
  const visibleChildReasoning = useMemo(() => {
    const id = visibleReasoningId(children, state === 'running', searchQuery);
    return new Set(id ? [id] : []);
  }, [children, state, searchQuery]);
  return <View testID={`execution-row:${block.item.id}`} style={styles.subagent}>
    <Pressable accessibilityRole="button" accessibilityLabel={`${block.item.title}：子任务详情`} accessibilityState={{ expanded: open }} onPress={() => setOpen((value) => !value)} style={styles.step}>
      {state === 'running' ? <ActivityIndicator accessibilityLabel={`${name}运行中`} size="small" color={dk.muted} style={{ width: 18, transform: [{ scale: 0.72 }] }} /> : <Icon name="bot" size={18} color={state === 'failed' ? dk.bad : dk.muted} />}
      <Text style={[styles.stepText, (state === 'failed' || state === 'interrupted') && { color: dk.bad }]} numberOfLines={1}>{name} · {block.unlinked ? '过程记录' : subagentLabel}</Text>
      <View style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}><Icon name="chevronDown" size={13} color={dk.faint} /></View>
    </Pressable>
    {open ? <View style={styles.executionDetails}>
      {block.item.detail ? <Text style={styles.stepText}>{block.item.detail}</Text> : null}
      {children.map((item) => item.kind === 'reasoning' && !visibleChildReasoning.has(item.id) ? null : item.kind === 'message' ? <View key={`m:${item.id}`}>
        {item.role === 'user' && item.messageOrigin?.kind === 'delegation' ? <MessageOriginBar item={item} tool={tool} nested /> : <Text style={styles.planCount}>{item.role === 'user' ? '任务' : '子智能体回复'}</Text>}
        <RemoteContent text={item.text} streaming={!item.final} exactSession={false} /></View>
        : item.kind === 'tool' && item.tool === 'plan' ? <PlanCard key={`p:${item.id}`} exactSession={false} block={{ type: 'plan', id: item.id, item, steps: planSteps(item.output) }} />
          : item.kind === 'tool' && item.tool === 'file_change' ? <View key={`f:${item.id}`}>{fileEdits(item).map((file) => <FileRow key={file.id} file={file} active={item.id === activeChildId} exactSession={false} searchQuery={searchQuery} />)}</View>
          : item.kind === 'reasoning' || item.kind === 'tool' || item.kind === 'approval' || item.kind === 'notice' || item.kind === 'turn' && (item.status === 'interrupted' || item.status === 'failed') ? <WorkItemRow key={`${item.kind}:${item.id}`} item={item} active={item.id === activeChildId} searchQuery={searchQuery} exactSession={false} /> : null)}
      {block.item.output ? <RemoteContent text={block.item.output} exactSession={false} /> : null}
      {!children.length && !block.item.output ? <Text style={styles.planCount}>还没有内部进度</Text> : null}
      {sessions.map((key, index) => <Pressable key={key} accessibilityRole="button" accessibilityLabel={`打开子智能体对话 ${index + 1}`} onPress={() => onOpenChild(key)} style={{ paddingVertical: 6, flexDirection: 'row', alignItems: 'center', gap: 7 }}>
        <ToolBadge tool={key.split(':', 1)[0]} size={17} />
        <Text style={styles.apiLink}>{ui.childTitle?.(key) ?? `子智能体 ${index + 1}`} ›</Text>
      </Pressable>)}
    </View> : null}
  </View>;
}

function executionErrorSummary(value: string): string {
  const clean = executionErrorDetail(value).replace(/\s+/g, ' ').trim();
  return clean.length > 180 ? `${clean.slice(0, 179).trimEnd()}…` : clean;
}

function WorkItemRow({ item, active = false, searchQuery = '', exactSession = true }: { item: Extract<TimelineItem, { kind: 'reasoning' | 'tool' | 'approval' | 'notice' | 'turn' }>; active?: boolean; searchQuery?: string; exactSession?: boolean }) {
  const styles = useThreadStyles();
  const dk = useDesk();
  const [open, setOpen] = useState(false);
  const matched = searchItemMatches(item, searchQuery);
  useEffect(() => {
    if (!matched) return;
    setOpen(true);
  }, [matched, searchQuery, item.kind, item.kind === 'tool' ? item.tool : undefined]);
  const ui = useContext(ThreadUi);
  const tabletRow = ui.presentation === 'tablet' ? styles.tabletStep : undefined;
  const now = useClock(Boolean(item.kind === 'tool' && item.tool === 'command' && item.status === 'running'));
  if (item.kind === 'turn') return <View style={[styles.step, tabletRow]}><Icon name={item.status === 'failed' ? 'alert' : 'stop'} size={14} color={item.status === 'failed' ? dk.bad : dk.muted} /><Text style={styles.stepText}>{item.status === 'failed' ? '本轮出错' : '本轮已中断'}{item.error ? `：${item.error}` : ''}</Text></View>;
  if (item.kind === 'reasoning') {
    const text = item.text.trim();
    if (!text) return null;
    return <View style={[styles.step, tabletRow, { alignItems: 'flex-start' }]}>
      <Icon name="lightbulb" size={14} color={dk.muted} />
      <Text accessibilityLiveRegion={!item.final ? 'polite' : undefined} style={styles.reasoning} numberOfLines={1} ellipsizeMode="tail">{`${item.final ? '思考摘要' : '正在思考'} · ${text.replace(/\*\*/g, '').replace(/\s+/g, ' ')}`}</Text>
    </View>;
  }
  if (item.kind === 'notice') return <View style={[styles.step, tabletRow]}><Icon name="info" size={14} color={dk.muted} /><Text style={styles.stepText}>{item.text}</Text></View>;
  if (item.kind === 'approval') return <View style={[styles.step, tabletRow]}>
    <Icon name={item.state === 'pending' ? 'hourglass' : item.state === 'resolved' ? 'info' : item.state === 'deny' ? 'close' : 'checkCircle'} size={14} color={item.state === 'pending' || item.state === 'resolved' ? dk.muted : item.state === 'deny' ? dk.bad : dk.ok} />
    <Text style={styles.stepText} numberOfLines={1}>{item.state === 'pending' ? item.approval === 'question' ? '等待回答' : '待批准' : item.state === 'resolved' ? '已处理，详情未同步' : item.by === 'timeout' ? '超时未处理' : item.approval === 'question' ? item.state === 'deny' ? '已取消回答' : '已回答' : item.state === 'deny' ? '已拒绝' : '已允许'}：{item.title}</Text>
  </View>;
  if (item.tool === 'file_change') return <View testID={`execution-row:${item.id}`}>
    <Pressable accessibilityRole="button" accessibilityLabel={`查看文件编辑：${item.title}`} accessibilityState={{ expanded: open }} onPress={() => setOpen(value => !value)} style={[styles.step, tabletRow]}>
      {item.status === 'running' ? <ActivityIndicator size="small" color={dk.muted} style={{ width: 18, transform: [{ scale: 0.72 }] }} /> : <Icon name="edit" size={18} color={item.status === 'failed' ? dk.bad : dk.muted} />}
      <Text style={[styles.stepText, item.status === 'failed' && { color: dk.bad }]} numberOfLines={1}>{executionLabel(item)}</Text>
      <View style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}><Icon name="chevronDown" size={13} color={dk.faint} /></View>
    </Pressable>
    {open ? <View style={styles.executionDetails}>{fileEdits(item).map(file => <FileRow key={file.id} file={file} exactSession={exactSession} searchQuery={searchQuery} />)}
      {item.output ? <OutputText plain text={item.output} onOpenLink={ui.openLink ? target => ui.openLink!(target, exactSession) : undefined} /> : null}
    </View> : null}
  </View>;
  // A read/image tool can have no text output at all.  It is still an
  // expandable Codex-style work item: the attachments are the result.
  const commandDetail = item.tool === 'command';
  const expandable = commandDetail || Boolean(item.attachments?.length || item.output || (item.detail && item.detail !== item.title));
  const durationMs = item.durationMs ?? (item.status === 'running' && item.startedAt !== undefined ? Math.max(0, now - item.startedAt) : undefined);
  const durationLabel = durationMs !== undefined ? formatDuration(durationMs) : undefined;
  const label = executionLabel(item, durationMs);
  return <View testID={`execution-row:${item.id}`}>
    <Pressable accessibilityRole={expandable ? 'button' : undefined} accessibilityLabel={commandDetail ? `查看命令详情：${item.title}` : `查看执行详情：${item.title}`} accessibilityState={expandable ? { expanded: open } : undefined} disabled={!expandable} onPress={() => setOpen((value) => !value)} style={[styles.step, tabletRow]}>
      {item.status === 'running' ? <ActivityIndicator accessibilityLabel={label} size="small" color={dk.muted} style={{ width: 18, transform: [{ scale: 0.72 }] }} /> : <Icon name={KIND_ICON[item.tool] ?? 'settings'} size={18} color={item.status === 'failed' ? dk.bad : dk.muted} />}
      <Text style={[styles.stepText, item.status === 'failed' && { color: dk.bad }]} numberOfLines={1} ellipsizeMode="tail">{label}</Text>
      {item.status === 'running' && durationLabel ? <Text style={styles.executionMeta}>用时 {durationLabel}</Text> : null}
      {expandable ? <View style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}><Icon name="chevronDown" size={13} color={dk.faint} /></View> : null}
    </Pressable>
    {open && commandDetail ? <View style={{marginLeft:27,marginBottom:10,gap:8}}>
      {item.attachments?.length ? <AttachmentStrip refs={item.attachments} align="left" /> : null}
      <CommandOutput scopeKey={JSON.stringify([ui.artifactScope,ui.currentSessionKey,item.id])} command={item.detail} output={item.output} exitCode={item.exitCode} onOpenLink={ui.openLink?target=>ui.openLink!(target,exactSession):undefined}/>
    </View> : open ? <View style={styles.output}>
      {item.attachments?.length ? <AttachmentStrip refs={item.attachments} align="left" /> : null}
      {item.detail && (commandDetail || item.detail !== item.title) ? item.tool === 'read' && ui.openLink && inlineRemoteReference(item.detail)
        ? <Pressable accessibilityRole="link" accessibilityLabel={`打开已读取文件 ${item.detail}`} onPress={() => ui.openLink?.(item.detail!, exactSession)}><Text selectable style={[styles.outputCmd, { color: dk.accentText, textDecorationLine: 'underline' }]}>{item.detail}</Text></Pressable>
        : <Text selectable style={styles.outputCmd}>{item.tool === 'command' ? `$ ${item.detail}` : item.detail}</Text> : null}
      {item.output ? <OutputText plain text={item.output} onOpenLink={ui.openLink ? target => ui.openLink!(target, exactSession) : undefined} /> : null}
      {typeof item.exitCode === 'number' && item.exitCode !== 0 ? <Text style={styles.exit}>退出码 {item.exitCode}</Text> : null}
    </View> : null}
  </View>;
}

function FileRow({ file, active = false, exactSession = true, searchQuery = '' }: { file: FileEdit; active?: boolean; exactSession?: boolean; searchQuery?: string }) {
  const styles = useThreadStyles();
  const dk = useDesk();
  const [open, setOpen] = useState(false);
  const { openDiff, openDiffInToolPanel, openLink } = useContext(ThreadUi);
  const canOpen = Boolean(file.diff || openLink);
  const label = active && file.status === 'running' ? `正在编辑 · ${file.path}` : file.path;
  return <View>
    <Pressable accessibilityRole={file.diff ? 'button' : 'link'} accessibilityLabel={file.diff ? `查看修改文件 ${file.path}` : `打开文件 ${file.path}`}
      disabled={!canOpen} onPress={() => file.diff
        // Codex keeps source/diff inspection in the tool rail.  Keep the
        // inline disclosure as an explicit opt-out for the small nested
        // surfaces that still need it; an omitted flag must never leave a
        // code result stranded in the conversation.
        ? openDiffInToolPanel !== false ? openDiff(file) : setOpen(value => !value)
        : openLink?.(file.path, exactSession)} style={styles.file}>
      <Icon name="file" size={14} color={dk.muted} />
      <Text style={[styles.fileName, canOpen && { color: dk.accentText, textDecorationLine: 'underline' }]} numberOfLines={1} ellipsizeMode="middle">{label}</Text>
      {active && file.status === 'running' ? <><ActivityIndicator size="small" color={dk.accentText} style={{ transform: [{ scale: 0.7 }] }} /><Text style={[styles.planCount, { color: dk.accentText }]}>正在编辑</Text></> : null}
      {file.add ? <Text style={[styles.stat, { color: dk.ok }]}>+{file.add}</Text> : null}
      {file.del ? <Text style={[styles.stat, { color: dk.bad }]}>−{file.del}</Text> : null}
    </Pressable>
    {open && file.diff ? <View style={{ marginTop: 4, marginBottom: 6, gap: 6 }}>
      <DiffView diff={file.diff} maxHeight={220} />
      <Pressable accessibilityRole="button" accessibilityLabel={`全屏查看 ${file.path} 的改动`} hitSlop={6} onPress={() => openDiff(file)} style={styles.fullDiff}>
        <Icon name="maximize" size={13} color={dk.accentText} accent={dk.accentText} /><Text style={styles.retryText}>全屏查看</Text>
      </Pressable>
    </View> : null}
  </View>;
}

const APPROVAL_ICON: Record<ApprovalItem['approval'], IconName> = { command: 'terminal', file_change: 'edit', tool: 'bolt', permission: 'lock', question: 'chat' };

export function ApprovalCard({ approval, more, tool, busy, disabled = false, allowSession = true, onDecide, onDeny }: {
  approval: ApprovalItem; more: number; tool: string; busy: boolean; disabled?: boolean; allowSession?: boolean; onDecide: (decision: Decision) => void; onDeny: () => void;
}) {
  const styles = useThreadStyles();
  const dk = useDesk();
  const ui = useContext(ThreadUi);
  const heading = approval.approval === 'command' ? '要运行这个命令吗？' : approval.approval === 'file_change' ? '要修改文件吗？' : approval.approval === 'permission' ? '需要额外权限' : '要执行这个操作吗？';
  const showDetail = Boolean(approval.detail && approval.detail !== approval.title);
  const detailKey = JSON.stringify([approval.id, approval.title, approval.detail]);
  const [expandedDetail, setExpandedDetail] = useState<string>();
  const detailExpanded = expandedDetail === detailKey;
  const decisions = approvalDecisions(approval);
  return <Appear distance={16} style={[styles.approvalWrap, ui.presentation === 'tablet' && styles.tabletApprovalWrap]}>
    <View style={[styles.approval, ui.presentation === 'tablet' && styles.tabletApproval]}>
      <View style={styles.approvalHead}>
        <DeskOrb size={22} mood="waiting" compact />
        <View style={styles.approvalBadge}><Icon name={APPROVAL_ICON[approval.approval]} size={12} color={dk.warn} /><Text style={styles.approvalKicker} numberOfLines={1}>{toolName(tool)} · {heading}</Text></View>
        <View style={{ flex: 1 }} />
        {more > 0 ? <View style={styles.moreBadge}><Text style={styles.moreText}>还有 {more} 个</Text></View> : null}
      </View>
      {detailExpanded ? <ScrollView testID="approval-full-details" nestedScrollEnabled style={{ maxHeight: 200 }} keyboardShouldPersistTaps="handled">
        <Text selectable style={styles.approvalTitle}>{approval.title}</Text>
        {showDetail ? <Text selectable style={styles.approvalDetail}>{approval.approval === 'command' ? `$ ${approval.detail}` : approval.detail}</Text> : null}
      </ScrollView> : <>
        <Text style={styles.approvalTitle} numberOfLines={2}>{approval.title}</Text>
        {showDetail ? <Text selectable style={styles.approvalDetail} numberOfLines={6}>{approval.approval === 'command' ? `$ ${approval.detail}` : approval.detail}</Text> : null}
      </>}
      {showDetail || approval.title.length > 40 || approval.title.includes('\n') ? <Pressable accessibilityRole="button" accessibilityLabel={detailExpanded ? '收起审批详情' : '查看完整审批详情'} accessibilityState={{ expanded: detailExpanded }}
        onPress={() => setExpandedDetail(detailExpanded ? undefined : detailKey)} style={{ alignSelf: 'flex-start', minHeight: 30, justifyContent: 'center' }}>
        <Text style={[styles.retryText, { color: dk.muted }]}>{detailExpanded ? '收起详情' : '完整详情'}</Text>
      </Pressable> : null}
      {approval.diff ? <DiffView diff={approval.diff} maxHeight={140} /> : null}
      <View style={styles.approvalActions}>
        {decisions.includes('deny') ? <MotionPressable disabled={busy || disabled} wrapperStyle={{ flex: 1 }} scaleTo={0.95} accessibilityRole="button" onPress={onDeny} style={[styles.decision, styles.decisionDeny]}>
          <Text style={[styles.decisionText, { color: dk.bad }]}>{approval.approvalOptions?.denyEffect === 'cancel_turn' ? '取消本轮' : '拒绝'}</Text>
        </MotionPressable> : null}
        {allowSession && decisions.includes('allow_session') ? <MotionPressable disabled={busy || disabled} wrapperStyle={{ flex: 1 }} scaleTo={0.95} accessibilityRole="button" onPress={() => onDecide('allow_session')} style={[styles.decision, styles.decisionSoft]}>
          <Text style={styles.decisionText} numberOfLines={1}>会话内允许</Text>
        </MotionPressable> : null}
        {decisions.includes('allow') ? <MotionPressable disabled={busy || disabled} wrapperStyle={{ flex: 1 }} scaleTo={0.95} accessibilityRole="button" onPress={() => onDecide('allow')} style={[styles.decision, styles.decisionAllow]}>
          {busy ? <ActivityIndicator color={dk.onInk} /> : <Text style={[styles.decisionText, { color: dk.onInk }]}>允许</Text>}
        </MotionPressable> : null}
        {!decisions.length ? <Text style={styles.decisionText}>请在电脑处理</Text> : null}
      </View>
    </View>
  </Appear>;
}

