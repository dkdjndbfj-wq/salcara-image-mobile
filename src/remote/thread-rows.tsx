/* Rows and cards of a remote thread: messages, the agent's work, plans, files and approvals. Split from ThreadView.tsx. */
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
import { useThreadStyles } from './thread-styles';

export type ApprovalItem = Extract<TimelineItem, { kind: 'approval' }>;

/** Actions and live status shared with deeply nested rows (files, images, the live summary). */
export const ThreadUi = createContext<{ openDiff: (file: FileEdit) => void; openImage: (uri: string) => void; runClock?: string }>({ openDiff: () => undefined, openImage: () => undefined });

export function ComposerChip({ icon, label, onPress, danger }: { icon: IconName; label: string; onPress: () => void; danger?: boolean }) {
  const styles = useThreadStyles();
  const dk = useDesk();
  return <MotionPressable accessibilityRole="button" accessibilityLabel={label} scaleTo={0.94} onPress={onPress} style={[styles.chip, danger && { backgroundColor: dk.badSoft }]}>
    <Icon name={icon} size={14} color={danger ? dk.bad : dk.muted} />
    <Text style={[styles.chipText, danger && { color: dk.bad }]} numberOfLines={1}>{label}</Text>
  </MotionPressable>;
}

export function NewThreadIntro({ agent, cwd, onPickProject }: { agent: AgentProfile | null; cwd: string; onPickProject: () => void }) {
  const styles = useThreadStyles();
  const dk = useDesk();
  return <View style={styles.intro}>
    <Appear><View style={styles.introIcon}><Icon name="code" size={22} color={dk.text2} /></View></Appear>
    <Text style={styles.introTitle}>要构建什么？</Text>
    <Text style={styles.introDetail}>{agent?.name ?? 'Codex'} 会在电脑上的项目里工作，进度实时同步到这里。</Text>
    <Pressable accessibilityRole="button" onPress={onPickProject} style={styles.introProject}>
      <Icon name="archive" size={15} color={dk.text2} />
      <Text style={styles.introProjectText} numberOfLines={1}>{cwd ? projectName(cwd) : '选择项目文件夹'}</Text>
      <Icon name="chevronDown" size={13} color={dk.faint} />
    </Pressable>
    {cwd ? <Text style={styles.introPath} numberOfLines={1}>{cwd}</Text> : null}
  </View>;
}

export const BlockRow = memo(function BlockRow({ block, tool, onOpenChild, stat, highlight, onQuote, onRetry }: {
  block: ConversationBlock; tool: ToolId; onOpenChild: (key: string) => void;
  stat?: TurnStat; highlight?: boolean; onQuote?: (text: string) => void; onRetry?: () => void;
}) {
  const styles = useThreadStyles();
  const dk = useDesk();
  const ui = useContext(ThreadUi);
  const row = (() => {
    switch (block.type) {
      case 'user': return <View style={styles.userRow}>
        {block.item.images?.length ? <View style={styles.userImages}>{block.item.images.map((uri) => <Pressable key={uri} accessibilityRole="imagebutton" accessibilityLabel="查看图片" onPress={() => ui.openImage(uri)}>
          <Image source={{ uri }} style={styles.userImage} /></Pressable>)}</View> : null}
        <Pressable accessibilityRole="text" accessibilityHint="长按复制" delayLongPress={350} onLongPress={() => copyUserMessage(block.item.text)} style={[styles.userBubble, block.item.local && { opacity: 0.72 }]}>
          <Text style={styles.userText}>{block.item.text}</Text>
        </Pressable>
      </View>;
      case 'assistant': return <View style={styles.assistant}>
        <MessageContent text={block.item.text} streaming={!block.item.final} />
        {block.item.final && block.item.text.trim() ? <MessageActions text={block.item.text} stat={stat} onQuote={onQuote} /> : null}
      </View>;
      case 'activity': return <ActivitySummary block={block} tool={tool} onOpenChild={onOpenChild} />;
      case 'turn': return <View style={[styles.notice, block.item.status === 'failed' && styles.noticeError]}>
        <Icon name={block.item.status === 'failed' ? 'alert' : 'stop'} size={14} color={block.item.status === 'failed' ? dk.bad : dk.muted} />
        <Text style={[styles.noticeText, block.item.status === 'failed' && { color: dk.bad }]}>{block.item.status === 'failed' ? `出错了${block.item.error ? `：${block.item.error}` : ''}` : '已停止'}</Text>
        {onRetry ? <Pressable accessibilityRole="button" accessibilityLabel="重试上一条消息" hitSlop={8} onPress={onRetry} style={styles.retry}>
          <Icon name="regenerate" size={13} color={dk.accentText} /><Text style={styles.retryText}>重试</Text>
        </Pressable> : null}
      </View>;
      case 'notice': return <View style={[styles.notice, styles.noticeError]}><Icon name="alert" size={14} color={dk.bad} /><Text style={[styles.noticeText, { color: dk.bad }]}>{block.item.text}</Text></View>;
      default: return null;
    }
  })();
  return highlight ? <View style={styles.highlight}>{row}</View> : row;
});

