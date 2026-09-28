import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Easing, Image, LayoutAnimation, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { ACTION_ICONS, ACTION_VERBS } from '../agent/actions';
import { extensionOf } from '../agent/files';
import type { AgentStep, AgentTrace, GeneratedFile, PhoneAction, PlanItem, Source, StepKind } from '../agent/types';
import { hostOf } from '../agent/web';
import { colors, radius } from '../theme';
import { Icon, type IconName } from './Icon';
import { Appear, MotionPressable, useReducedMotion } from './MotionPressable';

const KIND_ICONS: Record<StepKind, IconName> = {
  search: 'search', read: 'globe', image: 'palette', memory: 'bookmark', recall: 'bookmark', action: 'bolt', file: 'file',
  plan: 'listCheck', check: 'eye', history: 'history', tool: 'sparkles',
};

/** “已搜索 3 次 · 阅读 2 个网页 · 画了 1 张图” */
export function summarizeSteps(steps: AgentStep[]): string {
  const count = (kind: StepKind) => steps.filter((step) => step.kind === kind && step.status !== 'error').length;
  const parts = [
    count('search') && `搜索 ${count('search')} 次`,
    count('read') && `阅读 ${count('read')} 个网页`,
    count('history') && '查看了历史对话',
    count('image') && `画了 ${count('image')} 张图`,
    count('check') && '检查了画面',
    count('file') && `生成 ${count('file')} 个文件`,
    count('action') && `准备 ${count('action')} 个操作`,
    count('memory') && '更新了记忆',
  ].filter(Boolean) as string[];
  const failed = steps.filter((step) => step.status === 'error').length;
  if (failed) parts.push(`${failed} 步未完成`);
  return parts.join(' · ') || `${steps.length} 个步骤`;
}

/** The steps the assistant took, live while it works and collapsible afterwards. */
export function AgentActivity({ trace, pending }: { trace: AgentTrace; pending: boolean }) {
  const [open, setOpen] = useState(false);
  const steps = trace.steps;
  if (!steps.length) return null;
  const running = steps.find((step) => step.status === 'running');
  const expanded = open || (pending && Boolean(running));
  const toggle = () => {
    LayoutAnimation.configureNext(LayoutAnimation.create(200, 'easeInEaseOut', 'opacity'));
    setOpen((value) => !value);
  };
  const visible = expanded ? (pending && !open ? steps.slice(-4) : steps) : [];
  return <View style={styles.activity}>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded }} accessibilityLabel={expanded ? '收起步骤' : '展开步骤'} onPress={toggle} hitSlop={6} style={styles.activityHead}>
      {running ? <Pulse /> : <Icon name={trace.research ? 'telescope' : 'sparkles'} size={15} color={colors.primary} strokeWidth={1.9} />}
      <Text style={styles.activityTitle} numberOfLines={1}>
        {running ? running.title : `${trace.research ? '深度研究 · ' : ''}${summarizeSteps(steps)}`}
      </Text>
      <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={15} color={colors.subtle} strokeWidth={2} />
    </Pressable>
    {visible.length > 0 && <View style={styles.timeline}>
      {visible.map((step, index) => <StepRow key={step.id} step={step} last={index === visible.length - 1} />)}
    </View>}
  </View>;
}

function StepRow({ step, last }: { step: AgentStep; last: boolean }) {
  return <Appear distance={4} duration={220}>
    <View style={styles.stepRow}>
      <View style={styles.rail}>
        <View style={[styles.stepIcon, step.status === 'error' && { backgroundColor: colors.dangerSurface }]}>
          {step.status === 'running'
            ? <ActivityIndicator size="small" color={colors.primary} style={{ transform: [{ scale: 0.6 }] }} />
            : <Icon name={step.status === 'error' ? 'alert' : KIND_ICONS[step.kind] ?? 'sparkles'} size={13} color={step.status === 'error' ? colors.danger : colors.textMuted} strokeWidth={1.9} />}
        </View>
        {!last && <View style={styles.railLine} />}
      </View>
      <View style={styles.stepBody}>
        {step.note ? <Text style={styles.stepNote} numberOfLines={3}>{step.note}</Text> : null}
        <Text style={styles.stepTitle} numberOfLines={2}>{step.title}</Text>
        {step.status === 'error' ? <Text style={styles.stepError} numberOfLines={3}>{step.error || '没有完成'}</Text>
          : step.detail ? <Text style={styles.stepDetail} numberOfLines={1}>{step.detail}</Text> : null}
        {step.sources?.length ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.stepSources} style={{ flexGrow: 0 }}>
          {step.sources.slice(0, 6).map((source) => <SourcePill key={source.url} source={source} />)}
        </ScrollView> : null}
      </View>
    </View>
  </Appear>;
}

