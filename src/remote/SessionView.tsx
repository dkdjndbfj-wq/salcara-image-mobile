import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Icon, type IconName } from '../components/Icon';
import { MessageContent } from '../components/MessageContent';
import { Appear, AppDialog, IconButton, MotionPressable, Sheet, showToast } from '../components/ui';
import { colors, prettyModel, radius, shadow } from '../theme';
import type { Decision, ToolKind } from './client';
import { clientLabel, DiffView, EmptyState, folderName, mono, PulseDot, StatusPill, ToolBadge, toolName } from './parts';
import {
  EMPTY_TIMELINE, interruptSession, openSession, respondApproval, sendToSession, timelineKey, useRemote, type TimelineItem,
} from './store';

type ApprovalItem = Extract<TimelineItem, { kind: 'approval' }>;

export function SessionView({ deviceId, sessionKey, onClose }: { deviceId: string | null; sessionKey: string | null; onClose: () => void }) {
  const remote = useRemote();
  const key = deviceId && sessionKey ? timelineKey(deviceId, sessionKey) : '';
  const timeline = remote.timelines[key] ?? EMPTY_TIMELINE;
  const device = remote.devices.find((item) => item.deviceId === deviceId);
  const session = timeline.session ?? remote.sessions[deviceId ?? '']?.list.find((item) => item.sessionKey === sessionKey);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [denying, setDenying] = useState<ApprovalItem | null>(null);
  const [reason, setReason] = useState('');
  const [busyApproval, setBusyApproval] = useState<string | null>(null);
  const listRef = useRef<FlatList<TimelineItem>>(null);
  const followRef = useRef(true);
  const draggingRef = useRef(false);

  const refresh = () => {
    if (deviceId && sessionKey) void openSession(deviceId, sessionKey).catch(() => undefined);
  };
  useEffect(() => {
    if (!deviceId || !sessionKey) return;
    followRef.current = true;
    setText('');
    refresh();
  }, [deviceId, sessionKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const items = useMemo(() => timeline.items.filter((item) => !(item.kind === 'approval' && item.state === 'pending') && !(item.kind === 'turn' && item.status === 'started')), [timeline.items]);
  const pending = useMemo(() => timeline.items.filter((item): item is ApprovalItem => item.kind === 'approval' && item.state === 'pending'), [timeline.items]);
  const status = pending.length ? 'waiting_approval' : session?.status ?? 'idle';
  const running = status === 'running' || status === 'waiting_approval';
  const last = items[items.length - 1];
  const working = status === 'running' && !(last?.kind === 'message' && last.role === 'assistant' && !last.final);
  const online = device?.online ?? false;
  const controllable = session?.controllable ?? true;

  const send = async () => {
    const value = text.trim();
    if (!value || !deviceId || !sessionKey) return;
    setSending(true);
    followRef.current = true;
    try { await sendToSession(deviceId, sessionKey, value); setText(''); } catch (error) { showToast((error as Error).message, 'alert'); } finally { setSending(false); }
  };
  const stop = () => {
    if (deviceId && sessionKey) void interruptSession(deviceId, sessionKey).then(() => showToast('已让电脑停下', 'stop')).catch((error) => showToast((error as Error).message, 'alert'));
  };
  const decide = async (approval: ApprovalItem, decision: Decision, message?: string) => {
    if (!deviceId || !sessionKey) return;
    setBusyApproval(approval.id);
    try { await respondApproval({ approvalId: approval.id, deviceId, sessionKey }, decision, message); } catch (error) { showToast((error as Error).message, 'alert'); } finally { setBusyApproval(null); }
  };

  const blocked = !controllable ? '这个会话正在电脑上运行，结束后可以接着聊' : !online ? '电脑不在线，连上后可以接着聊' : null;
  const subtitle = session ? [folderName(session.cwd), clientLabel(session)].filter(Boolean).join(' · ') : undefined;

  return <Sheet visible={Boolean(deviceId && sessionKey)} presentation="page" scroll={false} onClose={onClose}
    title={session?.title || '会话'} subtitle={subtitle} headerRight={session ? <View style={styles.headerBadge}><ToolBadge tool={session.tool} client={session.client} size={30} /></View> : undefined}>
    <View style={styles.strip}>
      <StatusPill status={status} />
      {session?.model ? <Text style={styles.stripText} numberOfLines={1}>{prettyModel(session.model)}</Text> : null}
      <View style={{ flex: 1 }} />
      {!online && device ? <Text style={[styles.stripText, { color: colors.warningText }]}>电脑不在线</Text> : null}
    </View>
    <FlatList
      ref={listRef}
      data={items}
      keyExtractor={(item: TimelineItem) => `${item.kind}:${item.id}`}
      contentContainerStyle={styles.list}
      refreshing={timeline.loading && items.length > 0}
      onRefresh={refresh}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      showsVerticalScrollIndicator={false}
      onScroll={(event: { nativeEvent: { layoutMeasurement: { height: number }; contentOffset: { y: number }; contentSize: { height: number } } }) => {
        const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent;
        if (!draggingRef.current) followRef.current = contentSize.height - layoutMeasurement.height - contentOffset.y < 120;
      }}
      onScrollBeginDrag={() => { draggingRef.current = true; followRef.current = false; }}
      onScrollEndDrag={(event: { nativeEvent: { layoutMeasurement: { height: number }; contentOffset: { y: number }; contentSize: { height: number } } }) => {
        draggingRef.current = false;
        const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent;
        followRef.current = contentSize.height - layoutMeasurement.height - contentOffset.y < 40;
      }}
      scrollEventThrottle={64}
      onContentSizeChange={() => { if (followRef.current) listRef.current?.scrollToEnd({ animated: true }); }}
      ListEmptyComponent={timeline.loading
        ? <View style={styles.loading}><ActivityIndicator color={colors.primary} /><Text style={styles.loadingText}>正在从电脑读取会话…</Text></View>
        : timeline.error ? <EmptyState icon="alert" title="没有读到这个会话" detail={timeline.error} />
          : <EmptyState icon="chat" title="还没有内容" detail="电脑上的进展会实时出现在这里" />}
      ListFooterComponent={working ? <View style={styles.working}><PulseDot /><Text style={styles.workingText}>正在工作…</Text></View> : null}
      renderItem={({ item }: { item: TimelineItem }) => <TimelineRow item={item} />}
    />
    {pending.length > 0 && <ApprovalCard approval={pending[0]} more={pending.length - 1} tool={session?.tool ?? 'codex'} busy={busyApproval === pending[0].id}
      onDecide={(decision) => void decide(pending[0], decision)} onDeny={() => { setReason(''); setDenying(pending[0]); }} />}
    <View style={styles.composer}>
      {blocked ? <View style={styles.blocked}>
        <Icon name={controllable ? 'alert' : 'laptop'} size={16} color={colors.subtle} />
        <Text style={styles.blockedText}>{blocked}</Text>
      </View> : null}
      <View style={styles.inputRow}>
        <TextInput value={text} onChangeText={setText} editable={!blocked} multiline placeholder={blocked ? '暂时不能发送' : running ? '补充说明，完成后接着做' : '接着让它做点什么'}
          placeholderTextColor={colors.subtle} style={[styles.input, blocked && { opacity: 0.5 }]} accessibilityLabel="给电脑发消息" />
        {running && controllable && online && !text.trim()
          ? <IconButton icon="stop" label="停止" variant="soft" size={42} iconSize={18} onPress={stop} />
          : <IconButton icon="arrowUp" label="发送" variant="solid" size={42} iconSize={20} disabled={!text.trim() || Boolean(blocked) || sending} onPress={() => void send()} />}
      </View>
    </View>
    <AppDialog visible={Boolean(denying)} title="拒绝这一步？" message={denying?.title} icon="close" onClose={() => setDenying(null)} actions={[
      { label: '取消', tone: 'secondary', onPress: () => setDenying(null) },
      { label: '拒绝', tone: 'danger', onPress: () => { const target = denying; setDenying(null); if (target) void decide(target, 'deny', reason); } },
    ]}>
      <TextInput value={reason} onChangeText={setReason} placeholder="告诉它为什么（可选）" placeholderTextColor={colors.subtle} style={styles.reason} multiline maxLength={300} />
    </AppDialog>
  </Sheet>;
}

const TimelineRow = memo(function TimelineRow({ item }: { item: TimelineItem }) {
  switch (item.kind) {
    case 'message':
      if (item.role === 'user') return <View style={styles.userRow}><View style={[styles.userBubble, item.local && { opacity: 0.7 }]}><Text selectable style={styles.userText}>{item.text}</Text></View></View>;
      return <View style={styles.assistant}><MessageContent text={item.text} streaming={!item.final} /></View>;
    case 'reasoning': return <ReasoningRow text={item.text} final={item.final} />;
    case 'tool': return <ToolRow item={item} />;
    case 'approval': return <ResolvedApproval item={item} />;
    case 'turn': return <TurnSeparator item={item} />;
    case 'notice': return <View style={[styles.notice, item.level === 'error' && styles.noticeError, item.level === 'warn' && styles.noticeWarn]}>
      <Icon name={item.level === 'info' ? 'info' : 'alert'} size={15} color={item.level === 'error' ? colors.danger : item.level === 'warn' ? colors.warningText : colors.subtle} />
      <Text style={[styles.noticeText, item.level === 'error' && { color: colors.danger }, item.level === 'warn' && { color: colors.warningText }]}>{item.text}</Text>
    </View>;
    default: return null;
  }
});

function ReasoningRow({ text, final }: { text: string; final: boolean }) {
  const [open, setOpen] = useState(false);
  const first = text.trim().split('\n')[0]?.replace(/^\*\*|\*\*$/g, '') ?? '';
  return <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen((value) => !value)} style={styles.reasoning}>
    <View style={styles.reasoningHead}>
      {final ? <Icon name="lightbulb" size={15} color={colors.subtle} /> : <PulseDot color={colors.accent} />}
      <Text style={styles.reasoningLabel}>{final ? '思考过程' : '正在思考'}</Text>
      {!open ? <Text style={styles.reasoningPeek} numberOfLines={1}>{first}</Text> : <View style={{ flex: 1 }} />}
      <View style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}><Icon name="chevronDown" size={14} color={colors.faint} /></View>
    </View>
    {open ? <Text selectable style={styles.reasoningText}>{text.trim()}</Text> : null}
  </Pressable>;
}