const KIND_ICON: Record<ToolKind, IconName> = { command: 'terminal', file_change: 'edit', read: 'file', search: 'search', web: 'globe', mcp: 'link', plan: 'listCheck', subagent: 'code', other: 'settings' };

/** Codex's to-do list, shown like the app: a small card with checked / current / open steps. */
function PlanCard({ block }: { block: Extract<Block, { type: 'plan' }> }) {
  const styles = useThreadStyles();
  const dk = useDesk();
  const done = block.steps.filter((step) => step.status === 'done').length;
  return <View style={styles.plan}>
    <View style={styles.planHead}>
      <Icon name="listCheck" size={15} color={dk.accent} />
      <Text style={styles.planTitle}>计划</Text>
      {block.steps.length ? <Text style={styles.planCount}>{done}/{block.steps.length}</Text> : null}
    </View>
    {block.steps.length ? block.steps.map((step, index) => <View key={`${index}:${step.text}`} style={styles.planRow}>
      <View style={[styles.planDot, step.status === 'done' && styles.planDotDone, step.status === 'active' && styles.planDotActive]}>
        {step.status === 'done' ? <Icon name="check" size={10} color={dk.onInk} strokeWidth={3} /> : null}
      </View>
      <Text style={[styles.planText, step.status === 'done' && styles.planTextDone, step.status === 'active' && styles.planTextActive]}>{step.text}</Text>
    </View>) : <MessageContent text={block.item.output ?? ''} />}
  </View>;
}

function ActivitySummary({ block, tool, onOpenChild }: { block: Extract<ConversationBlock, { type: 'activity' }>; tool: ToolId; onOpenChild: (key: string) => void }) {
  const styles = useThreadStyles();
  const dk = useDesk();
  const [open, setOpen] = useState(false);
  const { runClock } = useContext(ThreadUi);
  return <View style={styles.work}>
    <Pressable accessibilityRole="button" accessibilityLabel={open ? '收起处理摘要' : '展开处理摘要'} accessibilityState={{ expanded: open }} onPress={() => setOpen((value) => !value)} style={styles.workHead} hitSlop={6}>
      {block.live ? <ActivityIndicator size="small" color={dk.muted} style={{ transform: [{ scale: 0.8 }] }} /> : <Icon name="listCheck" size={15} color={dk.muted} />}
      <Text style={[styles.workTitle, block.live && { color: dk.text2 }]} numberOfLines={1}>{block.current && block.live ? `${block.subagentCount ? `${block.subagentCount} 个子智能体 · ` : ''}${block.current}` : block.summary}</Text>
      {block.live && runClock ? <Text style={styles.workClock}>{runClock}</Text> : null}
      <View style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}><Icon name="chevronDown" size={14} color={dk.faint} /></View>
    </Pressable>
    {open ? <View style={styles.workBody}>{block.parts.map((part) => part.type === 'work'
      ? <View key={part.id}>{part.items.map((item) => <WorkItemRow key={`${item.kind}:${item.id}`} item={item} />)}</View>
      : part.type === 'plan' ? <PlanCard key={part.id} block={part} />
        : <SubagentDetails key={part.id} block={part} tool={tool} onOpenChild={onOpenChild} />)}</View> : null}
    {block.files.length ? <View style={styles.files}>{block.files.map((file) => <FileRow key={file.id} file={file} />)}</View> : null}
  </View>;
}