function Pulse() {
  const reduced = useReducedMotion();
  const value = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduced) return undefined;
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(value, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      Animated.timing(value, { toValue: 0, duration: 700, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [reduced, value]);
  return <Animated.View style={[styles.pulse, { opacity: value.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] }), transform: [{ scale: value.interpolate({ inputRange: [0, 1], outputRange: [0.8, 1.1] }) }] }]} />;
}

function openUrl(url: string) { void Linking.openURL(url).catch(() => undefined); }

function SourcePill({ source, index }: { source: Source; index?: number }) {
  return <Pressable accessibilityRole="link" accessibilityLabel={`打开来源：${source.title}`} onPress={() => openUrl(source.url)}
    style={({ pressed }) => [styles.pill, pressed && { backgroundColor: colors.surfaceStrong }]}>
    {index !== undefined ? <Text style={styles.pillIndex}>{index}</Text> : <Icon name="globe" size={11} color={colors.subtle} strokeWidth={2} />}
    <Text style={styles.pillText} numberOfLines={1}>{hostOf(source.url)}</Text>
  </Pressable>;
}

/** Numbered sources under the answer; tap to expand titles. */
export function SourcesRow({ sources }: { sources: Source[] }) {
  const [open, setOpen] = useState(false);
  if (!sources.length) return null;
  return <View style={styles.sources}>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => { LayoutAnimation.configureNext(LayoutAnimation.create(180, 'easeInEaseOut', 'opacity')); setOpen((value) => !value); }} style={styles.sourcesHead} hitSlop={6}>
      <Icon name="link" size={14} color={colors.textMuted} strokeWidth={1.9} />
      <Text style={styles.sourcesTitle}>{sources.length} 个来源</Text>
      <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} color={colors.subtle} strokeWidth={2} />
    </Pressable>
    {open
      ? <View style={styles.sourceList}>{sources.map((source, index) => <Pressable key={source.url} accessibilityRole="link" onPress={() => openUrl(source.url)}
        style={({ pressed }) => [styles.sourceItem, pressed && { backgroundColor: colors.surfaceStrong }]}>
        <Text style={styles.sourceNumber}>{index + 1}</Text>
        <View style={{ flex: 1 }}>
          <Text style={styles.sourceTitle} numberOfLines={2}>{source.title}</Text>
          <Text style={styles.sourceHost} numberOfLines={1}>{hostOf(source.url)}</Text>
        </View>
        <Icon name="external" size={14} color={colors.faint} />
      </Pressable>)}</View>
      : <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.stepSources} style={{ flexGrow: 0 }}>
        {sources.slice(0, 10).map((source, index) => <SourcePill key={source.url} source={source} index={index + 1} />)}
      </ScrollView>}
  </View>;
}

export function PlanCard({ plan, pending }: { plan: PlanItem[]; pending: boolean }) {
  if (!plan.length) return null;
  const done = plan.filter((item) => item.done).length;
  return <View style={styles.plan}>
    <View style={styles.planHead}>
      <Icon name="listCheck" size={15} color={colors.primary} strokeWidth={1.9} />
      <Text style={styles.planTitle}>研究计划</Text>
      <Text style={styles.planCount}>{done}/{plan.length}</Text>
    </View>
    {plan.map((item, index) => {
      const current = pending && !item.done && plan.slice(0, index).every((before) => before.done);
      return <View key={`${index}-${item.title}`} style={styles.planRow}>
        <View style={[styles.planCheck, item.done && styles.planCheckDone, current && styles.planCheckCurrent]}>
          {item.done ? <Icon name="check" size={11} color="#fff" strokeWidth={2.4} /> : null}
        </View>
        <Text style={[styles.planText, item.done && styles.planTextDone]}>{item.title}</Text>
      </View>;
    })}
  </View>;
}

export function FileCards({ files, onOpen }: { files: GeneratedFile[]; onOpen: (file: GeneratedFile) => void }) {
  if (!files.length) return null;
  return <View style={styles.cards}>
    {files.map((file) => {
      const extension = extensionOf(file.name).toUpperCase() || 'TXT';
      const tint = extension === 'CSV' || extension === 'TSV' ? '#12A150' : extension === 'HTML' || extension === 'HTM' ? '#F08A3C' : extension === 'JSON' ? '#6F7691' : colors.primary;
      return <MotionPressable key={file.id} scaleTo={0.98} accessibilityRole="button" accessibilityLabel={`打开文件 ${file.name}`} onPress={() => onOpen(file)} style={styles.fileCard}>
        <View style={[styles.fileBadge, { backgroundColor: tint }]}><Text style={styles.fileBadgeText}>{extension.slice(0, 4)}</Text></View>
        <View style={{ flex: 1 }}>
          <Text style={styles.fileName} numberOfLines={1}>{file.name}</Text>
          <Text style={styles.fileMeta}>{formatBytes(file.size)} · 点开预览或分享</Text>
        </View>
        <Icon name="chevronRight" size={17} color={colors.faint} />
      </MotionPressable>;
    })}
  </View>;
}