const KIND_ICON: Record<ToolKind, IconName> = { command: 'terminal', file_change: 'edit', read: 'file', search: 'search', web: 'globe', mcp: 'link', other: 'settings' };

function ToolRow({ item }: { item: Extract<TimelineItem, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false);
  const expandable = Boolean(item.output || (item.detail && item.detail !== item.title));
  return <View style={styles.tool}>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} disabled={!expandable} onPress={() => setOpen((value) => !value)} style={styles.toolHead}>
      <View style={styles.toolIcon}><Icon name={KIND_ICON[item.tool] ?? 'settings'} size={15} color={colors.textSecondary} /></View>
      <Text style={styles.toolTitle} numberOfLines={open ? 4 : 1}>{item.title}</Text>
      {item.status === 'running' ? <ActivityIndicator size="small" color={colors.primary} />
        : item.status === 'done' ? <Icon name="check" size={16} color={colors.success} strokeWidth={2.2} />
          : <Icon name="close" size={16} color={colors.danger} strokeWidth={2.2} />}
      {expandable ? <View style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}><Icon name="chevronDown" size={14} color={colors.faint} /></View> : null}
    </Pressable>
    {open ? <View style={styles.output}>
      {item.detail && item.detail !== item.title ? <Text selectable style={styles.outputCmd}>{item.tool === 'command' ? `$ ${item.detail}` : item.detail}</Text> : null}
      {item.output ? <Text selectable style={styles.outputText}>{item.output.replace(/\n+$/, '')}</Text> : null}
      {typeof item.exitCode === 'number' ? <Text style={[styles.exit, item.exitCode !== 0 && { color: '#FF8A8A' }]}>退出码 {item.exitCode}</Text> : null}
    </View> : null}
    {item.diff ? <View style={{ marginTop: 6 }}><DiffView diff={item.diff} maxHeight={180} /></View> : null}
  </View>;
}