function SubagentDetails({ block, tool, onOpenChild }: { block: Extract<Block, { type: 'subagent' }>; tool: ToolId; onOpenChild: (key: string) => void }) {
  const styles = useThreadStyles();
  const dk = useDesk();
  const [open, setOpen] = useState(false);
  const children = block.children;
  const state = subagentStatus(block, tool);
  const sessions = [...new Set([...(block.item.childSessionKeys ?? []), ...children.flatMap((item) => item.kind === 'tool' ? item.childSessionKeys ?? [] : [])])];
  return <View style={styles.subagent}>
    <Pressable accessibilityRole="button" accessibilityLabel={`${block.item.title}：子任务详情`} accessibilityState={{ expanded: open }} onPress={() => setOpen((value) => !value)} style={styles.planHead}>
      <Icon name="code" size={14} color={dk.muted} /><Text style={styles.subagentTitle} numberOfLines={2}>{block.item.title}</Text>
      <Text style={[styles.planCount, state === 'failed' && { color: dk.bad }]}>{block.unlinked ? '过程记录' : state === 'running' ? '进行中' : state === 'failed' ? '失败' : state === 'done' ? '完成' : '待更新'}</Text><View style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}><Icon name="chevronDown" size={14} color={dk.muted} /></View>
    </Pressable>
    {open ? <View style={{ gap: 8 }}>
      {block.item.detail ? <Text style={styles.stepText}>{block.item.detail}</Text> : null}
      {children.map((item) => item.kind === 'message' ? <View key={`m:${item.id}`}><Text style={styles.planCount}>{item.role === 'user' ? '任务' : '子智能体回复'}</Text><MessageContent text={item.text} streaming={!item.final} /></View>
        : item.kind === 'tool' && item.tool === 'plan' ? <PlanCard key={`p:${item.id}`} block={{ type: 'plan', id: item.id, item, steps: planSteps(item.output) }} />
          : item.kind === 'tool' && item.tool === 'file_change' ? <View key={`f:${item.id}`}>{fileEdits(item).map((file) => <FileRow key={file.id} file={file} />)}</View>
          : item.kind === 'reasoning' || item.kind === 'tool' || item.kind === 'approval' || item.kind === 'notice' ? <WorkItemRow key={`${item.kind}:${item.id}`} item={item} /> : null)}
      {block.item.output ? <MessageContent text={block.item.output} /> : null}
      {!children.length && !block.item.output ? <Text style={styles.planCount}>还没有内部进度</Text> : null}
      {sessions.map((key, index) => <Pressable key={key} accessibilityRole="button" accessibilityLabel={`打开子智能体对话 ${index + 1}`} onPress={() => onOpenChild(key)} style={{ paddingVertical: 6 }}><Text style={styles.apiLink}>打开子智能体对话 {sessions.length > 1 ? index + 1 : ''} ›</Text></Pressable>)}
    </View> : null}
  </View>;
}

function WorkItemRow({ item }: { item: Extract<TimelineItem, { kind: 'reasoning' | 'tool' | 'approval' | 'notice' }> }) {
  const styles = useThreadStyles();
  const dk = useDesk();
  const [open, setOpen] = useState(false);
  if (item.kind === 'reasoning') {
    const text = item.text.trim();
    if (!text) return null;
    return <Pressable accessibilityRole="button" onPress={() => setOpen((value) => !value)} style={styles.step}>
      <Icon name="lightbulb" size={14} color={dk.muted} />
      <Text style={styles.reasoning} numberOfLines={open ? undefined : 2}>{text.replace(/\*\*/g, '')}</Text>
    </Pressable>;
  }
  if (item.kind === 'notice') return <View style={styles.step}><Icon name="info" size={14} color={dk.muted} /><Text style={styles.stepText}>{item.text}</Text></View>;
  if (item.kind === 'approval') return <View style={styles.step}>
    <Icon name={item.state === 'pending' ? 'hourglass' : item.state === 'deny' ? 'close' : 'checkCircle'} size={14} color={item.state === 'pending' ? dk.muted : item.state === 'deny' ? dk.bad : dk.ok} />
    <Text style={styles.stepText} numberOfLines={1}>{item.state === 'pending' ? item.approval === 'question' ? '等待回答' : '待批准' : item.by === 'timeout' ? '超时未处理' : item.approval === 'question' ? item.state === 'deny' ? '已取消回答' : '已回答' : item.state === 'deny' ? '已拒绝' : '已允许'}：{item.title}</Text>
  </View>;
  if (item.tool === 'file_change') return null; // shown as file rows
  const expandable = Boolean(item.output || (item.detail && item.detail !== item.title));
  return <View>
    <Pressable accessibilityRole="button" disabled={!expandable} onPress={() => setOpen((value) => !value)} style={styles.step}>
      <Icon name={KIND_ICON[item.tool] ?? 'settings'} size={14} color={dk.muted} />
      <Text style={styles.stepText} numberOfLines={open ? 4 : 1}>{item.title}</Text>
      {item.tool === 'subagent' ? <Text style={[styles.planCount, item.status === 'failed' && { color: dk.bad }]}>{item.status === 'running' ? '进行中' : item.status === 'failed' ? '失败' : '完成'}</Text>
        : item.status === 'running' ? <ActivityIndicator size="small" color={dk.muted} style={{ transform: [{ scale: 0.7 }] }} />
        : item.status === 'failed' ? <Icon name="close" size={13} color={dk.bad} strokeWidth={2.2} /> : null}
    </Pressable>
    {open ? <View style={styles.output}>
      {item.detail && item.detail !== item.title ? <Text selectable style={styles.outputCmd}>{item.tool === 'command' ? `$ ${item.detail}` : item.detail}</Text> : null}
      {item.output ? <OutputText text={item.output} /> : null}
      {typeof item.exitCode === 'number' && item.exitCode !== 0 ? <Text style={styles.exit}>退出码 {item.exitCode}</Text> : null}
    </View> : null}
  </View>;
}