export function ActionCards({ actions, disabled, onRun, onDismiss }: {
  actions: PhoneAction[]; disabled: boolean; onRun: (action: PhoneAction) => void; onDismiss: (action: PhoneAction) => void;
}) {
  if (!actions.length) return null;
  return <View style={styles.cards}>
    {actions.map((action) => {
      const finished = action.status === 'done' || action.status === 'dismissed';
      return <View key={action.id} style={[styles.actionCard, finished && { opacity: 0.72 }]}>
        <View style={styles.actionTop}>
          <View style={styles.actionIcon}><Icon name={ACTION_ICONS[action.kind] ?? 'bolt'} size={18} color={colors.primaryDeep} strokeWidth={1.9} /></View>
          <View style={{ flex: 1 }}>
            <Text style={styles.actionVerb}>{ACTION_VERBS[action.kind] ?? '操作'}</Text>
            <Text style={styles.actionSummary} numberOfLines={3}>{action.summary}</Text>
          </View>
        </View>
        {action.status === 'failed' && action.error ? <Text style={styles.actionError}>{action.error}</Text> : null}
        {action.status === 'done' ? <View style={styles.actionState}><Icon name="checkCircle" size={15} color={colors.success} /><Text style={styles.actionStateText}>已交给系统应用</Text></View>
          : action.status === 'dismissed' ? <View style={styles.actionState}><Text style={styles.actionStateText}>已取消</Text></View>
            : <View style={styles.actionButtons}>
              <Pressable accessibilityRole="button" disabled={disabled} onPress={() => onDismiss(action)} style={({ pressed }) => [styles.actionButton, pressed && { opacity: 0.7 }, disabled && { opacity: 0.4 }]}>
                <Text style={styles.actionButtonText}>取消</Text>
              </Pressable>
              <Pressable accessibilityRole="button" disabled={disabled} onPress={() => onRun(action)} style={({ pressed }) => [styles.actionButton, styles.actionPrimary, pressed && { opacity: 0.85 }, disabled && { opacity: 0.4 }]}>
                <Text style={[styles.actionButtonText, { color: colors.onPrimary }]}>{action.status === 'failed' ? '重试' : '确认'}</Text>
              </Pressable>
            </View>}
      </View>;
    })}
    <Text style={styles.actionHint}>确认后会打开系统应用：闹钟和倒计时会直接设好，短信、邮件、日程和电话仍需你在那里发送或保存。</Text>
  </View>;
}

/** Follow-up questions the model suggested, one tap to ask. */
export function SuggestionList({ items, onPick }: { items: string[]; onPick: (text: string) => void }) {
  if (!items.length) return null;
  return <View style={styles.suggestions}>
    {items.map((item, index) => <Appear key={`${index}-${item}`} delay={260 + index * 70} distance={6}>
      <MotionPressable scaleTo={0.98} accessibilityRole="button" accessibilityLabel={`追问：${item}`} onPress={() => onPick(item)} style={styles.suggestion}>
        <Icon name="arrowUp" size={14} color={colors.primary} strokeWidth={2} />
        <Text style={styles.suggestionText} numberOfLines={2}>{item}</Text>
      </MotionPressable>
    </Appear>)}
  </View>;
}

/** Earlier drafts replaced by a self-check redraw. */
export function DraftStrip({ drafts, onPreview }: { drafts: string[]; onPreview: (uri: string) => void }) {
  if (!drafts.length) return null;
  return <View style={styles.drafts}>
    <Text style={styles.draftLabel}>初稿</Text>
    {drafts.map((uri) => <Pressable key={uri} accessibilityRole="imagebutton" accessibilityLabel="查看初稿" onPress={() => onPreview(uri)} style={styles.draftFrame}>
      <Image source={{ uri }} style={styles.draftImage} />
    </Pressable>)}
  </View>;
}