const DECISION_TEXT: Record<Decision, string> = { allow: '已允许', allow_session: '本会话都允许', deny: '已拒绝' };
const BY_TEXT = { phone: '手机', desktop: '电脑上', timeout: '超时自动' } as const;

function ResolvedApproval({ item }: { item: ApprovalItem }) {
  if (item.state === 'pending') return null;
  const denied = item.state === 'deny';
  return <View style={styles.resolved}>
    <Icon name={denied ? 'close' : 'checkCircle'} size={14} color={denied ? colors.danger : colors.success} />
    <Text style={styles.resolvedText} numberOfLines={1}>{item.by === 'timeout' ? '超时未处理，已拒绝' : `${item.by ? BY_TEXT[item.by] : ''}${DECISION_TEXT[item.state]}`}：{item.title}</Text>
  </View>;
}

function fmtTokens(value?: number) {
  if (!value) return '0';
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 100_000 ? 0 : 1)}k` : String(value);
}

function TurnSeparator({ item }: { item: Extract<TimelineItem, { kind: 'turn' }> }) {
  const usage = item.usage;
  const parts = item.status === 'completed' ? ['本轮完成'] : item.status === 'interrupted' ? ['已停止'] : [`失败${item.error ? `：${item.error}` : ''}`];
  if (usage && (usage.inputTokens || usage.outputTokens)) parts.push(`输入 ${fmtTokens(usage.inputTokens)} · 输出 ${fmtTokens(usage.outputTokens)}`);
  if (usage?.costUsd) parts.push(`$${usage.costUsd < 0.01 ? usage.costUsd.toFixed(4) : usage.costUsd.toFixed(2)}`);
  return <View style={styles.turn}>
    <View style={styles.turnLine} />
    <Text style={[styles.turnText, item.status === 'failed' && { color: colors.danger }]} numberOfLines={2}>{parts.join(' · ')}</Text>
    <View style={styles.turnLine} />
  </View>;
}

const APPROVAL_ICON: Record<ApprovalItem['approval'], IconName> = { command: 'terminal', file_change: 'edit', tool: 'bolt', permission: 'lock' };

function ApprovalCard({ approval, more, tool, busy, onDecide, onDeny }: {
  approval: ApprovalItem; more: number; tool: string; busy: boolean; onDecide: (decision: Decision) => void; onDeny: () => void;
}) {
  const heading = approval.approval === 'command' ? '要运行这个命令吗？' : approval.approval === 'file_change' ? '要修改文件吗？' : approval.approval === 'permission' ? '需要额外权限' : '要执行这个操作吗？';
  const showDetail = Boolean(approval.detail && approval.detail !== approval.title);
  // “运行 npm test” over a block that says “$ npm test” reads twice; ask the question instead.
  const title = showDetail && approval.title.includes(approval.detail ?? '') ? heading : approval.title;
  const kicker = title === heading ? `${toolName(tool)} 请求批准` : `${toolName(tool)} · ${heading}`;
  return <Appear distance={16} style={styles.approvalWrap}>
    <View style={styles.approval}>
      <View style={styles.approvalHead}>
        <View style={styles.approvalIcon}><Icon name={APPROVAL_ICON[approval.approval]} size={16} color={colors.warningText} /></View>
        <View style={{ flex: 1 }}>
          <Text style={styles.approvalKicker}>{kicker}</Text>
          <Text style={styles.approvalTitle} numberOfLines={2}>{title}</Text>
        </View>
        {more > 0 ? <View style={styles.moreBadge}><Text style={styles.moreText}>还有 {more} 个</Text></View> : null}
      </View>
      {showDetail ? <Text selectable style={styles.approvalDetail} numberOfLines={6}>{approval.approval === 'command' ? `$ ${approval.detail}` : approval.detail}</Text> : null}
      {approval.diff ? <DiffView diff={approval.diff} maxHeight={140} /> : null}
      {approval.cwd ? <Text style={styles.approvalCwd} numberOfLines={1}>在 {approval.cwd}</Text> : null}
      <View style={styles.approvalActions}>
        <MotionPressable disabled={busy} scaleTo={0.95} accessibilityRole="button" onPress={onDeny} wrapperStyle={{ flex: 1 }} style={[styles.decision, styles.decisionDeny]}>
          <Text style={[styles.decisionText, { color: colors.danger }]}>拒绝</Text>
        </MotionPressable>
        <MotionPressable disabled={busy} scaleTo={0.95} accessibilityRole="button" onPress={() => onDecide('allow_session')} wrapperStyle={{ flex: 1.3 }} style={[styles.decision, styles.decisionSoft]}>
          <Text style={styles.decisionText} numberOfLines={1}>本会话都允许</Text>
        </MotionPressable>
        <MotionPressable disabled={busy} scaleTo={0.95} accessibilityRole="button" onPress={() => onDecide('allow')} wrapperStyle={{ flex: 1 }} style={[styles.decision, styles.decisionAllow]}>
          {busy ? <ActivityIndicator color={colors.onPrimary} /> : <Text style={[styles.decisionText, { color: colors.onPrimary }]}>允许</Text>}
        </MotionPressable>
      </View>
    </View>
  </Appear>;
}

const styles = StyleSheet.create({
  headerBadge: { width: 40, alignItems: 'center' },
  strip: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingBottom: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  stripText: { color: colors.subtle, fontSize: 12.5 },
  list: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 16, gap: 10 },
  loading: { alignItems: 'center', gap: 10, paddingVertical: 64 },
  loadingText: { color: colors.subtle, fontSize: 13.5 },
  working: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6, paddingLeft: 2 },
  workingText: { color: colors.subtle, fontSize: 13 },
  userRow: { alignItems: 'flex-end', marginTop: 6 },
  userBubble: { maxWidth: '86%', backgroundColor: colors.userBubble, borderRadius: 20, borderBottomRightRadius: 6, paddingHorizontal: 14, paddingVertical: 10 },
  userText: { color: colors.text, fontSize: 15.5, lineHeight: 23 },
  assistant: { paddingRight: 4 },
  reasoning: { borderRadius: 14, backgroundColor: colors.surface, paddingHorizontal: 12, paddingVertical: 9 },
  reasoningHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  reasoningLabel: { color: colors.textMuted, fontSize: 13, fontWeight: '600' },
  reasoningPeek: { flex: 1, color: colors.subtle, fontSize: 13 },
  reasoningText: { color: colors.textMuted, fontSize: 13.5, lineHeight: 21, marginTop: 8 },
  tool: {},
  toolHead: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 38, paddingHorizontal: 10, borderRadius: 12, backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  toolIcon: { width: 24, height: 24, borderRadius: 7, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.card },
  toolTitle: { flex: 1, color: colors.textSecondary, fontSize: 13.5, fontWeight: '500' },
  output: { marginTop: 6, borderRadius: 12, backgroundColor: '#11151F', padding: 12, gap: 6 },
  outputCmd: { fontFamily: mono, fontSize: 12, lineHeight: 18, color: '#9FE7C4' },
  outputText: { fontFamily: mono, fontSize: 11.5, lineHeight: 17, color: '#D5DAE6' },
  exit: { fontFamily: mono, fontSize: 11, color: '#8A93A8' },
  resolved: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 4 },
  resolvedText: { flex: 1, color: colors.subtle, fontSize: 12.5 },
  turn: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 },
  turnLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  turnText: { color: colors.subtle, fontSize: 11.5, maxWidth: '80%', textAlign: 'center' },
  notice: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9, backgroundColor: colors.surface },
  noticeError: { backgroundColor: colors.dangerSurface },
  noticeWarn: { backgroundColor: colors.warningSurface },
  noticeText: { flex: 1, color: colors.textMuted, fontSize: 13, lineHeight: 19 },
  approvalWrap: { paddingHorizontal: 12, paddingBottom: 8 },
  approval: { borderRadius: radius.lg, backgroundColor: colors.card, padding: 14, gap: 10, borderWidth: 1, borderColor: '#F3D9A8', ...shadow.float },
  approvalHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  approvalIcon: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.warningSurface },
  approvalKicker: { color: colors.warningText, fontSize: 12, fontWeight: '600' },
  approvalTitle: { color: colors.text, fontSize: 15, fontWeight: '600', marginTop: 1 },
  moreBadge: { paddingHorizontal: 8, height: 22, borderRadius: 11, justifyContent: 'center', backgroundColor: colors.surfaceStrong },
  moreText: { color: colors.textMuted, fontSize: 11.5, fontWeight: '600' },
  approvalDetail: { fontFamily: mono, fontSize: 12, lineHeight: 18, color: '#D5DAE6', backgroundColor: '#11151F', borderRadius: 10, padding: 10 },
  approvalCwd: { color: colors.subtle, fontSize: 12 },
  approvalActions: { flexDirection: 'row', gap: 8 },
  decision: { height: 44, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  decisionDeny: { backgroundColor: colors.dangerSurface },
  decisionSoft: { backgroundColor: colors.surfaceStrong },
  decisionAllow: { backgroundColor: colors.primary, ...shadow.glow },
  decisionText: { color: colors.text, fontSize: 14.5, fontWeight: '600' },
  composer: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 4, borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border, gap: 8, backgroundColor: colors.card },
  blocked: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 12, backgroundColor: colors.surface },
  blockedText: { flex: 1, color: colors.textMuted, fontSize: 13, lineHeight: 18 },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  input: { flex: 1, minHeight: 44, maxHeight: 130, borderRadius: 22, backgroundColor: colors.surfaceStrong, paddingHorizontal: 16, paddingTop: 11, paddingBottom: 11, color: colors.text, fontSize: 15.5 },
  reason: { minHeight: 72, borderRadius: 14, backgroundColor: colors.surfaceStrong, paddingHorizontal: 14, paddingVertical: 10, color: colors.text, fontSize: 15, marginTop: 8, textAlignVertical: 'top' },
});