function FileRow({ file }: { file: FileEdit }) {
  const styles = useThreadStyles();
  const dk = useDesk();
  const [open, setOpen] = useState(false);
  const { openDiff } = useContext(ThreadUi);
  const name = file.path.split(/[\\/]/).pop() || file.path;
  return <View>
    <Pressable accessibilityRole="button" disabled={!file.diff} onPress={() => setOpen((value) => !value)} style={styles.file}>
      <Icon name="file" size={14} color={dk.muted} />
      <Text style={styles.fileName} numberOfLines={1}>{name}</Text>
      {file.status === 'running' ? <ActivityIndicator size="small" color={dk.muted} style={{ transform: [{ scale: 0.7 }] }} /> : null}
      {file.add ? <Text style={[styles.stat, { color: dk.ok }]}>+{file.add}</Text> : null}
      {file.del ? <Text style={[styles.stat, { color: dk.bad }]}>−{file.del}</Text> : null}
    </Pressable>
    {open && file.diff ? <View style={{ marginTop: 4, marginBottom: 6, gap: 6 }}>
      <DiffView diff={file.diff} maxHeight={220} />
      <Pressable accessibilityRole="button" accessibilityLabel={`全屏查看 ${name} 的改动`} hitSlop={6} onPress={() => openDiff(file)} style={styles.fullDiff}>
        <Icon name="eye" size={13} color={dk.accentText} /><Text style={styles.retryText}>全屏查看</Text>
      </Pressable>
    </View> : null}
  </View>;
}

const APPROVAL_ICON: Record<ApprovalItem['approval'], IconName> = { command: 'terminal', file_change: 'edit', tool: 'bolt', permission: 'lock', question: 'chat' };

export function ApprovalCard({ approval, more, tool, busy, allowSession = true, onDecide, onDeny }: {
  approval: ApprovalItem; more: number; tool: string; busy: boolean; allowSession?: boolean; onDecide: (decision: Decision) => void; onDeny: () => void;
}) {
  const styles = useThreadStyles();
  const dk = useDesk();
  const heading = approval.approval === 'command' ? '要运行这个命令吗？' : approval.approval === 'file_change' ? '要修改文件吗？' : approval.approval === 'permission' ? '需要额外权限' : '要执行这个操作吗？';
  const showDetail = Boolean(approval.detail && approval.detail !== approval.title);
  return <Appear distance={16} style={styles.approvalWrap}>
    <View style={styles.approval}>
      <View style={styles.approvalHead}>
        <View style={styles.approvalBadge}><Icon name={APPROVAL_ICON[approval.approval]} size={12} color={dk.warn} /><Text style={styles.approvalKicker} numberOfLines={1}>{toolName(tool)} · {heading}</Text></View>
        <View style={{ flex: 1 }} />
        {more > 0 ? <View style={styles.moreBadge}><Text style={styles.moreText}>还有 {more} 个</Text></View> : null}
      </View>
      <Text style={styles.approvalTitle} numberOfLines={2}>{approval.title}</Text>
      {showDetail ? <Text selectable style={styles.approvalDetail} numberOfLines={6}>{approval.approval === 'command' ? `$ ${approval.detail}` : approval.detail}</Text> : null}
      {approval.diff ? <DiffView diff={approval.diff} maxHeight={140} /> : null}
      <View style={styles.approvalActions}>
        <MotionPressable disabled={busy} scaleTo={0.95} accessibilityRole="button" onPress={onDeny} style={[styles.decision, styles.decisionDeny]}>
          <Text style={[styles.decisionText, { color: dk.bad }]}>拒绝</Text>
        </MotionPressable>
        <View style={{ flex: 1 }} />
        {allowSession ? <MotionPressable disabled={busy} scaleTo={0.95} accessibilityRole="button" onPress={() => onDecide('allow_session')} style={[styles.decision, styles.decisionSoft]}>
          <Text style={styles.decisionText} numberOfLines={1}>本对话都允许</Text>
        </MotionPressable> : null}
        <MotionPressable disabled={busy} scaleTo={0.95} accessibilityRole="button" onPress={() => onDecide('allow')} style={[styles.decision, styles.decisionAllow]}>
          {busy ? <ActivityIndicator color={dk.onInk} /> : <Text style={[styles.decisionText, { color: dk.onInk }]}>允许</Text>}
        </MotionPressable>
      </View>
    </View>
  </Appear>;
}

