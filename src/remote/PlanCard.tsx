import * as Clipboard from 'expo-clipboard';
import React, { useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { shareGeneratedFile, writeGeneratedFile } from '../agent/files';
import { Icon } from '../components/Icon';
import { MessageContent } from '../components/MessageContent';
import { useDesk } from '../theme';
import { useThreadStyles } from './thread-styles';
import type { Block } from './blocks';
import type { TimelineItem } from './store';
type PlanItem = Extract<TimelineItem, { kind: 'tool' }>;

function planExcerpt(output = '') {
  const lines = output.slice(0, 2048).trim().split(/\r?\n/);
  const clean = (text: string) => text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1').replace(/(\*\*|__|~~)(.+?)\1/g, '$2').trim();
  const heading = lines[0]?.match(/^#{1,6}\s+(.+)/);
  return {
    title: heading ? clean(heading[1]) : '',
    text: lines.slice(heading ? 1 : 0).filter(line => line.trim() && !/^\s*(#{1,6}\s|```)/.test(line))
      .map(line => clean(line.replace(/^\s*(?:[-+*]|\d+[.)])\s+/, ''))).join(' '),
  };
}

function PlanActions({ item }: { item: PlanItem }) {
  const d = useDesk(), current = useRef(item), busy = useRef(false);
  const name = item.planKind === 'tasks' ? '任务列表' : '计划', filename = item.planKind === 'tasks' ? 'TASKS.md' : 'PLAN.md';
  current.current = item;
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<{ id: string; category: PlanItem['planKind']; content: string; text: string; error?: boolean }>();
  const enabled = item.status === 'done' && Boolean(item.output?.trim());
  const run = async (action: 'copy' | 'export') => {
    const source = current.current, content = source.output ?? '';
    if (busy.current || source.status !== 'done' || !content.trim()) return;
    const sourceName = source.planKind === 'tasks' ? '任务列表' : '计划', sourceFile = source.planKind === 'tasks' ? 'TASKS.md' : 'PLAN.md';
    busy.current = true; setPending(true); setFeedback(undefined);
    try {
      if (action === 'copy') await Clipboard.setStringAsync(content);
      else await shareGeneratedFile(writeGeneratedFile(sourceFile, content));
      setFeedback({ id: source.id, category: source.planKind, content, text: action === 'copy' ? `已复制${sourceName}` : `已导出 ${sourceFile}` });
    } catch (reason) {
      setFeedback({ id: source.id, category: source.planKind, content, error: true, text: reason instanceof Error ? reason.message : action === 'copy' ? '复制失败，请重试' : '导出失败，请重试' });
    } finally {
      busy.current = false; setPending(false);
    }
  };
  const message = enabled && feedback?.id === item.id && feedback.category === item.planKind && feedback.content === item.output ? feedback : undefined;
  return <View style={{ alignItems: 'flex-end', flexShrink: 1 }}>
    <View style={{ flexDirection: 'row' }}>
      <Pressable accessibilityRole="button" accessibilityLabel={`复制${name}`} hitSlop={4} accessibilityState={{ disabled: !enabled || pending }} disabled={!enabled || pending}
        onPress={() => void run('copy')} style={({ pressed }) => [local.action, { opacity: !enabled || pending ? 0.35 : 1, backgroundColor: pressed ? d.press : 'transparent' }]}>
        <Icon name="copy" size={14} color={d.muted} />
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={`导出${name} ${filename}`} hitSlop={4} accessibilityState={{ disabled: !enabled || pending, busy: pending }} disabled={!enabled || pending}
        onPress={() => void run('export')} style={({ pressed }) => [local.action, { opacity: !enabled || pending ? 0.35 : 1, backgroundColor: pressed ? d.press : 'transparent' }]}>
        <Icon name="download" size={14} color={d.muted} />
      </Pressable>
    </View>
    {message ? <Text accessibilityLiveRegion="polite" style={{ color: message.error ? d.bad : d.muted, fontSize: 12 }}>{message.text}</Text> : null}
  </View>;
}

export function PlanSummaryCard({ block, onOpen }: { block: Extract<Block, { type: 'plan' }>; onOpen?: (item: PlanItem) => void }) {
  const styles = useThreadStyles(), d = useDesk();
  const proposal = block.item.planKind === 'proposal', tasks = block.item.planKind === 'tasks', done = block.steps.filter(step => step.status === 'done').length;
  const running = block.item.status === 'running';
  const excerpt = planExcerpt(block.item.output);
  return <View testID="remote-plan-summary" style={[styles.plan, local.summary]}>
    <View style={styles.planHead}><Icon name="listCheck" size={13} color={d.accent} /><Text numberOfLines={1} style={[styles.planTitle, local.title]}>{tasks ? block.item.title || '任务列表' : proposal && running ? '正在编写计划' : '计划'}</Text>
      {!proposal && !tasks && block.steps.length ? <Text style={[styles.planCount, local.count]}>{done}/{block.steps.length}</Text> : null}
      <PlanActions item={block.item} />
      {onOpen ? <Pressable accessibilityRole="button" accessibilityLabel={tasks ? '查看完整任务列表' : '查看完整计划'} hitSlop={4} onPress={() => onOpen(block.item)} style={local.action}>
        <Text style={[styles.apiLink, { fontSize: 12 }]}>详情</Text></Pressable> : null}
    </View>
    {tasks && block.item.detail ? <Text style={[styles.planCount, local.count]}>{block.item.detail}</Text> : null}
    {!proposal && block.steps.length ? block.steps.slice(0, 3).map((step, index) => <View key={`${index}:${step.text}`} style={[styles.planRow, { gap: 7 }]}>
      <View style={[styles.planDot, local.dot, step.status === 'done' && styles.planDotDone, step.status === 'active' && styles.planDotActive]}>
        {step.status === 'done' ? <Icon name="check" size={8} color={d.onInk} strokeWidth={3} /> : null}</View>
      <Text numberOfLines={1} style={[styles.planText, local.taskText, step.status === 'done' && styles.planTextDone, step.status === 'active' && styles.planTextActive]}>{step.text}</Text>
    </View>) : <View testID="remote-plan-summary-markdown" style={local.preview} pointerEvents="none">
      {block.item.output?.trim() ? <>
        {excerpt.title ? <Text numberOfLines={1} style={[local.excerptTitle, { color: d.text }]}>{excerpt.title}</Text> : null}
        {excerpt.text ? <Text numberOfLines={excerpt.title ? 2 : 3} style={[local.taskText, { color: d.text2 }]}>{excerpt.text}</Text> : null}
      </>
        : <Text style={[styles.planText, local.taskText]}>{tasks ? running ? '正在读取任务…' : '暂无任务' : running ? '正在形成方案…' : '尚无计划正文'}</Text>}
    </View>}
  </View>;
}
export function PlanPreview({ item, onClose, onOpenLink }: { item?: PlanItem; onClose: () => void; onOpenLink?: (target: string) => void }) {
  const d = useDesk(), { width } = useWindowDimensions(), insets = useSafeAreaInsets();
  const tasks = item?.planKind === 'tasks';
  const wide = width >= 768, panelWidth = wide ? Math.min(600, Math.max(400, width * 0.44)) : width;
  return <Modal visible={Boolean(item)} transparent animationType="fade" statusBarTranslucent onRequestClose={onClose}>
    {item ? <View style={[local.overlay, { backgroundColor: d.scrimLight }]}>
      <Pressable testID="remote-plan-backdrop" style={StyleSheet.absoluteFill} accessible={false} importantForAccessibility="no" onPress={onClose} />
      <View testID="remote-plan-panel" accessibilityViewIsModal onAccessibilityEscape={onClose}
        style={[local.panel, { width: panelWidth, backgroundColor: d.surface, borderLeftColor: d.line, borderLeftWidth: wide ? StyleSheet.hairlineWidth : 0,
          paddingTop: insets.top, paddingBottom: insets.bottom, paddingLeft: wide ? 0 : insets.left, paddingRight: insets.right }]}>
        <View style={[local.panelHeader, { borderBottomColor: d.line }]}>
          <Icon name="listCheck" size={15} color={d.muted} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text accessibilityRole="header" style={{ color: d.text, fontSize: 14, fontWeight: '600' }}>{tasks ? '任务详情' : '计划详情'}</Text>
            {tasks || item.status === 'running' ? <Text style={{ color: d.muted, fontSize: 11.5 }}>{tasks ? item.title || '任务列表' : '正在形成方案'}</Text> : null}
          </View>
          <PlanActions item={item} />
          <Pressable accessibilityRole="button" accessibilityLabel={tasks ? '关闭任务详情' : '关闭计划详情'} hitSlop={4} onPress={onClose}
            style={({ pressed }) => [local.action, { backgroundColor: pressed ? d.press : 'transparent' }]}>
            <Icon name="close" size={16} color={d.muted} />
          </Pressable>
        </View>
        <ScrollView key={item.id} style={{ flex: 1 }} contentContainerStyle={local.panelContent} keyboardShouldPersistTaps="handled">
          {tasks && item.detail ? <Text style={{ color: d.muted, fontSize: 11.5, marginBottom: 8 }}>{item.detail}</Text> : null}
          {item.output?.trim() ? <MessageContent text={item.output} streaming={item.status === 'running'} onOpenLink={onOpenLink} compact />
            : <Text style={{ color: d.muted }}>{tasks ? item.status === 'running' ? '正在读取任务…' : '暂无任务' : item.status === 'running' ? '正在形成方案…' : '尚无计划正文'}</Text>}
        </ScrollView>
      </View>
    </View> : null}
  </Modal>;
}

const local = StyleSheet.create({
  action: { minWidth: 32, minHeight: 32, alignItems: 'center', justifyContent: 'center', borderRadius: 7 },
  summary: { borderRadius: 12, paddingHorizontal: 10, paddingVertical: 7, gap: 4 },
  title: { fontSize: 13, fontWeight: '600', flexShrink: 1 },
  count: { fontSize: 11.5 },
  taskText: { fontSize: 12.5, lineHeight: 18 },
  dot: { width: 13, height: 13, marginTop: 2 },
  preview: { maxHeight: 72, overflow: 'hidden', gap: 4 },
  excerptTitle: { fontSize: 13, lineHeight: 18, fontWeight: '600' },
  overlay: { flex: 1, alignItems: 'flex-end' },
  panel: { flex: 1, maxWidth: '100%' },
  panelHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth },
  panelContent: { padding: 14, paddingBottom: 24 },
});