function formatBytes(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const styles = StyleSheet.create({
  activity: { alignSelf: 'stretch', gap: 6 },
  activityHead: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start', maxWidth: '100%', minHeight: 28 },
  activityTitle: { color: colors.textMuted, fontSize: 14, fontWeight: '500', flexShrink: 1 },
  pulse: { width: 9, height: 9, borderRadius: 5, backgroundColor: colors.primary, marginHorizontal: 3 },
  timeline: { paddingTop: 4, paddingLeft: 2 },
  stepRow: { flexDirection: 'row', gap: 10 },
  rail: { width: 22, alignItems: 'center' },
  stepIcon: { width: 22, height: 22, borderRadius: 11, backgroundColor: colors.surfaceStrong, alignItems: 'center', justifyContent: 'center' },
  railLine: { flex: 1, width: 1.5, backgroundColor: colors.border, marginVertical: 2, minHeight: 8 },
  stepBody: { flex: 1, paddingBottom: 12, gap: 2 },
  stepNote: { color: colors.subtle, fontSize: 13, lineHeight: 19, fontStyle: 'italic', marginBottom: 2 },
  stepTitle: { color: colors.textSecondary, fontSize: 14, lineHeight: 20 },
  stepDetail: { color: colors.subtle, fontSize: 12.5 },
  stepError: { color: colors.danger, fontSize: 12.5, lineHeight: 18 },
  stepSources: { gap: 6, paddingTop: 6, paddingRight: 10 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 5, height: 26, paddingHorizontal: 9, borderRadius: 13, backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, maxWidth: 190 },
  pillIndex: { color: colors.primaryDeep, fontSize: 11, fontWeight: '700' },
  pillText: { color: colors.textMuted, fontSize: 12, flexShrink: 1 },
  sources: { alignSelf: 'stretch', gap: 8 },
  sourcesHead: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', minHeight: 26 },
  sourcesTitle: { color: colors.textMuted, fontSize: 13, fontWeight: '500' },
  sourceList: { borderRadius: radius.md, backgroundColor: colors.surface, overflow: 'hidden' },
  sourceItem: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 10 },
  sourceNumber: { width: 20, height: 20, borderRadius: 10, textAlign: 'center', lineHeight: 20, fontSize: 11, fontWeight: '700', color: colors.primaryDeep, backgroundColor: colors.primarySoft, overflow: 'hidden' },
  sourceTitle: { color: colors.text, fontSize: 14, lineHeight: 19 },
  sourceHost: { color: colors.subtle, fontSize: 12, marginTop: 2 },
  plan: { alignSelf: 'stretch', padding: 14, borderRadius: 18, backgroundColor: colors.surface, gap: 9 },
  planHead: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  planTitle: { flex: 1, color: colors.text, fontSize: 14, fontWeight: '600' },
  planCount: { color: colors.subtle, fontSize: 12.5 },
  planRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  planCheck: { width: 18, height: 18, borderRadius: 9, borderWidth: 1.5, borderColor: colors.faint, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  planCheckDone: { backgroundColor: colors.primary, borderColor: colors.primary },
  planCheckCurrent: { borderColor: colors.primary },
  planText: { flex: 1, color: colors.textSecondary, fontSize: 14, lineHeight: 20 },
  planTextDone: { color: colors.subtle, textDecorationLine: 'line-through' },
  cards: { alignSelf: 'stretch', gap: 8 },
  fileCard: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 10, paddingRight: 14, borderRadius: 18, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
  fileBadge: { width: 42, height: 42, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  fileBadgeText: { color: '#fff', fontSize: 11, fontWeight: '700', letterSpacing: 0.3 },
  fileName: { color: colors.text, fontSize: 14.5, fontWeight: '500' },
  fileMeta: { color: colors.subtle, fontSize: 12, marginTop: 2 },
  actionCard: { padding: 14, borderRadius: 20, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, gap: 12 },
  actionTop: { flexDirection: 'row', gap: 12, alignItems: 'center' },
  actionIcon: { width: 38, height: 38, borderRadius: 19, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  actionVerb: { color: colors.subtle, fontSize: 12, fontWeight: '500' },
  actionSummary: { color: colors.text, fontSize: 15, lineHeight: 21, fontWeight: '500', marginTop: 1 },
  actionError: { color: colors.danger, fontSize: 13, lineHeight: 18 },
  actionButtons: { flexDirection: 'row', gap: 8, justifyContent: 'flex-end' },
  actionButton: { minWidth: 72, height: 36, paddingHorizontal: 16, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceStrong },
  actionPrimary: { backgroundColor: colors.primary },
  actionButtonText: { color: colors.text, fontSize: 14, fontWeight: '600' },
  actionState: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  actionStateText: { color: colors.subtle, fontSize: 13 },
  actionHint: { color: colors.subtle, fontSize: 11.5, marginLeft: 4 },
  suggestions: { alignSelf: 'stretch', gap: 8, marginTop: 2 },
  suggestion: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start', maxWidth: '100%', paddingVertical: 9, paddingHorizontal: 14, borderRadius: 18, backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  suggestionText: { color: colors.textSecondary, fontSize: 14, lineHeight: 19, flexShrink: 1 },
  drafts: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  draftLabel: { color: colors.subtle, fontSize: 12.5 },
  draftFrame: { width: 44, height: 44, borderRadius: 10, overflow: 'hidden', backgroundColor: colors.surface },
  draftImage: { width: 44, height: 44 },
});
